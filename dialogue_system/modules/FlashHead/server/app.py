"""
FlashHead WebRTC 数字人推流服务

接口：
  GET  /health                  健康检查
  POST /offer                   接收 WebRTC SDP offer，返回 answer（含完整 ICE 候选）
  POST /candidate               接收浏览器 ICE candidate
  POST /push_audio/{client_id}  接收 TTS 音频（int16 PCM, 24kHz）
  POST /interrupt/{client_id}   打断当前会话推理
"""

import asyncio
import fractions
import logging
import os
import sys
import time
from collections import deque
from contextlib import asynccontextmanager
from typing import Dict, Optional

import numpy as np
import soxr
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from aiortc import RTCIceCandidate, RTCPeerConnection, RTCSessionDescription
from aiortc.mediastreams import VideoStreamTrack, AudioStreamTrack
from av import AudioFrame, VideoFrame

# 将 FlashHead 根目录加入 path
CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
FLASHHEAD_ROOT = os.path.abspath(os.path.join(CURRENT_DIR, ".."))
if FLASHHEAD_ROOT not in sys.path:
    sys.path.insert(0, FLASHHEAD_ROOT)

from flash_head.inference import (
    get_audio_embedding,
    get_base_data,
    get_infer_params,
    get_pipeline,
    run_pipeline,
)

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s"
)
logger = logging.getLogger(__name__)

# ── 全局模型（启动时加载一次）────────────────────────────────────────────────
_pipeline = None
_infer_params: dict = {}
_cfg: "ServerConfig" = None
_inference_lock = asyncio.Lock()   # 单 GPU 串行推理


# ══════════════════════════════════════════════════════════════════════════════
# 配置
# ══════════════════════════════════════════════════════════════════════════════

class ServerConfig:
    def __init__(
        self,
        ckpt_dir: str,
        wav2vec_dir: str,
        model_type: str,
        cond_image: str,
        device: str = "cuda:0",
        base_seed: int = 42,
        use_face_crop: bool = False,
    ):
        self.ckpt_dir = ckpt_dir
        self.wav2vec_dir = wav2vec_dir
        self.model_type = model_type
        self.cond_image = cond_image
        self.device = device
        self.base_seed = base_seed
        self.use_face_crop = use_face_crop


# ══════════════════════════════════════════════════════════════════════════════
# 自定义 WebRTC 媒体轨道
# ══════════════════════════════════════════════════════════════════════════════

class DigitalHumanVideoTrack(VideoStreamTrack):
    """将推理生成的视频帧（numpy RGB uint8）通过 WebRTC 推送给浏览器。"""

    FPS = 25

    def __init__(self):
        super().__init__()
        self._queue: asyncio.Queue = asyncio.Queue(maxsize=150)
        self._last_frame_np: Optional[np.ndarray] = None

    async def recv(self) -> VideoFrame:
        pts, time_base = await self.next_timestamp()

        try:
            frame_np = self._queue.get_nowait()
            self._last_frame_np = frame_np
        except asyncio.QueueEmpty:
            # 没有新帧时复用上一帧；首帧前显示黑屏
            frame_np = (
                self._last_frame_np
                if self._last_frame_np is not None
                else np.zeros((512, 512, 3), dtype=np.uint8)
            )

        frame = VideoFrame.from_ndarray(frame_np, format="rgb24")
        frame.pts = pts
        frame.time_base = time_base
        return frame

    async def push_frame(self, frame_np: np.ndarray):
        try:
            self._queue.put_nowait(frame_np)
        except asyncio.QueueFull:
            # 队列满时丢弃最旧帧，保证实时性
            try:
                self._queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
            await self._queue.put(frame_np)

    def clear(self):
        while not self._queue.empty():
            try:
                self._queue.get_nowait()
            except asyncio.QueueEmpty:
                break


