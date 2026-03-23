const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const voiceCircle = document.getElementById('voiceCircle');
const circleStatusEl = document.getElementById('circleStatus');
const waveformCanvas = document.getElementById('waveformCanvas');
const ctx = waveformCanvas.getContext('2d');
const digitalHumanVideo = document.getElementById('digitalHumanVideo');
const videoPlaceholder = document.getElementById('videoPlaceholder');
const activeVideo = digitalHumanVideo;

if (videoPlaceholder) {
  videoPlaceholder.style.backgroundImage = "url('/avatar/default')";
}

function showDefaultAvatar() {
  if (videoPlaceholder) {
    videoPlaceholder.style.display = 'flex';
  }
}

function hideDefaultAvatar() {
  if (videoPlaceholder) {
    videoPlaceholder.style.display = 'none';
  }
}

waveformCanvas.width = waveformCanvas.clientWidth;
waveformCanvas.height = 100;

let audioContext, analyser, dataArray, source, stream, processor;
let silentGain;
let animationId = null;
let listening = false;

// ==================== 主控 WebSocket ====================
const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const wsUrl = `${protocol}//${window.location.host}/ws`;

let socket = new WebSocket(wsUrl);
socket.binaryType = 'arraybuffer';

socket.onopen = () => console.log('[WebSocket] connected');
socket.onclose = () => console.log('[WebSocket] disconnected');
socket.onerror = (error) => console.error('[WebSocket] error:', error);

const MSE_CODEC_CANDIDATES = [
  'video/mp4; codecs="avc1.42E01E,mp4a.40.2"',
  'video/mp4; codecs="avc1.4D401E,mp4a.40.2"',
  'video/mp4; codecs="avc1.64001F,mp4a.40.2"',
  'video/mp4'
];
const MSE_START_BUFFER_SEC = 0.35;
const MSE_KEEP_BUFFER_SEC = 8;

let mediaSource = null;
let sourceBuffer = null;
let mseObjectUrl = null;
let mseCodec = null;
let mseOpened = false;
let mseAppendQueue = [];
let mseAppending = false;
let mseGeneration = 0;
let acceptIncomingMedia = false;
let pendingTurnReset = false;
let mseConsecutiveAppendErrors = 0;
let mseLastChunkAt = 0;
let mseLastUpdateEndAt = Date.now();
let mseRecovering = false;
let mseHealthTimer = null;
let firstFrameRevealArmed = false;
let firstFrameFallbackTimer = null;
let firstFrameRvfcToken = null;
let firstChunkSeenGeneration = -1;

const MSE_HEALTH_CHECK_MS = 800;
const MSE_MAX_APPEND_ERRORS = 3;
const MSE_UPDATE_STUCK_MS = 3000;
const MSE_QUEUE_STUCK_MS = 1800;
const MSE_STREAM_FINISHED_IDLE_MS = 1200;

function clearFirstFrameRevealWatchers() {
  if (!activeVideo) return;
  activeVideo.removeEventListener('loadeddata', onFirstFrameMaybeVisible);
  activeVideo.removeEventListener('canplay', onFirstFrameMaybeVisible);
  activeVideo.removeEventListener('playing', onFirstFrameMaybeVisible);
  activeVideo.removeEventListener('timeupdate', onFirstFrameMaybeVisible);

  if (firstFrameFallbackTimer) {
    clearTimeout(firstFrameFallbackTimer);
    firstFrameFallbackTimer = null;
  }

  if (firstFrameRvfcToken !== null && typeof activeVideo.cancelVideoFrameCallback === 'function') {
    try {
      activeVideo.cancelVideoFrameCallback(firstFrameRvfcToken);
    } catch (_e) {
    }
    firstFrameRvfcToken = null;
  }
}

function onFirstFrameMaybeVisible() {
  if (!firstFrameRevealArmed || !acceptIncomingMedia || !activeVideo) return;
  if (firstChunkSeenGeneration !== mseGeneration) return;
  const ready = activeVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
  const moved = activeVideo.currentTime > 0;
  const visibleLikely = activeVideo.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA && !activeVideo.paused;

  if (!ready || (!moved && !visibleLikely)) {
    return;
  }

  firstFrameRevealArmed = false;
  clearFirstFrameRevealWatchers();
  hideDefaultAvatar();
}

function armFirstFrameReveal() {
  if (!activeVideo || firstFrameRevealArmed) return;
  firstFrameRevealArmed = true;

  activeVideo.addEventListener('loadeddata', onFirstFrameMaybeVisible);
  activeVideo.addEventListener('canplay', onFirstFrameMaybeVisible);
  activeVideo.addEventListener('playing', onFirstFrameMaybeVisible);
  activeVideo.addEventListener('timeupdate', onFirstFrameMaybeVisible);

  if (typeof activeVideo.requestVideoFrameCallback === 'function') {
    firstFrameRvfcToken = activeVideo.requestVideoFrameCallback(() => {
      onFirstFrameMaybeVisible();
    });
  }

  firstFrameFallbackTimer = setTimeout(() => {
    onFirstFrameMaybeVisible();
  }, 1200);
}

