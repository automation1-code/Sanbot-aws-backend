import express from "express";
import cors from "cors";
import "dotenv/config";

// HeyGen integration
import HeyGenManager from "./heygen/HeyGenManager.js";
import sessionStore from "./heygen/SessionStore.js";

// LiveAvatar integration (Audio-based streaming for lowest latency)
import LiveAvatarManager from "./liveavatar/LiveAvatarManager.js";

// Orchestrated LiveKit mode (OpenAI Agent + HeyGen BYOLI in single room)
import LiveKitOrchestrator from "./orchestration/LiveKitOrchestrator.js";

const app = express();
app.use(cors());
app.use(express.text());
app.use(express.json()); // For HeyGen endpoints

// Debug middleware to log all incoming requests
app.use((req, res, next) => {
  console.log(`[DEBUG] ${req.method} ${req.path}`);
  next();
});
const port = process.env.PORT || 3000;
const apiKey = process.env.OPENAI_API_KEY;

// Initialize HeyGen manager (if API key is configured)
const heygenApiKey = process.env.HEYGEN_API_KEY;
const heygenDefaultAvatar = process.env.HEYGEN_DEFAULT_AVATAR_ID;
let heygenManager = null;

if (heygenApiKey) {
  heygenManager = new HeyGenManager(heygenApiKey, heygenDefaultAvatar);
  console.log("[HeyGen] Manager initialized");
} else {
  console.log("[HeyGen] API key not configured, HeyGen features disabled");
}

// Initialize LiveAvatar manager (if API key is configured)
const liveAvatarApiKey = process.env.LIVEAVATAR_API_KEY;
const liveAvatarDefaultAvatar = process.env.LIVEAVATAR_DEFAULT_AVATAR_ID;
let liveAvatarManager = null;

if (liveAvatarApiKey) {
  liveAvatarManager = new LiveAvatarManager(liveAvatarApiKey, liveAvatarDefaultAvatar);
  console.log("[LiveAvatar] Manager initialized");
} else {
  console.log("[LiveAvatar] API key not configured, LiveAvatar features disabled");
}

// Initialize LiveKit Orchestrator (for orchestrated mode)
// The Python agent (agent/agent.py) handles HeyGen/LiveAvatar via its plugin
const livekitUrl = process.env.LIVEKIT_URL;
const livekitApiKey = process.env.LIVEKIT_API_KEY;
const livekitApiSecret = process.env.LIVEKIT_API_SECRET;
let orchestrator = null;

if (livekitUrl && livekitApiKey && livekitApiSecret) {
  orchestrator = new LiveKitOrchestrator(livekitUrl, livekitApiKey, livekitApiSecret);
  console.log("[Orchestrator] LiveKit Orchestrator initialized");
} else {
  console.log("[Orchestrator] LiveKit credentials not configured, orchestrated mode disabled");
  if (!livekitUrl) console.log("[Orchestrator]   Missing: LIVEKIT_URL");
  if (!livekitApiKey) console.log("[Orchestrator]   Missing: LIVEKIT_API_KEY");
  if (!livekitApiSecret) console.log("[Orchestrator]   Missing: LIVEKIT_API_SECRET");
}

// OpenAI Realtime GA API session configuration
// Based on https://platform.openai.com/docs/guides/realtime-websocket
const sessionConfig = JSON.stringify({
  session: {
    type: "realtime",
    model: "gpt-4o-realtime-preview-2024-12-17",
    output_modalities: ["audio"],
    instructions: "You are a helpful voice assistant. Speak clearly and concisely.",
    audio: {
      input: {
        format: {
          type: "audio/pcm",
          rate: 24000,
        },
        turn_detection: {
          type: "semantic_vad",
        },
      },
      output: {
        format: {
          type: "audio/pcm",
          rate: 24000,
        },
        voice: process.env.OPENAI_VOICE || "marin",
      },
    },
  },
});

// ============================================
// LATENCY OPTIMIZATION: Token Caching
// ============================================
// Caches ephemeral tokens to avoid repeated OpenAI API calls
// Tokens are refreshed 60 seconds before expiry
let cachedToken = null;
let tokenExpiresAt = 0;
const TOKEN_REFRESH_MARGIN_MS = 60000;  // Refresh 1 min before expiry

