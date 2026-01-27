/**
 * LiveAvatar Manager
 *
 * Handles communication with LiveAvatar API.
 * Provides session token generation and management.
 *
 * API Documentation: https://api.liveavatar.com
 *
 * Usage:
 * 1. Get a session token using generateSessionToken()
 * 2. Return the token to the client
 * 3. Client uses the token with LiveAvatar SDK to start session
 *
 * Mode:
 * - CUSTOM: App controls what the avatar says (using repeatAudio/repeat)
 * - FULL: LiveAvatar AI controls conversation
 */

const LIVEAVATAR_API_URL = 'https://api.liveavatar.com';

export default class LiveAvatarManager {
  constructor(apiKey, defaultAvatarId = null) {
    this.apiKey = apiKey;
    this.defaultAvatarId = defaultAvatarId;
  }

  /**
   * Generate a session token for LiveAvatar
   *
   * @param {Object} options
   * @param {string} options.mode - Session mode: 'CUSTOM' or 'FULL'
   * @param {string} [options.avatarId] - Avatar ID (uses default if not specified)
   * @param {Object} [options.avatarPersona] - For FULL mode: { voice_id, context_id, language }
   * @param {boolean} [options.isSandbox] - Use sandbox environment
   * @returns {Promise<{session_token: string, session_id: string}>}
   */
  async generateSessionToken(options = {}) {
    const {
      mode = 'CUSTOM',
      avatarId = this.defaultAvatarId,
      avatarPersona = null,
      isSandbox = false
    } = options;

    const body = {
      mode,
      avatar_id: avatarId,
      is_sandbox: isSandbox
    };

    // avatar_persona is REQUIRED for FULL mode
    if (mode === 'FULL') {
      body.avatar_persona = {
        voice_id: avatarPersona?.voice_id || null,
        context_id: avatarPersona?.context_id || null,
        language: avatarPersona?.language || 'en'
      };
    }

    const response = await fetch(`${LIVEAVATAR_API_URL}/v1/sessions/token`, {
      method: 'POST',
      headers: {
        'X-API-KEY': this.apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`LiveAvatar API error (${response.status}): ${errorText}`);
    }

    const data = await response.json();

    // Check for success code
    if (data.code !== 1000) {
      throw new Error(`LiveAvatar API error: ${data.message || 'Unknown error'}`);
    }

    return {
      session_token: data.data.session_token,
      session_id: data.data.session_id
    };
  }

  /**
   * Check API quota/availability
   * @returns {Promise<Object>}
   */
  async getStatus() {
    try {
      // Simple health check - try to get token info
      const response = await fetch(`${LIVEAVATAR_API_URL}/v1/status`, {
        method: 'GET',
        headers: {
          'X-API-KEY': this.apiKey
        }
      });

      if (response.ok) {
        return { available: true };
      } else {
        return { available: false, error: `HTTP ${response.status}` };
      }
    } catch (error) {
      return { available: false, error: error.message };
    }
  }

  /**
   * Send text for avatar to speak
   *
   * NOTE: For CUSTOM mode, this uses the streaming.task endpoint.
   * The preferred method is sending via WebSocket (agent.speak with audio chunks).
   *
   * @param {Object} options
   * @param {string} options.sessionId - Session ID
   * @param {string} options.text - Text to speak
   * @param {string} [options.taskType] - Task type: 'repeat' or 'talk'
   * @returns {Promise<{task_id: string}>}
   */
  async sendText(options = {}) {
    const { sessionId, text, taskType = 'repeat' } = options;

    if (!sessionId || !text) {
      throw new Error('sessionId and text are required');
    }

    console.log(`[LiveAvatarManager] Sending text to session ${sessionId}: "${text.substring(0, 50)}..."`);

    // Try the streaming task endpoint (HeyGen-compatible format)
    const response = await fetch(`${LIVEAVATAR_API_URL}/v1/streaming.task`, {
      method: 'POST',
      headers: {
        'X-API-KEY': this.apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        session_id: sessionId,
        text: text,
        task_type: taskType
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[LiveAvatarManager] API error: ${response.status} - ${errorText}`);
      throw new Error(`LiveAvatar API error (${response.status}): ${errorText}`);
    }

    const data = await response.json();

    // Check for success
    if (data.code && data.code !== 1000) {
      throw new Error(`LiveAvatar API error: ${data.message || 'Unknown error'}`);
    }

    return {
      task_id: data.data?.task_id || data.task_id || 'unknown'
    };
  }

  /**
   * Interrupt avatar speech
   *
   * @param {string} sessionId - Session ID to interrupt
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async interrupt(sessionId) {
    if (!sessionId) {
      return { success: false, error: 'sessionId is required' };
    }

    console.log(`[LiveAvatarManager] Interrupting session ${sessionId}`);

    try {
      const response = await fetch(`${LIVEAVATAR_API_URL}/v1/streaming.interrupt`, {
        method: 'POST',
        headers: {
          'X-API-KEY': this.apiKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          session_id: sessionId
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[LiveAvatarManager] Interrupt error: ${response.status} - ${errorText}`);
        return { success: false, error: `HTTP ${response.status}: ${errorText}` };
      }

      const data = await response.json();

      if (data.code && data.code !== 1000) {
        return { success: false, error: data.message || 'Unknown error' };
      }

      return { success: true };
    } catch (error) {
      console.error(`[LiveAvatarManager] Interrupt exception:`, error);
      return { success: false, error: error.message };
    }
  }
}
