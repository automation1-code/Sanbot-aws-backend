/**
 * HeyGen LiveAvatar API Manager
 *
 * Handles LiveAvatar streaming session lifecycle and text-to-avatar communication.
 * Uses the new LiveAvatar API with LiveKit for video delivery.
 *
 * @see https://docs.liveavatar.com/docs/quick-start-guide
 */

const LIVEAVATAR_API_BASE = "https://api.liveavatar.com/v1";

class HeyGenManager {
  constructor(apiKey, defaultAvatarId = null) {
    if (!apiKey) {
      throw new Error("HeyGen API key is required");
    }
    this.apiKey = apiKey;
    this.defaultAvatarId = defaultAvatarId;
  }

  /**
   * Make authenticated request to LiveAvatar API
   * @param {string} endpoint - API endpoint
   * @param {object} options - fetch options
   * @param {string} [bearerToken] - Optional bearer token for session-based auth
   */
  async _request(endpoint, options = {}, bearerToken = null) {
    const url = `${LIVEAVATAR_API_BASE}${endpoint}`;
    const headers = {
      "Content-Type": "application/json",
      "Accept": "application/json",
      ...options.headers,
    };

    // Use bearer token if provided, otherwise use API key
    if (bearerToken) {
      headers["Authorization"] = `Bearer ${bearerToken}`;
    } else {
      headers["X-API-KEY"] = this.apiKey;
    }

    // Debug: Log request details (redact sensitive info)
    console.log(`[LiveAvatar] Request: ${options.method || 'GET'} ${url}`);
    if (!bearerToken) {
      console.log(`[LiveAvatar] API Key format: ${this.apiKey ? `${this.apiKey.substring(0, 8)}...${this.apiKey.substring(this.apiKey.length - 4)}` : 'NOT SET'}`);
    }

    try {
      const response = await fetch(url, {
        ...options,
        headers,
      });

      const data = await response.json();

      console.log(`[LiveAvatar] Response status: ${response.status}`);
      console.log(`[LiveAvatar] Response data:`, JSON.stringify(data).substring(0, 200));

      if (!response.ok) {
        const error = new Error(data.message || data.error || `LiveAvatar API error: ${response.status}`);
        error.status = response.status;
        error.data = data;
        throw error;
      }

      return data;
    } catch (error) {
      console.error(`LiveAvatar API request failed: ${endpoint}`, error);
      throw error;
    }
  }

  /**
   * Create a streaming session token
   * Step 1: Get session_id and session_token from LiveAvatar
   *
   * @param {Object} options
   * @param {string} options.avatarId - LiveAvatar avatar ID
   * @param {string} [options.voiceId] - Optional voice ID
   * @param {string} [options.contextId] - Optional context ID for persona
   * @param {string} [options.language] - Language code (default: "en")
   * @returns {Promise<{session_id: string, session_token: string}>}
   */
  async createSession({ avatarId, voiceId, contextId, language = "en" } = {}) {
    const avatar = avatarId || this.defaultAvatarId;
    if (!avatar) {
      throw new Error("Avatar ID is required");
    }

    // Build request body - avatar_persona is required by LiveAvatar API
    const body = {
      mode: "FULL",
      avatar_id: avatar,
      avatar_persona: {
        language: language,
      },
    };

    // Add optional voice and context IDs
    if (voiceId) {
      body.avatar_persona.voice_id = voiceId;
    }
    if (contextId) {
      body.avatar_persona.context_id = contextId;
    }

    console.log(`[LiveAvatar] Creating session with body:`, JSON.stringify(body));

    const response = await this._request("/sessions/token", {
      method: "POST",
      body: JSON.stringify(body),
    });

    // Debug: Log the full response structure
    console.log(`[LiveAvatar] Full response:`, JSON.stringify(response));
    console.log(`[LiveAvatar] response.data:`, JSON.stringify(response.data));
    console.log(`[LiveAvatar] response.code:`, response.code);

    // LiveAvatar returns: {"code":1000,"data":{"session_id":"...","session_token":"..."}}
    // Extract session data from the nested data object
    let sessionId, sessionToken;

    if (response.code === 1000 && response.data) {
      // Standard LiveAvatar success response
      sessionId = response.data.session_id;
      sessionToken = response.data.session_token;
    } else if (response.session_id) {
      // Direct response format
      sessionId = response.session_id;
      sessionToken = response.session_token;
    } else {
      // Fallback - try to find the data
      const data = response.data || response;
      sessionId = data.session_id || data.sessionId;
      sessionToken = data.session_token || data.sessionToken || data.token;
    }

    console.log(`[LiveAvatar] Extracted sessionId: ${sessionId}`);
    console.log(`[LiveAvatar] Extracted sessionToken: ${sessionToken ? 'present' : 'missing'}`);

    if (!sessionId) {
      throw new Error("No session_id in response: " + JSON.stringify(response).substring(0, 300));
    }

    // Store session token for subsequent requests
    this._sessionTokens = this._sessionTokens || {};
    this._sessionTokens[sessionId] = sessionToken;

    return {
      session_id: sessionId,
      session_token: sessionToken,
    };
  }

