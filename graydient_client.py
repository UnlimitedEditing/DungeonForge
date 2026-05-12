"""
graydient_client.py — Direct HTTP client for the Graydient v3 API.

Speaks the same wire format as the official SDK but lives entirely within
this project so we control iteration on request shape, error handling,
and workflow selection without touching a third-party package.

Key facts from the SDK source (render_v3.py):
  - POST /render with Content-Type: application/vnd.api+json
  - Workflow slug goes into the 'options' string as /run:<slug>
  - Other option flags (seed etc) join the same space-separated string
  - Streaming uses SSE; 'rendering_done' event carries the render_hash
  - GET /render/<hash> returns JSON-API envelope; image URL is in
    attributes.images[0].media[0].url (or .url fallback)
"""

import json
import logging
import os
from typing import Callable, Optional

import requests
import sseclient

log = logging.getLogger("forge.graydient")

BASE_URL = os.environ.get("GRAYDIENT_API_URL", "https://app.graydient.ai/api/v3/")


def _url(path: str) -> str:
    return BASE_URL.rstrip("/") + "/" + path.lstrip("/")


def _headers(api_key: str, stream: bool = False) -> dict:
    h = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/vnd.api+json",
        "Accept-Type": "application/vnd.api+json",
    }
    if stream:
        h["Accept"] = "text/event-stream"
    return h


def validate_key(api_key: str) -> bool:
    """Probe GET /workflows — cheap call, 200 means key is valid."""
    try:
        resp = requests.get(_url("workflows"), headers=_headers(api_key), timeout=10)
        return resp.status_code == 200
    except Exception:
        return False


def render_create(
    prompt: str,
    workflow: str,
    api_key: str,
    on_event: Callable[[dict], None],
    init_image: Optional[str] = None,
    seed: Optional[int] = None,
) -> None:
    """
    Submit a workflow render and stream progress events back.
    Blocks until the SSE stream closes. on_event fires for each parsed event.

    init_image: publicly-accessible URL used as the source image for img2img
    or img2vid workflows (maps to the SDK's inputs={"init_image": url}).

    The workflow slug is the primary iteration variable — change it in forge.py
    (WORKFLOW / ANIM_WORKFLOW constants) to switch between Graydient offerings.
    """
    options_parts = [f"/run:{workflow}"]
    if seed is not None:
        options_parts.append(f"/seed:{seed}")

    body = {
        "options": " ".join(options_parts),
        "placeholders": {},
        "metadata_fields": {},
        "prompt": prompt,
        "task": "workflow",
        "progressive_return": True,
        "stream": True,
    }
    if init_image:
        body["init_image"] = init_image

    log.info("render_create workflow=%s prompt=%.80s", workflow, prompt)
    resp = requests.post(
        _url("render"),
        headers=_headers(api_key, stream=True),
        json=body,
        stream=True,
        timeout=600,
    )
    resp.raise_for_status()

    client = sseclient.SSEClient(resp)
    for event in client.events():
        try:
            payload = json.loads(event.data)
        except (json.JSONDecodeError, ValueError):
            log.warning("unparseable SSE event: %.200s", event.data)
            continue
        log.debug("sse event keys=%s", list(payload.keys()))
        on_event(payload)


def render_info(render_hash: str, api_key: str) -> dict:
    """
    Fetch completed render metadata. Returns the attributes dict merged with id,
    matching the structure the SDK's to_render() produces.
    """
    resp = requests.get(
        _url(f"render/{render_hash}"),
        headers=_headers(api_key),
        timeout=30,
    )
    resp.raise_for_status()
    data = resp.json()["data"]
    return {"id": data["id"], **data["attributes"]}


def extract_image_url(render_data: dict) -> Optional[str]:
    """Pull the first image URL from a render_info result dict."""
    images = render_data.get("images") or []
    if not images:
        return None
    img = images[0]
    media = img.get("media") or []
    if media:
        return media[0].get("url")
    return img.get("url")
