"""Bounded runtime J18 annotations; related publications are never merged."""
import json
import math
import re
import time
import urllib.parse
import urllib.request
import public_sources


def ask_pair(left, right, timeout=3):
    settings = public_sources._gateway_settings()
    if not settings:
        return None
    url, token = settings
    url = urllib.parse.urljoin(url, "/internal/judge/v1/ask")
    def record(item):
        return {"title": str(item.get("title") or "")[:2048],
                "abstract": str(item.get("abstract") or "")[:20000]}
    body = json.dumps({"site": "J18", "input": {"left": record(left), "right": record(right)}}).encode()
    if len(body) > 128 * 1024:
        return None
    request = urllib.request.Request(url, data=body, method="POST",
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + token})
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None
    with urllib.request.build_opener(NoRedirect).open(request, timeout=timeout) as response:
        raw = response.read(128 * 1024 + 1)
    if len(raw) > 128 * 1024:
        return None
    result = json.loads(raw)
    confidence = result.get("confidence")
    if (result.get("outcome") != "settled" or isinstance(confidence, bool)
            or not isinstance(confidence, (int, float)) or not math.isfinite(confidence)
            or not .9 <= confidence <= 1):
        return None
    return result.get("value")


def annotate(items, *, ask=ask_pair, clock=time.monotonic):
    """Return separate links and unknown coverage, preserving every input row."""
    links, checked, unavailable = [], 0, 0
    deadline = clock() + 20
    stop = {"a", "an", "the", "of", "in", "and", "or", "for", "with", "to", "from", "by", "on",
            "trial", "study", "randomized", "randomised", "controlled", "patients", "results", "analysis"}
    def words(item):
        return set(re.findall(r"[\w]+", str(item.get("title") or "").casefold())) - stop
    indexed = [(item, words(item)) for item in items]
    limited = False
    for index, (left, left_words) in enumerate(indexed):
        for right_index, (right, right_words) in enumerate(indexed[index + 1:], index + 1):
            if len(left_words & right_words) < 2:
                continue
            if checked >= 40 or clock() >= deadline:
                limited = True
                break
            checked += 1
            try:
                result = ask(left, right, timeout=min(3, max(.1, deadline - clock())))
            except Exception:
                result = None
            if not isinstance(result, dict) or result.get("relation") not in {"same_trial", "different"}:
                unavailable += 1
            elif result["relation"] == "same_trial":
                links.append({"leftId": left.get("id") or "item-%d" % (index + 1),
                              "rightId": right.get("id") or "item-%d" % (right_index + 1),
                              "leftIndex": index, "rightIndex": right_index,
                              "relation": "suspected_same_trial", "merged": False})
        if limited:
            break
    return {"suspectedSameTrial": links, "trialLinkageReview": {
        "status": "incomplete" if limited or unavailable else "annotated",
        "candidatePairsReviewed": checked, "unresolvedPairs": unavailable,
        "candidateLimitReached": limited,
        "notice": "Publication records are retained. These candidate annotations do not establish independent trials; unresolved and unexamined pairs remain unknown."}}
