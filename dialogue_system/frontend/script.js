const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const voiceCircle = document.getElementById('voiceCircle');
const circleStatusEl = document.getElementById('circleStatus');
const waveformCanvas = document.getElementById('waveformCanvas');
const ctx = waveformCanvas.getContext('2d');
const digitalHumanVideo = document.getElementById('digitalHumanVideo');
const videoPlaceholder = document.getElementById('videoPlaceholder');

waveformCanvas.width = waveformCanvas.clientWidth;
waveformCanvas.height = 100;

let audioContext, analyser, dataArray, source, stream, processor;
let animationId = null;
let listening = false;

// ==================== WebSocket ====================
const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const wsUrl = `${protocol}//${window.location.host}/ws`;

let socket = new WebSocket(wsUrl);
socket.binaryType = 'arraybuffer';

socket.onopen = () => console.log('[WebSocket] connected');
socket.onclose = () => console.log('[WebSocket] disconnected');
socket.onerror = (error) => console.error('[WebSocket] error:', error);

// ==================== WebRTC ====================
let pc = null;

async function initWebRTC() {
  if (pc) {
    pc.close();
    pc = null;
  }

  pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  });

  // 收到媒体流（数字人视频 + 音频）
  pc.ontrack = (event) => {
    console.log('[WebRTC] received track:', event.track.kind);
    if (event.streams && event.streams[0]) {
      digitalHumanVideo.srcObject = event.streams[0];
      digitalHumanVideo.play().catch(e => console.warn('[WebRTC] video play error:', e));
      videoPlaceholder.style.display = 'none';
    }
  };

  // 将 ICE candidate 通过 WebSocket 转发给 app.py
  pc.onicecandidate = (event) => {
    if (event.candidate && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        event: 'webrtc_candidate',
        data: {
          candidate: event.candidate.candidate,
          sdpMid: event.candidate.sdpMid,
          sdpMLineIndex: event.candidate.sdpMLineIndex,
        },
      }));
    }
  };

  pc.onconnectionstatechange = () => {
    console.log('[WebRTC] connection state:', pc.connectionState);
    if (pc.connectionState === 'connected') {
      console.log('[WebRTC] digital human connected');
    }
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
      videoPlaceholder.style.display = 'flex';
    }
  };

  // 创建 offer 并发给 app.py
  const offer = await pc.createOffer({
    offerToReceiveAudio: true,
    offerToReceiveVideo: true,
  });
  await pc.setLocalDescription(offer);

  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({
      event: 'webrtc_offer',
      data: { sdp: offer.sdp, type: offer.type },
    }));
    console.log('[WebRTC] offer sent');
  } else {
    console.error('[WebRTC] WebSocket not open, cannot send offer');
  }
}

// ==================== DOM elements ====================
const vadStatusEl = document.getElementById("vadStatus");
const userTranscriptionEl = document.getElementById("userTranscription");
const loadingOverlay = document.getElementById("loadingOverlay");
const loadingMessage = document.getElementById("loadingMessage");
const loadingConfirmBtn = document.getElementById("loadingConfirmBtn");
const loadingSpinner = document.querySelector(".loading-spinner");
const loadingSuccess = document.querySelector(".loading-success");

// ==================== WebSocket 消息处理 ====================
socket.onmessage = (event) => {
  const data = event.data;

  // 不再处理二进制音频（音频已通过 WebRTC 播放）
  if (data instanceof ArrayBuffer) {
    return;
  }

  let msg;
  try {
    msg = JSON.parse(data);
  } catch (e) {
    console.error('Failed to parse message:', e);
    return;
  }

  const eventName = msg.event;
  const payload = msg.data;

  switch (eventName) {
    case 'connect_ack':
      console.log('Connection confirmed:', payload);
      break;

    case 'text_response':
      console.log('[LLM]', payload.text);
      break;

    case 'vad_loading':
      handleVadLoading(payload);
      break;

    case 'vad_status':
      if (vadStatusEl) {
        vadStatusEl.textContent = payload.message || payload.state || "Unknown Status";
        vadStatusEl.dataset.state = payload.state || "idle";
      }
      break;

    case 'circle_status':
      updateCircleState(payload.status);
      break;

    case 'user_transcription':
      handleUserTranscription(payload);
      break;

    case 'stop_audio':
      // 数字人停止说话（由 FlashHead 端处理帧停止）
      updateCircleState("LISTENING");
      break;

    // ── WebRTC 信令 ──────────────────────────────────────────────────────────

    case 'webrtc_answer':
      // 收到 FlashHead 的 answer，完成 WebRTC 握手
      (async () => {
        try {
          await pc.setRemoteDescription(new RTCSessionDescription({
            sdp: payload.sdp,
            type: payload.type,
          }));
          console.log('[WebRTC] remote description set (answer)');
        } catch (e) {
          console.error('[WebRTC] setRemoteDescription error:', e);
        }
      })();
      break;

    case 'webrtc_candidate':
      // 收到服务端的 ICE candidate（trickleless ICE 下通常不会收到）
      if (pc && payload && payload.candidate) {
        pc.addIceCandidate(new RTCIceCandidate(payload)).catch(e =>
          console.warn('[WebRTC] addIceCandidate error:', e)
        );
      }
      break;

    case 'webrtc_error':
      console.error('[WebRTC] server error:', payload.message);
      videoPlaceholder.style.display = 'flex';
      break;

    default:
      console.log('Unknown event:', eventName);
  }
};

