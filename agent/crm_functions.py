"""
CRM Functions for LiveKit Agent

Server-side CRM operations matching the Android CrmApiClient.java auth flow:
  1. Login via POST /auth/login with email/password -> Bearer token (AT STARTUP ONLY)
  2. Token cached in module globals, used by all tool calls
  3. Endpoints: /leads (POST), /packages (GET), /packages/{id} (GET)
  4. Tool calls NEVER trigger login — if token is missing/expired, they fail gracefully

Base URL: https://crm.tripandevent.com (matches Android Constants.CRM_BASE_URL)

Environment Variables:
    CRM_BASE_URL      - CRM API base URL (default: https://crm.tripandevent.com)
    CRM_EMAIL         - CRM login email
    CRM_PASSWORD      - CRM login password
"""

import asyncio
import logging
import os
import time
from typing import Optional
from urllib.parse import urlencode

import httpx

logger = logging.getLogger("sanbot-agent.crm")

# Configuration (matches Android Constants.java)
CRM_BASE_URL = os.getenv("CRM_BASE_URL", "https://crm.tripandevent.com/api")
CRM_EMAIL = os.getenv("CRM_EMAIL", "samim97322@gmail.com")
CRM_PASSWORD = os.getenv("CRM_PASSWORD", "TNE@1234")

# Token state
_access_token: Optional[str] = None
_token_expires_at: float = 0.0
_is_authenticating = False

# Shared async HTTP client (persistent connection pool)
_client: Optional[httpx.AsyncClient] = None

TOKEN_LIFETIME_SECONDS = 50 * 60  # 50 minutes (token expires in ~1 hour, refresh early)

logger.info(f"CRM config: base_url={CRM_BASE_URL}, email={CRM_EMAIL}")


def _get_client() -> httpx.AsyncClient:
    """Get or create shared async HTTP client (no base_url — full URLs used everywhere)."""
    global _client
    if _client is None or _client.is_closed:
        _client = httpx.AsyncClient(
            timeout=10.0,  # 10s for voice agent (lower than Android's 15s)
        )
    return _client


def _url(path: str) -> str:
    """Build full CRM URL. Matches: curl -X POST https://crm.tripandevent.com/api/auth/login"""
    base = CRM_BASE_URL.rstrip("/")
    path = path.lstrip("/")
    return f"{base}/{path}"


# ============================================
# AUTHENTICATION (matches Android CrmApiClient.java)
# ============================================

async def _login() -> str:
    """Login to CRM and get access token.

    POST /auth/login with {"email": "...", "password": "..."}
    Response: {"success": true, "data": {"accessToken": "...", "refreshToken": "..."}}
    """
    global _access_token, _token_expires_at, _is_authenticating

    if _is_authenticating:
        # Wait for concurrent login to finish
        for _ in range(50):
            await asyncio.sleep(0.1)
            if _access_token and time.time() < _token_expires_at:
                return _access_token
        raise Exception("Authentication timeout")

    _is_authenticating = True
    try:
        client = _get_client()
        login_url = _url("auth/login")
        logger.info(f"CRM login attempt: POST {login_url} (email={CRM_EMAIL})")
        # Use a longer timeout for login — first connection to CRM may be cold-starting
        resp = await client.post(
            login_url,
            json={"email": CRM_EMAIL, "password": CRM_PASSWORD},
            headers={"Content-Type": "application/json"},
            timeout=20.0,
        )

        # Log full response details on any error (not just raise_for_status)
        if resp.status_code >= 400:
            logger.error(f"CRM login HTTP {resp.status_code}: {resp.text[:500]}")
            raise Exception(f"HTTP {resp.status_code}: {resp.text[:200]}")

        body = resp.json()
        logger.info(f"CRM login response keys: {list(body.keys())}")

        # Response: {"success": true, "data": {"accessToken": "...", ...}}
        # Extract from nested data object first, then fall back to top-level
        inner = body.get("data", {})
        token = (
            inner.get("accessToken")
            or inner.get("access_token")
            or body.get("accessToken")
            or body.get("access_token")
            or body.get("token")
        )
        if not token:
            raise Exception(f"No token in login response: {body}")

        _access_token = token
        _token_expires_at = time.time() + TOKEN_LIFETIME_SECONDS
        logger.info("CRM login successful — token cached")
        return token
    except httpx.ConnectError as e:
        logger.error(f"CRM login connection error (check URL/network): {type(e).__name__}: {e}")
        raise
    except httpx.TimeoutException as e:
        logger.error(f"CRM login timed out (server unreachable?): {type(e).__name__}: {e}")
        raise
    except Exception as e:
        logger.error(f"CRM login failed: {type(e).__name__}: {e}")
        raise
    finally:
        _is_authenticating = False


def _has_valid_token() -> bool:
    return _access_token is not None and time.time() < _token_expires_at


async def _ensure_authenticated() -> str:
    if _has_valid_token():
        return _access_token
    return await _login()


