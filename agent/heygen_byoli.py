"""
HeyGen BYOLI (Bring Your Own LiveKit Instance) Session Manager — Direct Audio Tap

Creates a HeyGen Interactive Avatar session in CUSTOM mode using the LiveAvatar API.
The avatar joins the LiveKit room via BYOLI to publish lip-sync video.

Audio for lip-sync is forwarded by tapping directly into the agent's audio output
pipeline (via HeyGenAudioTap), eliminating the need for a separate "audio bridge"
participant. This reduces lip-sync latency by cutting out one network hop.

Flow:
  1. Generate LiveKit token for HeyGen avatar (video publishing)
  2. Create session token via LiveAvatar API (CUSTOM mode + livekit_config)
  3. Start session -> HeyGen joins room for video, returns ws_url
  4. Connect to HeyGen WebSocket for audio forwarding
  5. Agent wraps session.output.audio with HeyGenAudioTap
  6. Audio frames go ONLY to HeyGen WebSocket (room publishing skipped — Android mutes agent audio)
  7. Keep-alive pings every 30s (REST) + 60s (WebSocket)
  8. Cleanup on stop

Latency improvement over audio bridge approach:
  Before: Agent -> Room -> Bridge subscribes (~30-50ms) -> WebSocket -> HeyGen
  After:  Agent -> WebSocket -> HeyGen (direct, ~0ms extra)

API Reference:
  - LiveAvatar API: https://api.liveavatar.com/v1/sessions/*
  - Auth: X-API-KEY header for session creation, Bearer token for session ops
  - WebSocket messages: agent.speak (audio), agent.speak_end, session.keep_alive
"""

import asyncio
import base64
import logging
import os
import uuid

import aiohttp
import httpx
from livekit import api as livekit_api, rtc
from livekit.agents.voice.io import AudioOutput, AudioOutputCapabilities

logger = logging.getLogger("heygen-byoli")

HEYGEN_SAMPLE_RATE = 24000  # HeyGen expects 24kHz mono PCM
WS_KEEP_ALIVE_INTERVAL = 60  # seconds
REST_KEEP_ALIVE_INTERVAL = 30  # seconds


# ================================================================
# AUDIO TAP — intercepts agent audio output, forwards to HeyGen WS
# ================================================================

