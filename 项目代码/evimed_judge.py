"""Advisory engine judge client; uncertain or unavailable results preserve fallback."""
from __future__ import annotations
import asyncio
import json
import math
import inspect
import threading
import os
import urllib.parse
import urllib.request


def _request(site: str, input: dict):
    """Return a settled closed decision only; never expose credentials or errors."""
    url = os.getenv("EVIMED_JUDGE_GATEWAY_URL", "")
    token = os.getenv("EVIMED_JUDGE_GATEWAY_TOKEN", "")
    if not url or not token:
        return None
    address = urllib.parse.urlsplit(url)
    if address.scheme not in {"http", "https"} or not address.hostname or address.username or address.password:
        return None
    try:
        body = json.dumps({"site": site, "input": input}, ensure_ascii=False).encode()
        if len(body) > 1024 * 1024:
            return None
        request = urllib.request.Request(url, data=body, method="POST", headers={
            "Content-Type": "application/json", "Authorization": f"Bearer {token}",
        })
        # Do not redirect scoped credentials to a different destination.
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *args, **kwargs):
                return None
        with urllib.request.build_opener(NoRedirect).open(request, timeout=15) as response:
            raw = response.read(1024 * 1024 + 1)
        if len(raw) > 1024 * 1024:
            return None
        result = json.loads(raw)
        return result
    except Exception:
        return None



_COMPARISON_SLOTS = threading.BoundedSemaphore(2)


def _schedule_comparison(receipt, baseline):
    if not isinstance(receipt, str) or len(receipt) != 32 or not callable(baseline):
        return
    if not _COMPARISON_SLOTS.acquire(blocking=False):
        return

    def run():
        try:
            value = baseline()
            if inspect.isawaitable(value):
                value = asyncio.run(value)
            _request("comparison", {"receipt": receipt, "value": value})
        except Exception:
            _request("comparison", {"receipt": receipt, "failed": True})
        finally:
            _COMPARISON_SLOTS.release()

    threading.Thread(target=run, name="evimed-judge-comparison", daemon=True).start()


def ask(site: str, input: dict, *, threshold: float = 0.9, baseline=None):
    """Return closed decisions and run sampled original checks outside delivery."""
    result = _request(site, input)
    if not isinstance(result, dict):
        return None
    confidence = result.get("confidence")
    if (result.get("outcome") != "settled" or isinstance(confidence, bool)
            or not isinstance(confidence, (int, float)) or not math.isfinite(confidence)
            or not threshold <= confidence <= 1):
        return None
    _schedule_comparison(result.get("comparisonReceipt"), baseline)
    return result.get("value")


async def ask_async(site: str, input: dict, *, threshold: float = 0.9, baseline=None):
    # Reuse the owning event loop for async engine clients and their connection pools.
    loop = asyncio.get_running_loop()
    def original():
        value = baseline()
        if inspect.isawaitable(value):
            future = asyncio.run_coroutine_threadsafe(value, loop)
            try:
                return future.result(timeout=25 * 60)
            finally:
                if not future.done():
                    future.cancel()
        return value
    return await asyncio.to_thread(ask, site, input, threshold=threshold,
                                   baseline=original if callable(baseline) else None)
