# AWS Nova Sonic Voice Agent (Local Web App)

This project runs a browser voice app with two runtime modes:
- **Nova Sonic tab**: realtime Nova Sonic bidirectional voice streaming.
- **Modular Stack tab**: browser speech recognition -> Bedrock reasoning model -> Amazon Polly TTS.

## Prerequisites

- Node.js 18+
- AWS credentials configured on your machine (for example via `aws configure`)
- Access to Amazon Bedrock and Nova Sonic in your AWS account/region

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create `.env`:

   ```bash
   copy .env.example .env
   ```

3. Update `.env` as needed (region/model/port), including:
   - `NOVA_SONIC_MODEL_ID` (realtime tab)
   - `MODULAR_REASON_MODEL_ID` (modular reasoning tab, e.g. `deepseek.v3.2`)
   To enable CloudWatch app logs, add:
   - `CW_LOG_ENABLED=true`
   - `CW_LOG_GROUP=/voice-agent/app`
   - `CW_LOG_STREAM_PREFIX=local-`

4. Start server:

   ```bash
   npm start
   ```

5. Open:

   `http://localhost:3000`

6. Click **Start**, allow mic permission, and speak.

## Notes

- In Nova tab, browser mic audio streams to Bedrock Nova Sonic in realtime.
- In Modular tab, browser sends transcribed text, backend calls Bedrock reasoning then Polly speech synthesis.
- AWS credentials stay on your local server, not in browser code.

## Deploy on Render (Free Tier)

This repo includes `render.yaml` so you can deploy as a Render Web Service quickly.

1. Push this project to GitHub.
2. In Render, click **New +** -> **Blueprint**.
3. Select your GitHub repo and deploy.
4. In Render service environment variables, set:
   - `AWS_REGION=ap-northeast-1`
   - `NOVA_SONIC_MODEL_ID=amazon.nova-2-sonic-v1:0`
   - `MODULAR_REASON_MODEL_ID=deepseek.v3-v1:0`
   - `CW_LOG_ENABLED=false` (or `true` if you want app logs in CloudWatch)
   - `CW_LOG_GROUP=/voice-agent/app`
   - `CW_LOG_STREAM_PREFIX=render-`
   - `AWS_ACCESS_KEY_ID=<your-key>`
   - `AWS_SECRET_ACCESS_KEY=<your-secret>`
   - `AWS_SESSION_TOKEN=<optional>`
5. Redeploy (or wait for auto-deploy).
6. Verify health endpoint:
   - `https://<your-render-service>.onrender.com/healthz`
7. Use this in Lovable for Nova Sonic:
   - `wss://<your-render-service>.onrender.com/ws`

Notes for free tier:
- Render free services can sleep when idle, so first response after idle can be slower.
- WebSocket path must be `/ws`.
