/**
 * LiveKit Orchestrator
 *
 * Manages the orchestrated session lifecycle:
 * 1. Creates a LiveKit room
 * 2. Generates a user token for the Android client
 * 3. Returns connection info
 *
 * The Python agent (agent/agent.py) handles:
 * - Auto-dispatching to the room when a user joins
 * - OpenAI STT+LLM+TTS pipeline
 * - LiveAvatar plugin (creates HeyGen session, forwards audio, publishes video)
 * - Robot commands via data channel
 *
 * Requires:
 * - LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET in .env
 */

import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';

export default class LiveKitOrchestrator {
  /**
   * @param {string} livekitUrl - LiveKit Cloud WebSocket URL (wss://...)
   * @param {string} apiKey - LiveKit API Key
   * @param {string} apiSecret - LiveKit API Secret
   */
  constructor(livekitUrl, apiKey, apiSecret) {
    this.livekitUrl = livekitUrl;
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;

    this.roomService = new RoomServiceClient(livekitUrl, apiKey, apiSecret);

    console.log('[Orchestrator] Initialized with LiveKit URL:', livekitUrl);
  }

  /**
   * Create an orchestrated session.
   *
   * Creates a LiveKit room and generates a user token.
   * The Python agent auto-dispatches when the user joins.
   * The LiveAvatar plugin (in the agent) handles HeyGen session creation.
   *
   * @param {Object} options
   * @param {string} [options.roomName] - Custom room name (auto-generated if not provided)
   * @returns {Promise<{url: string, roomName: string, userToken: string}>}
   */
  async createSession({ roomName } = {}) {
    roomName = roomName || `orchestrated-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

    console.log(`[Orchestrator] Creating session: room=${roomName}`);

    // 1. Create the LiveKit room
    try {
      await this.roomService.createRoom({ name: roomName, emptyTimeout: 300 });
      console.log(`[Orchestrator] Room created: ${roomName}`);
    } catch (err) {
      // Room may already exist or auto-create is enabled
      console.log(`[Orchestrator] Room creation note: ${err.message}`);
    }

    // 2. Generate token for the User (Android app)
    const userIdentity = `user-${Date.now()}`;
    const userToken = await this._generateToken({
      identity: userIdentity,
      name: 'SanBot User',
      roomName,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });
    console.log(`[Orchestrator] User token generated: ${userIdentity}`);

    // 3. Agent auto-dispatches via LiveKit Agents framework
    //    The Python agent (agent/agent.py) registers with LiveKit Cloud
    //    and is dispatched automatically when a participant joins the room.
    //    The LiveAvatar plugin in the agent creates the HeyGen session.
    console.log(`[Orchestrator] Session ready. Agent will auto-dispatch when user joins.`);

    return {
      url: this.livekitUrl,
      roomName,
      userToken,
    };
  }

  /**
   * Stop an orchestrated session.
   *
   * Deletes the LiveKit room. The agent and LiveAvatar plugin clean up
   * their own resources when the room is destroyed or participants leave.
   *
   * @param {Object} options
   * @param {string} [options.roomName] - Room name to delete
   */
  async stopSession({ roomName }) {
    console.log(`[Orchestrator] Stopping session: room=${roomName}`);

    // Delete room (optional - rooms auto-close when empty)
    if (roomName) {
      try {
        await this.roomService.deleteRoom(roomName);
        console.log(`[Orchestrator] Room deleted: ${roomName}`);
      } catch (err) {
        console.error(`[Orchestrator] Room delete error:`, err.message);
      }
    }
  }

  /**
   * Generate a LiveKit access token.
   * @private
   */
  async _generateToken({ identity, name, roomName, canPublish, canSubscribe, canPublishData }) {
    const at = new AccessToken(this.apiKey, this.apiSecret, {
      identity,
      name,
      ttl: '1h',
    });

    at.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish,
      canSubscribe,
      canPublishData,
    });

    return await at.toJwt();
  }
}