class DigitalHumanAudioTrack(AudioStreamTrack):
    """将 TTS PCM 音频（int16 24kHz）通过 WebRTC 推送给浏览器。"""

    SAMPLE_RATE = 24000
    # 每帧 20ms：24000 * 0.02 = 480 samples
    FRAME_SAMPLES = 480

    def __init__(self):
        super().__init__()
        self._queue: asyncio.Queue = asyncio.Queue(maxsize=500)
        self._buffer = bytearray()

    async def recv(self) -> AudioFrame:
        pts, time_base = await self.next_timestamp()
        needed_bytes = self.FRAME_SAMPLES * 2  # int16 = 2 bytes/sample

        # 从队列补充缓冲区
        while len(self._buffer) < needed_bytes:
            try:
                chunk = self._queue.get_nowait()
                self._buffer.extend(chunk)
            except asyncio.QueueEmpty:
                # 用静音补足
                self._buffer.extend(bytes(needed_bytes - len(self._buffer)))
                break

        pcm_bytes = bytes(self._buffer[:needed_bytes])
        del self._buffer[:needed_bytes]

        samples = np.frombuffer(pcm_bytes, dtype=np.int16).reshape(1, -1)
        frame = AudioFrame.from_ndarray(samples, format="s16", layout="mono")
        frame.pts = pts
        frame.sample_rate = self.SAMPLE_RATE
        frame.time_base = time_base
        return frame

    async def push_audio(self, pcm_bytes: bytes):
        await self._queue.put(pcm_bytes)

    def clear(self):
        while not self._queue.empty():
            try:
                self._queue.get_nowait()
            except asyncio.QueueEmpty:
                break
        self._buffer.clear()


# ══════════════════════════════════════════════════════════════════════════════
# 会话管理
# ══════════════════════════════════════════════════════════════════════════════

class FlashHeadSession:
    """
    单个用户会话：维护 WebRTC 连接、媒体轨道和推理循环。
    """

    def __init__(self, client_id: str):
        self.client_id = client_id

        # WebRTC
        self.pc: Optional[RTCPeerConnection] = None
        self.video_track = DigitalHumanVideoTrack()
        self.audio_track = DigitalHumanAudioTrack()

        # 推理控制
        self._stop_event = asyncio.Event()
        self._inference_task: Optional[asyncio.Task] = None

        # FlashHead 推理参数（从全局 infer_params 读取）
        p = _infer_params
        self.sample_rate: int = int(p["sample_rate"])          # 16000
        self.tgt_fps: int = int(p["tgt_fps"])                  # 25
        self.frame_num: int = int(p["frame_num"])              # 33
        self.motion_frames_num: int = int(p["motion_frames_num"])
        self.cached_audio_duration: int = int(p["cached_audio_duration"])  # 8

        self.slice_len = self.frame_num - self.motion_frames_num
        self.slice_samples = self.slice_len * self.sample_rate // self.tgt_fps

        cached_len = self.sample_rate * self.cached_audio_duration
        self.audio_dq = deque([0.0] * cached_len, maxlen=cached_len)
        self.audio_end_idx = self.cached_audio_duration * self.tgt_fps
        self.audio_start_idx = self.audio_end_idx - self.frame_num

        # 待推理音频缓冲（16kHz float32）
        self._pending_16k = np.array([], dtype=np.float32)
        # 待推理音频队列
        self._audio_in_queue: asyncio.Queue = asyncio.Queue()

    # ── 打断 ─────────────────────────────────────────────────────────────────

    def interrupt(self):
        """停止推理，清空帧/音频队列。"""
        self._stop_event.set()
        self.video_track.clear()
        self.audio_track.clear()
        self._pending_16k = np.array([], dtype=np.float32)
        # 清空 audio_in_queue
        while not self._audio_in_queue.empty():
            try:
                self._audio_in_queue.get_nowait()
            except asyncio.QueueEmpty:
                break

    def reset_stop(self):
        """为下一轮对话重置停止事件。"""
        self._stop_event = asyncio.Event()

    # ── 接收 TTS 音频 ────────────────────────────────────────────────────────

    async def push_tts_audio(self, pcm_int16_24k: bytes):
        """
        接收 TTS 输出的 int16 PCM（24kHz）：
          1. 直接推入音频轨道（WebRTC 播放）
          2. 降采样到 16kHz float32 → 推入推理队列
        """
        if not pcm_int16_24k:
            return

        # ① WebRTC 音频轨道
        await self.audio_track.push_audio(pcm_int16_24k)

        # ② 推理队列：24kHz int16 → 16kHz float32
        arr_int16 = np.frombuffer(pcm_int16_24k, dtype=np.int16)
        arr_f32 = arr_int16.astype(np.float32) / 32768.0
        arr_16k = soxr.resample(arr_f32, 24000, 16000)
        await self._audio_in_queue.put(arr_16k)

    # ── 推理循环 ─────────────────────────────────────────────────────────────

    async def start_inference_loop(self):
        self._inference_task = asyncio.create_task(self._inference_loop())

    async def _inference_loop(self):
        import concurrent.futures
        loop = asyncio.get_running_loop()
        executor = concurrent.futures.ThreadPoolExecutor(max_workers=1)

        logger.info(f"[{self.client_id}] Inference loop started")

        while not self._stop_event.is_set():
            try:
                chunk = await asyncio.wait_for(
                    self._audio_in_queue.get(), timeout=1.0
                )
            except asyncio.TimeoutError:
                continue

            self._pending_16k = np.concatenate([self._pending_16k, chunk])

            while len(self._pending_16k) >= self.slice_samples:
                if self._stop_event.is_set():
                    break

                audio_slice = self._pending_16k[: self.slice_samples]
                self._pending_16k = self._pending_16k[self.slice_samples :]

                self.audio_dq.extend(audio_slice.tolist())
                audio_array = np.array(self.audio_dq, dtype=np.float32)

                try:
                    async with _inference_lock:
                        audio_embedding = await loop.run_in_executor(
                            executor,
                            get_audio_embedding,
                            _pipeline,
                            audio_array,
                            self.audio_start_idx,
                            self.audio_end_idx,
                        )
                        frames = await loop.run_in_executor(
                            executor,
                            run_pipeline,
                            _pipeline,
                            audio_embedding,
                        )

                    # 去掉 motion frames，转 numpy
                    frames = frames[self.motion_frames_num :]
                    frames_np = frames.cpu().numpy().astype(np.uint8)

                    for i in range(frames_np.shape[0]):
                        if self._stop_event.is_set():
                            break
                        await self.video_track.push_frame(frames_np[i])

                except Exception as e:
                    logger.error(f"[{self.client_id}] Inference error: {e}", exc_info=True)

        logger.info(f"[{self.client_id}] Inference loop stopped")

    # ── 关闭 ─────────────────────────────────────────────────────────────────

    async def close(self):
        self._stop_event.set()
        if self._inference_task and not self._inference_task.done():
            self._inference_task.cancel()
            try:
                await self._inference_task
            except asyncio.CancelledError:
                pass
        if self.pc:
            await self.pc.close()
        logger.info(f"[{self.client_id}] Session closed")


