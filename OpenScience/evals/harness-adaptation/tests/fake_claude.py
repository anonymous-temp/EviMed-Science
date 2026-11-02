#!/usr/bin/env python3
"""A stand-in for the `claude` CLI as the improver channel calls it: prompt on stdin, one JSON result on stdout, files edited in cwd.

Which stage it is playing is read from the evidence layout in cwd (context/candidates = selector, context/adoption.json = reflector,
context/pool = composer, else an editor; the editor's dimension from the mission text). It appends one line per call to FAKE_CLAUDE_LOG
(model, whether an endpoint and a token were set, whether any Vertex or inherited Claude Code variable leaked in, the flags) and never the token.

  FAKE_CLAUDE_MODE   ok (default) | quota (429 for FAKE_CLAUDE_FAIL_MODEL) | transport | budget | badtree (the editors write a tree the guard refuses)
  FAKE_CLAUDE_FAIL_MODEL  the model id the failure applies to (default: every model)
"""
import hashlib
import json
import os
import pathlib
import sys

argv = sys.argv[1:]
mission = sys.stdin.read()
model = argv[argv.index("--model") + 1] if "--model" in argv else os.environ.get("ANTHROPIC_MODEL", "")
mode = os.environ.get("FAKE_CLAUDE_MODE", "ok")
fail_model = os.environ.get("FAKE_CLAUDE_FAIL_MODEL", "")
cwd = pathlib.Path.cwd()

leak = sorted(k for k in os.environ if k.startswith(("CLAUDE_CODE_", "CLAUDE_AGENT_", "VERTEX", "GOOGLE_CLOUD_")) and k not in ("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "CLAUDE_CODE_SUBAGENT_MODEL"))
leak += [k for k in ("CLAUDE_CODE_USE_VERTEX", "ANTHROPIC_VERTEX_PROJECT_ID", "CLOUD_ML_REGION", "ANTHROPIC_API_KEY") if k in os.environ]
token = os.environ.get("ANTHROPIC_AUTH_TOKEN", "")
with open(os.environ["FAKE_CLAUDE_LOG"], "a") as handle:
    handle.write(json.dumps({
        "model": model, "base_url": os.environ.get("ANTHROPIC_BASE_URL"), "token_sha": hashlib.sha256(token.encode()).hexdigest()[:12] if token else None,
        "leaked_env": leak, "flags": [a for a in argv if a.startswith("--")], "tools": argv[argv.index("--tools") + 1] if "--tools" in argv else None,
        "cwd_has_context": (cwd / "context").is_dir(), "mission_chars": len(mission), "haiku": os.environ.get("ANTHROPIC_DEFAULT_HAIKU_MODEL"),
    }) + "\n")


def reply(text, **extra):
    usage = {"input_tokens": 1200, "output_tokens": 300, "cache_read_input_tokens": 5000, "cache_creation_input_tokens": 0}
    out = {"type": "result", "subtype": "success", "is_error": False, "result": text, "total_cost_usd": 0.05, "num_turns": 4, "usage": usage,
           "permission_denials": [], "api_error_status": None}
    out.update(extra)
    print(json.dumps(out))
    sys.exit(0)


active = mode != "ok" and (not fail_model or fail_model == model)
if active:
    if mode == "quota":
        reply("5-hour limit reached - resets at 3pm", is_error=True, subtype="error_during_execution", api_error_status=429, usage={})
    if mode == "transport":
        sys.stderr.write("socket hang up\n")
        sys.exit(1)
    if mode == "hang":
        import time
        time.sleep(30)
    if mode == "budget":
        reply("", is_error=True, subtype="error_max_budget_usd")

ctx = cwd / "context"
if (ctx / "candidates").is_dir():
    candidates = sorted((ctx / "candidates").glob("*.md"))
    chosen = next((p.stem for p in candidates if "Final answer: 42" in p.read_text()), candidates[0].stem)
    reply(f"<why>\nThe candidate with the checked value is complete.\n</why>\n\n```choice\n{chosen}\n```")
if (ctx / "adoption.json").is_dir() or (ctx / "adoption.json").is_file():
    reply("<edits>\ncomponent: guidance.md\ncandidates: inv1, dom1\nchange: added a short verification rule\nobserved: the probe run recomputed the value in code before answering\n"
          "verdict: helped\n</edits>\n\n<experience>\ncue: When a request asks for one exact computed value\n"
          "lesson: Add a standing rule in guidance.md to recompute the value in code and state the final line last.\n"
          "evidence: The guidance.md row: the probe trajectory recomputed with a tool where the base trajectory answered from memory.\nconfidence: medium, one task\n</experience>")

harness = ctx / "harness"
guidance = harness / "guidance.md"
dim = "INVARIANT" if "INVARIANT" in mission else "DOMAIN" if "DOMAIN" in mission else "AGG"
if active and mode == "badtree":
    guidance.write_text("Remember 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 numbers everywhere.\n")
    reply("<notes>bad on purpose</notes>")
if (ctx / "pool").is_dir():
    merged = []
    for d in sorted((ctx / "pool").iterdir()):
        text = (d / "harness" / "guidance.md").read_text() if (d / "harness" / "guidance.md").is_file() else ""
        merged += [line for line in text.splitlines() if line.strip() and line not in merged]
    guidance.write_text("\n".join(merged) + "\n")
    reply("<notes>\nkept -> inv1 and dom1 rules -> both rollouts recomputed the value in code\n</notes>")
rule = "Recompute the requested value with a tool before answering, and keep the requested final line last." if dim == "INVARIANT" else "Name the definition you apply and check each input against the note before computing."
guidance.write_text(rule + "\n")
reply(f"<notes>\n{dim}: added one rule; moment: the base trajectory answered without a check.\n</notes>")
