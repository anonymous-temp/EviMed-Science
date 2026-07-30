#!/usr/bin/env python3
"""Collect open-domain answers for the answer-quality eval.

Live mode (default): drives a running OpenScience server through the same
dispatch flow the desktop uses (login -> ensure project -> start runtime ->
open-domain session -> dispatch -> poll -> read messages), and writes
results/answers-<timestamp>.json plus results/answers-latest.json.

Offline mode: --answers-file <json> skips collection entirely, normalizes the
pre-collected answers into results/answers-latest.json, and judges them via
judge.py, so the harness is always usable without a server.

Live-mode environment:
  OPEN_SCIENCE_EVAL_BASE_URL  server URL (default http://127.0.0.1:8798)
  OPEN_SCIENCE_EVAL_USERNAME  local-auth username (default evimed)
  OPEN_SCIENCE_EVAL_PASSWORD  local-auth password; falls back to the local
                              secrets file .evimed-local/secrets/bootstrap-password
  OPEN_SCIENCE_EVAL_PROJECT   project id for the runs (default eval-open-domain-quality-v1)
The server has no bearer-token auth: it issues a session cookie plus a CSRF
token at login, which this script then sends on every request.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import http.cookiejar
import json
import os
import shutil
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any


HERE = Path(__file__).resolve().parent
WORKSPACE_ROOT = HERE.parents[2]
RESULTS_DIR = HERE / "results"
BOOTSTRAP_PASSWORD_FILE = WORKSPACE_ROOT / ".evimed-local" / "secrets" / "bootstrap-password"
DEFAULT_BASE_URL = "http://127.0.0.1:8798"
DEFAULT_PROJECT_ID = "eval-open-domain-quality-v1"
DEFAULT_PROJECT_NAME = "开放域答案质量评测"
ACTIVE_RUN_STATES = {"queued", "dispatching", "running"}
ANSWER_ARTIFACT_MAX_CHARS = 200_000
REPORT_ARTIFACT_EXCERPT_CHARS = 60_000

sys.path.insert(0, str(HERE))
import judge  # noqa: E402  (same-directory module)


class EvalError(RuntimeError):
    """Collection failure with an actionable message."""


class HttpFailure(EvalError):
    def __init__(self, method: str, url: str, status: int, detail: str):
        super().__init__(f"{method} {url} -> HTTP {status}: {detail[:400]}")
        self.status = status


def http_json(
    opener: urllib.request.OpenerDirector,
    method: str,
    url: str,
    body: Any = None,
    headers: dict[str, str] | None = None,
    timeout: int = 60,
) -> Any:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    request = urllib.request.Request(url, data=data, method=method)
    request.add_header("Accept", "application/json")
    if data is not None:
        request.add_header("Content-Type", "application/json")
    for key, value in (headers or {}).items():
        request.add_header(key, value)
    try:
        with opener.open(request, timeout=timeout) as response:
            raw = response.read(4 * 1024 * 1024)
    except urllib.error.HTTPError as error:
        detail = error.read(64_000).decode("utf-8", "replace")
        raise HttpFailure(method, url, error.code, detail) from error
    except urllib.error.URLError as error:
        raise EvalError(
            f"{method} {url} failed: {error.reason}. Is an OpenScience server running at that URL? "
            "(start one with `pnpm dev:server`, or use --answers-file for offline judging)"
        ) from error
    text = raw.decode("utf-8", "replace")
    if not text.strip():
        return {}
    try:
        return json.loads(text)
    except json.JSONDecodeError as error:
        raise EvalError(f"{method} {url} returned non-JSON: {text[:200]}") from error


def unwrap(payload: Any, what: str) -> Any:
    if not isinstance(payload, dict) or "data" not in payload:
        raise EvalError(f"unexpected {what} response shape: {str(payload)[:200]}")
    return payload["data"]


# ---------------------------------------------------------------------------
# Live-mode server flow
# ---------------------------------------------------------------------------


def resolve_password() -> str:
    password = os.environ.get("OPEN_SCIENCE_EVAL_PASSWORD", "").strip()
    if password:
        return password
    try:
        return BOOTSTRAP_PASSWORD_FILE.read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def login(base: str, opener: urllib.request.OpenerDirector) -> str:
    """Authenticate; returns the CSRF token (empty when the server skips CSRF)."""
    username = os.environ.get("OPEN_SCIENCE_EVAL_USERNAME", "evimed").strip() or "evimed"
    password = resolve_password()
    if not password:
        raise EvalError(
            "No server password. Set OPEN_SCIENCE_EVAL_PASSWORD or provide "
            f"{BOOTSTRAP_PASSWORD_FILE} (never commit it)."
        )
    try:
        payload = http_json(
            opener, "POST", f"{base}/api/auth/login", {"username": username, "password": password}
        )
        data = unwrap(payload, "login")
        token = data.get("csrfToken") if isinstance(data, dict) else None
        if not isinstance(token, str) or not token:
            raise EvalError("login succeeded but returned no csrfToken; cannot continue")
        return token
    except HttpFailure as error:
        if error.status == 401:
            raise EvalError(
                "Login rejected (401 invalid_credentials). Check OPEN_SCIENCE_EVAL_USERNAME / "
                "OPEN_SCIENCE_EVAL_PASSWORD."
            ) from error
        if error.status != 404:
            raise
    # Local password auth disabled: try the development auto-login.
    try:
        http_json(opener, "POST", f"{base}/api/auth/dev-login", {})
        return ""  # dev-auth servers skip the CSRF check entirely
    except HttpFailure as error:
        if error.status == 404:
            raise EvalError(
                "This server supports neither local password login nor dev-login (it is probably "
                "OIDC-hosted, which needs an interactive browser sign-in). Options: run a local-auth "
                "server (`pnpm dev:server`) and point OPEN_SCIENCE_EVAL_BASE_URL at it, or collect "
                "answers through the UI and judge them offline with --answers-file."
            ) from error
        raise


def ensure_project(base: str, headers: dict[str, str], opener: urllib.request.OpenerDirector) -> str:
    project_id = os.environ.get("OPEN_SCIENCE_EVAL_PROJECT", DEFAULT_PROJECT_ID).strip() or DEFAULT_PROJECT_ID
    projects = unwrap(http_json(opener, "GET", f"{base}/api/projects", headers=headers), "project list")
    if not any(isinstance(item, dict) and item.get("id") == project_id for item in projects):
        http_json(
            opener,
            "POST",
            f"{base}/api/projects",
            {"id": project_id, "name": DEFAULT_PROJECT_NAME},
            headers=headers,
        )
    return project_id


def start_runtime(base: str, headers: dict[str, str], opener: urllib.request.OpenerDirector) -> str:
    payload = http_json(opener, "POST", f"{base}/api/commands/start_runtime", {}, headers=headers, timeout=180)
    runtime_url = unwrap(payload, "start_runtime")
    if not isinstance(runtime_url, str) or not runtime_url.startswith("http"):
        raise EvalError(f"start_runtime returned an unexpected value: {str(runtime_url)[:200]}")
    return runtime_url.rstrip("/")


def message_texts(messages: list[dict[str, Any]], role: str) -> list[str]:
    """Return one entry per message, in order, for the given role."""
    texts: list[str] = []
    for message in messages:
        if not isinstance(message, dict) or message.get("info", {}).get("role") != role:
            continue
        parts = [
            part["text"].strip()
            for part in message.get("parts") or []
            if isinstance(part, dict)
            and part.get("type") == "text"
            and not part.get("synthetic")
            and isinstance(part.get("text"), str)
            and part["text"].strip()
        ]
        if parts:
            texts.append("\n\n".join(parts))
    return texts


SUBSTANTIVE_TEXT_SHARE = 0.25


def message_text(messages: list[dict[str, Any]], role: str) -> str:
    """The reply a user reads.

    An agent narrates between tool calls, and every one of those turns is an
    assistant message, so joining them all judges the transcript. Taking only
    the last one is wrong the other way: an agent that delivers its report and
    then adds a short wrap-up would be judged on the wrap-up. Start from the
    last substantive message and keep everything after it.
    """
    texts = message_texts(messages, role)
    if not texts:
        return ""
    threshold = max(len(text) for text in texts) * SUBSTANTIVE_TEXT_SHARE
    start = max(index for index, text in enumerate(texts) if len(text) >= threshold)
    return "\n\n".join(texts[start:])


def tool_call_count(messages: list[dict[str, Any]]) -> int:
    return sum(
        1
        for message in messages
        if isinstance(message, dict)
        for part in message.get("parts") or []
        if isinstance(part, dict) and part.get("type") == "tool"
    )


def wait_for_run(
    base: str, headers: dict[str, str], opener: urllib.request.OpenerDirector, run_id: str, timeout_minutes: int
) -> dict[str, Any]:
    deadline = time.monotonic() + timeout_minutes * 60
    while time.monotonic() < deadline:
        payload = http_json(opener, "GET", f"{base}/api/agent-runs?limit=200", headers=headers)
        runs = unwrap(payload, "agent run list")
        run = next((item for item in runs if isinstance(item, dict) and item.get("id") == run_id), None)
        if run and run.get("status") not in ACTIVE_RUN_STATES:
            return run
        time.sleep(5)
    raise EvalError(f"run {run_id} did not reach a terminal state within {timeout_minutes} minutes")


def capture_artifacts(
    base: str, headers: dict[str, str], opener: urllib.request.OpenerDirector, paths: list[str]
) -> list[dict[str, Any]]:
    captured: list[dict[str, Any]] = []
    for artifact_path in paths[:10]:
        try:
            payload = http_json(
                opener, "POST", f"{base}/api/commands/read_artifact", {"path": artifact_path}, headers=headers
            )
            data = unwrap(payload, "read_artifact")
            captured.append(
                {
                    "path": artifact_path,
                    "encoding": data.get("encoding", "") if isinstance(data, dict) else "",
                    "data": (data.get("data", "") if isinstance(data, dict) else "")[:ANSWER_ARTIFACT_MAX_CHARS],
                }
            )
        except EvalError as error:
            captured.append({"path": artifact_path, "error": str(error)[:300]})
    return captured


def collect_one(
    question: dict[str, Any],
    base: str,
    runtime_url: str,
    headers: dict[str, str],
    opener: urllib.request.OpenerDirector,
    timeout_minutes: int,
) -> dict[str, Any]:
    session = http_json(opener, "POST", f"{runtime_url}/session", {}, headers=headers)
    session_id = session.get("id")
    if not isinstance(session_id, str) or not session_id:
        raise EvalError(f"runtime did not return a session id: {str(session)[:200]}")
    http_json(
        opener,
        "PUT",
        f"{base}/api/research-sessions/{urllib.parse.quote(session_id)}",
        {"mode": "open-domain"},
        headers=headers,
    )
    # Dispatch ids must be unique per collection attempt: the server dedupes
    # dispatches by dispatchId, so a deterministic id would idempotently replay
    # the PREVIOUS run record and this new session would be read as 0 chars.
    dispatch_id = f"eval_oda_{question['id']}_{uuid.uuid4().hex[:10]}".replace("-", "_")
    dispatched = http_json(
        opener,
        "POST",
        f"{base}/api/agent-runs/dispatch",
        {"sessionId": session_id, "dispatchId": dispatch_id, "text": question["question"]},
        headers=headers,
    )
    run_id = unwrap(dispatched, "dispatch").get("id")
    terminal = wait_for_run(base, headers, opener, run_id, timeout_minutes)
    messages_payload = http_json(
        opener, "GET", f"{runtime_url}/session/{urllib.parse.quote(session_id)}/message", headers=headers
    )
    messages = messages_payload if isinstance(messages_payload, list) else []
    assistant_messages = message_texts(messages, "assistant")
    assistant_text = assistant_messages[-1] if assistant_messages else ""
    artifacts = capture_artifacts(base, headers, opener, terminal.get("artifacts") or [])
    # Prefer the written report over the largest file: a specialist run's biggest
    # utf8 artifact is usually a JSON evidence snapshot, and appending that to the
    # answer is what makes the reply unreadable.
    readable = [
        item for item in artifacts
        if item.get("encoding") == "utf8" and isinstance(item.get("data"), str) and item["data"].strip()
    ]
    reports = [item for item in readable if str(item.get("path", "")).lower().endswith((".md", ".markdown"))]
    preferred = reports or [item for item in readable if not str(item.get("path", "")).lower().endswith(".json")]
    artifact_text = max(preferred, key=lambda item: len(item["data"]))["data"] if preferred else ""

    answer = assistant_text
    if question["tier"] == "report" and artifact_text:
        answer = (
            f"{assistant_text}\n\n---\n（以下为本次运行生成的报告正文节选）\n\n"
            f"{artifact_text[:REPORT_ARTIFACT_EXCERPT_CHARS]}"
        ).strip()

    return {
        "id": question["id"],
        "tier": question["tier"],
        "question": question["question"],
        "answer": answer,
        "run": {
            "runId": terminal.get("id"),
            "status": terminal.get("status"),
            "dispatchStatus": terminal.get("dispatchStatus"),
            "durationMs": terminal.get("durationMs"),
            "model": terminal.get("model"),
            "errorCode": terminal.get("errorCode"),
            "qualityNotices": terminal.get("qualityNotices") or [],
            "narrationMessages": max(0, len(assistant_messages) - 1),
            "sessionId": session_id,
            "toolCalls": tool_call_count(messages),
            "artifacts": [item.get("path", "") for item in artifacts],
            "assistantChars": len(assistant_text),
            "reportArtifactChars": len(artifact_text),
        },
        "error": None if terminal.get("status") == "succeeded" and answer else f"run status: {terminal.get('status')}",
    }


def collect_live(questions: list[dict[str, Any]], args: argparse.Namespace) -> list[dict[str, Any]]:
    base = os.environ.get("OPEN_SCIENCE_EVAL_BASE_URL", DEFAULT_BASE_URL).strip().rstrip("/") or DEFAULT_BASE_URL
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    csrf = login(base, opener)
    headers = {"X-Open-Science-CSRF": csrf} if csrf else {}
    project_id = ensure_project(base, headers, opener)
    headers = {**headers, "X-Open-Science-Project": project_id}
    runtime_url = start_runtime(base, headers, opener)
    print(f"[live] base={base} project={project_id} runtime={runtime_url}")

    previous: dict[str, dict[str, Any]] = {}
    latest_path = RESULTS_DIR / "answers-latest.json"
    if not args.rerun and latest_path.is_file():
        try:
            for entry in judge.load_answers(latest_path):
                if entry["answer"].strip() and entry["run"].get("status") == "succeeded":
                    previous[entry["id"]] = entry
        except (ValueError, json.JSONDecodeError):
            pass

    results: list[dict[str, Any] | None] = [None] * len(questions)
    pending: list[tuple[int, dict[str, Any]]] = []
    for index, question in enumerate(questions):
        if question["id"] in previous:
            print(f"[skip] {question['id']} (already collected; use --rerun to refresh)")
            entry = previous[question["id"]]
            entry.setdefault("tier", question["tier"])
            entry.setdefault("question", question["question"])
            results[index] = entry
        else:
            pending.append((index, question))

    # urllib openers are not thread-safe, so each worker builds its own opener
    # around the shared (now read-only) login CookieJar.

    def worker(item: tuple[int, dict[str, Any]]) -> None:
        index, question = item
        print(f"[start] {question['id']} ({question['tier']}) {question['question'][:40]}...")
        worker_opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
        try:
            results[index] = collect_one(
                question, base, runtime_url, headers, worker_opener, args.timeout_minutes
            )
            status = results[index]["run"]["status"]
            chars = len(results[index]["answer"])
            print(f"[done] {question['id']} {status} answer={chars} chars")
        except Exception as error:  # per-question isolation: keep collecting the rest
            results[index] = {
                "id": question["id"],
                "tier": question["tier"],
                "question": question["question"],
                "answer": "",
                "run": {"status": "error"},
                "error": str(error)[:500],
            }
            print(f"[error] {question['id']} {error}")

    workers = max(1, min(args.workers, 3))
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
        list(executor.map(worker, pending))

    return [entry for entry in results if entry is not None]


# ---------------------------------------------------------------------------
# Offline mode + output
# ---------------------------------------------------------------------------


def normalize_offline_answers(answers_path: Path, questions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_id = {question["id"]: question for question in questions}
    normalized: list[dict[str, Any]] = []
    for entry in judge.load_answers(answers_path):
        question = by_id.get(entry["id"])
        normalized.append(
            {
                "id": entry["id"],
                "tier": question["tier"] if question else "unknown",
                "question": question["question"] if question else "",
                "answer": entry["answer"],
                "run": entry["run"],
                "error": entry.get("error"),
            }
        )
    return normalized


def write_answers(entries: list[dict[str, Any]], meta: dict[str, Any]) -> Path:
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    document = {
        "schemaVersion": 1,
        "collectedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        **meta,
        "answers": entries,
    }
    text = json.dumps(document, ensure_ascii=False, indent=2) + "\n"
    output_path = RESULTS_DIR / f"answers-{stamp}.json"
    output_path.write_text(text, encoding="utf-8")
    shutil.copyfile(output_path, RESULTS_DIR / "answers-latest.json")
    print(f"answers: {output_path} (also copied to answers-latest.json)")
    return output_path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--questions", type=Path, default=judge.QUESTIONS_FILE)
    parser.add_argument(
        "--answers-file",
        type=Path,
        help="offline mode: skip collection, normalize this file to answers-latest.json and judge it",
    )
    parser.add_argument("--only", default="", help="comma-separated question ids to collect")
    parser.add_argument("--start", type=int, default=0)
    parser.add_argument("--limit", type=int, default=0, help="0 means all remaining questions")
    parser.add_argument("--workers", type=int, default=1, help="concurrent dispatches (1-3)")
    parser.add_argument("--timeout-minutes", type=int, default=30, help="per-run terminal-state timeout")
    parser.add_argument("--rerun", action="store_true", help="ignore previously collected answers")
    parser.add_argument("--judge-workers", type=int, default=2)
    args = parser.parse_args()

    questions = judge.load_questions(args.questions)
    if args.only:
        wanted = {item.strip() for item in args.only.split(",") if item.strip()}
        unknown = wanted - {question["id"] for question in questions}
        if unknown:
            raise SystemExit(f"Unknown --only id(s): {', '.join(sorted(unknown))}")
        questions = [question for question in questions if question["id"] in wanted]
    else:
        questions = questions[args.start :]
        if args.limit:
            questions = questions[: args.limit]
    if not questions:
        raise SystemExit("No questions selected.")

    if args.answers_file:
        entries = normalize_offline_answers(args.answers_file, judge.load_questions(args.questions))
        output_path = write_answers(entries, {"mode": "offline", "sourceFile": str(args.answers_file)})
        judge.judge_file(output_path, judge.load_questions(args.questions), workers=args.judge_workers)
        return 0

    try:
        entries = collect_live(questions, args)
    except EvalError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    collected = sum(1 for entry in entries if entry["answer"].strip())
    failed = len(entries) - collected
    base = os.environ.get("OPEN_SCIENCE_EVAL_BASE_URL", DEFAULT_BASE_URL).strip().rstrip("/")
    output_path = write_answers(entries, {"mode": "live", "baseUrl": base})
    print(f"collected {collected}/{len(entries)} answers ({failed} failed)")
    if collected == 0:
        print("No answers collected; not judging. Fix the errors above and re-run.", file=sys.stderr)
        return 2
    judge.judge_file(output_path, judge.load_questions(args.questions), workers=args.judge_workers)
    if failed:
        print(f"warning: {failed} question(s) failed to collect; report covers the rest.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