# 全局会话表
_sessions: Dict[str, FlashHeadSession] = {}


# ══════════════════════════════════════════════════════════════════════════════
# FastAPI 应用
# ══════════════════════════════════════════════════════════════════════════════

def create_app(cfg: ServerConfig) -> FastAPI:
    global _cfg
    _cfg = cfg

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        global _pipeline, _infer_params, _inference_lock
        _inference_lock = asyncio.Lock()

        logger.info("[FlashHead] Loading model, please wait...")
        import torch
        device = cfg.device
        os.environ.setdefault("CUDA_VISIBLE_DEVICES", device.replace("cuda:", ""))

        _pipeline = get_pipeline(
            world_size=1,
            ckpt_dir=cfg.ckpt_dir,
            wav2vec_dir=cfg.wav2vec_dir,
            model_type=cfg.model_type,
        )
        get_base_data(
            _pipeline,
            cond_image_path_or_dir=cfg.cond_image,
            base_seed=cfg.base_seed,
            use_face_crop=cfg.use_face_crop,
        )
        _infer_params = get_infer_params()
        logger.info(
            f"[FlashHead] Ready. sr={_infer_params['sample_rate']}, "
            f"fps={_infer_params['tgt_fps']}, "
            f"frame_num={_infer_params['frame_num']}"
        )
        yield

        # 关闭所有会话
        for session in list(_sessions.values()):
            await session.close()
        _sessions.clear()

    app = FastAPI(lifespan=lifespan)

    # ── 健康检查 ───────────────────────────────────────────────────────────────

    @app.get("/health")
    async def health():
        return {"status": "ok", "sessions": len(_sessions)}

    # ── WebRTC Offer ──────────────────────────────────────────────────────────

    @app.post("/offer")
    async def offer(request: Request):
        """
        接收来自 app.py 转发的浏览器 WebRTC offer，
        返回包含完整 ICE 候选的 answer（trickleless ICE）。

        Body JSON:
          client_id : str
          sdp       : str   (SDP 字符串)
          type      : str   ("offer")
          cond_image: str   可选，指定数字人形象图路径
        """
        params = await request.json()
        client_id: str = params["client_id"]
        sdp: str = params["sdp"]
        sdp_type: str = params["type"]
        cond_image: str = params.get("cond_image", cfg.cond_image)

        # 关闭旧会话（同一 client_id 重连）
        if client_id in _sessions:
            await _sessions[client_id].close()
            del _sessions[client_id]

        # 如果指定了不同的数字人形象，重新 prepare（单 GPU 串行，加锁）
        if cond_image != cfg.cond_image:
            async with _inference_lock:
                import asyncio
                loop = asyncio.get_running_loop()
                import concurrent.futures
                with concurrent.futures.ThreadPoolExecutor(max_workers=1) as ex:
                    await loop.run_in_executor(
                        ex,
                        get_base_data,
                        _pipeline,
                        cond_image,
                        cfg.base_seed,
                        cfg.use_face_crop,
                    )

        session = FlashHeadSession(client_id)
        _sessions[client_id] = session

        # 建立 RTCPeerConnection
        pc = RTCPeerConnection()
        session.pc = pc

        @pc.on("connectionstatechange")
        async def on_connection_state_change():
            logger.info(f"[{client_id}] WebRTC state: {pc.connectionState}")
            if pc.connectionState in ("failed", "closed", "disconnected"):
                if client_id in _sessions:
                    await _sessions[client_id].close()
                    del _sessions[client_id]

        # 添加媒体轨道
        pc.addTrack(session.video_track)
        pc.addTrack(session.audio_track)

        # 处理 offer
        await pc.setRemoteDescription(
            RTCSessionDescription(sdp=sdp, type=sdp_type)
        )
        answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)

        # 等待 ICE gathering 完成（trickleless ICE），超时 10s
        ice_complete = asyncio.Event()

        @pc.on("icegatheringstatechange")
        def on_ice_gathering_state_change():
            if pc.iceGatheringState == "complete":
                ice_complete.set()

        if pc.iceGatheringState != "complete":
            try:
                await asyncio.wait_for(ice_complete.wait(), timeout=10.0)
            except asyncio.TimeoutError:
                logger.warning(f"[{client_id}] ICE gathering timeout, using current candidates")

        # 启动推理循环
        await session.start_inference_loop()

        logger.info(f"[{client_id}] WebRTC session created")
        return JSONResponse({
            "sdp": pc.localDescription.sdp,
            "type": pc.localDescription.type,
        })

    # ── ICE Candidate ─────────────────────────────────────────────────────────

    @app.post("/candidate")
    async def candidate(request: Request):
        """
        接收浏览器发来的 ICE candidate（由 app.py 中转）。

        Body JSON:
          client_id  : str
          candidate  : dict | None  (candidate / sdpMid / sdpMLineIndex)
        """
        params = await request.json()
        client_id: str = params["client_id"]
        session = _sessions.get(client_id)
        if not session or not session.pc:
            return JSONResponse({"error": "session not found"}, status_code=404)

        candidate_data = params.get("candidate")
        if candidate_data and candidate_data.get("candidate"):
            try:
                ice = RTCIceCandidate(
                    sdpMid=candidate_data.get("sdpMid"),
                    sdpMLineIndex=candidate_data.get("sdpMLineIndex"),
                    candidate=candidate_data["candidate"],
                )
                await session.pc.addIceCandidate(ice)
            except Exception as e:
                logger.warning(f"[{client_id}] addIceCandidate error: {e}")

        return JSONResponse({"ok": True})

    # ── 推入 TTS 音频 ─────────────────────────────────────────────────────────

    @app.post("/push_audio/{client_id}")
    async def push_audio(client_id: str, request: Request):
        """
        接收 TTS 生成的 int16 PCM（24kHz）原始字节流。
        由 flashhead_client.push_audio() 调用。
        """
        session = _sessions.get(client_id)
        if not session:
            return JSONResponse({"error": "session not found"}, status_code=404)

        pcm_bytes = await request.body()
        await session.push_tts_audio(pcm_bytes)
        return JSONResponse({"ok": True})

    # ── 打断 ──────────────────────────────────────────────────────────────────

    @app.post("/interrupt/{client_id}")
    async def interrupt(client_id: str):
        """停止当前会话的推理，清空帧队列。会话保持，下次 push_audio 继续。"""
        session = _sessions.get(client_id)
        if session:
            session.interrupt()
            session.reset_stop()
            await session.start_inference_loop()   # 重启推理循环
        return JSONResponse({"ok": True})

    return app
