"""Private, resumable HTTP receipts for the public-data component experiment.

Provider keys are loaded from operator-owned files, never from a dataset. This
module is evaluation tooling, not a runtime integration or a clinical data grant.
"""
from __future__ import annotations

import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import time
import urllib.error
import urllib.request

ENDPOINTS = {"deepseek": "https://api.deepseek.com/chat/completions",
             "typesafe": "https://api.typesafe.ai/v1/systemone",
             "dashscope": "https://dashscope.aliyuncs.com/compatible-api/v1/reranks"}

# Evaluation reference prices, CNY per million tokens. Mirrored from the
# platform's metering table for the frozen Flash/Pro comparison, 2026-11-02.
DEEPSEEK_RATES = {"deepseek-v4-flash": (.04, 2, 8),
                  "deepseek-v4-pro": (.3, 9, 27)}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """Never forward a provider credential to a redirect target."""
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.URLError("Provider redirect refused")


def request_digest(provider, payload):
    return digest({"endpoint": ENDPOINTS[provider], "payload": payload})


def model_matches(provider, requested, observed):
    if provider == "deepseek" and requested == "deepseek-v4-flash":
        return observed in ("deepseek-v4-flash", "deepseek-flash")
    # DashScope's documented response does not promise a model field.
    return observed == requested or (provider == "dashscope" and observed is None)


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                     separators=(",", ":")).encode()).hexdigest()


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + f".{os.getpid()}.tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    os.replace(temporary, path)


