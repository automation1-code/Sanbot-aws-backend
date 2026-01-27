# SanBot Voice Agent — Backend

Backend for the SanBot Voice Agent Android app. Consists of two servers:

1. **Node.js (Express)** — HTTP gateway for OpenAI token generation, avatar session management, and orchestration control
2. **Python (LiveKit Agent)** — AI agent worker with OpenAI Realtime plugin, CRM function tools, and robot control (only needed for Orchestrated mode)

---

## Setup

### 1. Environment Variables

```bash
cp .env.example .env
```

Edit `.env` with your keys:

```env
# Required
OPENAI_API_KEY=sk-proj-...
PORT=3051

# LiveAvatar (optional — for audio-based avatar)
LIVEAVATAR_API_KEY=your-liveavatar-api-key
LIVEAVATAR_DEFAULT_AVATAR_ID=your-avatar-id


# LiveKit (required for Orchestrated mode)
LIVEKIT_URL=wss://your-livekit-instance.livekit.cloud
LIVEKIT_API_KEY=your-livekit-api-key
LIVEKIT_API_SECRET=your-livekit-api-secret
```

---

## Running the Servers

### Option A: Docker Compose (recommended)

Starts both servers in containers:

```bash
docker compose up --build
```

This launches:
- **backend** (Node.js) on port `3051`
- **agent** (Python) as a worker process (no exposed ports — connects outbound to LiveKit Cloud)

To run in the background:

```bash
docker compose up --build -d
```

To stop:

```bash
docker compose down
```

### Option B: Run Manually

#### Node.js Server

Requires Node.js 18+.

```bash
npm install
npm start
```

The server starts on `http://localhost:3051` (or the port set in `.env`).

For development with auto-reload:

```bash
npm run dev
```

#### Python Agent (Orchestrated mode only)

Requires Python 3.11+. The Python agent is only needed if you use **Orchestrated mode** (single LiveKit room with OpenAI Agent).

```bash
cd agent
pip install -r requirements.txt
python agent.py start
```

Or using a virtual environment:

```bash
cd agent
python -m venv venv
source venv/bin/activate        # Linux/macOS
# venv\Scripts\activate         # Windows
pip install -r requirements.txt
python agent.py start
```

The agent connects outbound to LiveKit Cloud and auto-dispatches to rooms — no ports need to be exposed.

---

## API Endpoints

### Token Management

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/token` | GET | Get a cached OpenAI ephemeral token for WebRTC |

### LiveAvatar (audio-based avatar)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/liveavatar/session/token` | POST | Create a LiveAvatar session, returns connection info |
| `/liveavatar/speak` | POST | Send audio/text to avatar for lip-sync |
| `/liveavatar/interrupt` | POST | Interrupt current avatar speech |
| `/liveavatar/status` | GET | Get LiveAvatar session status |

### HeyGen (text-based avatar)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/heygen/session` | POST | Create a HeyGen streaming session |
| `/heygen/stream` | POST | Send text to HeyGen avatar |
| `/heygen/interrupt` | POST | Interrupt avatar speech |
| `/heygen/stop` | POST | Stop HeyGen session |
| `/heygen/stats` | GET | Get HeyGen session statistics |

### Orchestrated Mode

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/orchestrated/session/start` | POST | Start orchestrated session (LiveKit room + agent) |
| `/orchestrated/session/stop` | POST | Stop orchestrated session |
| `/orchestrated/status` | GET | Get orchestration status |

---

## Python Agent Details

The Python agent (`agent/agent.py`) runs as a LiveKit Agents worker using the OpenAI Realtime plugin. It acts as "Tara", a sales agent for the Trip & Event travel platform.

### Agent Function Tools

| Function | Description |
|----------|-------------|
| `find_packages()` | Search travel packages by destination |
| `save_customer_lead()` | Save customer name, email, phone to CRM |
| `create_quote()` | Generate and save a price quote |
| `robot_action()` | Control Sanbot robot gestures (wave, nod, greet, thinking, excited, goodbye) |

### CRM Integration

The agent authenticates with the Trip & Event CRM API (`crm.tripandevent.com`) using email/password credentials from the environment. The auth token is cached and reused for subsequent API calls.

### Configuration

Agent behavior is configured via constants in `agent.py`:

- **Voice**: `marin` (OpenAI voice)
- **Turn Detection**: Semantic VAD
- **Audio**: PCM 16-bit mono @ 24kHz
- **Output**: Audio only

---

## Architecture

```
Android App
    │
    ├──► GET /token ──────────────► Node.js Server
    │                                    │
    │                                    ├── Caches OpenAI ephemeral tokens
    │                                    ├── Manages LiveAvatar sessions
    │                                    ├── Manages HeyGen sessions
    │                                    └── Controls orchestrated sessions
    │
    ├──► WebRTC ──────────────────► OpenAI Realtime API
    │    (audio + data channel)
    │
    └──► LiveKit Room ────────────► Python Agent (Orchestrated mode)
         (when orchestrated)             │
                                         ├── OpenAI Realtime plugin
                                         ├── CRM API calls
                                         └── Robot gesture commands
```

### Token Caching

The Node.js server caches OpenAI ephemeral tokens and refreshes them 60 seconds before expiry. This reduces redundant API calls when multiple clients request tokens in quick succession.

---

## Docker Details

### Services (`docker-compose.yml`)

| Service | Image | Port | Purpose |
|---------|-------|------|---------|
| `backend` | `node:18-slim` | 3051 | HTTP API gateway |
| `agent` | `python:3.11-slim` | none | LiveKit agent worker |

Both services share the same `.env` file and auto-restart unless stopped.

### Building Individual Services

```bash
# Node.js server only
docker build -f Dockerfile.backend -t sanbot-backend .

# Python agent only
docker build -f agent/Dockerfile -t sanbot-agent agent/
```

### Running Individual Containers

```bash
# Node.js server
docker run -p 3051:3051 --env-file .env sanbot-backend

# Python agent
docker run --env-file .env sanbot-agent
```

---

## Dependencies

### Node.js (`package.json`)

| Package | Purpose |
|---------|---------|
| `express` | HTTP server framework |
| `cors` | Cross-origin request handling |
| `dotenv` | Environment variable loading |
| `livekit-server-sdk` | LiveKit token generation and room management |

### Python (`agent/requirements.txt`)

| Package | Purpose |
|---------|---------|
| `livekit-agents[openai,silero]` | LiveKit Agents framework with OpenAI Realtime + VAD |
| `livekit-api` | LiveKit server API (token generation) |
| `python-dotenv` | Environment variable loading |
| `httpx` | Async HTTP client for CRM API calls |
| `aiohttp` | Async WebSocket client for HeyGen audio forwarding |

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `OPENAI_API_KEY` not set | Ensure `.env` file exists and contains your API key |
| Port 3051 already in use | Change `PORT` in `.env` or stop the conflicting process |
| Python agent won't start | Ensure Python 3.11+, install `libsndfile1` on Linux (`apt install libsndfile1`) |
| LiveKit connection fails | Verify `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET` in `.env` |
| Docker build fails | Ensure Docker is installed and running, check network connectivity |
| Token endpoint returns error | Verify your OpenAI API key is valid and has Realtime API access |
