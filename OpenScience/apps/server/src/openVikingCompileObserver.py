"""Read only the fixed hosted OpenViking startup surface; never print secrets.

The controller supplies its reviewed source hashes, never a caller's paths.
No engine modules are imported and no provider or engine request is made.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import time

CONFIG_PATH = "/run/openviking-secrets/ov.conf"


class DefiniteRejection(ValueError):
    """A checked configuration/code condition, never a generic parser failure."""


def checked_bytes(path, limit):
    current = Path(path)
    for part in [current, *current.parents]:
        if part.is_symlink():
            raise DefiniteRejection("symlink")
    with open(path, "rb") as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_size > limit:
            raise DefiniteRejection("file")
        body = stream.read(limit + 1)
        after = os.fstat(stream.fileno())
    stamp = lambda info: [info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns]
    if len(body) > limit or stamp(before) != stamp(after) or stamp(after) != stamp(os.stat(path)):
        raise RuntimeError("file changed during observation")
    return body, stamp(after)


def process(pid):
    root = Path("/proc") / str(pid)
    args = root.joinpath("cmdline").read_bytes().split(b"\0")
    args = [os.fsdecode(part) for part in args if part]
    fields = root.joinpath("stat").read_bytes().rsplit(b") ", 1)[1].split()
    return {"pid": int(pid), "parent": int(fields[1]), "ticks": int(fields[19]), "args": args}


def environment(pid):
    entries = Path(f"/proc/{pid}/environ").read_bytes().split(b"\0")
    values = dict(entry.split(b"=", 1) for entry in entries if b"=" in entry)
    if any(key.upper().startswith(b"NANOBOT_") for key in values) or b"OPENVIKING_CONF_CONTENT" in values:
        raise DefiniteRejection("environment")
    if values.get(b"OPENVIKING_CONFIG_FILE") != CONFIG_PATH.encode("ascii"):
        raise DefiniteRejection("configuration path")
    # Unrelated environment values are opaque bytes, and never reach the
    # returned projection. A legitimate non-UTF-8 value is not unsafe config.
    return {"OPENVIKING_CONFIG_FILE": CONFIG_PATH,
            "VIKINGBOT_WITH_OPENVIKING_SERVER": os.fsdecode(values.get(b"VIKINGBOT_WITH_OPENVIKING_SERVER", b""))}


def observed_processes():
    servers, bots = [], []
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            item = process(entry.name)
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            continue
        args = item["args"]
        if "/app/.venv/bin/openviking-server" in args:
            start = args.index("/app/.venv/bin/openviking-server")
            if args[start + 1:] != ["--host", "0.0.0.0", "--port", "1933", "--with-bot"]:
                raise DefiniteRejection("server command")
            servers.append(item)
        if "/app/.venv/bin/vikingbot" in args or ("-m" in args and "vikingbot" in args):
            start = args.index("/app/.venv/bin/vikingbot") if "/app/.venv/bin/vikingbot" in args else args.index("vikingbot")
            if args[start + 1:] != ["gateway", "--host", "127.0.0.1", "--port", "18790", "--config", CONFIG_PATH]:
                raise DefiniteRejection("bot command")
            bots.append(item)
    if len(servers) != 1 or len(bots) != 1:
        raise RuntimeError("managed processes unavailable")
    if bots[0]["parent"] != servers[0]["pid"]:
        raise DefiniteRejection("process identity")
    server, bot = servers[0], bots[0]
    environment(server["pid"])
    if environment(bot["pid"]).get("VIKINGBOT_WITH_OPENVIKING_SERVER") != "1":
        raise DefiniteRejection("unmanaged bot")
    return server, bot


def observe(proof):
    before = observed_processes()
    body, config_stamp = checked_bytes(CONFIG_PATH, 1024 * 1024)
    if re.search(rb"\$(?:\{|[A-Za-z_])", body):
        raise DefiniteRejection("configuration interpolation")
    try:
        config = json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise DefiniteRejection("configuration parse") from error
    bot = config.get("bot", {})
    if not isinstance(bot, dict) or any(not re.fullmatch(r"[a-z][a-z0-9_]*", key) for key in bot):
        raise DefiniteRejection("configuration key alias")
    sandbox = bot.get("sandbox")
    expected = {"backend": "direct", "backends": {"direct": {"allow_exec": False, "allow_compile_exec": False}}}
    direct = sandbox.get("backends", {}).get("direct", {}) if isinstance(sandbox, dict) else {}
    if sandbox != expected or direct.get("allow_exec") is not False or direct.get("allow_compile_exec") is not False:
        raise DefiniteRejection("sandbox")
    ticks = os.sysconf("SC_CLK_TCK")
    boot_epoch = time.time() - time.clock_gettime(time.CLOCK_BOOTTIME)
    earliest_start = min(item["ticks"] for item in before) / ticks + boot_epoch - 1 / ticks
    if max(config_stamp[-2:]) / 1e9 >= earliest_start:
        raise DefiniteRejection("configuration changed after process start")
    code = []
    for entry in proof["files"]:
        source, _stamp = checked_bytes(entry["installedPath"], 2 * 1024 * 1024)
        sha = hashlib.sha256(source).hexdigest()
        if sha != entry["sha256"]:
            raise DefiniteRejection("implementation changed")
        code.append({"path": entry["installedPath"], "sha256": sha})
    after = observed_processes()
    final_body, final_stamp = checked_bytes(CONFIG_PATH, 1024 * 1024)
    if before != after or body != final_body or config_stamp != final_stamp:
        raise RuntimeError("observation changed")
    digest = lambda value: hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return {"configDigest": hashlib.sha256(body).hexdigest(), "configPath": CONFIG_PATH,
            "backend": "direct", "allowExec": False, "allowCompileExec": False,
            "codeDigest": digest(code), "processDigest": digest({"processes": before, "config": config_stamp})}


if __name__ == "__main__":
    try:
        print(json.dumps(observe(json.loads(sys.argv[1])), sort_keys=True))
    except DefiniteRejection:
        # A definite configuration/code/command rejection is distinct from an
        # unavailable process or filesystem. No exception text is returned.
        print('{"valid":false,"state":"rejected","code":"configuration_or_code_rejected"}')
        sys.exit(1)
    except Exception:
        # Parsing/IO errors can contain private configuration values.
        print('{"valid":false,"state":"unavailable","code":"observation_unavailable"}')
        sys.exit(1)