// API route for ephemeral token generation (with caching)
app.get("/token", async (req, res) => {
  const now = Date.now();

  // Return cached token if still valid
  if (cachedToken && tokenExpiresAt > now + TOKEN_REFRESH_MARGIN_MS) {
    console.log("[Token] Returning cached token (expires in " +
      Math.round((tokenExpiresAt - now) / 1000) + "s)");
    return res.json({
      client_secret: {
        value: cachedToken,
        expires_at: Math.floor(tokenExpiresAt / 1000)
      }
    });
  }

  // Fetch new token from OpenAI
  try {
    console.log("[Token] Fetching new ephemeral token from OpenAI...");

    const response = await fetch(
      "https://api.openai.com/v1/realtime/client_secrets",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: sessionConfig,
      },
    );

    const data = await response.json();

    // Cache the token if response is valid
    if (data.client_secret && data.client_secret.value) {
      cachedToken = data.client_secret.value;
      tokenExpiresAt = data.client_secret.expires_at * 1000;  // Convert to ms
      console.log("[Token] New token cached, expires at " +
        new Date(tokenExpiresAt).toISOString());
    }

    res.json(data);
  } catch (error) {
    console.error("[Token] Generation error:", error);
    res.status(500).json({ error: "Failed to generate token" });
  }
});

// ============================================
// HEYGEN LIVEVATAAR ENDPOINTS
// ============================================

/**
 * Check if HeyGen is available
 */
function requireHeyGen(req, res, next) {
  if (!heygenManager) {
    return res.status(503).json({
      error: "HeyGen not configured",
      message: "Set HEYGEN_API_KEY environment variable to enable HeyGen features",
    });
  }
  next();
}

/**
 * Create a new HeyGen streaming session
 * POST /heygen/session
 * Body: { avatarId?: string, voiceId?: string, clientId: string }
 */
app.post("/heygen/session", (req, res, next) => {
  console.log("[DEBUG] /heygen/session route hit");
  next();
}, requireHeyGen, async (req, res) => {
  try {
    const { avatarId, voiceId, clientId } = req.body;

    if (!clientId) {
      return res.status(400).json({ error: "clientId is required" });
    }

    // Check if client already has an active session
    const existing = sessionStore.get(clientId);
    if (existing && existing.status === "active") {
      console.log(`[HeyGen] Client ${clientId} already has active session`);
      return res.json({
        success: true,
        sessionId: existing.sessionId,
        liveKitUrl: existing.liveKitUrl,
        liveKitToken: existing.liveKitToken,
        iceServers: existing.iceServers,
        existing: true,
      });
    }

    // Store session as "creating"
    sessionStore.set(clientId, {
      status: "creating",
      avatarId: avatarId || heygenDefaultAvatar,
    });

    // Create HeyGen session
    const sessionData = await heygenManager.createSession({
      avatarId: avatarId || heygenDefaultAvatar,
      voiceId,
    });

    // Start the session to get LiveKit connection info
    const startData = await heygenManager.startSession(sessionData.session_id);

    // Update session store with connection info
    sessionStore.set(clientId, {
      sessionId: sessionData.session_id,
      avatarId: avatarId || heygenDefaultAvatar,
      liveKitUrl: startData.url,
      liveKitToken: startData.access_token,
      iceServers: sessionData.ice_servers || [],
      status: "active",
    });

    console.log(`[HeyGen] Session created for client: ${clientId}`);

    res.json({
      success: true,
      sessionId: sessionData.session_id,
      liveKitUrl: startData.url,
      liveKitToken: startData.access_token,
      iceServers: sessionData.ice_servers || [],
    });
  } catch (error) {
    console.error("[HeyGen] Session creation failed:", error);

    // Clean up failed session
    if (req.body.clientId) {
      sessionStore.remove(req.body.clientId);
    }

    res.status(500).json({
      error: "Failed to create HeyGen session",
      message: error.message,
    });
  }
});

/**
 * Stream text to HeyGen avatar
 * POST /heygen/stream
 * Body: { sessionId: string, text: string, taskType?: "repeat" | "talk" }
 */
app.post("/heygen/stream", requireHeyGen, async (req, res) => {
  try {
    const { sessionId, text, taskType = "repeat" } = req.body;

    if (!sessionId) {
      return res.status(400).json({ error: "sessionId is required" });
    }

    if (!text || text.trim().length === 0) {
      return res.json({ success: true, taskId: null, skipped: true });
    }

    const result = await heygenManager.sendText({
      sessionId,
      text,
      taskType,
    });

    res.json({
      success: true,
      taskId: result.task_id,
    });
  } catch (error) {
    console.error("[HeyGen] Stream text failed:", error);
    res.status(500).json({
      error: "Failed to stream text to avatar",
      message: error.message,
    });
  }
});