  /**
   * Start a streaming session
   * Step 2: Start the session and get LiveKit connection info
   *
   * @param {string} sessionId - Session ID from createSession
   * @returns {Promise<{session_id: string, url: string, access_token: string}>}
   */
  async startSession(sessionId) {
    if (!sessionId) {
      throw new Error("Session ID is required");
    }

    // Get the session token from our cache
    const sessionToken = this._sessionTokens?.[sessionId];
    if (!sessionToken) {
      throw new Error("Session token not found. Call createSession first.");
    }

    console.log(`[LiveAvatar] Starting session: ${sessionId}`);

    const response = await this._request("/sessions/start", {
      method: "POST",
    }, sessionToken);

    console.log(`[LiveAvatar] Start session response:`, JSON.stringify(response).substring(0, 500));

    // Handle different response formats
    const data = response.data || response;
    const livekitUrl = data.livekit_url || data.livekitUrl || data.url || response.livekit_url;
    const accessToken = data.livekit_client_token || data.livekitClientToken || data.access_token || data.token || response.livekit_client_token;

    console.log(`[LiveAvatar] Session started: ${sessionId}, LiveKit URL: ${livekitUrl ? 'present' : 'missing'}`);

    return {
      session_id: sessionId,
      url: livekitUrl,
      access_token: accessToken,
    };
  }