// ==================== Loading Overlay ====================
function handleVadLoading({ state, message }) {
  loadingOverlay.classList.remove("hidden");
  loadingMessage.textContent = message;

  if (state === "loading") {
    loadingConfirmBtn.classList.add("hidden");
    loadingSpinner.classList.remove("hidden");
    loadingSuccess.classList.add("hidden");
  } else if (state === "ready") {
    loadingSpinner.classList.add("hidden");
    loadingSuccess.classList.remove("hidden");
    loadingConfirmBtn.classList.remove("hidden");
  }
}

// 点击「Start Experience」后关闭 overlay，发起 WebRTC
loadingConfirmBtn.addEventListener("click", async () => {
  loadingOverlay.classList.add("hidden");
  updateCircleState("READY");
  await initWebRTC();
});

// ==================== Transcription ====================
function handleUserTranscription({ text }) {
  if (!userTranscriptionEl) return;
  const MAX_LEN = 20;
  let displayText = text || "No transcription yet";
  if (displayText.length > MAX_LEN) {
    let tail = displayText.slice(-MAX_LEN);
    const match = tail.match(/^[a-zA-Z]+/);
    if (match) tail = displayText.slice(-(MAX_LEN + match[0].length));
    displayText = "..." + tail;
  }
  userTranscriptionEl.textContent = displayText;
  userTranscriptionEl.classList.add("updated");
  window.setTimeout(() => userTranscriptionEl.classList.remove("updated"), 400);
}

// ==================== Audio Capture ====================
startBtn.addEventListener('click', async () => {
  try {
    listening = true;
    updateCircleState("LISTENING");

    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });

    // 发送采样率配置
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        event: "config_audio",
        data: { sample_rate: audioContext.sampleRate }
      }));
    }

    if (audioContext.state === 'suspended') await audioContext.resume();

    source = audioContext.createMediaStreamSource(stream);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    dataArray = new Uint8Array(analyser.frequencyBinCount);

    processor = audioContext.createScriptProcessor(512, 1, 1);
    source.connect(analyser);
    source.connect(processor);
    processor.connect(audioContext.destination);

    processor.onaudioprocess = e => {
      if (!listening) return;
      const input = e.inputBuffer.getChannelData(0);
      const int16 = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) {
        int16[i] = Math.max(-1, Math.min(1, input[i])) * 0x7fff;
      }
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(int16.buffer);
      }
    };

    startBtn.disabled = true;
    stopBtn.disabled = false;
    drawUserWaveform();
    pulseAssistantCircle();

  } catch (err) {
    console.error('Cannot access microphone:', err);
    alert("Cannot access microphone! Please check browser permissions.");
    updateCircleState("READY");
    startBtn.disabled = false;
  }
});

stopBtn.addEventListener('click', () => {
  listening = false;

  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ event: 'duplex_stop' }));
  }

  cancelAnimationFrame(animationId);
  if (stream) stream.getTracks().forEach(t => t.stop());
  if (processor) processor.disconnect();
  if (source) source.disconnect();
  voiceCircle.style.transform = 'scale(1)';
  ctx.clearRect(0, 0, waveformCanvas.width, waveformCanvas.height);
  startBtn.disabled = false;
  stopBtn.disabled = true;
  updateCircleState("READY");
});

// ==================== Draw Waveform ====================
function drawUserWaveform() {
  if (!listening) return;
  animationId = requestAnimationFrame(drawUserWaveform);

  analyser.getByteTimeDomainData(dataArray);
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, waveformCanvas.width, waveformCanvas.height);

  ctx.lineWidth = 2;
  ctx.strokeStyle = '#38bdf8';
  ctx.beginPath();

  const sliceWidth = waveformCanvas.width / dataArray.length;
  let x = 0;
  let lastY = waveformCanvas.height / 2;

  for (let i = 0; i < dataArray.length; i++) {
    const v = dataArray[i] / 128.0;
    const y = lastY + (v * waveformCanvas.height / 2 - lastY) * 0.2;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
    lastY = y;
    x += sliceWidth;
  }
  ctx.stroke();
}

// ==================== Assistant Circle Animation ====================
let pulseDirection = 1;
function pulseAssistantCircle() {
  if (!listening) return;
  animationId = requestAnimationFrame(pulseAssistantCircle);

  if (voiceCircle.classList.contains('state-speaking') || voiceCircle.classList.contains('state-processing')) {
    return;
  }

  let currentScale = parseFloat(voiceCircle.style.transform.replace('scale(', '').replace(')', '')) || 1;
  if (currentScale >= 1.05) pulseDirection = -1;
  if (currentScale <= 1) pulseDirection = 1;
  currentScale += pulseDirection * 0.002;
  voiceCircle.style.transform = `scale(${currentScale})`;
}

// ==================== Update Circle State ====================
function updateCircleState(state) {
  voiceCircle.classList.remove('state-speaking', 'state-listening', 'state-processing');

  let statusText = "READY";
  switch (state) {
    case 'LISTENING':
      voiceCircle.classList.add('state-listening');
      statusText = "LISTENING";
      break;
    case 'THINKING':
      voiceCircle.classList.add('state-processing');
      statusText = "THINKING";
      break;
    case 'SPEAKING':
      voiceCircle.classList.add('state-speaking');
      statusText = "SPEAKING";
      break;
    case 'READY':
    default:
      statusText = "READY";
      break;
  }

  if (circleStatusEl) circleStatusEl.textContent = statusText;
}