/**
 * Interrupt avatar speech (for barge-in)
 * POST /heygen/interrupt
 * Body: { sessionId: string }
 */
app.post("/heygen/interrupt", requireHeyGen, async (req, res) => {
  try {
    const { sessionId } = req.body;

    if (!sessionId) {
      return res.status(400).json({ error: "sessionId is required" });
    }

    const result = await heygenManager.interrupt(sessionId);

    res.json({
      success: result.success,
      message: result.success ? "Avatar interrupted" : "Interrupt failed (avatar may not be speaking)",
    });
  } catch (error) {
    console.error("[HeyGen] Interrupt failed:", error);
    res.status(500).json({
      error: "Failed to interrupt avatar",
      message: error.message,
    });
  }
});

/**
 * Stop HeyGen session
 * POST /heygen/stop
 * Body: { sessionId: string, clientId?: string }
 */
app.post("/heygen/stop", requireHeyGen, async (req, res) => {
  try {
    const { sessionId, clientId } = req.body;

    if (!sessionId && !clientId) {
      return res.status(400).json({ error: "sessionId or clientId is required" });
    }

    let session = null;
    let actualSessionId = sessionId;

    // Find session by clientId if sessionId not provided
    if (clientId && !sessionId) {
      session = sessionStore.get(clientId);
      if (session) {
        actualSessionId = session.sessionId;
      }
    }

    if (!actualSessionId) {
      return res.json({ success: true, message: "No session to stop" });
    }

    // Update status to stopping
    if (clientId) {
      sessionStore.updateStatus(clientId, "stopping");
    }

    // Stop HeyGen session
    const result = await heygenManager.stopSession(actualSessionId);

    // Remove from session store
    if (clientId) {
      sessionStore.remove(clientId);
    } else {
      // Find and remove by sessionId
      const sessionData = sessionStore.getBySessionId(actualSessionId);
      if (sessionData) {
        sessionStore.remove(sessionData.clientId);
      }
    }

    res.json({
      success: result.success,
      message: "Session stopped",
    });
  } catch (error) {
    console.error("[HeyGen] Stop session failed:", error);
    res.status(500).json({
      error: "Failed to stop session",
      message: error.message,
    });
  }
});

/**
 * Get HeyGen session stats (for debugging)
 * GET /heygen/stats
 */