class ProviderClient:
    """One frozen attempt per label; failures are cached and never auto-selected away."""

    def __init__(self, out_dir: Path, config_file=None):
        self.out_dir = Path(out_dir)
        self.out_dir.mkdir(parents=True, exist_ok=True)
        config_file = config_file or os.environ.get("VCR_EVAL_PROVIDER_CONFIG")
        if not config_file:
            raise ValueError("Set VCR_EVAL_PROVIDER_CONFIG to a private key-path configuration.")
        self.config = json.loads(Path(config_file).read_text())

    def configured(self, provider):
        value = self.config.get(provider, {}).get("key_file")
        return bool(value and Path(value).is_file() and Path(value).stat().st_size)

    def request(self, provider, model, payload, label):
        if not re.fullmatch(r"[A-Za-z0-9_.-]+", label):
            raise ValueError("Unsafe receipt label")
        if payload.get("model") != model:
            raise ValueError("The requested model must match the payload")
        if provider == "deepseek" and model not in DEEPSEEK_RATES:
            raise ValueError("No frozen price for this DeepSeek model")
        cfg = self.config.get(provider, {})
        endpoint = cfg.get("endpoint", "")
        if endpoint != ENDPOINTS.get(provider):
            raise ValueError("Provider endpoint is not the frozen official endpoint")
        fingerprint = digest({"endpoint": endpoint, "payload": payload})
        receipt_path = self.out_dir / (label + ".json")
        # A lock also prevents two resumed workers from purchasing the same call.
        with (self.out_dir / (label + ".lock")).open("a+") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            if receipt_path.exists():
                cached = json.loads(receipt_path.read_text())
                if cached["request_sha256"] != fingerprint:
                    raise ValueError("Cached request differs; use a new frozen experiment name")
                return cached
            if not self.configured(provider):
                raise ValueError(f"{provider} credential is not configured")
            key = Path(cfg["key_file"]).read_text().strip()
            data = json.dumps(payload, ensure_ascii=False).encode()
            # A conservative UTF-8-byte token bound, including all output allowance.
            if provider == "deepseek":
                _, miss_rate, output_rate = DEEPSEEK_RATES[model]
                reserve = ((len(data) + 1000) * miss_rate + int(payload.get("max_tokens", 0)) * output_rate) / 1e6
            elif provider == "typesafe":
                reserve = (len(data) + 1000) * .042 / 1e6
            else:
                # Query may be charged with each candidate. Beijing public price,
                # checked 2026-11-02: CNY .5/M input tokens; not an invoice.
                reserve = (len(data) + len(str(payload.get("query", "")).encode()) * len(payload.get("documents", [])) + 1000) * .5 / 1e6
            ledger_path = self.out_dir / "spend.jsonl"
            currency = "USD" if provider == "typesafe" else "CNY"
            with ledger_path.open("a+") as ledger:
                fcntl.flock(ledger, fcntl.LOCK_EX)
                ledger.seek(0)
                previous = [json.loads(line) for line in ledger if line.strip()]
                selected = [r for r in previous if r["provider"] == provider]
                if any(r["label"] == label for r in selected):
                    raise ValueError("A prior attempt has no terminal receipt; its outcome and billing are uncertain")
                if len(selected) >= cfg.get("max_calls", 4000):
                    raise ValueError("Provider call ceiling reached")
                # A terminal usage receipt replaces its reservation; an
                # in-flight, failed or orphaned attempt retains the full bound.
                bound = 0
                for row in selected:
                    terminal = self.out_dir / (row["label"] + ".json")
                    settled = json.loads(terminal.read_text()) if terminal.exists() else None
                    cost = settled.get("cost") if isinstance(settled, dict) else None
                    bound += cost if type(cost) in (int, float) and math.isfinite(cost) and cost >= 0 else row["reservation"]
                if currency != "UNPRICED" and bound + reserve > cfg.get("budget", 30 if provider == "deepseek" else 2):
                    raise ValueError("Conservative provider budget reached")
                ledger.write(json.dumps({"label": label, "provider": provider, "currency": currency,
                                         "reservation": reserve, "request_sha256": fingerprint}) + "\n")
                ledger.flush()
            request = urllib.request.Request(endpoint, data=data, method="POST", headers={
                "Content-Type": "application/json", "Authorization": "Bearer " + key})
            proxies = {"https": cfg["proxy"]} if cfg.get("proxy") else {}
            opener = urllib.request.build_opener(urllib.request.ProxyHandler(proxies), NoRedirect())
            result = {"label": label, "provider": provider, "requested_model": model,
                      "request_sha256": fingerprint, "started_at_epoch": time.time(),
                      "status": None, "body": None, "error": None, "usage": {},
                      "cost": None, "currency": currency, "attempts": 1,
                      "reservation": reserve, "billing": "usage estimate, not invoice"}
            started = time.monotonic()
            try:
                with opener.open(request, timeout=cfg.get("timeout_s", 90)) as response:
                    result["status"] = response.status
                    raw = response.read(8 * 1024 * 1024 + 1)
                    if len(raw) > 8 * 1024 * 1024:
                        raise ValueError("Response too large")
                if key.encode() in raw:
                    raise ValueError("Credential-shaped response refused")
                body = json.loads(raw)
                if not isinstance(body, dict):
                    raise ValueError("Response must be an object")
                result["body"] = body
                usage = body.get("usage", {})
                result["usage"] = usage
                if provider == "deepseek":
                    integer = lambda x: type(x) is int and x >= 0
                    prompt, completion = usage.get("prompt_tokens"), usage.get("completion_tokens")
                    hit, miss = usage.get("prompt_cache_hit_tokens",0), usage.get("prompt_cache_miss_tokens",prompt)
                    cache_present = [key in usage for key in ("prompt_cache_hit_tokens","prompt_cache_miss_tokens")]
                    complete = integer(prompt) and integer(completion) and integer(hit) and integer(miss) and hit+miss==prompt and cache_present[0]==cache_present[1]
                    hit_rate, miss_rate, output_rate = DEEPSEEK_RATES[model]
                    if complete:
                        result["cost"] = (hit * hit_rate + miss * miss_rate + completion * output_rate) / 1e6
                if provider == "typesafe" and "input_tokens" in usage:
                    result["cost"] = usage["input_tokens"] * .042 / 1e6
                if provider == "dashscope":
                    tokens = usage.get("total_tokens", usage.get("input_tokens"))
                    if type(tokens) in (int, float) and tokens >= 0:
                        result["cost"] = tokens * .5 / 1e6
                if not model_matches(provider, model, body.get("model")):
                    result["error"] = "served_model_mismatch"
            except urllib.error.HTTPError as exc:
                result["status"] = exc.code
                result["error"] = f"http_{exc.code}"
            except Exception as exc:
                # Provider error bodies, URLs, request headers and keys never enter logs.
                result["error"] = "request_" + type(exc).__name__
            result["elapsed_s"] = time.monotonic() - started
            if result["error"]:
                result["billing"] = "unknown unless provider usage was returned"
            elif result['cost'] is None:
                result['billing'] = 'unknown: complete valid provider usage was not returned'
            write_json(receipt_path, result)
            return result