class HeyGenAudioTap(AudioOutput):
    """AudioOutput wrapper that sends agent audio ONLY to HeyGen WebSocket.

    Room publishing is fully bypassed — Android mutes agent audio anyway.
    This avoids encode/publish overhead on every frame (~25ms saved).

    Since the original AudioOutput never receives frames, we do NOT use
    next_in_chain (which expects the chain to emit playback_finished).
    Instead, we call on_playback_finished() ourselves in flush()/clear_buffer()
    to satisfy the framework's segment lifecycle (wait_for_playout).

    Audio frames are queued and sent by a background task to avoid blocking
    the main audio pipeline. Frames are naturally batched (queue drain)
    to reduce WebSocket message count.
    """

    def __init__(
        self,
        original: AudioOutput,
        heygen_session: "HeyGenBYOLISession",
    ) -> None:
        super().__init__(
            label="HeyGenTap",
            # NO next_in_chain — original never receives frames, so it can't
            # emit playback_finished. We handle the segment lifecycle ourselves.
            sample_rate=original.sample_rate,
            capabilities=AudioOutputCapabilities(pause=False),
        )
        self._original = original
        self._heygen = heygen_session

        # Resampler for HeyGen (24kHz mono) — created on first frame if needed
        self._resampler: rtc.AudioResampler | None = None
        self._resampler_checked = False

        # Non-blocking send queue + background sender
        self._send_queue: asyncio.Queue[bytes] = asyncio.Queue(maxsize=500)
        self._sender_task = asyncio.create_task(self._send_loop())
        self._closed = False

        # Guard: only call on_playback_finished() if a segment is active
        # (capture_frame was called). Prevents "playback_finished called more
        # times than playback segments were captured" warning.
        self._segment_active = False

    async def capture_frame(self, frame: rtc.AudioFrame) -> None:
        """Queue frame for HeyGen only (skip room publishing — Android mutes agent audio).

        Segment lifecycle: super().capture_frame() tracks segment start.
        flush() and clear_buffer() call on_playback_finished() to close the segment.
        """
        # Update base class state — increments __playback_segments_count on first frame
        await super().capture_frame(frame)
        self._segment_active = True
        # Skip self._original.capture_frame(frame) — no room publishing.
        # Android mutes agent audio anyway. We handle playback_finished in flush()/clear_buffer().

        # Queue PCM bytes for HeyGen (non-blocking)
        if self._closed:
            return

        try:
            if not self._resampler_checked:
                self._resampler_checked = True
                if frame.sample_rate != HEYGEN_SAMPLE_RATE:
                    self._resampler = rtc.AudioResampler(
                        input_rate=frame.sample_rate,
                        output_rate=HEYGEN_SAMPLE_RATE,
                        num_channels=1,
                    )
                    logger.info(
                        f"HeyGen audio resampler: {frame.sample_rate}Hz -> {HEYGEN_SAMPLE_RATE}Hz"
                    )

            if self._resampler:
                for f in self._resampler.push(frame):
                    self._send_queue.put_nowait(f.data.tobytes())
            else:
                self._send_queue.put_nowait(frame.data.tobytes())
        except asyncio.QueueFull:
            pass  # Drop frame rather than block audio pipeline

    def flush(self) -> None:
        """Mark segment complete and notify HeyGen that speech ended."""
        super().flush()  # sets __capturing = False
        # Signal segment complete to the framework (replaces next_in_chain propagation).
        # Without this, wait_for_playout() hangs because no one calls on_playback_finished().
        if self._segment_active:
            self._segment_active = False
            self.on_playback_finished(playback_position=0.0, interrupted=False)
        # Flush resampler
        if self._resampler:
            for f in self._resampler.flush():
                try:
                    self._send_queue.put_nowait(f.data.tobytes())
                except asyncio.QueueFull:
                    pass
        # Signal speak_end (sentinel value)
        try:
            self._send_queue.put_nowait(b"__FLUSH__")
        except asyncio.QueueFull:
            pass

    def clear_buffer(self) -> None:
        """Interrupt current segment and notify HeyGen to stop lip-sync."""
        # Reset capturing state so the next segment starts fresh.
        # super().flush() sets __capturing = False, which allows the next
        # capture_frame() to increment __playback_segments_count properly.
        super().flush()
        # Signal segment interrupted to the framework (replaces next_in_chain propagation).
        # Without this, wait_for_playout() hangs after barge-in ("speech not done in time").
        if self._segment_active:
            self._segment_active = False
            self.on_playback_finished(playback_position=0.0, interrupted=True)
        # Drain pending audio from the queue
        while not self._send_queue.empty():
            try:
                self._send_queue.get_nowait()
            except asyncio.QueueEmpty:
                break
        # Send interrupt to HeyGen
        asyncio.ensure_future(self._heygen.notify_interrupt())

    async def aclose(self) -> None:
        """Clean up sender task."""
        self._closed = True
        if self._sender_task:
            self._sender_task.cancel()
            try:
                await self._sender_task
            except (asyncio.CancelledError, Exception):
                pass
        # Close original
        if hasattr(self._original, "aclose"):
            await self._original.aclose()

    async def _send_loop(self) -> None:
        """Background task: drains queue and sends batched audio to HeyGen."""
        try:
            while True:
                # Wait for first item
                item = await self._send_queue.get()

                if item == b"__FLUSH__":
                    # Speech ended — notify HeyGen
                    await self._heygen.notify_speak_end()
                    continue

                # Accumulate PCM bytes (natural batching — drain what's ready)
                batch = bytearray(item)
                while not self._send_queue.empty():
                    try:
                        extra = self._send_queue.get_nowait()
                        if extra == b"__FLUSH__":
                            # Send current batch first, then speak_end
                            break
                        batch.extend(extra)
                    except asyncio.QueueEmpty:
                        break
                else:
                    extra = None

                # Send batched audio to HeyGen
                b64_audio = base64.b64encode(bytes(batch)).decode("ascii")
                await self._heygen.send_audio(b64_audio)

                # Handle flush sentinel that was found during drain
                if extra == b"__FLUSH__":
                    await self._heygen.notify_speak_end()

        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.error(f"HeyGen audio send loop error: {e}", exc_info=True)


# ================================================================
# HEYGEN BYOLI SESSION
# ================================================================

