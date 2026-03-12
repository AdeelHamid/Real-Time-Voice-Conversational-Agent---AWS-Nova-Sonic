const path = require("path");
const http = require("http");
const os = require("os");
const express = require("express");
const WebSocket = require("ws");
const { v4: uuidv4 } = require("uuid");
const {
  BedrockRuntimeClient,
  InvokeModelWithBidirectionalStreamCommand,
  ConverseCommand
} = require("@aws-sdk/client-bedrock-runtime");
const {
  CloudWatchLogsClient,
  CreateLogGroupCommand,
  CreateLogStreamCommand,
  PutLogEventsCommand
} = require("@aws-sdk/client-cloudwatch-logs");
const { PollyClient, SynthesizeSpeechCommand } = require("@aws-sdk/client-polly");
require("dotenv").config();

const PORT = Number(process.env.PORT || 3000);
const AWS_REGION = process.env.AWS_REGION || "us-east-1";
const MODEL_ID = process.env.NOVA_SONIC_MODEL_ID || "amazon.nova-sonic-v1:0";
const MODULAR_REASON_MODEL_ID = process.env.MODULAR_REASON_MODEL_ID || "deepseek.v3.2";
const SUPPORTED_VOICES = new Set(["matthew", "amy", "joanna", "ivy", "kimberly"]);
const CW_LOG_ENABLED = String(process.env.CW_LOG_ENABLED || "false").toLowerCase() === "true";
const CW_LOG_GROUP = process.env.CW_LOG_GROUP || "/voice-agent/app";
const CW_LOG_STREAM_PREFIX = process.env.CW_LOG_STREAM_PREFIX || `${os.hostname()}-`;