function pickMseCodec() {
  for (const codec of MSE_CODEC_CANDIDATES) {
    if (MediaSource.isTypeSupported(codec)) {
      return codec;
    }
  }
  return null;
}

function tryPlayVideo() {
  if (!activeVideo) return;
  if (!sourceBuffer || !sourceBuffer.buffered || sourceBuffer.buffered.length === 0) return;

  const end = sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1);
  const current = activeVideo.currentTime || 0;
  if (end - current < MSE_START_BUFFER_SEC) return;

  const p = activeVideo.play();
  if (p && typeof p.catch === 'function') {
    p.catch((e) => console.warn('[MSE] play error:', e));
  }
}

function getBufferedAheadSec() {
  if (!sourceBuffer || !sourceBuffer.buffered || sourceBuffer.buffered.length === 0 || !activeVideo) {
    return 0;
  }
  const end = sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1);
  const current = activeVideo.currentTime || 0;
  return Math.max(0, end - current);
}

function trimOldBuffer() {
  if (!sourceBuffer || sourceBuffer.updating || sourceBuffer.buffered.length === 0) return;
  const current = activeVideo.currentTime || 0;
  const keepFrom = Math.max(0, current - MSE_KEEP_BUFFER_SEC);
  const start = sourceBuffer.buffered.start(0);
  if (keepFrom > start + 0.5) {
    try {
      sourceBuffer.remove(0, keepFrom);
    } catch (e) {
      console.warn('[MSE] remove old buffer failed:', e);
    }
  }
}

function appendNextMseChunk() {
  if (!mseOpened || !sourceBuffer || sourceBuffer.updating || mseAppending) return;
  if (mseAppendQueue.length === 0) {
    tryPlayVideo();
    return;
  }

  mseAppending = true;
  const chunk = mseAppendQueue.shift();
  if (!chunk || chunk.generation !== mseGeneration) {
    mseAppending = false;
    appendNextMseChunk();
    return;
  }
  try {
    sourceBuffer.appendBuffer(chunk.bytes);
  } catch (e) {
    mseAppending = false;
    mseConsecutiveAppendErrors += 1;
    console.warn('[MSE] appendBuffer failed:', e);
    if (chunk) mseAppendQueue.unshift(chunk);
    if (mseConsecutiveAppendErrors >= MSE_MAX_APPEND_ERRORS) {
      recoverMsePipeline('append-buffer-errors');
    }
  }
}

function enqueueMseChunk(mp4Data) {
  if (!mp4Data || mp4Data.byteLength === 0) return;
  if (!acceptIncomingMedia) return false;
  mseLastChunkAt = Date.now();
  firstChunkSeenGeneration = mseGeneration;
  mseAppendQueue.push({
    generation: mseGeneration,
    bytes: new Uint8Array(mp4Data),
  });
  appendNextMseChunk();
  return true;
}

function recoverMsePipeline(reason) {
  if (mseRecovering) return;
  if (!activeVideo) return;

  mseRecovering = true;
  console.warn('[MSE] recovering pipeline:', reason);

  const keepAccepting = acceptIncomingMedia;
  mseGeneration += 1;
  firstChunkSeenGeneration = -1;
  mseAppendQueue = [];
  mseAppending = false;
  mseConsecutiveAppendErrors = 0;
  pendingTurnReset = false;

  if (sourceBuffer && sourceBuffer.updating) {
    try {
      sourceBuffer.abort();
    } catch (e) {
      console.warn('[MSE] abort during recovery failed:', e);
    }
  }

  buildMsePipeline();
  acceptIncomingMedia = keepAccepting;
  mseLastUpdateEndAt = Date.now();

  setTimeout(() => {
    mseRecovering = false;
  }, 200);
}

function monitorMseHealth() {
  if (!activeVideo || !sourceBuffer || !mseOpened) return;
  if (!acceptIncomingMedia || pendingTurnReset) return;

  const now = Date.now();
  const bufferedAhead = getBufferedAheadSec();

  if (sourceBuffer.updating && now - mseLastUpdateEndAt > MSE_UPDATE_STUCK_MS) {
    recoverMsePipeline('sourcebuffer-updating-stuck');
    return;
  }

  if (!sourceBuffer.updating && mseAppendQueue.length > 5 && now - mseLastUpdateEndAt > MSE_QUEUE_STUCK_MS) {
    recoverMsePipeline('append-queue-stuck');
    return;
  }

  if (!sourceBuffer.updating && !mseAppending && mseAppendQueue.length > 0 && bufferedAhead < 0.12) {
    appendNextMseChunk();
  }

  const streamLikelyFinished = (
    firstChunkSeenGeneration === mseGeneration
    && !sourceBuffer.updating
    && !mseAppending
    && mseAppendQueue.length === 0
    && bufferedAhead < 0.02
    && now - mseLastChunkAt > MSE_STREAM_FINISHED_IDLE_MS
  );

  if (streamLikelyFinished) {
    acceptIncomingMedia = false;
    firstFrameRevealArmed = false;
    clearFirstFrameRevealWatchers();
    showDefaultAvatar();
    if (!activeVideo.paused) {
      activeVideo.pause();
    }
    return;
  }

  if (!activeVideo.paused && bufferedAhead < 0.06 && mseAppendQueue.length === 0 && now - mseLastChunkAt > 2500) {
    recoverMsePipeline('buffer-underrun-without-new-chunks');
  }
}

