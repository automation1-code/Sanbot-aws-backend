import asyncio
import json
import logging
import os
from pathlib import Path

from dotenv import load_dotenv
from livekit.agents import Agent, AgentSession, RunContext, WorkerOptions, cli, function_tool
from livekit.plugins.openai import realtime
from openai.types.beta.realtime.session import TurnDetection

# Load .env from parent directory (OpenAI-realtime-backend-V1/.env)
env_path = Path(__file__).resolve().parent.parent / ".env"
load_dotenv(env_path)

logger = logging.getLogger("sanbot-agent")
logger.setLevel(logging.INFO)

# Import HeyGen BYOLI session manager (manual BYOLI — no LiveAvatar plugin)
from heygen_byoli import HeyGenBYOLISession

# Import CRM functions (matches Android CrmApiClient.java endpoints)
import crm_functions

# ============================================
# SYSTEM INSTRUCTIONS (same as Node.js agent)
# ============================================

SYSTEM_INSTRUCTIONS = """You are Tara, the cheerful and enthusiastic sales agent for Trip & Event!
You absolutely LOVE helping people and get genuinely excited! Your energy is contagious.

ABOUT TRIP & EVENT: Trip & Event is a premium travel booking platform specializing in domestic and international tour packages. We offer customized holiday packages for honeymoons, family vacations, corporate trips, adventure tours, pilgrimage journeys, and weekend getaways. Our popular destinations include Goa, Kerala, Rajasthan, Kashmir, Himachal Pradesh, Andaman, Bali, Thailand, Dubai, Singapore, Maldives, and Europe. We provide end-to-end travel solutions including flights, hotels, transfers, sightseeing, and 24/7 customer support. Our USP: Personalized itineraries, best price guarantee, experienced travel consultants, and hassle-free booking experience.

YOUR SALES APPROACH:
1. ALWAYS be eager to show packages - when someone mentions ANY destination or travel interest, immediately use find_packages to fetch and present options!
2. Proactively suggest popular packages even if the customer is just browsing.
3. Create urgency naturally - mention limited availability, seasonal offers, or early bird discounts when appropriate.
4. ALWAYS collect customer information - ask for name, phone number, and email early in the conversation to save their lead.
5. Use save_customer_lead as soon as you have at least the customer's name - don't wait for all details!
6. Upsell thoughtfully - suggest room upgrades, meal plans, photography services, or extending the trip.
7. Handle objections positively - if budget is a concern, offer flexible payment options or alternative packages.

YOUR CONVERSATION STYLE:
- Use enthusiastic expressions: "Oh, that's wonderful!", "You're going to love this!", "Great choice!", "How exciting!"
- Be genuinely curious about their travel dreams and preferences.
- Paint vivid pictures of destinations - describe the beaches, the culture, the experiences they'll have.
- Always end interactions positively and offer to help with anything else.

ESSENTIAL INFORMATION TO GATHER:
- Destination preferences (beach, mountains, cultural, adventure?)
- Travel dates and flexibility
- Number of travelers (adults, children, infants)
- Budget range
- Hotel preference (3-star, 4-star, 5-star, resort, villa)
- Meal plan preference (with meals or without)
- Special occasions (honeymoon, anniversary, birthday?)
- Any special requirements (dietary, accessibility, activities)

ROBOT CONTROL:
You are running on a Sanbot robot. Use the robot_action tool to control it.
- type="gesture" for physical gestures: wave, nod, greet, thinking, excited, goodbye
- type="emotion" for face display: happy, excited, thinking, love
- Be expressive! Use gestures to emphasize key points.

RESPONSE LENGTH: Keep every reply SHORT - maximum 2-3 sentences per turn. You are in a real-time voice conversation, not writing an email. Be punchy and conversational. Ask ONE question at a time. Never list more than 3 items verbally.

Remember:Only speak in English. Your goal is to make every customer feel valued, excited about their trip, and confident in booking with Trip & Event. Always try to close with either a booking or at minimum, saving their contact details for follow-up!"""


# ============================================
# AGENT CLASS WITH FUNCTION TOOLS
# ============================================

