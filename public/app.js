const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const voiceToggleBtn = document.getElementById("voiceToggleBtn");
const tabNovaBtn = document.getElementById("tabNova");
const tabModularBtn = document.getElementById("tabModular");
const experimentPanelEl = document.getElementById("experimentPanel");
const statusEl = document.getElementById("status");
const transcriptEl = document.getElementById("transcript");
const systemPromptEl = document.getElementById("systemPrompt");
const avatarPanelEl = document.getElementById("avatarPanel");
const avatarModeEl = document.getElementById("avatarMode");
const pipelineProfileEl = document.getElementById("pipelineProfile");
const pipelineModelEl = document.getElementById("pipelineModel");
const pipelineTtsEl = document.getElementById("pipelineTts");
const mNovaTurns = document.getElementById("mNovaTurns");
const mNovaFRT = document.getElementById("mNovaFRT");
const mNovaINT = document.getElementById("mNovaINT");
const mModTurns = document.getElementById("mModTurns");
const mModFRT = document.getElementById("mModFRT");
const mModINT = document.getElementById("mModINT");

let ws;
let audioCtx;
let mediaStream;
let scriptNode;
let recognition;
let recognitionShouldRestart = false;
let nextPlayTime = 0;
let assistantSources = new Set();
let suppressAssistantAudioUntil = 0;

const BARGE_IN_RMS_THRESHOLD = 0.03;
const BARGE_IN_SUPPRESS_MS = 1400;
const BARGE_IN_COOLDOWN_MS = 900;
const LISTENING_RMS_THRESHOLD = 0.02;
const BASE_SPEECH_RMS = 0.012;
const SPEECH_NOISE_MULTIPLIER = 2.4;
let lastBargeInAt = 0;
let conversationStarted = false;
let selectedVoice = "matthew";
let lastUserSpeechAt = 0;
let lastAssistantAudioAt = 0;
let currentStreamEpoch = 0;
let awaitingInterruptSession = false;
let noiseFloorRms = 0.004;
let speechFrameCount = 0;
let activeProfile = "nova";
let sessionProfile = "nova";
let turnStartAt = 0;
let firstResponseRecorded = false;
let interruptSentAt = 0;

const metrics = {
  nova: { turns: 0, firstResponseMs: [], interruptMs: [] },
  modular: { turns: 0, firstResponseMs: [], interruptMs: [] }
};

const CLIENT_PIPELINE_DEFAULTS = {
  nova: {
    profileLabel: "Nova Sonic",
    modelId: "amazon.nova-2-sonic-v1:0",
    ttsEngine: "nova-sonic-integrated"
  },
  modular: {
    profileLabel: "Modular Stack",
    modelId: "amazon.nova-lite-v1:0",
    ttsEngine: "amazon-polly"
  }
};

function setStatus(msg) {
  statusEl.textContent = msg;
}

