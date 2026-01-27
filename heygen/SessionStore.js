/**
 * HeyGen Session Store
 *
 * In-memory storage for active HeyGen streaming sessions.
 * Maps client IDs to their HeyGen session data.
 *
 * Note: For production, consider using Redis or another persistent store.
 */

class SessionStore {
  constructor() {
    // Map<clientId, SessionData>
    this.sessions = new Map();

    // Session cleanup interval (check every 5 minutes)
    this.cleanupInterval = setInterval(() => this._cleanup(), 5 * 60 * 1000);
  }

  /**
   * Session data structure
   * @typedef {Object} SessionData
   * @property {string} sessionId - HeyGen session ID
   * @property {string} clientId - Client/device identifier
   * @property {string} avatarId - Avatar being used
   * @property {string} liveKitUrl - LiveKit server URL
   * @property {string} liveKitToken - LiveKit access token
   * @property {Array} iceServers - ICE servers for WebRTC
   * @property {string} status - Session status: 'creating', 'active', 'stopping', 'stopped'
   * @property {number} createdAt - Timestamp when session was created
   * @property {number} lastActivity - Timestamp of last activity
   */

  /**
   * Create or update a session
   *
   * @param {string} clientId - Client identifier
   * @param {SessionData} sessionData - Session data
   */
  set(clientId, sessionData) {
    const existing = this.sessions.get(clientId);

    this.sessions.set(clientId, {
      ...existing,
      ...sessionData,
      clientId,
      lastActivity: Date.now(),
      createdAt: existing?.createdAt || Date.now(),
    });

    console.log(`[SessionStore] Session stored for client: ${clientId}`);
  }

  /**
   * Get session by client ID
   *
   * @param {string} clientId
   * @returns {SessionData|null}
   */
  get(clientId) {
    const session = this.sessions.get(clientId);
    if (session) {
      session.lastActivity = Date.now();
    }
    return session || null;
  }

  /**
   * Get session by HeyGen session ID
   *
   * @param {string} sessionId - HeyGen session ID
   * @returns {SessionData|null}
   */
  getBySessionId(sessionId) {
    for (const [clientId, session] of this.sessions) {
      if (session.sessionId === sessionId) {
        session.lastActivity = Date.now();
        return session;
      }
    }
    return null;
  }

  /**
   * Update session status
   *
   * @param {string} clientId
   * @param {string} status
   */
  updateStatus(clientId, status) {
    const session = this.sessions.get(clientId);
    if (session) {
      session.status = status;
      session.lastActivity = Date.now();
      console.log(`[SessionStore] Session ${clientId} status: ${status}`);
    }
  }

  /**
   * Remove a session
   *
   * @param {string} clientId
   * @returns {SessionData|null} - Removed session data
   */
  remove(clientId) {
    const session = this.sessions.get(clientId);
    if (session) {
      this.sessions.delete(clientId);
      console.log(`[SessionStore] Session removed: ${clientId}`);
    }
    return session || null;
  }

  /**
   * Check if client has an active session
   *
   * @param {string} clientId
   * @returns {boolean}
   */
  hasActiveSession(clientId) {
    const session = this.sessions.get(clientId);
    return session && session.status === "active";
  }

  /**
   * Get all active sessions
   *
   * @returns {Array<SessionData>}
   */
  getActiveSessions() {
    const active = [];
    for (const session of this.sessions.values()) {
      if (session.status === "active") {
        active.push(session);
      }
    }
    return active;
  }

  /**
   * Get session count
   *
   * @returns {Object} - { total, active, creating }
   */
  getStats() {
    let active = 0;
    let creating = 0;

    for (const session of this.sessions.values()) {
      if (session.status === "active") active++;
      if (session.status === "creating") creating++;
    }

    return {
      total: this.sessions.size,
      active,
      creating,
    };
  }

  /**
   * Clean up stale sessions
   * Sessions inactive for more than 30 minutes are removed
   */
  _cleanup() {
    const staleThreshold = 30 * 60 * 1000; // 30 minutes
    const now = Date.now();
    const stale = [];

    for (const [clientId, session] of this.sessions) {
      if (now - session.lastActivity > staleThreshold) {
        stale.push(clientId);
      }
    }

    for (const clientId of stale) {
      console.log(`[SessionStore] Cleaning up stale session: ${clientId}`);
      this.sessions.delete(clientId);
    }

    if (stale.length > 0) {
      console.log(`[SessionStore] Cleaned up ${stale.length} stale sessions`);
    }
  }

  /**
   * Stop cleanup interval (for graceful shutdown)
   */
  destroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}

// Export singleton instance
const sessionStore = new SessionStore();
export default sessionStore;