async def warmup() -> None:
    """Pre-fetch CRM auth token at server startup.

    Called via asyncio.run() BEFORE cli.run_app() starts the LiveKit worker.
    The token (a plain string) persists across event loops via module globals.
    The httpx client is closed after login so it gets recreated on the
    worker's event loop (asyncio.run() creates a temporary loop).

    Failures are logged but don't prevent the agent from starting —
    however, CRM tool calls will fail until the agent is restarted.
    """
    global _client
    try:
        await _ensure_authenticated()
        logger.info("CRM warmup complete — token pre-fetched")
    except Exception as e:
        logger.warning(f"CRM warmup failed (CRM tools will be unavailable): {e}")
    finally:
        # Close the httpx client — it's bound to this temporary event loop.
        # _get_client() will recreate it on the worker's event loop.
        if _client and not _client.is_closed:
            await _client.aclose()
        _client = None


def _auth_headers() -> dict:
    """Return auth headers using the cached token. Never triggers login."""
    if not _access_token:
        logger.error("CRM token not available — login at startup may have failed")
        return {"Content-Type": "application/json"}
    return {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {_access_token}",
    }


async def _crm_request(endpoint: str, method: str = "GET", body: dict = None) -> dict:
    """Make authenticated CRM API request. Uses cached token only — never triggers login."""
    if not _access_token:
        logger.error("CRM token not available — cannot make API request")
        return {"success": False, "error": "CRM not authenticated (token missing)"}

    try:
        client = _get_client()
        headers = _auth_headers()
        url = _url(endpoint)

        if method == "GET":
            response = await client.get(url, headers=headers)
        elif method == "POST":
            response = await client.post(url, json=body, headers=headers)
        else:
            response = await client.request(method, url, json=body, headers=headers)

        if response.status_code == 401:
            logger.error("CRM token expired (401) — restart the agent to re-authenticate")
            return {"success": False, "error": "CRM token expired — restart agent to refresh"}

        if response.status_code >= 400:
            error_text = response.text[:200]
            logger.error(f"CRM API error {response.status_code}: {error_text}")
            return {"success": False, "error": f"API error: {response.status_code}"}

        return response.json()
    except httpx.TimeoutException:
        logger.error(f"CRM request timeout: {method} {endpoint}")
        return {"success": False, "error": "CRM request timed out — server may be unreachable"}
    except Exception as e:
        logger.error(f"CRM request failed: {e}")
        return {"success": False, "error": str(e)}


# ============================================
# HELPERS
# ============================================

def _normalize_hotel_type(s: str) -> Optional[str]:
    if not s:
        return None
    lower = s.lower().strip()
    if any(x in lower for x in ["5", "five", "luxury"]):
        return "5 Star"
    if any(x in lower for x in ["4", "four", "premium"]):
        return "4 Star"
    if any(x in lower for x in ["3", "three", "standard"]):
        return "3 Star"
    if any(x in lower for x in ["2", "two", "budget"]):
        return "2 Star"
    if "resort" in lower:
        return "Resort"
    if "villa" in lower:
        return "Villa"
    if "home" in lower or "stay" in lower:
        return "Homestay"
    return s


def _normalize_meal_plan(s: str) -> Optional[str]:
    if not s:
        return None
    lower = s.lower().strip()
    if "all" in lower or lower == "ap":
        return "AP"
    if any(x in lower for x in ["half", "modified"]) or lower == "map":
        return "MAP"
    if any(x in lower for x in ["breakfast", "continental"]) or lower == "cp":
        return "CP"
    if any(x in lower for x in ["no", "european", "room only"]) or lower == "ep":
        return "EP"
    return s


# ============================================
# PUBLIC API FUNCTIONS
# ============================================

async def save_lead(params: dict) -> dict:
    """Save a customer lead to CRM.

    Endpoint: POST /leads (matches Android CrmApiClient.createLead)
    """
    logger.info(f"Saving lead: {params.get('name')}")

    # Build lead data matching Android LeadData schema (camelCase)
    lead_data = {
        "name": params.get("name", ""),
        "email": params.get("email") or None,
        "mobile": params.get("phone") or None,
        "destination": params.get("destination") or None,
        "journeyStartDate": params.get("travel_date") or None,
        "durationNights": params.get("nights") or None,
        "durationDays": (params.get("nights") or 0) + 1 if params.get("nights") else None,
        "adults": params.get("adults", 2),
        "children": params.get("children", 0),
        "infants": 0,
        "hotelType": _normalize_hotel_type(params.get("hotel_type", "")),
        "mealPlan": _normalize_meal_plan(params.get("meal_plan", "")),
        "specialRequirement": params.get("special_requirements") or None,
        "aiSummary": params.get("conversation_summary") or None,
        # Attribution (matches Android CrmFunctionHandlers)
        "source": "Voice Agent",
        "sourceType": "voice_agent",
        "utmSource": "sanbot",
        "utmMedium": "voice",
        "utmCampaign": "orchestrated-livekit",
        "notes": "Lead captured via SanBot Voice Agent (Orchestrated Mode).",
    }

    # Remove None values to keep payload small
    lead_data = {k: v for k, v in lead_data.items() if v is not None}

    result = await _crm_request("leads", "POST", lead_data)

    if result.get("success") or result.get("id") or result.get("lead_id"):
        return {
            "success": True,
            "message": f"Lead saved for {params.get('name')}!",
            "lead_id": result.get("id") or result.get("lead_id") or "saved",
        }

    return {
        "success": False,
        "message": f"Failed to save lead: {result.get('error', 'Unknown error')}",
    }