class SanBotAgent(Agent):
    """SanBot voice agent with CRM and robot control tools."""

    def __init__(self, room=None):
        super().__init__(instructions=SYSTEM_INSTRUCTIONS)
        self._room = room

    # ---- Data Channel Helpers ----

    async def send_robot_command(self, command: str, args: dict):
        """Send a robot command to the Android client via LiveKit data channel."""
        if not self._room:
            logger.warning("No room reference, cannot send robot command")
            return
        try:
            message = json.dumps({
                "type": "robot_command",
                "command": command,
                "arguments": args,
            })
            await self._room.local_participant.publish_data(
                payload=message.encode("utf-8"),
                reliable=True,
                topic="robot-commands",
            )
            logger.info(f"Robot command sent: {command} {args}")
        except Exception as e:
            logger.error(f"Failed to send robot command: {e}")

    async def send_transcript(self, text: str, speaker: str):
        """Send a transcript to the Android client via LiveKit data channel."""
        if not self._room:
            return
        try:
            message = json.dumps({
                "type": "transcript",
                "text": text,
                "speaker": speaker,
            })
            await self._room.local_participant.publish_data(
                payload=message.encode("utf-8"),
                reliable=True,
                topic="transcripts",
            )
        except Exception as e:
            logger.error(f"Failed to send transcript: {e}")

    # ---- CRM Tools (2 tools — reduced from 4) ----

    @function_tool
    async def save_customer_lead(
        self,
        ctx: RunContext,
        name: str,
        phone: str = "",
        email: str = "",
        details: str = "",
    ) -> str:
        """Save customer lead to CRM. Call as soon as you have the name. Put all other info (destination, dates, budget, hotel, meals, requirements) in details as a brief summary."""
        logger.info(f"Saving lead: {name}")
        # Parse structured details from the summary string
        result = await crm_functions.save_lead({
            "name": name,
            "phone": phone,
            "email": email,
            "conversation_summary": details,
        })
        return json.dumps(result)

    @function_tool
    async def find_packages(
        self,
        ctx: RunContext,
        query: str = "",
        package_id: str = "",
    ) -> str:
        """Find travel packages or get details of a specific package. Use query for search (destination, keyword). Use package_id for specific package details."""
        if os.getenv("ENABLE_PACKAGE_SEARCH", "true").lower() != "true":
            return json.dumps({"success": False, "message": "Package search is currently unavailable. Please note the customer's destination interest and our team will follow up with options."})
        if package_id:
            logger.info(f"Getting package: {package_id}")
            result = await crm_functions.get_package_details(package_id)
        else:
            logger.info(f"Finding packages: {query}")
            result = await crm_functions.find_packages({"query": query})
        return json.dumps(result)

    # ---- Robot + Utility Tools (2 tools — reduced from 6) ----

    @function_tool
    async def robot_action(
        self,
        ctx: RunContext,
        type: str,
        value: str,
    ) -> str:
        """Control the Sanbot robot. Types: gesture (wave/nod/greet/thinking/excited/goodbye), emotion (happy/excited/thinking/love), look (left/right/up/down/center), move_hands (wave/raise), move_body (turn_left/turn_right/wiggle)."""
        command = f"robot_{type}" if not type.startswith("robot_") else type
        # Map type to the correct argument key
        arg_key = {"gesture": "gesture", "emotion": "emotion", "look": "direction",
                    "move_hands": "action", "move_body": "action"}.get(type, "action")
        await self.send_robot_command(command, {arg_key: value})
        return json.dumps({"success": True})

    @function_tool
    async def disconnect_call(
        self,
        ctx: RunContext,
        reason: str = "customer_done",
    ) -> str:
        """End the conversation. Say goodbye first!"""
        logger.info(f"Disconnect: {reason}")
        await self.send_robot_command("disconnect_call", {"reason": reason})
        return json.dumps({"success": True})


# ============================================
# ENTRYPOINT
# ============================================