  /**
   * Send text for the avatar to speak
   * Uses LiveAvatar/HeyGen streaming.task endpoint
   *
   * @param {Object} options
   * @param {string} options.sessionId - Active session ID
   * @param {string} options.text - Text for avatar to speak
   * @param {string} [options.taskType="repeat"] - "repeat" (speak exactly) or "talk" (use LLM)
   * @returns {Promise<{task_id: string}>}
   */
  async sendText({ sessionId, text, taskType = "repeat" }) {
    if (!sessionId) {
      throw new Error("Session ID is required");
    }
    if (!text || text.trim().length === 0) {
      console.log("[LiveAvatar] Skipping empty text");
      return { task_id: null };
    }

    // Get the session token for authorization
    const sessionToken = this._sessionTokens?.[sessionId];

    const body = {
      session_id: sessionId,
      text: text.trim(),
      task_type: taskType,
    };

    console.log(`[LiveAvatar] Sending text (${text.length} chars): "${text.substring(0, 50)}..."`);

    try {
      // Try the LiveAvatar sessions/speak endpoint first
      const response = await this._request("/sessions/speak", {
        method: "POST",
        body: JSON.stringify(body),
      }, sessionToken);

      const data = response.data || response;
      console.log(`[LiveAvatar] Text sent successfully, task: ${data.task_id}`);
      return { task_id: data.task_id || `task-${Date.now()}` };
    } catch (error) {
      // If LiveAvatar endpoint fails, try the old HeyGen endpoint format
      console.log(`[LiveAvatar] sessions/speak failed, trying alternative...`);

      try {
        // Try calling HeyGen's streaming.task endpoint directly
        const heygenUrl = "https://api.heygen.com/v1/streaming.task";
        const headers = {
          "Content-Type": "application/json",
          "X-Api-Key": this.apiKey,
        };

        const response = await fetch(heygenUrl, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });

        const data = await response.json();
        console.log(`[LiveAvatar] HeyGen streaming.task response:`, JSON.stringify(data).substring(0, 200));

        if (response.ok && data.data) {
          return { task_id: data.data.task_id };
        }
      } catch (fallbackError) {
        console.warn(`[LiveAvatar] Fallback also failed:`, fallbackError.message);
      }

      // Return a placeholder if both fail
      console.warn(`[LiveAvatar] Text send failed, but continuing...`);
      return { task_id: null, error: error.message };
    }
  }

  /**
   * Interrupt the avatar's current speech
   * Used for barge-in when user starts speaking
   *
   * @param {string} sessionId - Active session ID
   * @returns {Promise<{success: boolean}>}
   */
  async interrupt(sessionId) {
    if (!sessionId) {
      throw new Error("Session ID is required");
    }

    console.log(`[LiveAvatar] Interrupt requested for session: ${sessionId}`);

    const sessionToken = this._sessionTokens?.[sessionId];

    try {
      // Try LiveAvatar interrupt endpoint
      const response = await this._request("/sessions/interrupt", {
        method: "POST",
        body: JSON.stringify({ session_id: sessionId }),
      }, sessionToken);

      console.log(`[LiveAvatar] Avatar interrupted successfully`);
      return { success: true, data: response.data || response };
    } catch (error) {
      // Try HeyGen's streaming.interrupt endpoint
      try {
        const heygenUrl = "https://api.heygen.com/v1/streaming.interrupt";
        const response = await fetch(heygenUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Api-Key": this.apiKey,
          },
          body: JSON.stringify({ session_id: sessionId }),
        });

        if (response.ok) {
          console.log(`[LiveAvatar] HeyGen interrupt successful`);
          return { success: true };
        }
      } catch (fallbackError) {
        // Ignore fallback errors
      }

      // Interrupt may fail if avatar is not speaking - that's OK
      console.log(`[LiveAvatar] Interrupt failed (avatar may not be speaking): ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Stop and clean up a streaming session
   *
   * @param {string} sessionId - Active session ID
   * @returns {Promise<{success: boolean}>}
   */
  async stopSession(sessionId) {
    if (!sessionId) {
      console.log("[LiveAvatar] No session to stop");
      return { success: true };
    }

    try {
      const sessionToken = this._sessionTokens?.[sessionId];

      await this._request("/sessions/stop", {
        method: "POST",
      }, sessionToken);

      // Clean up stored token
      if (this._sessionTokens) {
        delete this._sessionTokens[sessionId];
      }

      console.log(`[LiveAvatar] Session stopped: ${sessionId}`);
      return { success: true };
    } catch (error) {
      console.error(`[LiveAvatar] Failed to stop session: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * List active sessions
   *
   * @returns {Promise<Array>}
   */
  async listSessions() {
    try {
      const response = await this._request("/sessions", {
        method: "GET",
      });
      return response.sessions || response.data || response;
    } catch (error) {
      console.warn("[LiveAvatar] Could not list sessions:", error.message);
      return [];
    }
  }

  /**
   * Check remaining session quota
   *
   * @returns {Promise<Object>}
   */
  async getQuota() {
    try {
      // LiveAvatar may not have a direct quota endpoint
      // Return session list as a proxy for usage info
      const sessions = await this.listSessions();
      return { active_sessions: sessions.length };
    } catch (error) {
      console.warn("[LiveAvatar] Could not fetch quota:", error.message);
      return null;
    }
  }
}

export default HeyGenManager;
