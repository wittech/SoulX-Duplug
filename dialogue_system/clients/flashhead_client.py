"""
FlashHead 客户端

供 dialogue_system/app.py 调用，负责：
  1. 将 TTS 音频推送给 FlashHead 服务
  2. 打断当前会话推理
  3. 提供浏览器直连 WebSocket 的 URL
"""

import logging
import requests

logger = logging.getLogger(__name__)


class FlashHeadClient:
    def __init__(self, api_url: str = "http://localhost:6008"):
        self.api_url = api_url.rstrip("/")
        # WebSocket URL 供前端直连（http→ws, https→wss）
        self.ws_url = self.api_url.replace("http://", "ws://").replace("https://", "wss://")
        # 启动时探活
        try:
            resp = requests.get(f"{self.api_url}/health", timeout=5)
            if resp.status_code == 200:
                logger.info(f"[FlashHeadClient] Connected to {self.api_url}")
            else:
                logger.warning(f"[FlashHeadClient] Health check failed: {resp.status_code}")
        except Exception as e:
            logger.warning(f"[FlashHeadClient] Cannot reach FlashHead service: {e}")

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

    def flush(self, client_id: str) -> None:
        """TTS 音频发送完毕，通知 FlashHead 刷新剩余帧为最后一段 MP4。"""
        try:
            requests.post(
                f"{self.api_url}/flush/{client_id}",
                timeout=10,
            )
        except Exception as e:
            logger.warning(f"[FlashHeadClient] flush failed: {e}")

    def interrupt(self, client_id: str) -> None:
        """通知 FlashHead 停止当前会话的推理。"""
        try:
            requests.post(
                f"{self.api_url}/interrupt/{client_id}",
                timeout=5,
            )
        except Exception as e:
            logger.warning(f"[FlashHeadClient] interrupt failed: {e}")