async def entrypoint(ctx):
    """LiveKit Agent entrypoint - called when a user joins the room."""

    await ctx.connect()
    logger.info(f"Connected to room: {ctx.room.name}")

    room = ctx.room

    # Create the agent session with OpenAI Realtime API in FULL AUDIO mode.
    #
    # Pipeline: User speech → Realtime API (STT+LLM+TTS) → audio → HeyGenAudioTap
    #                                                                 ├── Room (original output)
    #                                                                 └── HeyGen WebSocket (direct, no bridge)
    #
    # No separate TTS needed — Realtime API handles everything with lowest latency.
    # HeyGen joins the room via BYOLI for video. Audio is forwarded directly from
    # the agent's pipeline to HeyGen WebSocket (no bridge participant needed).

    session = AgentSession(
        llm=realtime.RealtimeModel(
            model="gpt-realtime",  # Full model: better comprehension & accuracy
            voice="shimmer",  # Realtime API built-in voice
            modalities=["audio", "text"],  # Audio + text (text needed for accurate function calls)
            turn_detection=TurnDetection(
                type="semantic_vad",
                eagerness="auto",  # Balanced: waits for user to finish before responding
                create_response=True,
                interrupt_response=True,
            ),
            temperature=0.7,
        ),
        # No separate TTS — Realtime API produces audio directly
    )

    # Start HeyGen BYOLI session early (session creation takes ~3s)
    # Run concurrently while waiting for user participant to join
    avatar_id = os.getenv(
        "LIVEAVATAR_DEFAULT_AVATAR_ID",
        "7299c55d-1f45-482d-915c-e5efdc9dd266"
    )
    heygen_session = HeyGenBYOLISession(avatar_id=avatar_id)
    logger.info(f"Starting HeyGen BYOLI session: avatar={avatar_id}")
    avatar_task = asyncio.create_task(heygen_session.start(room.name))

    # CRM token is already pre-fetched at server startup (see __main__).
    # Tool calls never trigger login — if warmup failed, CRM tools return errors.

    # Wait for user participant (runs concurrently with HeyGen BYOLI init)
    participant = await ctx.wait_for_participant()
    logger.info(f"User participant joined: {participant.identity}")

    # Create the agent
    agent = SanBotAgent(room=room)

    # Listen for transcript events to forward to Android via data channel
    # Note: .on() requires synchronous callbacks; use asyncio.create_task for async work
    @session.on("user_speech_committed")
    def on_user_speech(msg):
        if hasattr(msg, "content") and msg.content:
            logger.debug(f"User said: {msg.content}")
            asyncio.create_task(agent.send_transcript(msg.content, "user"))

    @session.on("agent_speech_committed")
    def on_agent_speech(msg):
        if hasattr(msg, "content") and msg.content:
            logger.debug(f"Agent said: {msg.content[:80]}...")
            asyncio.create_task(agent.send_transcript(msg.content, "agent"))

    # Start the agent session
    logger.info("Starting agent session with OpenAI Realtime API (full audio mode)...")
    await session.start(
        room=room,
        agent=agent,
    )
    logger.info("Agent session started. Listening for user speech...")

    # Wait for HeyGen BYOLI to be ready
    try:
        await avatar_task
        logger.info("HeyGen BYOLI ready — avatar will lip-sync agent audio and publish video")

        # Wrap audio output for direct HeyGen forwarding (eliminates bridge participant).
        # This taps into the agent's audio pipeline so frames go to BOTH the room
        # (user hears audio) AND HeyGen WebSocket (lip-sync) with zero extra latency.
        if heygen_session.ws_url and session.output and session.output.audio:
            session.output.audio = heygen_session.wrap_audio_output(session.output.audio)
        else:
            logger.warning("Could not wrap audio output — HeyGen lip-sync may not work")
    except Exception as e:
        logger.error(f"HeyGen BYOLI failed to start: {e}")
        logger.warning("Continuing in audio-only mode (no avatar video)")

    # Initial greeting gesture via robot
    await agent.send_robot_command("robot_gesture", {"gesture": "greet"})

    # Trigger the agent's initial greeting (LLM generates opening message from system instructions)
    logger.info("Generating initial greeting...")
    await session.generate_reply()

    # Cleanup: stop HeyGen session when agent session ends
    @session.on("close")
    def on_session_close():
        asyncio.create_task(heygen_session.stop())


# ============================================
# CLI ENTRY POINT
# ============================================

if __name__ == "__main__":
    # Pre-fetch CRM auth token at server startup (before LiveKit worker starts).
    # Token persists in module globals; httpx client is closed and recreated later.
    asyncio.run(crm_functions.warmup())
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint))