app.get("/heygen/stats", requireHeyGen, async (req, res) => {
  try {
    const stats = sessionStore.getStats();
    const quota = await heygenManager.getQuota();

    res.json({
      sessions: stats,
      quota,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// LIVEAVATAR SESSION PRE-WARMING
// ============================================
// LATENCY OPTIMIZATION: Pre-warm session tokens on server start
// This saves 500-1000ms on the first LiveAvatar session request
const liveAvatarSessionPool = [];
const LIVEAVATAR_POOL_SIZE = 2;
const LIVEAVATAR_SESSION_TTL_MS = 5 * 60 * 1000;  // 5 minutes

/**
 * Pre-warm LiveAvatar session tokens on server start
 */
async function prewarmLiveAvatarSessions() {
  if (!liveAvatarManager) {
    console.log("[LiveAvatar] Skipping pre-warm (not configured)");
    return;
  }

  console.log("[LiveAvatar] Pre-warming session pool...");

  for (let i = 0; i < LIVEAVATAR_POOL_SIZE; i++) {
    try {
      const session = await liveAvatarManager.generateSessionToken({
        mode: "CUSTOM",
        avatarId: liveAvatarDefaultAvatar,
        isSandbox: process.env.NODE_ENV !== "production"
      });

      liveAvatarSessionPool.push({
        ...session,
        createdAt: Date.now()
      });

      console.log(`[LiveAvatar] Pre-warmed session ${i + 1}/${LIVEAVATAR_POOL_SIZE}: ${session.session_id}`);
    } catch (error) {
      console.error(`[LiveAvatar] Pre-warm failed for session ${i + 1}:`, error.message);
    }
  }

  console.log(`[LiveAvatar] Pool ready: ${liveAvatarSessionPool.length} sessions`);
}

/**
 * Get a pre-warmed session from the pool, or null if none available
 */
function getPrewarmedSession() {
  const now = Date.now();

  // Remove expired sessions
  while (liveAvatarSessionPool.length > 0) {
    const session = liveAvatarSessionPool[0];
    if (now - session.createdAt > LIVEAVATAR_SESSION_TTL_MS) {
      console.log("[LiveAvatar] Removing expired session from pool");
      liveAvatarSessionPool.shift();
    } else {
      break;
    }
  }

  // Return and remove the first valid session
  if (liveAvatarSessionPool.length > 0) {
    const session = liveAvatarSessionPool.shift();
    console.log(`[LiveAvatar] Using pre-warmed session: ${session.session_id}`);

    // Asynchronously replenish the pool
    setTimeout(() => replenishSessionPool(), 100);

    return session;
  }

  return null;
}

/**
 * Replenish the session pool in the background
 */
async function replenishSessionPool() {
  if (!liveAvatarManager) return;
  if (liveAvatarSessionPool.length >= LIVEAVATAR_POOL_SIZE) return;

  try {
    const session = await liveAvatarManager.generateSessionToken({
      mode: "CUSTOM",
      avatarId: liveAvatarDefaultAvatar,
      isSandbox: process.env.NODE_ENV !== "production"
    });

    liveAvatarSessionPool.push({
      ...session,
      createdAt: Date.now()
    });

    console.log(`[LiveAvatar] Replenished pool: ${liveAvatarSessionPool.length} sessions`);
  } catch (error) {
    console.error("[LiveAvatar] Pool replenish failed:", error.message);
  }
}

// Pre-warm sessions on server start (after a short delay)
setTimeout(prewarmLiveAvatarSessions, 2000);

// ============================================
// LIVEAVATAR ENDPOINTS (Audio-based, lowest latency)
// ============================================

/**
 * Check if LiveAvatar is available
 */
function requireLiveAvatar(req, res, next) {
  if (!liveAvatarManager) {
    return res.status(503).json({
      success: false,
      error: "LiveAvatar not configured",
      message: "Set LIVEAVATAR_API_KEY environment variable to enable LiveAvatar features",
    });
  }
  next();
}

/**
 * Get a session token for LiveAvatar
 * POST /liveavatar/session/token
 * Body: { mode?: "CUSTOM"|"FULL", avatar_id?: string, avatar_persona?: { voice_id?, context_id?, language? }, is_sandbox?: boolean }
 *
 * Response: { success: true, session_token: string, session_id: string }
 *
 * Modes:
 * - CUSTOM (default): For external AI (OpenAI). Supports repeatAudio/agent.speak for lip sync.
 * - FULL: LiveAvatar's internal AI handles conversation (NOT compatible with external audio)
 *
 * The client will use this token to call LiveAvatar API directly.
 */
app.post("/liveavatar/session/token", requireLiveAvatar, async (req, res) => {
  try {
    const {
      mode = "CUSTOM",
      avatar_id = liveAvatarDefaultAvatar,
      avatar_persona = null,
      is_sandbox = process.env.NODE_ENV !== "production"
    } = req.body;

    // LATENCY OPTIMIZATION: Try to use a pre-warmed session
    // Only use pool for CUSTOM mode with default avatar
    let result;
    if (mode === "CUSTOM" && avatar_id === liveAvatarDefaultAvatar && !avatar_persona) {
      const prewarmed = getPrewarmedSession();
      if (prewarmed) {
        result = prewarmed;
        console.log(`[LiveAvatar] Using pre-warmed session (saves ~500ms)`);
      }
    }

    // If no pre-warmed session, generate fresh
    if (!result) {
      console.log(`[LiveAvatar] Generating fresh session token (mode: ${mode}, avatar: ${avatar_id})`);

      result = await liveAvatarManager.generateSessionToken({
        mode,
        avatarId: avatar_id,
        avatarPersona: avatar_persona,
        isSandbox: is_sandbox
      });

      console.log(`[LiveAvatar] Session token generated: ${result.session_id}`);
    }

    res.json({
      success: true,
      session_token: result.session_token,
      session_id: result.session_id
    });
  } catch (error) {
    console.error("[LiveAvatar] Token generation failed:", error);
    res.status(500).json({
      success: false,
      error: "Failed to generate LiveAvatar session token",
      message: error.message,
    });
  }
});

/**
 * Send text for avatar to speak with lip sync
 * POST /liveavatar/speak
 * Body: { session_id: string, text: string, task_type?: "repeat"|"talk" }
 *
 * NOTE: For CUSTOM mode sessions, text commands should go via WebSocket
 * not REST API. This endpoint is for FULL mode or as a fallback.
 *
 * In CUSTOM mode, audio should be sent via WebSocket:
 * - agent.speak with base64 audio chunks
 * - agent.speak_end to finalize
 */
app.post("/liveavatar/speak", requireLiveAvatar, async (req, res) => {
  try {
    const { session_id, text, task_type = "repeat" } = req.body;

    if (!session_id) {
      return res.status(400).json({
        success: false,
        error: "session_id is required"
      });
    }

    if (!text || text.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: "text is required"
      });
    }

    console.log(`[LiveAvatar] Speak request: session=${session_id}, text="${text.substring(0, 50)}..."`);

    // Use LiveAvatarManager for speak commands
    const result = await liveAvatarManager.sendText({
      sessionId: session_id,
      text: text.trim(),
      taskType: task_type
    });

    console.log(`[LiveAvatar] Speak success: task_id=${result.task_id}`);

    res.json({
      success: true,
      task_id: result.task_id
    });
  } catch (error) {
    console.error("[LiveAvatar] Speak failed:", error);
    res.status(500).json({
      success: false,
      error: "Failed to send speak command",
      message: error.message
    });
  }
});

/**
 * Interrupt avatar speech
 * POST /liveavatar/interrupt
 * Body: { session_id: string }
 */
app.post("/liveavatar/interrupt", requireLiveAvatar, async (req, res) => {
  try {
    const { session_id } = req.body;

    if (!session_id) {
      return res.status(400).json({
        success: false,
        error: "session_id is required"
      });
    }

    console.log(`[LiveAvatar] Interrupt request: session=${session_id}`);

    const result = await liveAvatarManager.interrupt(session_id);

    res.json({
      success: result.success,
      message: result.success ? "Interrupted" : result.error
    });
  } catch (error) {
    console.error("[LiveAvatar] Interrupt failed:", error);
    res.status(500).json({
      success: false,
      error: "Failed to interrupt",
      message: error.message
    });
  }
});

/**
 * Get LiveAvatar status (for debugging)
 * GET /liveavatar/status
 */
app.get("/liveavatar/status", requireLiveAvatar, async (req, res) => {
  try {
    const status = await liveAvatarManager.getStatus();
    res.json({
      success: true,
      status,
      defaultAvatarId: liveAvatarDefaultAvatar,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================
// ORCHESTRATED MODE ENDPOINTS (LiveKit + OpenAI Agent + HeyGen BYOLI)
// ============================================

/**
 * Check if Orchestrator is available
 */
function requireOrchestrator(req, res, next) {
  if (!orchestrator) {
    return res.status(503).json({
      success: false,
      error: "Orchestrated mode not configured",
      message: "Set LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET to enable orchestrated mode",
    });
  }
  next();
}

/**
 * Create an orchestrated session.
 * Creates a LiveKit room and returns user credentials.
 * The Python agent auto-dispatches when the user joins and
 * handles HeyGen/LiveAvatar session creation via its plugin.
 *
 * POST /orchestrated/session/start
 * Body: {} (no parameters needed)
 * Returns: { success, url, roomName, userToken }
 */
app.post("/orchestrated/session/start", requireOrchestrator, async (req, res) => {
  try {
    console.log(`[Orchestrated] Creating session`);

    const session = await orchestrator.createSession();

    console.log(`[Orchestrated] Session created: room=${session.roomName}`);

    res.json({
      success: true,
      url: session.url,
      roomName: session.roomName,
      userToken: session.userToken,
    });
  } catch (error) {
    console.error("[Orchestrated] Session creation failed:", error);
    res.status(500).json({
      success: false,
      error: "Failed to create orchestrated session",
      message: error.message,
    });
  }
});

/**
 * Stop an orchestrated session.
 * Deletes the LiveKit room. The agent and LiveAvatar plugin
 * clean up their own resources automatically.
 *
 * POST /orchestrated/session/stop
 * Body: { roomName?: string }
 */
app.post("/orchestrated/session/stop", requireOrchestrator, async (req, res) => {
  try {
    const { roomName } = req.body;

    console.log(`[Orchestrated] Stopping session: room=${roomName}`);

    await orchestrator.stopSession({ roomName });

    res.json({
      success: true,
      message: "Orchestrated session stopped",
    });
  } catch (error) {
    console.error("[Orchestrated] Session stop failed:", error);
    res.status(500).json({
      success: false,
      error: "Failed to stop orchestrated session",
      message: error.message,
    });
  }
});

/**
 * Get orchestrated mode status.
 * GET /orchestrated/status
 */
app.get("/orchestrated/status", (req, res) => {
  res.json({
    success: true,
    available: !!orchestrator,
    livekitConfigured: !!(livekitUrl && livekitApiKey && livekitApiSecret),
    defaultAvatarId: liveAvatarDefaultAvatar,
  });
});

app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Backend running on port ${port}`);
});
