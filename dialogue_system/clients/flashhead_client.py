"""
FlashHead 客户端

供 dialogue_system/app.py 调用，负责：
  1. 中转 WebRTC 信令（offer / candidate）
  2. 将 TTS 音频推送给 FlashHead 服务
  3. 打断当前会话推理
"""

import logging
import requests

logger = logging.getLogger(__name__)


class FlashHeadClient:
    def __init__(self, api_url: str = "http://localhost:6008"):
        self.api_url = api_url.rstrip("/")
        # 启动时探活
        try:
            resp = requests.get(f"{self.api_url}/health", timeout=5)
            if resp.status_code == 200:
                logger.info(f"[FlashHeadClient] Connected to {self.api_url}")
            else:
                logger.warning(f"[FlashHeadClient] Health check failed: {resp.status_code}")
        except Exception as e:
            logger.warning(f"[FlashHeadClient] Cannot reach FlashHead service: {e}")

    def send_offer(
        self,
        client_id: str,
        sdp: str,
        sdp_type: str,
        cond_image: str = None,
    ) -> dict:
        """
        将浏览器的 WebRTC offer 转发给 FlashHead，返回 answer。

        Returns:
            {"sdp": ..., "type": "answer"}
        """
        payload = {"client_id": client_id, "sdp": sdp, "type": sdp_type}
        if cond_image:
            payload["cond_image"] = cond_image
        try:
            resp = requests.post(
                f"{self.api_url}/offer",
                json=payload,
                timeout=30,   # ICE gathering 最多等 10s，再加处理余量
            )
            resp.raise_for_status()
            return resp.json()
        except Exception as e:
            logger.error(f"[FlashHeadClient] send_offer failed: {e}")
            return {}

    def send_candidate(self, client_id: str, candidate: dict) -> None:
        """将浏览器的 ICE candidate 转发给 FlashHead。"""
        try:
            requests.post(
                f"{self.api_url}/candidate",
                json={"client_id": client_id, "candidate": candidate},
                timeout=5,
            )
        except Exception as e:
            logger.warning(f"[FlashHeadClient] send_candidate failed: {e}")

    def push_audio(self, client_id: str, pcm_bytes: bytes) -> None:
        """
        将 TTS 输出的 int16 PCM（24kHz）原始字节推送给 FlashHead。
        在后台线程中同步调用，不阻塞主事件循环。
        """
        if not pcm_bytes:
            return
        try:
            requests.post(
                f"{self.api_url}/push_audio/{client_id}",
                data=pcm_bytes,
                headers={"Content-Type": "application/octet-stream"},
                timeout=10,
            )
        except Exception as e:
            logger.warning(f"[FlashHeadClient] push_audio failed: {e}")

    def interrupt(self, client_id: str) -> None:
        """通知 FlashHead 停止当前会话的推理。"""
        try:
            requests.post(
                f"{self.api_url}/interrupt/{client_id}",
                timeout=5,
            )
        except Exception as e:
            logger.warning(f"[FlashHeadClient] interrupt failed: {e}")