class AppLogger {
  constructor() {
    this.cloudWatchEnabled = CW_LOG_ENABLED;
    this.logGroup = CW_LOG_GROUP;
    this.logStream = `${CW_LOG_STREAM_PREFIX}${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
    this.initPromise = null;
    this.queue = Promise.resolve();
    this.client = this.cloudWatchEnabled ? new CloudWatchLogsClient({ region: AWS_REGION }) : null;
  }

  enqueue(type, data = {}) {
    const entry = {
      ts: new Date().toISOString(),
      type,
      region: AWS_REGION,
      modelId: MODEL_ID,
      ...data
    };
    console.log(`[app-log] ${JSON.stringify(entry)}`);

    if (!this.cloudWatchEnabled) {
      return;
    }
    this.queue = this.queue
      .then(() => this.put(entry))
      .catch((error) => {
        console.error(`[app-log] cloudwatch write failed: ${error.message}`);
      });
  }

  async init() {
    if (!this.cloudWatchEnabled) {
      return;
    }
    if (this.initPromise) {
      return this.initPromise;
    }
    this.initPromise = (async () => {
      try {
        await this.client.send(new CreateLogGroupCommand({ logGroupName: this.logGroup }));
      } catch (error) {
        if (error.name !== "ResourceAlreadyExistsException") {
          throw error;
        }
      }
      try {
        await this.client.send(
          new CreateLogStreamCommand({
            logGroupName: this.logGroup,
            logStreamName: this.logStream
          })
        );
      } catch (error) {
        if (error.name !== "ResourceAlreadyExistsException") {
          throw error;
        }
      }
    })();
    return this.initPromise;
  }

  async put(entry) {
    await this.init();
    await this.client.send(
      new PutLogEventsCommand({
        logGroupName: this.logGroup,
        logStreamName: this.logStream,
        logEvents: [
          {
            timestamp: Date.now(),
            message: JSON.stringify(entry)
          }
        ]
      })
    );
  }
}

const appLogger = new AppLogger();
const reasoningClient = new BedrockRuntimeClient({ region: AWS_REGION });
const pollyClient = new PollyClient({ region: AWS_REGION });

function mapVoiceToPolly(voiceId) {
  const map = {
    matthew: "Matthew",
    amy: "Amy",
    joanna: "Joanna",
    ivy: "Ivy",
    kimberly: "Kimberly"
  };
  return map[voiceId] || "Matthew";
}

async function streamToBuffer(stream) {
  if (!stream) {
    return Buffer.alloc(0);
  }
  if (Buffer.isBuffer(stream)) {
    return stream;
  }
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function extractConverseText(response) {
  const content = response?.output?.message?.content || [];
  const textPart = content.find((c) => typeof c.text === "string");
  return textPart?.text || "";
}

async function runModularTurn({
  turnId,
  systemPrompt,
  voiceId,
  userText
}) {
  appLogger.enqueue("modular_turn_start", {
    turnId,
    reasonModelId: MODULAR_REASON_MODEL_ID,
    reasonProvider: "aws-bedrock",
    ttsEngine: "amazon-polly",
    voiceId
  });

  const reasonResponse = await reasoningClient.send(
    new ConverseCommand({
      modelId: MODULAR_REASON_MODEL_ID,
      system: [{ text: systemPrompt }],
      messages: [
        {
          role: "user",
          content: [{ text: userText }]
        }
      ],
      inferenceConfig: {
        maxTokens: 512,
        temperature: 0.7,
        topP: 0.9
      }
    })
  );

  const assistantTextRaw = extractConverseText(reasonResponse);
  const assistantText = (assistantTextRaw || "I did not get enough context. Please try again.").trim();
  const pollyText = assistantText.slice(0, 2900);

  const pollyResponse = await pollyClient.send(
    new SynthesizeSpeechCommand({
      Engine: "neural",
      OutputFormat: "pcm",
      SampleRate: "16000",
      Text: pollyText,
      VoiceId: mapVoiceToPolly(voiceId),
      TextType: "text"
    })
  );
  const audioBuffer = await streamToBuffer(pollyResponse.AudioStream);

  appLogger.enqueue("modular_turn_complete", {
    turnId,
    reasonModelId: MODULAR_REASON_MODEL_ID,
    ttsEngine: "amazon-polly",
    voiceId
  });

  return {
    assistantText,
    audioBase64: audioBuffer.toString("base64"),
    sampleRate: 16000
  };
}

class AsyncEventQueue {
  constructor() {
    this.queue = [];
    this.waiters = [];
    this.closed = false;
  }

  push(item) {
    if (this.closed) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: item, done: false });
      return;
    }
    this.queue.push(item);
  }

  close() {
    this.closed = true;
    while (this.waiters.length) {
      const waiter = this.waiters.shift();
      waiter({ value: undefined, done: true });
    }
  }

  next() {
    if (this.queue.length > 0) {
      return Promise.resolve({ value: this.queue.shift(), done: false });
    }
    if (this.closed) {
      return Promise.resolve({ value: undefined, done: true });
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  [Symbol.asyncIterator]() {
    return {
      next: () => this.next()
    };
  }
}

class NovaSonicSession {
  constructor(ws, streamEpoch) {
    this.ws = ws;
    this.streamEpoch = streamEpoch;
    this.sessionId = uuidv4();
    this.promptName = "voicePrompt";
    this.contentName = "voiceContent";
    this.queue = new AsyncEventQueue();
    this.started = false;
    this.closed = false;
    this.client = new BedrockRuntimeClient({ region: AWS_REGION });
    this.streamPromise = null;
  }

  sendToBrowser(payload) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ ...payload, streamEpoch: this.streamEpoch }));
    }
  }

  enqueueEvent(eventObj) {
    const bodyBytes = Buffer.from(JSON.stringify(eventObj), "utf8");
    this.queue.push({
      chunk: {
        bytes: bodyBytes
      }
    });
  }

  async start(systemPrompt, voiceId = "matthew", profile = "nova") {
    if (this.started) {
      return;
    }
    this.started = true;

    this.enqueueEvent({
      event: {
        sessionStart: {
          inferenceConfiguration: {
            maxTokens: 1024,
            topP: 0.9,
            temperature: 0.7
          }
        }
      }
    });

    this.enqueueEvent({
      event: {
        promptStart: {
          promptName: this.promptName,
          textOutputConfiguration: {
            mediaType: "text/plain"
          },
          audioOutputConfiguration: {
            mediaType: "audio/lpcm",
            sampleRateHertz: 24000,
            sampleSizeBits: 16,
            channelCount: 1,
            voiceId,
            encoding: "base64",
            audioType: "SPEECH"
          }
        }
      }
    });

    if (systemPrompt && systemPrompt.trim()) {
      this.enqueueEvent({
        event: {
          contentStart: {
            promptName: this.promptName,
            contentName: "systemInstructions",
            type: "TEXT",
            interactive: false,
            role: "SYSTEM",
            textInputConfiguration: {
              mediaType: "text/plain"
            }
          }
        }
      });
      this.enqueueEvent({
        event: {
          textInput: {
            promptName: this.promptName,
            contentName: "systemInstructions",
            content: systemPrompt
          }
        }
      });
      this.enqueueEvent({
        event: {
          contentEnd: {
            promptName: this.promptName,
            contentName: "systemInstructions"
          }
        }
      });
    }

    this.enqueueEvent({
      event: {
        contentStart: {
          promptName: this.promptName,
          contentName: this.contentName,
          type: "AUDIO",
          interactive: true,
          role: "USER",
          audioInputConfiguration: {
            mediaType: "audio/lpcm",
            sampleRateHertz: 16000,
            sampleSizeBits: 16,
            channelCount: 1,
            audioType: "SPEECH",
            encoding: "base64"
          }
        }
      }
    });

    appLogger.enqueue("session_start", {
      sessionId: this.sessionId,
      streamEpoch: this.streamEpoch,
      voiceId,
      profile,
      ttsEngine: "nova-sonic-integrated"
    });

    this.streamPromise = this.runStream();
  }

  addAudioChunk(base64Audio) {
    if (this.closed || !this.started) {
      return;
    }
    this.enqueueEvent({
      event: {
        audioInput: {
          promptName: this.promptName,
          contentName: this.contentName,
          content: base64Audio
        }
      }
    });
  }

  async stop() {
    if (this.closed) {
      return;
    }
    this.closed = true;

    if (this.started) {
      this.enqueueEvent({
        event: {
          contentEnd: {
            promptName: this.promptName,
            contentName: this.contentName
          }
        }
      });
      this.enqueueEvent({
        event: {
          promptEnd: {
            promptName: this.promptName
          }
        }
      });
      this.enqueueEvent({
        event: {
          sessionEnd: {}
        }
      });
    }
    this.queue.close();

    appLogger.enqueue("session_stop", {
      sessionId: this.sessionId,
      streamEpoch: this.streamEpoch
    });

    if (this.streamPromise) {
      try {
        await this.streamPromise;
      } catch {
        // Already reported to browser.
      }
    }
  }

  async runStream() {
    this.sendToBrowser({ type: "status", message: "Connecting to Amazon Nova Sonic..." });

    const command = new InvokeModelWithBidirectionalStreamCommand({
      modelId: MODEL_ID,
      body: this.queue
    });

    let response;
    try {
      response = await this.client.send(command);
    } catch (error) {
      appLogger.enqueue("stream_open_error", {
        sessionId: this.sessionId,
        streamEpoch: this.streamEpoch,
        error: error.message
      });
      this.sendToBrowser({
        type: "error",
        message: `Could not start bidirectional stream: ${error.message}`
      });
      throw error;
    }

    this.sendToBrowser({ type: "status", message: "Connected. Speak now." });

    try {
      for await (const streamEvent of response.body) {
        if (this.closed) {
          break;
        }
        if (!streamEvent.chunk?.bytes) {
          continue;
        }
        const jsonText = Buffer.from(streamEvent.chunk.bytes).toString("utf8");
        let parsed;
        try {
          parsed = JSON.parse(jsonText);
        } catch {
          continue;
        }

        const event = parsed.event || {};
        if (event.textOutput?.content) {
          this.sendToBrowser({
            type: "assistant_text",
            text: event.textOutput.content
          });
        }
        if (event.audioOutput?.content) {
          this.sendToBrowser({
            type: "assistant_audio",
            audio: event.audioOutput.content
          });
        }
        if (event.completionEnd) {
          appLogger.enqueue("completion_end", {
            sessionId: this.sessionId,
            streamEpoch: this.streamEpoch
          });
          this.sendToBrowser({ type: "status", message: "Response complete." });
        }
      }
    } catch (error) {
      if (!this.closed) {
        appLogger.enqueue("stream_runtime_error", {
          sessionId: this.sessionId,
          streamEpoch: this.streamEpoch,
          error: error.message
        });
        this.sendToBrowser({
          type: "error",
          message: `Realtime stream error: ${error.message}`
        });
      }
      throw error;
    }
  }
}

const app = express();
app.get("/healthz", (_req, res) => {
  res.status(200).json({ ok: true });
});
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/ws" });

function buildPipelineInfo(profile, voiceId, streamEpoch) {
  if (profile === "modular") {
    return {
      streamEpoch,
      profile,
      modelId: MODULAR_REASON_MODEL_ID,
      ttsEngine: "amazon-polly",
      voiceId
    };
  }
  return {
    streamEpoch,
    profile: "nova",
    modelId: MODEL_ID,
    ttsEngine: "nova-sonic-integrated",
    voiceId
  };
}

wss.on("connection", (ws) => {
  let streamEpoch = 1;
  let session = new NovaSonicSession(ws, streamEpoch);
  let activeSystemPrompt =
    "You are a concise, helpful real-time voice assistant. Keep answers clear and practical.";
  let activeVoiceId = "matthew";
  let activeProfile = "nova";
  let isStarted = false;
  let modularTurnCounter = 0;
  ws.send(JSON.stringify({ type: "status", message: "WebSocket connected." }));

  const newSession = () => {
    streamEpoch += 1;
    return new NovaSonicSession(ws, streamEpoch);
  };

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString("utf8"));
    } catch {
      ws.send(JSON.stringify({ type: "error", message: "Invalid message format." }));
      return;
    }

    if (msg.type === "start") {
      const incomingPrompt = typeof msg.systemPrompt === "string" ? msg.systemPrompt.trim() : "";
      activeSystemPrompt = incomingPrompt.length > 0 ? incomingPrompt : activeSystemPrompt;
      const incomingVoice = typeof msg.voiceId === "string" ? msg.voiceId.trim().toLowerCase() : "";
      if (SUPPORTED_VOICES.has(incomingVoice)) {
        activeVoiceId = incomingVoice;
      }
      const profile = typeof msg.profile === "string" ? msg.profile : "nova";
      activeProfile = profile === "modular" ? "modular" : "nova";
      if (activeProfile === "nova") {
        await session.start(activeSystemPrompt, activeVoiceId, activeProfile);
      }
      isStarted = true;
      appLogger.enqueue("start_request", {
        streamEpoch,
        voiceId: activeVoiceId,
        profile: activeProfile
      });
      if (activeProfile === "modular") {
        ws.send(JSON.stringify({ type: "status", message: "Modular stack ready. Speak now." }));
      }
      ws.send(
        JSON.stringify({
          type: "session_started",
          ...buildPipelineInfo(activeProfile, activeVoiceId, streamEpoch)
        })
      );
      return;
    }

    if (msg.type === "audio") {
      if (activeProfile !== "nova") {
        return;
      }
      session.addAudioChunk(msg.audio);
      return;
    }

    if (msg.type === "modular_user_text") {
      if (!isStarted || activeProfile !== "modular") {
        return;
      }
      const userText = typeof msg.text === "string" ? msg.text.trim() : "";
      if (!userText) {
        return;
      }
      modularTurnCounter += 1;
      const turnId = modularTurnCounter;

      try {
        const result = await runModularTurn({
          turnId,
          systemPrompt: activeSystemPrompt,
          voiceId: activeVoiceId,
          userText
        });
        if (turnId !== modularTurnCounter || ws.readyState !== WebSocket.OPEN) {
          return;
        }
        ws.send(
          JSON.stringify({
            type: "assistant_text",
            text: result.assistantText,
            streamEpoch
          })
        );
        ws.send(
          JSON.stringify({
            type: "assistant_audio",
            audio: result.audioBase64,
            sampleRate: result.sampleRate,
            streamEpoch
          })
        );
        ws.send(JSON.stringify({ type: "status", message: "Response complete." }));
      } catch (error) {
        appLogger.enqueue("modular_turn_error", {
          turnId,
          error: error.message,
          reasonModelId: MODULAR_REASON_MODEL_ID
        });
        ws.send(
          JSON.stringify({
            type: "error",
            message: `Modular pipeline error: ${error.message}`
          })
        );
      }
      return;
    }

    if (msg.type === "modular_interrupt") {
      if (!isStarted || activeProfile !== "modular") {
        return;
      }
      modularTurnCounter += 1;
      ws.send(JSON.stringify({ type: "status", message: "Interrupted. Listening..." }));
      appLogger.enqueue("modular_interrupt", { streamEpoch, voiceId: activeVoiceId });
      return;
    }

    if (msg.type === "stop") {
      await session.stop();
      session = newSession();
      isStarted = false;
      activeProfile = "nova";
      modularTurnCounter += 1;
      appLogger.enqueue("stop_request", { streamEpoch });
      ws.send(JSON.stringify({ type: "status", message: "Session reset. Press Start again." }));
      return;
    }

    if (msg.type === "interrupt") {
      if (activeProfile !== "nova") {
        return;
      }
      if (!isStarted) {
        return;
      }
      const incomingVoice = typeof msg.voiceId === "string" ? msg.voiceId.trim().toLowerCase() : "";
      if (SUPPORTED_VOICES.has(incomingVoice)) {
        activeVoiceId = incomingVoice;
      }
      await session.stop();
      session = newSession();
      await session.start(activeSystemPrompt, activeVoiceId, activeProfile);
      appLogger.enqueue("interrupt_request", {
        streamEpoch,
        voiceId: activeVoiceId,
        profile: activeProfile
      });
      ws.send(
        JSON.stringify({
          type: "session_started",
          ...buildPipelineInfo(activeProfile, activeVoiceId, streamEpoch)
        })
      );
      ws.send(JSON.stringify({ type: "status", message: "Interrupted. Listening..." }));
      return;
    }

    if (msg.type === "set_voice") {
      const incomingVoice = typeof msg.voiceId === "string" ? msg.voiceId.trim().toLowerCase() : "";
      if (!SUPPORTED_VOICES.has(incomingVoice)) {
        ws.send(JSON.stringify({ type: "error", message: `Unsupported voiceId: ${incomingVoice}` }));
        return;
      }
      activeVoiceId = incomingVoice;
      if (!isStarted || activeProfile === "modular") {
        ws.send(JSON.stringify({ type: "status", message: `Voice set to ${activeVoiceId}.` }));
        return;
      }
      await session.stop();
      session = newSession();
      await session.start(activeSystemPrompt, activeVoiceId, activeProfile);
      appLogger.enqueue("voice_change", {
        streamEpoch,
        voiceId: activeVoiceId,
        profile: activeProfile
      });
      ws.send(
        JSON.stringify({
          type: "session_started",
          ...buildPipelineInfo(activeProfile, activeVoiceId, streamEpoch)
        })
      );
      ws.send(JSON.stringify({ type: "status", message: `Voice changed to ${activeVoiceId}.` }));
    }
  });

  ws.on("close", async () => {
    await session.stop();
  });
});

server.listen(PORT, () => {
  console.log(`Nova Sonic voice app is running on http://localhost:${PORT}`);
});