async def find_packages(params: dict) -> dict:
    """Find travel packages — handles both filtered search and keyword search.

    Endpoint: GET /packages (matches Android CrmApiClient.getPackages)

    If 'query' is provided, it's used as the destination filter
    (matches Android searchPackages which just calls getPackages with destination=query).
    """
    logger.info(f"Finding packages: {params}")

    query_params = {}

    # Keyword search -> destination filter (matches Android searchPackages)
    query = params.get("query", "")
    destination = params.get("destination", "") or query

    if destination:
        query_params["destination"] = destination
    if params.get("min_price"):
        query_params["minPrice"] = str(params["min_price"])
    if params.get("max_price"):
        query_params["maxPrice"] = str(params["max_price"])
    if params.get("package_type"):
        query_params["packageType"] = params["package_type"]
    if params.get("nights"):
        nights = params["nights"]
        query_params["minNights"] = str(max(1, nights - 1))
        query_params["maxNights"] = str(nights + 1)

    query_params["limit"] = str(params.get("limit", 5))

    endpoint = "packages"
    if query_params:
        endpoint += "?" + urlencode(query_params)

    result = await _crm_request(endpoint)

    if result.get("success") is False:
        return {
            "success": False,
            "message": f"Could not fetch packages: {result.get('error')}",
            "packages": [],
        }

    packages = result.get("packages") or result.get("data") or result
    package_list = packages if isinstance(packages, list) else []
    count = len(package_list)

    # Voice summary (max 3 items for spoken response)
    if count == 0:
        voice_summary = "No packages found. Let me suggest some alternatives!"
    else:
        parts = [f"Found {count} package{'s' if count > 1 else ''}!"]
        for i, pkg in enumerate(package_list[:3]):
            name = pkg.get("packageName") or pkg.get("package_name") or pkg.get("name", "Package")
            nights = pkg.get("totalNights") or pkg.get("total_nights") or pkg.get("nights", "?")
            price = pkg.get("sellingPrice") or pkg.get("selling_price") or pkg.get("price", "?")
            currency = pkg.get("currency", "INR")
            parts.append(f"{i + 1}. {name} - {nights} nights at {currency} {price}.")
        if count > 3:
            parts.append(f"And {count - 3} more options.")
        voice_summary = " ".join(parts)

    return {
        "success": True,
        "count": count,
        "packages": package_list,
        "voice_summary": voice_summary,
    }


async def get_package_details(package_id: str) -> dict:
    """Get detailed info about a specific package.

    Endpoint: GET /packages/{id} (matches Android CrmApiClient.getPackageById)
    """
    logger.info(f"Getting package details: {package_id}")

    result = await _crm_request(f"packages/{package_id}")

    if result.get("success") is False:
        return {
            "success": False,
            "message": f"Could not find package: {result.get('error')}",
        }

    pkg = result.get("data") or result
    name = pkg.get("packageName") or pkg.get("package_name") or pkg.get("name", "Unknown")
    nights = pkg.get("totalNights") or pkg.get("total_nights") or pkg.get("nights", 0)
    days = pkg.get("totalDays") or pkg.get("total_days") or (nights + 1 if nights else 0)
    price = pkg.get("sellingPrice") or pkg.get("selling_price") or pkg.get("basePrice") or pkg.get("base_price") or pkg.get("price", 0)
    currency = pkg.get("currency", "INR")

    # Voice description (matches Android PackageDetail.toDetailedVoiceDescription)
    desc_parts = [f"{name}. {nights} nights {days} days starting from {currency} {price} per person."]
    inclusions = pkg.get("inclusions", [])
    if inclusions:
        inc_text = ", ".join(inclusions[:4])
        if len(inclusions) > 4:
            inc_text += " and more"
        desc_parts.append(f"Includes: {inc_text}.")

    return {
        "success": True,
        "id": pkg.get("id", package_id),
        "name": name,
        "description": pkg.get("description", ""),
        "price": price,
        "currency": currency,
        "nights": nights,
        "days": days,
        "destinations": pkg.get("destinations", []),
        "inclusions": inclusions,
        "exclusions": pkg.get("exclusions", []),
        "voice_description": " ".join(desc_parts),
    }