class HeyGenBYOLISession:
    """Manages a HeyGen BYOLI session with direct WebSocket audio forwarding."""

    LIVEAVATAR_API_BASE = "https://api.liveavatar.com"

    def __init__(
        self,
        avatar_id: str,
        liveavatar_api_key: str | None = None,
        livekit_url: str | None = None,
        livekit_api_key: str | None = None,
        livekit_api_secret: str | None = None,
    ):
        self.avatar_id = avatar_id
        self.liveavatar_api_key = liveavatar_api_key or os.getenv("LIVEAVATAR_API_KEY", "")
        self.livekit_url = livekit_url or os.getenv("LIVEKIT_URL", "")
        self.livekit_api_key = livekit_api_key or os.getenv("LIVEKIT_API_KEY", "")
        self.livekit_api_secret = livekit_api_secret or os.getenv("LIVEKIT_API_SECRET", "")

        self.session_id: str | None = None
        self.session_token: str | None = None
        self.ws_url: str | None = None

        self._rest_keep_alive_task: asyncio.Task | None = None
        self._ws_keep_alive_task: asyncio.Task | None = None

        # WebSocket resources (direct connection, no bridge participant)
        self._ws_session: aiohttp.ClientSession | None = None
        self._ws: aiohttp.ClientWebSocketResponse | None = None

        # Audio tap reference (set by wrap_audio_output)
        self._audio_tap: HeyGenAudioTap | None = None

        self._started = False

    # ================================================================
    # PUBLIC API
    # ================================================================

    async def start(self, room_name: str) -> None:
        """Create and start a HeyGen BYOLI session.

        Args:
            room_name: The LiveKit room name the avatar should join.
        """
        if self._started:
            logger.warning("HeyGen session already started")
            return

        logger.info(f"Creating HeyGen BYOLI session: avatar={self.avatar_id}, room={room_name}")

        # 1. Generate a LiveKit token for HeyGen to join the room (video publishing)
        avatar_token = self._generate_avatar_token(room_name)

        # 2. Create session token via LiveAvatar API
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                f"{self.LIVEAVATAR_API_BASE}/v1/sessions/token",
                headers={
                    "Content-Type": "application/json",
                    "X-API-KEY": self.liveavatar_api_key,
                },
                json={
                    "mode": "CUSTOM",
                    "avatar_id": self.avatar_id,
                    "livekit_config": {
                        "livekit_url": self.livekit_url,
                        "livekit_room": room_name,
                        "livekit_client_token": avatar_token,
                    },
                },
            )
            resp.raise_for_status()
            data = resp.json()

            self.session_id = data["data"]["session_id"]
            self.session_token = data["data"]["session_token"]
            logger.info(f"HeyGen session token created: session_id={self.session_id}")

            # 3. Start the session -> HeyGen joins the LiveKit room for video
            start_resp = await client.post(
                f"{self.LIVEAVATAR_API_BASE}/v1/sessions/start",
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {self.session_token}",
                },
            )
            start_resp.raise_for_status()
            start_data = start_resp.json()
            self.ws_url = start_data["data"].get("ws_url")
            logger.info(
                f"HeyGen session started: session_id={self.session_id}, "
                f"ws_url={'yes' if self.ws_url else 'NONE'}"
            )

        self._started = True

        # 4. Start REST keep-alive pings
        self._rest_keep_alive_task = asyncio.create_task(self._rest_keep_alive_loop())

        # 5. Connect to HeyGen WebSocket for audio forwarding (no bridge participant needed)
        if self.ws_url:
            self._ws_session = aiohttp.ClientSession()
            self._ws = await self._ws_session.ws_connect(self.ws_url)
            logger.info("Connected to HeyGen WebSocket for direct audio forwarding")
            # Start WebSocket keep-alive
            self._ws_keep_alive_task = asyncio.create_task(self._ws_keep_alive_loop())
        else:
            logger.warning("No ws_url returned by HeyGen — lip-sync will NOT work (video only)")

    def wrap_audio_output(self, original_output: AudioOutput) -> HeyGenAudioTap:
        """Wrap the agent's audio output to also forward audio to HeyGen.

        Call this after session.start() to tap into the audio pipeline:
            session.output.audio = heygen_session.wrap_audio_output(session.output.audio)

        Returns:
            HeyGenAudioTap that replaces session.output.audio
        """
        self._audio_tap = HeyGenAudioTap(original_output, self)
        logger.info("Audio output wrapped with HeyGenAudioTap (direct forwarding, no bridge)")
        return self._audio_tap

    async def stop(self) -> None:
        """Stop the HeyGen session and clean up all resources."""
        if not self._started:
            return

        logger.info("Stopping HeyGen BYOLI session")

        # Close audio tap
        if self._audio_tap:
            await self._audio_tap.aclose()
            self._audio_tap = None

        # Cancel keep-alive tasks
        for task in [self._ws_keep_alive_task, self._rest_keep_alive_task]:
            if task:
                task.cancel()
                try:
                    await task
                except (asyncio.CancelledError, Exception):
                    pass
        self._ws_keep_alive_task = None
        self._rest_keep_alive_task = None

        # Close WebSocket
        await self._cleanup_ws()

        # Stop the session via REST API
        if self.session_token:
            try:
                async with httpx.AsyncClient(timeout=10.0) as client:
                    await client.post(
                        f"{self.LIVEAVATAR_API_BASE}/v1/sessions/stop",
                        headers={
                            "Content-Type": "application/json",
                            "Authorization": f"Bearer {self.session_token}",
                        },
                        json={
                            "session_id": self.session_id,
                            "reason": "USER_DISCONNECTED",
                        },
                    )
                logger.info("HeyGen session stopped via API")
            except Exception as e:
                logger.error(f"Failed to stop HeyGen session: {e}")

        self.session_id = None
        self.session_token = None
        self.ws_url = None
        self._started = False

    # ================================================================
    # AUDIO FORWARDING (called by HeyGenAudioTap)
    # ================================================================

    async def send_audio(self, b64_audio: str) -> None:
        """Send base64-encoded PCM audio to HeyGen WebSocket for lip-sync."""
        await self._send_ws({
            "type": "agent.speak",
            "audio": b64_audio,
        })

    async def notify_speak_end(self) -> None:
        """Notify HeyGen that agent stopped speaking."""
        await self._send_ws({
            "type": "agent.speak_end",
            "event_id": str(uuid.uuid4()),
        })
        await self._send_ws({
            "type": "agent.start_listening",
            "event_id": str(uuid.uuid4()),
        })

    async def notify_interrupt(self) -> None:
        """Notify HeyGen to immediately stop buffered lip-sync playback."""
        logger.debug("Sending agent.interrupt to HeyGen")
        await self._send_ws({
            "type": "agent.interrupt",
            "event_id": str(uuid.uuid4()),
        })

    # ================================================================
    # WEBSOCKET HELPERS
    # ================================================================

    async def _send_ws(self, msg: dict) -> None:
        """Send a JSON message to the HeyGen WebSocket."""
        if self._ws and not self._ws.closed:
            try:
                await self._ws.send_json(msg)
            except Exception as e:
                logger.warning(f"WebSocket send failed: {e}")

    async def _cleanup_ws(self) -> None:
        """Clean up WebSocket resources."""
        if self._ws and not self._ws.closed:
            try:
                await self._ws.close()
            except Exception:
                pass
        self._ws = None

        if self._ws_session:
            try:
                await self._ws_session.close()
            except Exception:
                pass
        self._ws_session = None

    # ================================================================
    # KEEP-ALIVE TASKS
    # ================================================================

    async def _ws_keep_alive_loop(self) -> None:
        """Send WebSocket keep-alive pings every 60 seconds."""
        try:
            while self._started:
                await asyncio.sleep(WS_KEEP_ALIVE_INTERVAL)
                await self._send_ws({
                    "type": "session.keep_alive",
                    "event_id": str(uuid.uuid4()),
                })
                logger.debug("HeyGen WebSocket keep-alive sent")
        except asyncio.CancelledError:
            pass

    async def _rest_keep_alive_loop(self) -> None:
        """Send REST keep-alive pings every 30 seconds."""
        while True:
            try:
                await asyncio.sleep(REST_KEEP_ALIVE_INTERVAL)
                if self.session_token:
                    async with httpx.AsyncClient(timeout=10.0) as client:
                        await client.post(
                            f"{self.LIVEAVATAR_API_BASE}/v1/sessions/keep-alive",
                            headers={
                                "Content-Type": "application/json",
                                "Authorization": f"Bearer {self.session_token}",
                            },
                        )
                    logger.debug("HeyGen REST keep-alive sent")
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.warning(f"HeyGen REST keep-alive failed: {e}")

    # ================================================================
    # TOKEN GENERATION
    # ================================================================

    def _generate_avatar_token(self, room_name: str) -> str:
        """Generate a LiveKit access token for HeyGen to join the room (video publishing)."""
        token = livekit_api.AccessToken(
            api_key=self.livekit_api_key,
            api_secret=self.livekit_api_secret,
        )
        token.with_identity("liveavatar-avatar-byoli")
        token.with_name("HeyGen Avatar")
        token.with_grants(
            livekit_api.VideoGrants(
                room_join=True,
                room=room_name,
                can_publish=True,
                can_subscribe=True,
                can_publish_data=True,
            )
        )
        return token.to_jwt()