function appendTranscript(text) {
  transcriptEl.textContent += `${text}\n`;
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function setPipelineBadge({ profile, modelId, ttsEngine }) {
  const defaults = CLIENT_PIPELINE_DEFAULTS[profile === "modular" ? "modular" : "nova"];
  const profileLabel = profile === "modular" ? "Modular Stack" : "Nova Sonic";
  pipelineProfileEl.textContent = `Pipeline: ${profileLabel}`;
  pipelineModelEl.textContent = `Model: ${modelId || defaults.modelId}`;
  pipelineTtsEl.textContent = `TTS: ${ttsEngine || defaults.ttsEngine}`;
}

function avg(values) {
  if (!values.length) {
    return null;
  }
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function fmtMs(v) {
  return v == null ? "-" : `${Math.round(v)} ms`;
}

function updateMetricsUI() {
  mNovaTurns.textContent = String(metrics.nova.turns);
  mNovaFRT.textContent = fmtMs(avg(metrics.nova.firstResponseMs));
  mNovaINT.textContent = fmtMs(avg(metrics.nova.interruptMs));
  mModTurns.textContent = String(metrics.modular.turns);
  mModFRT.textContent = fmtMs(avg(metrics.modular.firstResponseMs));
  mModINT.textContent = fmtMs(avg(metrics.modular.interruptMs));
}

function setActiveTab(profile) {
  activeProfile = profile;
  tabNovaBtn.classList.toggle("is-active", profile === "nova");
  tabModularBtn.classList.toggle("is-active", profile === "modular");
  experimentPanelEl.classList.toggle("hidden", profile !== "modular");
  setStatus(profile === "modular" ? "Modular stack mode selected." : "Nova Sonic mode selected.");
  setPipelineBadge({ profile });
}

function setAvatarMode(mode) {
  if (!avatarPanelEl || !avatarModeEl) {
    return;
  }
  avatarPanelEl.dataset.mode = mode;
  avatarModeEl.textContent = mode === "speaking" ? "Speaking" : mode === "listening" ? "Listening" : "Idle";
}

function floatTo16BitPCM(float32Array) {
  const output = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i += 1) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    output[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return output;
}

function int16ToBase64(int16Array) {
  const bytes = new Uint8Array(int16Array.buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToInt16Array(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Int16Array(bytes.buffer);
}

function rmsLevel(float32Array) {
  let sumSquares = 0;
  for (let i = 0; i < float32Array.length; i += 1) {
    sumSquares += float32Array[i] * float32Array[i];
  }
  return Math.sqrt(sumSquares / float32Array.length);
}

function interruptAssistantPlayback() {
  if (!audioCtx) {
    return;
  }
  for (const src of assistantSources) {
    try {
      src.stop();
    } catch {
      // Ignore already-ended nodes.
    }
  }
  assistantSources.clear();
  nextPlayTime = audioCtx.currentTime;
  suppressAssistantAudioUntil = Date.now() + BARGE_IN_SUPPRESS_MS;
  setStatus("You interrupted. Listening...");

  if (ws && ws.readyState === WebSocket.OPEN) {
    const now = Date.now();
    if (now - lastBargeInAt > BARGE_IN_COOLDOWN_MS && !awaitingInterruptSession) {
      if (sessionProfile === "modular") {
        ws.send(JSON.stringify({ type: "modular_interrupt", voiceId: selectedVoice, profile: activeProfile }));
      } else {
        ws.send(JSON.stringify({ type: "interrupt", voiceId: selectedVoice, profile: activeProfile }));
      }
      lastBargeInAt = now;
      if (sessionProfile !== "modular") {
        awaitingInterruptSession = true;
      }
      interruptSentAt = now;
    }
  }
}

function updateVoiceButton() {
  voiceToggleBtn.textContent = selectedVoice === "matthew" ? "Voice: Male" : "Voice: Female";
}

function playPcm16(base64Audio, sampleRate = 24000) {
  if (!audioCtx) {
    return;
  }
  if (Date.now() < suppressAssistantAudioUntil) {
    return;
  }
  const pcm = base64ToInt16Array(base64Audio);
  const floatData = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i += 1) {
    floatData[i] = pcm[i] / 32768;
  }

  const buffer = audioCtx.createBuffer(1, floatData.length, sampleRate);
  buffer.copyToChannel(floatData, 0);

  const source = audioCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(audioCtx.destination);
  assistantSources.add(source);
  source.onended = () => {
    assistantSources.delete(source);
  };

  const now = audioCtx.currentTime;
  if (nextPlayTime < now) {
    nextPlayTime = now;
  }
  source.start(nextPlayTime);
  nextPlayTime += buffer.duration;
  lastAssistantAudioAt = Date.now();
}

async function startCapture(profile) {
  audioCtx = new AudioContext({ sampleRate: 16000 });
  await audioCtx.resume();

  if (profile === "modular") {
    return;
  }

  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      sampleRate: 16000,
      echoCancellation: true,
      noiseSuppression: true
    }
  });

  const source = audioCtx.createMediaStreamSource(mediaStream);
  scriptNode = audioCtx.createScriptProcessor(2048, 1, 1);

  scriptNode.onaudioprocess = (event) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }
    const input = event.inputBuffer.getChannelData(0);
    const rms = rmsLevel(input);
    const assistantIsSpeaking =
      (audioCtx && nextPlayTime > audioCtx.currentTime + 0.05) || assistantSources.size > 0;
    const dynamicSpeechThreshold = Math.max(BASE_SPEECH_RMS, noiseFloorRms * SPEECH_NOISE_MULTIPLIER);
    const speechDetected = rms > dynamicSpeechThreshold;
    if (!assistantIsSpeaking) {
      noiseFloorRms = noiseFloorRms * 0.92 + rms * 0.08;
    }
    if (rms > LISTENING_RMS_THRESHOLD) {
      lastUserSpeechAt = Date.now();
    }
    if (speechDetected) {
      speechFrameCount += 1;
    } else {
      speechFrameCount = Math.max(0, speechFrameCount - 1);
    }

    const bargeInDetected = speechFrameCount >= 2 && rms > Math.min(BARGE_IN_RMS_THRESHOLD, dynamicSpeechThreshold + 0.006);
    if (conversationStarted && assistantIsSpeaking && bargeInDetected) {
      interruptAssistantPlayback();
      speechFrameCount = 0;
    }
    const int16 = floatTo16BitPCM(input);
    ws.send(
      JSON.stringify({
        type: "audio",
        audio: int16ToBase64(int16)
      })
    );
  };

  source.connect(scriptNode);
  scriptNode.connect(audioCtx.destination);
}

function startModularRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    throw new Error("SpeechRecognition is not supported in this browser. Use Chrome/Edge.");
  }

  recognitionShouldRestart = true;
  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = "en-US";

  recognition.onresult = (event) => {
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      const text = (result[0]?.transcript || "").trim();
      if (!text) {
        continue;
      }

      lastUserSpeechAt = Date.now();
      const assistantIsSpeaking =
        (audioCtx && nextPlayTime > audioCtx.currentTime + 0.05) || assistantSources.size > 0;
      if (assistantIsSpeaking) {
        interruptAssistantPlayback();
      }

      if (!result.isFinal) {
        continue;
      }

      appendTranscript(`You: ${text}`);
      turnStartAt = Date.now();
      firstResponseRecorded = false;
      metrics[sessionProfile].turns += 1;
      updateMetricsUI();

      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: "modular_user_text",
            text,
            profile: activeProfile
          })
        );
      }
    }
  };

  recognition.onerror = (event) => {
    setStatus(`Speech recognition error: ${event.error}`);
  };

  recognition.onend = () => {
    if (conversationStarted && sessionProfile === "modular" && recognitionShouldRestart) {
      try {
        recognition.start();
      } catch {
        // Ignore rapid restart issues from browser speech APIs.
      }
    }
  };

  recognition.start();
}