function startMseHealthMonitor() {
  if (mseHealthTimer) return;
  mseHealthTimer = setInterval(monitorMseHealth, MSE_HEALTH_CHECK_MS);
}

function buildMsePipeline() {
  if (!activeVideo || typeof MediaSource === 'undefined') return false;
  mseCodec = pickMseCodec();
  if (!mseCodec) {
    console.error('[MSE] no supported codec');
    return false;
  }

  mediaSource = new MediaSource();
  mseOpened = false;
  sourceBuffer = null;
  mseAppendQueue = [];
  mseAppending = false;

  if (mseObjectUrl) {
    URL.revokeObjectURL(mseObjectUrl);
    mseObjectUrl = null;
  }
  mseObjectUrl = URL.createObjectURL(mediaSource);
  activeVideo.src = mseObjectUrl;
  activeVideo.muted = false;
  activeVideo.playsInline = true;

  mediaSource.addEventListener('sourceopen', () => {
    try {
      sourceBuffer = mediaSource.addSourceBuffer(mseCodec);
      sourceBuffer.mode = 'sequence';
      mseOpened = true;

      sourceBuffer.addEventListener('updateend', () => {
        mseAppending = false;
        mseConsecutiveAppendErrors = 0;
        mseLastUpdateEndAt = Date.now();
        trimOldBuffer();
        appendNextMseChunk();
      });

      sourceBuffer.addEventListener('error', (e) => {
        mseAppending = false;
        console.error('[MSE] SourceBuffer error:', e);
        recoverMsePipeline('sourcebuffer-error-event');
      });

      appendNextMseChunk();
    } catch (e) {
      console.error('[MSE] sourceopen init failed:', e);
    }
  }, { once: true });

  return true;
}

function preparePipelineForNewTurn() {
  mseAppendQueue = [];
  mseAppending = false;

  if (sourceBuffer && sourceBuffer.updating) {
    try {
      sourceBuffer.abort();
    } catch (e) {
      console.warn('[MSE] abort failed:', e);
    }
  }

  buildMsePipeline();
}

function stopPlaybackKeepFrame() {
  if (activeVideo && !activeVideo.paused) {
    activeVideo.pause();
  }
}

function resetVideoState() {
  firstFrameRevealArmed = false;
  clearFirstFrameRevealWatchers();
  mseGeneration += 1;
  firstChunkSeenGeneration = -1;
  acceptIncomingMedia = false;
  pendingTurnReset = true;
  mseAppendQueue = [];
  mseAppending = false;
  stopPlaybackKeepFrame();
  showDefaultAvatar();
}

function hardResetVideoState() {
  resetVideoState();
  preparePipelineForNewTurn();
  pendingTurnReset = false;
}

function handleMediaFrame(arrayBuffer) {
  if (arrayBuffer.byteLength < 5) return;

  const view = new DataView(arrayBuffer);
  const type = view.getUint8(0);

  if (type === 0x04) {
    const mp4Len = view.getUint32(1, true);
    if (arrayBuffer.byteLength < 5 + mp4Len) return;

    const mp4Data = arrayBuffer.slice(5, 5 + mp4Len);
    if (pendingTurnReset) {
      preparePipelineForNewTurn();
      pendingTurnReset = false;
    }
    const accepted = enqueueMseChunk(mp4Data);
    if (accepted) {
      armFirstFrameReveal();
    }
  }
}

buildMsePipeline();
startMseHealthMonitor();

if (activeVideo) {
  activeVideo.addEventListener('ended', () => {
    firstFrameRevealArmed = false;
    clearFirstFrameRevealWatchers();
    showDefaultAvatar();
  });
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

  if (data instanceof ArrayBuffer) {
    handleMediaFrame(data);
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
      if (payload.status === 'SPEAKING') {
        acceptIncomingMedia = true;
      } else if (payload.status === 'LISTENING' || payload.status === 'READY') {
        showDefaultAvatar();
      }
      break;

    case 'user_transcription':
      handleUserTranscription(payload);
      break;

    case 'stop_audio':
      if (payload && payload.message === 'interrupt') {
        hardResetVideoState();
      } else {
        resetVideoState();
      }
      updateCircleState("LISTENING");
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

loadingConfirmBtn.addEventListener("click", () => {
  loadingOverlay.classList.add("hidden");
  updateCircleState("READY");
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
    acceptIncomingMedia = false;
    updateCircleState("LISTENING");

    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });

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
    silentGain = audioContext.createGain();
    silentGain.gain.value = 0;
    source.connect(analyser);
    source.connect(processor);
    processor.connect(silentGain);
    silentGain.connect(audioContext.destination);

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

  hardResetVideoState();

  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ event: 'duplex_stop' }));
  }

  cancelAnimationFrame(animationId);
  if (stream) stream.getTracks().forEach(t => t.stop());
  if (processor) processor.disconnect();
  if (silentGain) silentGain.disconnect();
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