function stopCapture() {
  recognitionShouldRestart = false;
  if (recognition) {
    try {
      recognition.stop();
    } catch {
      // Ignore cleanup errors.
    }
    recognition = null;
  }
  if (scriptNode) {
    scriptNode.disconnect();
    scriptNode.onaudioprocess = null;
    scriptNode = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
  if (audioCtx) {
    audioCtx.close();
    audioCtx = null;
  }
  assistantSources.clear();
  suppressAssistantAudioUntil = 0;
  lastBargeInAt = 0;
  conversationStarted = false;
  lastUserSpeechAt = 0;
  lastAssistantAudioAt = 0;
  currentStreamEpoch = 0;
  awaitingInterruptSession = false;
  noiseFloorRms = 0.004;
  speechFrameCount = 0;
  nextPlayTime = 0;
  setAvatarMode("idle");
}

function openSocket() {
  return new Promise((resolve, reject) => {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${protocol}//${location.host}/ws`);

    ws.onopen = () => resolve();
    ws.onerror = (err) => reject(err);
    ws.onclose = () => {
      conversationStarted = false;
      currentStreamEpoch = 0;
      awaitingInterruptSession = false;
      setAvatarMode("idle");
    };
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === "status") {
        setStatus(msg.message);
      } else if (msg.type === "session_started") {
        currentStreamEpoch = msg.streamEpoch || currentStreamEpoch;
        setPipelineBadge({
          profile: msg.profile || sessionProfile,
          modelId: msg.modelId,
          ttsEngine: msg.ttsEngine
        });
        awaitingInterruptSession = false;
        if (interruptSentAt > 0) {
          metrics[sessionProfile].interruptMs.push(Date.now() - interruptSentAt);
          interruptSentAt = 0;
          updateMetricsUI();
        }
        suppressAssistantAudioUntil = Date.now() + 120;
      } else if (msg.type === "assistant_text") {
        if (msg.streamEpoch && currentStreamEpoch && msg.streamEpoch !== currentStreamEpoch) {
          return;
        }
        if (!firstResponseRecorded && turnStartAt > 0) {
          metrics[sessionProfile].firstResponseMs.push(Date.now() - turnStartAt);
          firstResponseRecorded = true;
          updateMetricsUI();
        }
        appendTranscript(`Assistant: ${msg.text}`);
      } else if (msg.type === "assistant_audio") {
        if (msg.streamEpoch && currentStreamEpoch && msg.streamEpoch !== currentStreamEpoch) {
          return;
        }
        if (!firstResponseRecorded && turnStartAt > 0) {
          metrics[sessionProfile].firstResponseMs.push(Date.now() - turnStartAt);
          firstResponseRecorded = true;
          updateMetricsUI();
        }
        playPcm16(msg.audio, msg.sampleRate || 24000);
      } else if (msg.type === "error") {
        awaitingInterruptSession = false;
        setStatus(`Error: ${msg.message}`);
      }
    };
  });
}

startBtn.addEventListener("click", async () => {
  try {
    transcriptEl.textContent = "";
    setStatus(activeProfile === "modular" ? "Starting modular speech recognition..." : "Requesting microphone...");
    await openSocket();
    await startCapture(activeProfile);
    ws.send(
      JSON.stringify({
        type: "start",
        systemPrompt: systemPromptEl.value,
        voiceId: selectedVoice,
        profile: activeProfile
      })
    );
    sessionProfile = activeProfile;
    if (sessionProfile === "modular") {
      startModularRecognition();
    } else {
      turnStartAt = Date.now();
      firstResponseRecorded = false;
      metrics[sessionProfile].turns += 1;
      updateMetricsUI();
    }
    conversationStarted = true;
    setAvatarMode("listening");
    startBtn.disabled = true;
    stopBtn.disabled = false;
  } catch (error) {
    setStatus(`Failed to start: ${error.message || error}`);
  }
});

stopBtn.addEventListener("click", () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "stop" }));
    ws.close();
  }
  stopCapture();
  conversationStarted = false;
  awaitingInterruptSession = false;
  interruptSentAt = 0;
  startBtn.disabled = false;
  stopBtn.disabled = true;
  setStatus("Stopped.");
  setAvatarMode("idle");
});

voiceToggleBtn.addEventListener("click", () => {
  selectedVoice = selectedVoice === "matthew" ? "amy" : "matthew";
  updateVoiceButton();

  if (ws && ws.readyState === WebSocket.OPEN && conversationStarted) {
    ws.send(
      JSON.stringify({
        type: "set_voice",
        voiceId: selectedVoice,
        profile: activeProfile
      })
    );
    setStatus(`Voice changed to ${selectedVoice === "matthew" ? "Male" : "Female"}.`);
  }
});

updateVoiceButton();
setAvatarMode("idle");
updateMetricsUI();
setActiveTab("nova");

tabNovaBtn.addEventListener("click", () => setActiveTab("nova"));
tabModularBtn.addEventListener("click", () => setActiveTab("modular"));

setInterval(() => {
  if (!conversationStarted) {
    setAvatarMode("idle");
    return;
  }

  const now = Date.now();
  if (now - lastUserSpeechAt < 300) {
    setAvatarMode("listening");
    return;
  }
  if (assistantSources.size > 0 || now - lastAssistantAudioAt < 350) {
    setAvatarMode("speaking");
    return;
  }
  setAvatarMode("idle");
}, 120);
