#!/usr/bin/env python3
"""The RSI lab's Compose stack on a GitHub Actions runner: from the CI release images to a stack a lane can use.

Python 3 standard library only; run as root on a disposable runner (the workflow's root shell). Nothing here prints a secret, a prompt or
a model output: every line is a counter, a name or a bounded code.

  stack.py images  --archive DIR            verify and load the CI release archive; write $LAB_WORK/images.json
  stack.py build-delta --patch-src DIR --key K   build a candidate runtime image from the loaded base with Dockerfile.delta
  stack.py env     --lanes N [--runtime-image TAG]   write deploy/web/.env.lab, the secret files and the seeded data volume
  stack.py up                               start the stack (the services listed in SERVICES) and wait until the web API answers
  stack.py ready                            print the readiness checks that are not ok (codes only)
  stack.py health                           exit 0 when the stack is fit to take the next item; restart what died
  stack.py verify                           the lab's own checks: dataset hosts unreachable, runtime keyless, sandbox level
  stack.py selfcheck                        register and delete one throwaway account through the product's own helper
  stack.py diagnose [--logs]                container state (and redacted log tails)
  stack.py down                             stop and remove everything

Environment: LAB_WORK (scratch, default $RUNNER_TEMP/lab), LAB_SRC (the OpenScience directory of the source checkout), LAB_BUNDLE (the
decoded RSI_LAB_BUNDLE: secrets/ and broker/).
"""
import argparse
import hashlib
import json
import os
import pathlib
import re
import secrets as token_source
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

HERE = pathlib.Path(__file__).resolve().parent
WORK = pathlib.Path(os.environ.get("LAB_WORK") or os.path.join(os.environ.get("RUNNER_TEMP", "/tmp"), "lab"))
SRC = pathlib.Path(os.environ.get("LAB_SRC") or "OpenScience").resolve()
BUNDLE = pathlib.Path(os.environ.get("LAB_BUNDLE") or WORK / "bundle")
WEB_DIR = SRC / "deploy" / "web"
SECRETS_DIR = WEB_DIR / "secrets"
ENV_FILE = WEB_DIR / ".env.lab"
API = "http://127.0.0.1:8787"

COMPOSE_FILES = ["docker-compose.yml", "docker-compose.local-auth.yml", "docker-compose.backup.yml", "docker-compose.result-replay.yml"]
OVERLAY = HERE / "docker-compose.lab.yml"
PROFILES = ["backup", "web-search"]
SERVICES = ["evimed-postgres", "open-science-web-search", "open-science-runtime-controller", "evimed-drug-evidence-adapter", "result-replay",
            "open-science-backup", "open-science-web"]

# Levers copied from production's .env as read on 2026-11-01 (see ENV-DIFFERENCES.md). Anything production sets that is neither here
# nor in LAB_OVERRIDES is a lever the lab leaves at the code's default or does not use at all, and the document says which.
PARITY = {
    "OPEN_SCIENCE_DEPLOYMENT_PROFILE": "controlled-pilot",
    "OPEN_SCIENCE_APP_VERSION": "0.1.3",
    "OPEN_SCIENCE_AUTH_MODE": "local",
    "OPEN_SCIENCE_MAX_PROJECTS_PER_USER": "20",
    "OPEN_SCIENCE_SESSION_TTL_MS": "604800000",
    "OPEN_SCIENCE_RUNTIME_MODE": "kernel",
    "OPEN_SCIENCE_RUNTIME_SANDBOX_MODE": "docker",
    "OPEN_SCIENCE_RUNTIME_CONTROLLER_TIMEOUT_MS": "30000",
    "OPEN_SCIENCE_RUNTIME_CONTROLLER_POLL_MS": "500",
    "OPEN_SCIENCE_RUNTIME_REQUIRE_IMAGE_LOCAL": "true",
    "OPEN_SCIENCE_RUNTIME_TRANSPORT": "unix",
    "OPEN_SCIENCE_RUNTIME_NETWORK_MODE": "open-science-runtime-internal",
    "OPEN_SCIENCE_RUNTIME_INTERNAL_NETWORK_NAME": "open-science-runtime-internal",
    "OPEN_SCIENCE_ALLOW_RUNTIME_NETWORK_EGRESS": "false",
    "OPEN_SCIENCE_RUNTIME_NETWORK_EGRESS_POLICY_ACK": "false",
    "OPEN_SCIENCE_RUNTIME_CPU_LIMIT": "2",
    "OPEN_SCIENCE_RUNTIME_MEMORY_LIMIT": "3g",
    "OPEN_SCIENCE_RUNTIME_PIDS_LIMIT": "1024",
    "OPEN_SCIENCE_RUNTIME_READ_ONLY_ROOT": "true",
    "OPEN_SCIENCE_RUNTIME_TMPFS": "/tmp:rw,nosuid,nodev,size=64m",
    "OPEN_SCIENCE_EVIMED_MCP_SOURCE_DIR": "/app/runtime/mcp/evimed-research",
    "OPEN_SCIENCE_DEEPSEEK_PROVIDER_ENABLED": "true",
    "OPEN_SCIENCE_REQUIRE_MATERIALS_PROJECT": "true",
    "OPEN_SCIENCE_DEEPSEEK_MODEL": "deepseek-flash",
    "OPEN_SCIENCE_DEEPSEEK_REASONING_EFFORT": "high",
    "OPEN_SCIENCE_LLM_ROUTING_ENABLED": "true",
    "OPEN_SCIENCE_LLM_ROUTING_CONFIDENCE_THRESHOLD": "0.75",
    "OPEN_SCIENCE_LEARNING_ENABLED": "true",
    "OPEN_SCIENCE_LEARNING_CONCURRENCY": "2",
    "OPEN_SCIENCE_RUNTIME_UI_PROXY_ENABLED": "true",
    "OPEN_SCIENCE_RUNTIME_UI_PORT": "8788",
    "OPEN_SCIENCE_PUBLIC_SOURCE_GATEWAY_TIMEOUT_MS": "60000",
    "OPEN_SCIENCE_PUBLIC_SOURCE_GATEWAY_MAX_RESPONSE_BYTES": "16777216",
    "OPEN_SCIENCE_MODEL_GATEWAY_TIMEOUT_MS": "300000",
    "OPEN_SCIENCE_MODEL_GATEWAY_MAX_BODY_BYTES": "12582912",
    "OPEN_SCIENCE_MODEL_GATEWAY_MAX_RESPONSE_BYTES": "33554432",
    "OPEN_SCIENCE_AUTOPILOT_ENABLED": "true",
    "OPEN_SCIENCE_REQUIRE_INBOX": "true",
    "OPEN_SCIENCE_ALLOW_UNSANDBOXED_RUNTIME": "false",
    "OPEN_SCIENCE_ALLOW_DIRECT_SHELL": "false",
    "OPEN_SCIENCE_ALLOW_PERSISTENT_APPROVALS": "false",
    "OPEN_SCIENCE_ALLOW_FULL_APPROVAL": "false",
    "OPEN_SCIENCE_ENABLE_KERNEL": "true",
    "OPEN_SCIENCE_KERNEL_SANDBOX_MODE": "docker",
    "OPEN_SCIENCE_ALLOW_UNSANDBOXED_KERNEL": "false",
    "OPEN_SCIENCE_MAX_PROJECT_BYTES": "1073741824",
    "OPEN_SCIENCE_MAX_JSON_BYTES": "12582912",
    "OPEN_SCIENCE_MAX_FILE_BYTES": "52428800",
    "OPEN_SCIENCE_PROXY_MAX_BODY_SIZE": "73408512",
    "OPEN_SCIENCE_MAX_WORKSPACE_SCAN_ENTRIES": "100000",
    "OPEN_SCIENCE_MAX_ARCHIVE_ENTRIES": "100000",
    "OPEN_SCIENCE_MAX_ARCHIVE_BYTES": "1073741824",
    "OPEN_SCIENCE_MAX_PROJECT_USAGE_SCAN_ENTRIES": "100000",
    "OPEN_SCIENCE_MAX_LOG_READ_BYTES": "1048576",
    "OPEN_SCIENCE_MAX_LOG_FILE_BYTES": "10485760",
    "OPEN_SCIENCE_KERNEL_MAX_OUTPUT_BYTES": "1048576",
    "OPEN_SCIENCE_KERNEL_TIMEOUT_MS": "10000",
    "OPEN_SCIENCE_MAX_CONCURRENT_COMMANDS": "8",
    "OPEN_SCIENCE_MAX_CONCURRENT_KERNELS": "2",
    "OPEN_SCIENCE_MAX_CONCURRENT_KERNELS_PER_USER": "1",
    "OPEN_SCIENCE_MAX_CONCURRENT_TASKS_PER_PROJECT": "1",
    "OPEN_SCIENCE_MAX_QUEUED_TASKS": "100",
    "OPEN_SCIENCE_MAX_QUEUED_TASKS_PER_PROJECT": "25",
    "OPEN_SCIENCE_COMMAND_TIMEOUT_MS": "120000",
    "OPEN_SCIENCE_RUNTIME_PROXY_CONNECT_TIMEOUT_MS": "90000",
    "OPEN_SCIENCE_RUNTIME_PROXY_REQUEST_TIMEOUT_MS": "120000",
    "OPEN_SCIENCE_RUNTIME_IDLE_TIMEOUT_MS": "43200000",
    "OPEN_SCIENCE_RUNTIME_QUOTA_CHECK_INTERVAL_MS": "30000",
    "OPEN_SCIENCE_MAX_RUNTIME_PROXY_CONNECTIONS": "64",
    "OPEN_SCIENCE_MAX_RUNTIME_PROXY_CONNECTIONS_PER_PROJECT": "8",
    "OPEN_SCIENCE_RATE_LIMIT_MAX_REQUESTS": "600",
    "OPEN_SCIENCE_AUTH_RATE_LIMIT_MAX_REQUESTS": "20",
    "OPEN_SCIENCE_COMMAND_RATE_LIMIT_MAX_REQUESTS": "120",
    "OPEN_SCIENCE_TRUST_PROXY": "true",
    "OPEN_SCIENCE_RUNTIME_IDLE_YIELD_AFTER_MS": "120000",
    "OPEN_SCIENCE_WEB_SEARCH_BAILIAN_ENABLED": "true",
    "OPEN_SCIENCE_REVIEW_ENABLED": "true",
    "OPEN_SCIENCE_SELF_REGISTRATION_ENABLED": "1",
    "OPEN_SCIENCE_USER_DAILY_SPEND_LIMIT": "0",
    "OPEN_SCIENCE_USER_WEEKLY_SPEND_LIMIT": "0",
    "OPEN_SCIENCE_USER_RUN_SPEND_LIMIT": "0",
    "OPEN_SCIENCE_EVIMED_CREDITS_PER_CNY": "1",
    "OPEN_SCIENCE_EVIMED_CREDITS_ENABLED": "true",
    "OPEN_SCIENCE_EVIMED_CREDITS_SIMULATED": "true",
    "OPEN_SCIENCE_RESEARCH_BILLING_ENABLED": "true",
    "OPEN_SCIENCE_AVAILABILITY_ENABLED": "true",
    "OPEN_SCIENCE_LEARNING_EVIDENCE_OUTCOMES_ENABLED": "true",
    "OPEN_SCIENCE_ENGINE_MODEL_GATEWAY_ENABLED": "true",
    "OPEN_SCIENCE_SPECIALIST_MAX_CONCURRENT_JOBS": "1",
    "OPEN_SCIENCE_RUNTIME_SKILL_DIRS": "runtime/skills/core,runtime/skills/curated-scientific,runtime/skills/office,runtime/skills/community,runtime/skills/geo-private,capability-skills",
    "OPEN_SCIENCE_DEEPSEEK_RELEASE_RECEIPT_MAX_AGE_MS": "86400000",
    "OPEN_SCIENCE_LEARNING_WINDOW": "",
}


def lab_overrides(lanes):
    """Differences from production, name -> (lab value, why). ENV-DIFFERENCES.md carries the same list in prose."""
    return {
        "OPEN_SCIENCE_PUBLIC_URL": ("http://127.0.0.1:8787", "no TLS terminator: the driver's Origin must equal the request's own origin, which the control plane "
                                    "computes from this scheme (https here would refuse every registration with 403 csrf_required)"),
        "OPEN_SCIENCE_DOMAIN": ("localhost", "no public address"),
        "OPEN_SCIENCE_RUNTIME_UI_PUBLIC_ORIGIN": ("https://localhost:8443", "no public address; readiness wants an https origin for the kernel page"),
        "OPEN_SCIENCE_OPENVIKING_URL": ("", "no context engine"),
        "OPEN_SCIENCE_MEMORY_ENABLED": ("false", "no context engine: memory is off, nothing is recalled or kept"),
        "OPEN_SCIENCE_MEMORY_INDEX_STRICT": ("false", "same as production"),
        "OPEN_SCIENCE_SOURCE_INGESTION_ENABLED": ("false", "no OpenList and no parsing API; the benchmarks upload into the workspace"),
        "OPEN_SCIENCE_REQUIRE_DOCUMENT_PARSER": ("false", "no parsing API key"),
        "OPEN_SCIENCE_REQUIRE_ALL_SPECIALIST_ADAPTERS": ("false", "the six specialist engines are not run"),
        "OPEN_SCIENCE_VCR_ENABLED": ("false", "module off"),
        "OPEN_SCIENCE_GEO_ENABLED": ("false", "module off"),
        "OPEN_SCIENCE_FRONTIER_ENABLED": ("false", "module off"),
        "OPEN_SCIENCE_EVOLUTION_ENABLED": ("false", "module off"),
        "OPEN_SCIENCE_IM_ENABLED": ("false", "no messaging channel"),
        "OPEN_SCIENCE_WEB_RENDER_ENABLED": ("false", "no cloud browser account"),
        "OPEN_SCIENCE_MANAGED_BROWSER_ENABLED": ("false", "the managed browser container is not run"),
        "OPEN_SCIENCE_WEB_SEARCH_URL": ("http://open-science-web-search:8080/search", "the bundled SearXNG, direct (no Tokyo edge)"),
        "OPEN_SCIENCE_MAX_RUNNING_RUNTIMES": (str(lanes + 1), "per runner: one runtime per worker and one spare"),
        "OPEN_SCIENCE_MAX_RUNNING_RUNTIMES_PER_USER": ("2", "same as production; each request has its own account"),
        "OPEN_SCIENCE_MAX_CONCURRENT_TASKS": (str(lanes + 1), "per runner"),
    }


def say(line):
    print(line, flush=True)


def run(command, check=True, capture=False, input=None, env=None, timeout=None, cwd=None):
    result = subprocess.run(command, check=False, capture_output=capture, input=input, env=env, timeout=timeout, cwd=cwd,
                            text=isinstance(input, str) or (capture and input is None) or None)
    if check and result.returncode != 0:
        tail = ""
        if capture:
            tail = (result.stderr if isinstance(result.stderr, str) else (result.stderr or b"").decode("utf-8", "replace"))[-300:]
        raise SystemExit(f"command failed ({result.returncode}): {' '.join(str(c) for c in command[:4])} {tail}")
    return result


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 22), b""):
            digest.update(chunk)
    return digest.hexdigest()


def compose_command(extra=()):
    command = ["docker", "compose", "--env-file", str(ENV_FILE), "--project-directory", str(WEB_DIR)]
    for name in COMPOSE_FILES:
        command += ["-f", str(WEB_DIR / name)]
    command += ["-f", str(OVERLAY)]
    for profile in PROFILES:
        command += ["--profile", profile]
    return command + list(extra)


# ------------------------------------------------------------------------------------------------------------------ images
def cmd_images(args):
    archive = pathlib.Path(args.archive)
    expected = (archive / "images.tar.gz.sha256").read_text().split()[0]
    started = time.time()
    actual = sha256_file(archive / "images.tar.gz")
    if actual != expected:
        raise SystemExit("images.tar.gz does not match its recorded sha256")
    say(f"archive verified in {time.time() - started:.0f}s")
    started = time.time()
    loader = subprocess.Popen(["docker", "load", "-q"], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL)
    unzip = subprocess.Popen(["gzip", "-dc", str(archive / "images.tar.gz")], stdout=loader.stdin)
    loader.stdin.close()
    if unzip.wait() != 0 or loader.wait() != 0:
        raise SystemExit("docker load failed")
    say(f"images loaded in {time.time() - started:.0f}s")
    prepared = json.loads((archive / "prepared-export.json").read_text())
    manifest = json.loads((archive / "release-manifest.json").read_text())
    roles = {}
    for role, record in prepared["roles"].items():
        inspected = run(["docker", "image", "inspect", "--format", "{{.Id}}", record["reference"]], capture=True).stdout.strip()
        if inspected != record["imageId"]:
            raise SystemExit(f"image {role} is not the one the archive recorded")
        roles[role] = record["reference"]
    WORK.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(archive / "release-manifest.json", WORK / "release-manifest.json")
    images = {"roles": roles, "releaseId": prepared["releaseId"], "sourceRevision": prepared["sourceRevision"],
              "buildCreated": manifest["source"]["createdAt"]}
    (WORK / "images.json").write_text(json.dumps(images, indent=2))
    say(f"images verified: {len(roles)} roles, release {prepared['releaseId']}, revision {prepared['sourceRevision'][:12]}")


def load_images():
    return json.loads((WORK / "images.json").read_text())


def cmd_build_delta(args):
    images = load_images()
    base = images["roles"]["runtime"]
    source = pathlib.Path(args.patch_src).resolve()
    tag = f"open-science-runtime:lab-{re.sub(r'[^A-Za-z0-9_.-]', '-', args.key)}"
    revision = run(["git", "-C", str(source.parent), "rev-parse", "HEAD"], capture=True).stdout.strip()
    started = time.time()
    command = ["docker", "build", "--progress=plain", "-f", str(source / "deploy/runtime-dsh/Dockerfile.delta"),
               "--build-arg", f"RUNTIME_BASE_IMAGE={base}", "--build-arg", f"RELEASE_ID=evimed-{revision[:12]}-lab",
               "--build-arg", f"SOURCE_REVISION={revision}", "--build-arg", f"BUILD_CREATED={time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime())}",
               "-t", tag, str(source)]
    log = WORK / "delta-build.log"
    stop = threading.Event()

    def watch():
        # A runner that goes away mid-build leaves nothing else to read: memory and disk, every 20 s.
        while not stop.wait(20):
            memory = run(["free", "-m"], capture=True).stdout.splitlines()[1].split()
            disk = run(["df", "-BM", "--output=avail", "/"], capture=True).stdout.splitlines()[1].strip()
            top = run(["ps", "-eo", "rss,comm", "--sort=-rss"], capture=True).stdout.splitlines()[1:4]
            try:
                headers = [line for line in log.read_text(errors="replace").splitlines() if re.match(r"#\d+ \[", line)]
            except OSError:
                headers = []
            say(f"build running {time.time() - started:.0f}s: mem used {memory[2]}M avail {memory[6]}M, disk avail {disk}; top "
                f"{[(int(row.split()[0]) // 1024, row.split()[1]) for row in top]}; step {headers[-1][:110] if headers else '-'}")

    threading.Thread(target=watch, daemon=True).start()
    with open(log, "wb") as sink:
        code = subprocess.run(command, stdout=sink, stderr=subprocess.STDOUT, timeout=3000).returncode
    stop.set()
    text = log.read_text(errors="replace")
    steps = [line for line in text.splitlines() if re.match(r"#\d+ \[", line)]
    say(f"build steps seen: {len(steps)}; last: {steps[-1][:160] if steps else 'none'}")
    if code != 0:
        say("build failed; the log's last lines:\n" + "\n".join(text.splitlines()[-25:])[-2500:])
        raise SystemExit(f"delta build failed ({code})")
    images["runtimeDelta"] = tag
    images["runtimeDeltaRevision"] = revision
    (WORK / "images.json").write_text(json.dumps(images, indent=2))
    say(f"delta runtime image built in {time.time() - started:.0f}s: {tag} from revision {revision[:12]}")


# ------------------------------------------------------------------------------------------------------------------ env
def write_secret(name, value, mode=0o600):
    path = SECRETS_DIR / name
    path.write_text(value if value.endswith("\n") else value + "\n")
    os.chmod(path, mode)
    return path


def copy_secret(source, name):
    path = SECRETS_DIR / name
    shutil.copyfile(source, path)
    os.chmod(path, 0o600)
    return path


def cmd_env(args):
    images = load_images()
    lanes = int(args.lanes)
    SECRETS_DIR.mkdir(parents=True, exist_ok=True)
    os.chmod(SECRETS_DIR, 0o700)
    bundle = BUNDLE / "secrets"
    # Keys: the provider keys come from the bundle; everything the stack signs with is minted here, fresh for this job.
    files = {
        "deepseek-api-key": copy_secret(bundle / "deepseek.api-key", "deepseek-api-key.txt"),
        "dashscope": copy_secret(bundle / "dashscope.api-key", "dashscope.api-key"),
        "evimed": copy_secret(bundle / "evimed.api-key", "evimed-api-key.txt"),
        "typesafe": copy_secret(bundle / "typesafe.api-key", "typesafe-api-key.txt"),
        "materials": copy_secret(bundle / "materials-project.api-key", "materials-project-api-key.txt"),
        "gateway": write_secret("model-gateway-signing-key.txt", token_source.token_hex(32)),
        "workload": write_secret("evimed-workload-signing-key.txt", token_source.token_hex(32)),
        "receipt": write_secret("deepseek-release-receipt.json", "{}"),
        "parser": write_secret("document-parser.token", ""),
        "searx": write_secret("web-search.env", f"SEARXNG_SECRET={token_source.token_hex(32)}"),
    }
    os.chmod(files["parser"], 0o400)
    postgres_backup = WORK / "postgres-backup"
    (postgres_backup / "status").mkdir(parents=True, exist_ok=True)
    os.chmod(postgres_backup, 0o700)
    os.chmod(postgres_backup / "status", 0o755)
    unpaywall = (bundle / "unpaywall.email").read_text().strip()
    gid = os.stat("/var/run/docker.sock").st_gid
    roles = images["roles"]
    runtime_image = images.get("runtimeDelta") if args.delta else roles["runtime"]
    env = {
        "NODE_ENV": "production",
        "OPEN_SCIENCE_DATA_VOLUME": "open-science-data",
        "OPEN_SCIENCE_POSTGRES_BACKUP_STATUS_DIR": str(postgres_backup / "status"),
        "OPEN_SCIENCE_RELEASE_ID": images["releaseId"],
        "OPEN_SCIENCE_SOURCE_REVISION": images["sourceRevision"],
        "OPEN_SCIENCE_BUILD_CREATED": images["buildCreated"],
        "OPEN_SCIENCE_WEB_CONTAINER_IMAGE": roles["web"],
        "OPEN_SCIENCE_RUNTIME_CONTAINER_IMAGE": runtime_image,
        "OPEN_SCIENCE_RESULT_REPLAY_IMAGE": roles["resultReplay"],
        "OPEN_SCIENCE_RESULT_ENGINE_URL": "http://result-replay:8031",
        "EVIMED_DRUG_EVIDENCE_ADAPTER_IMAGE": roles["evidenceAdapter"],
        "OPEN_SCIENCE_RELEASE_MANIFEST_HOST_FILE": str(WORK / "release-manifest.json"),
        "OPEN_SCIENCE_DOCKER_SOCKET_GID": str(gid),
        "OPEN_SCIENCE_BOOTSTRAP_USER": "lab-admin",
        "OPEN_SCIENCE_BOOTSTRAP_PASSWORD": "",
        "OPEN_SCIENCE_BOOTSTRAP_PASSWORD_FILE": str(SECRETS_DIR / "bootstrap-password.txt"),
        "OPEN_SCIENCE_PRODUCTION_STATE_SECRETS_DIR": str(SECRETS_DIR),
        "OPEN_SCIENCE_POSTGRES_PASSWORD_HOST_FILE": str(SECRETS_DIR / "postgres-password.txt"),
        "OPEN_SCIENCE_DATABASE_URL_HOST_FILE": str(SECRETS_DIR / "database-url.txt"),
        "OPEN_SCIENCE_DOCUMENT_PARSER_TOKEN_HOST_FILE": str(files["parser"]),
        "OPEN_SCIENCE_OPENLIST_ADMIN_PASSWORD_HOST_FILE": str(SECRETS_DIR / "openlist-admin-password.txt"),
        "OPEN_SCIENCE_DASHSCOPE_API_KEY_HOST_FILE": str(files["dashscope"]),
        "OPEN_SCIENCE_OPENVIKING_CONF_HOST_FILE": str(SECRETS_DIR / "openviking-ov.conf"),
        "OPEN_SCIENCE_OPENVIKING_API_KEY_HOST_FILE": str(SECRETS_DIR / "openviking-api-key.txt"),
        "OPEN_SCIENCE_OPENVIKING_MODEL_KEY_HOST_FILE": str(SECRETS_DIR / "openviking-model-key.txt"),
        "OPEN_SCIENCE_DEEPSEEK_API_KEY_HOST_FILE": str(files["deepseek-api-key"]),
        "OPEN_SCIENCE_MODEL_GATEWAY_SIGNING_SECRET_HOST_FILE": str(files["gateway"]),
        "OPEN_SCIENCE_MATERIALS_PROJECT_API_KEY_HOST_FILE": str(files["materials"]),
        "OPEN_SCIENCE_EVIMED_WORKLOAD_SIGNING_SECRET_HOST_FILE": str(files["workload"]),
        "OPEN_SCIENCE_EVIMED_API_KEY_HOST_FILE": str(files["evimed"]),
        "OPEN_SCIENCE_TYPESAFE_API_KEY_HOST_FILE": str(files["typesafe"]),
        "OPEN_SCIENCE_DEEPSEEK_RELEASE_RECEIPT_HOST_FILE": str(files["receipt"]),
        "OPEN_SCIENCE_WEB_SEARCH_SECRET_ENV_FILE": str(files["searx"]),
        "OPEN_SCIENCE_OPERATOR_METRICS_TOKEN": token_source.token_hex(24),
        "OPEN_SCIENCE_UNPAYWALL_EMAIL": unpaywall,
        "OPEN_SCIENCE_BACKUP_MODE": "local",
        "OPEN_SCIENCE_BACKUP_ENCRYPTION_ACK": "true",
        "OPEN_SCIENCE_BACKUP_DIR": "/backups",
        "OPEN_SCIENCE_BACKUP_RETENTION_DAYS": "1",
        "OPEN_SCIENCE_BACKUP_PASSPHRASE_FILE": str(SECRETS_DIR / "backup-passphrase.txt"),
        "OPEN_SCIENCE_BACKUP_INTERVAL_SECONDS": "86400",
        "OPEN_SCIENCE_BACKUP_HEALTH_GRACE_SECONDS": "1800",
        "OPEN_SCIENCE_BACKUP_RETRY_SECONDS": "30",
        "OPEN_SCIENCE_BACKUP_MAX_FAILURES": "3",
        "OPEN_SCIENCE_BACKUP_RESTORE_DRILL_EVERY": "1",
        "OPEN_SCIENCE_RESTORE_DRILL_ACK": "true",
        "OPEN_SCIENCE_MONITORING_SECRETS_DIR": "./secrets",
        **PARITY,
    }
    for name, (value, _why) in lab_overrides(lanes).items():
        env[name] = value
    # The overrides that are not "production's value" are applied last, so a name in both is the lab's.
    ENV_FILE.write_text("".join(f"{k}={v}\n" for k, v in sorted(env.items())))
    os.chmod(ENV_FILE, 0o600)
    # Fresh signing material and the stack's own passwords, made by the product's own scripts (as CI does).
    node_env = {**os.environ, "OPEN_SCIENCE_BOOTSTRAP_PASSWORD_FILE": env["OPEN_SCIENCE_BOOTSTRAP_PASSWORD_FILE"],
                "OPEN_SCIENCE_PRODUCTION_STATE_SECRETS_DIR": str(SECRETS_DIR),
                "OPEN_SCIENCE_POSTGRES_PASSWORD_HOST_FILE": env["OPEN_SCIENCE_POSTGRES_PASSWORD_HOST_FILE"],
                "OPEN_SCIENCE_DATABASE_URL_HOST_FILE": env["OPEN_SCIENCE_DATABASE_URL_HOST_FILE"],
                "OPEN_SCIENCE_OPENLIST_ADMIN_PASSWORD_HOST_FILE": env["OPEN_SCIENCE_OPENLIST_ADMIN_PASSWORD_HOST_FILE"],
                "OPEN_SCIENCE_DASHSCOPE_API_KEY_HOST_FILE": env["OPEN_SCIENCE_DASHSCOPE_API_KEY_HOST_FILE"],
                "OPEN_SCIENCE_OPENVIKING_CONF_HOST_FILE": env["OPEN_SCIENCE_OPENVIKING_CONF_HOST_FILE"],
                "OPEN_SCIENCE_OPENVIKING_API_KEY_HOST_FILE": env["OPEN_SCIENCE_OPENVIKING_API_KEY_HOST_FILE"],
                "OPEN_SCIENCE_OPENVIKING_MODEL_KEY_HOST_FILE": env["OPEN_SCIENCE_OPENVIKING_MODEL_KEY_HOST_FILE"],
                "OPEN_SCIENCE_BACKUP_PASSPHRASE_FILE": env["OPEN_SCIENCE_BACKUP_PASSPHRASE_FILE"]}
    for script in ("configure-local-auth.mjs", "configure-production-state.mjs", "configure-backup.mjs"):
        run(["node", str(SRC / "scripts/ops" / script)], env=node_env, capture=True, cwd=str(SRC))
    os.chmod(env["OPEN_SCIENCE_BACKUP_PASSPHRASE_FILE"], 0o400)
    # The data volume: the empty user tree and a synthetic stand-in for the pharmacy reference (the real one is licensed data).
    fixture = WORK / "pharmacy-reference.sqlite"
    sys.path.insert(0, str(SRC / "runtime/mcp/evimed-research"))
    import sqlite3
    from build_pharmacy_reference import DDL  # noqa: E402
    if fixture.exists():
        fixture.unlink()
    with sqlite3.connect(fixture) as db:
        db.executescript(DDL)
        db.execute("INSERT INTO metadata VALUES (?, ?)", ("kind", "synthetic-lab-fixture"))
        db.execute("INSERT INTO datasets VALUES (?, ?, ?, ?, ?)", ("lab-fixture", "lab-fixture.csv", hashlib.sha256(b"synthetic-lab").hexdigest(), 1, '["label"]'))
        db.execute("INSERT INTO records VALUES (?, ?, ?, ?, ?)", (1, "lab-fixture", 1, '{"label":"synthetic lab record, not clinical data"}', "synthetic lab record"))
        db.execute("INSERT INTO records_fts(records_fts) VALUES ('rebuild')")
    run(["docker", "volume", "create", "open-science-data"], capture=True)
    run(["docker", "run", "--rm", "--network", "none", "--user", "0", "--entrypoint", "sh",
         "-v", "open-science-data:/data", "-v", f"{fixture}:/lab-fixture.sqlite:ro", runtime_image,
         "-ec", "test ! -e /data/pharmacy-reference.sqlite; mkdir -p /data/users; chmod 700 /data/users; cp /lab-fixture.sqlite /data/pharmacy-reference.sqlite; chmod 444 /data/pharmacy-reference.sqlite"],
        capture=True)
    say(f"environment written: {len(env)} levers, runtime image {runtime_image.split(':')[0]}:{runtime_image.split(':')[-1][:24]}")


# ------------------------------------------------------------------------------------------------------------------ up
def api_get(path, timeout=5):
    try:
        with urllib.request.urlopen(API + path, timeout=timeout) as response:
            return response.status, response.read(1 << 20)
    except urllib.error.HTTPError as error:
        return error.code, error.read(1 << 20)
    except (urllib.error.URLError, OSError):
        return 0, b""


def readiness_summary():
    status, body = api_get("/api/ready", timeout=10)
    checks = {}
    try:
        data = json.loads(body).get("data") or {}
        for name, check in (data.get("checks") or {}).items():
            if isinstance(check, dict) and check.get("ok") is not True:
                code = check.get("code")
                checks[name] = code if isinstance(code, str) and re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,79}", code) else "failed"
    except (ValueError, AttributeError):
        pass
    return status, checks


def cmd_up(args):
    started = time.time()
    run(compose_command(["up", "-d", "--no-build", "--pull", "missing", *SERVICES]), capture=True, timeout=1800)
    say(f"compose up returned after {time.time() - started:.0f}s")
    for attempt in range(180):
        status, _ = api_get("/api/health")
        if status == 200:
            break
        time.sleep(2)
    else:
        diagnose()
        raise SystemExit("the web API did not answer /api/health in 6 minutes")
    say(f"web API answering after {time.time() - started:.0f}s")
    # The backup receipt readiness asks for (what CI does before its readiness wait).
    environment = {**os.environ, "EVIMED_POSTGRES_BACKUP_DIR": str(WORK / "postgres-backup"),
                   "EVIMED_POSTGRES_PASSPHRASE_FILE": str(SECRETS_DIR / "backup-passphrase.txt"),
                   "OPEN_SCIENCE_POSTGRES_BACKUP_STATUS_DIR": str(WORK / "postgres-backup" / "status")}
    result = run(["python3", "-B", str(SRC / "scripts/ops/postgres-backup.py")], check=False, capture=True, env=environment, cwd=str(SRC))
    say(f"postgres backup receipt: exit {result.returncode}")
    for attempt in range(8):
        status, checks = readiness_summary()
        if status == 200:
            break
        time.sleep(3)
    say(f"readiness {status}; checks not ok: {json.dumps(checks, sort_keys=True)}")
    say(f"stack up after {time.time() - started:.0f}s")


def diagnose(logs=True):
    """Container state and, at bring-up only, a redacted tail of each service's log (bounded; no environment, no request content)."""
    rows = run(compose_command(["ps", "-a", "--format", "{{.Service}} {{.State}} {{.Health}}"]), check=False, capture=True).stdout
    say("containers:\n" + (rows or "").strip())
    for service in (SERVICES if logs else []):
        tail = run(compose_command(["logs", "--no-color", "--tail", "25", service]), check=False, capture=True).stdout or ""
        redacted = re.sub(r"(?i)(key|token|secret|password|authorization|cookie)[^\s\"']*[=:]\s*\S+", r"\1=<redacted>", tail)
        say(f"--- {service} (tail, redacted)\n{redacted[-1800:]}")


def cmd_diagnose(args):
    diagnose(logs=args.logs)


def cmd_ready(args):
    status, checks = readiness_summary()
    say(f"readiness {status}; checks not ok: {json.dumps(checks, sort_keys=True)}")


# ------------------------------------------------------------------------------------------------------------------ health
def container_state(service):
    result = run(compose_command(["ps", "-q", service]), check=False, capture=True)
    container = (result.stdout or "").strip().splitlines()
    if not container:
        return None
    inspected = run(["docker", "inspect", "--format", "{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}", container[0]],
                    check=False, capture=True).stdout.split()
    return inspected


def stack_healthy(restart=True):
    """True when the web API answers and the services a run depends on are running. A service that died is started again once."""
    problems = []
    for service in ("evimed-postgres", "open-science-runtime-controller", "open-science-web"):
        state = container_state(service)
        if not state or state[0] != "running":
            problems.append(service)
    if restart and problems:
        run(compose_command(["up", "-d", "--no-build", "--no-deps", *problems]), check=False, capture=True, timeout=300)
        time.sleep(20)
        problems = [s for s in problems if not (container_state(s) or [""])[0] == "running"]
    status, _ = api_get("/api/health")
    return status == 200 and not problems


def cmd_health(args):
    ok = stack_healthy()
    say(f"stack healthy: {ok}")
    sys.exit(0 if ok else 1)


# ------------------------------------------------------------------------------------------------------------------ verify
DATASET_HOSTS = ["huggingface.co", "hf.co", "cdn-lfs.huggingface.co", "cdn-lfs-us-1.huggingface.co"]
OPEN_HOSTS = ["export.arxiv.org", "eutils.ncbi.nlm.nih.gov"]


def cmd_verify(args):
    """The lab's own checks, counters only. Exit 1 when a check that must hold does not."""
    failures = []
    # (1) The dataset hosts do not resolve to the internet from the control plane and the search service; the open hosts still connect.
    probe = ("const net=require('net');const dns=require('dns').promises;(async()=>{const out={};"
             "for(const h of process.argv.slice(1)){try{const a=await dns.lookup(h);out[h]=a.address;}catch(e){out[h]='unresolved';}}"
             "console.log(JSON.stringify(out));})()")
    for service in ("open-science-web",):
        answer = run(compose_command(["exec", "-T", service, "node", "-e", probe, *DATASET_HOSTS, *OPEN_HOSTS]), check=False, capture=True)
        try:
            resolved = json.loads((answer.stdout or "{}").strip().splitlines()[-1])
        except (ValueError, IndexError):
            resolved = {}
        blocked = [h for h in DATASET_HOSTS if resolved.get(h) == "127.0.0.1"]
        open_ok = [h for h in OPEN_HOSTS if resolved.get(h) not in (None, "unresolved", "127.0.0.1")]
        say(f"{service}: dataset hosts pinned to loopback {len(blocked)}/{len(DATASET_HOSTS)}; open hosts resolving {len(open_ok)}/{len(OPEN_HOSTS)}")
        if len(blocked) != len(DATASET_HOSTS) or len(open_ok) != len(OPEN_HOSTS):
            failures.append(f"{service}:hosts")
    probe_py = "import socket,sys;print(','.join(sorted({a[4][0] for a in socket.getaddrinfo(sys.argv[1],443)})))"
    search = run(compose_command(["exec", "-T", "open-science-web-search", "sh", "-c",
                                  f"for h in huggingface.co hf.co; do echo \"$h $(python3 -c \"{probe_py}\" $h 2>/dev/null || echo none)\"; done"]),
                 check=False, capture=True).stdout or ""
    rows = dict(line.split(None, 1) if len(line.split(None, 1)) == 2 else (line.strip(), "") for line in search.splitlines())
    pinned = sum(1 for value in rows.values() if value.strip() == "127.0.0.1")
    say(f"open-science-web-search: dataset hosts pinned to loopback {pinned}/2 ({json.dumps({k: v.strip() for k, v in rows.items()})})")
    if pinned != 2:
        failures.append("search:hosts")
    # (2) The runner host itself still reaches the dataset host (the lane's own fetch).
    try:
        with urllib.request.urlopen("https://huggingface.co/api/models?limit=1", timeout=20) as response:
            say(f"runner host reaches the dataset host: {response.status}")
    except (urllib.error.URLError, OSError) as error:
        say(f"runner host cannot reach the dataset host: {type(error).__name__}")
        failures.append("runner:hf")
    # (3) A runtime container holds no provider key; checked on any runtime that is running.
    verify_runtime_keyless(failures)
    say("verify: " + ("ok" if not failures else "failed " + ",".join(failures)))
    sys.exit(1 if failures else 0)


def verify_runtime_keyless(failures):
    containers = run(["docker", "ps", "-q", "--filter", "label=open-science.web.runtime=true"], check=False, capture=True).stdout.split()
    if not containers:
        say("runtime keyless check: no runtime container is running (check again during a run)")
        return
    secret_values = []
    for name in ("deepseek.api-key", "dashscope.api-key", "evimed.api-key", "typesafe.api-key", "materials-project.api-key"):
        value = (BUNDLE / "secrets" / name).read_text().strip()
        if len(value) >= 8:
            secret_values.append(value)
    for container in containers[:2]:
        inspected = json.loads(run(["docker", "inspect", container], capture=True).stdout)[0]
        blob = json.dumps({"env": inspected["Config"].get("Env"), "mounts": inspected["Mounts"], "cmd": inspected["Config"].get("Cmd")})
        in_inspect = sum(1 for value in secret_values if value in blob)
        mount_secret = sum(1 for mount in inspected["Mounts"] if "secrets" in (mount.get("Source") or "") or "/run/secrets" in (mount.get("Destination") or ""))
        files = run(["docker", "exec", "--user", "0", container, "sh", "-c",
                     "cat /proc/1/environ 2>/dev/null | tr '\\0' '\\n'; for p in /proc/[0-9]*/environ; do cat $p 2>/dev/null | tr '\\0' '\\n'; done | sort -u"],
                    check=False, capture=True).stdout or ""
        in_process_env = sum(1 for value in secret_values if value in files)
        say(f"runtime {container[:12]}: provider keys in its definition {in_inspect}, in process environments {in_process_env}, secret mounts {mount_secret}")
        if in_inspect or in_process_env or mount_secret:
            failures.append("runtime:keys")


def cmd_selfcheck(args):
    """The path every request takes first, once, before any request: register a throwaway account through the product's own helper in the
    web image, then delete it. Prints the helper's own lines (an account id of the form labchk-<time>-<hex>, never a password)."""
    images = load_images()
    script = ("const { fetchTransport, openThrowawayAccount } = await import('/app/scripts/ops/throwaway-account.mjs');"
              f"const base = '{API}';"
              "try { const a = await openThrowawayAccount({ base, send: fetchTransport(base), prefix: 'labchk', say: console.log });"
              " const r = await a.close(); console.log(JSON.stringify(r)); process.exit(r.deleted ? 0 : 3); }"
              " catch (e) { console.log('FAIL ' + String(e && e.message).slice(0, 300)); process.exit(2); }")
    result = run(["docker", "run", "--rm", "--network", "host", "--user", "0:0", "--entrypoint", "node", images["roles"]["web"],
                  "--input-type=module", "-e", script], check=False, capture=True, timeout=180)
    say((result.stdout or "").strip()[-600:])
    if result.returncode != 0:
        say((result.stderr or "").strip()[-300:])
        raise SystemExit(f"throwaway account self-check failed ({result.returncode})")


# ------------------------------------------------------------------------------------------------------------------ down
def cmd_down(args):
    run(compose_command(["--profile", "runtime-image", "down", "-v", "--remove-orphans"]), check=False, capture=True, timeout=600)
    leftovers = run(["docker", "ps", "-aq", "--filter", "label=open-science.web.runtime=true"], check=False, capture=True).stdout.split()
    for container in leftovers:
        run(["docker", "rm", "-f", container], check=False, capture=True)
    say(f"stack down; {len(leftovers)} leftover runtime container(s) removed")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    s = sub.add_parser("images")
    s.add_argument("--archive", required=True)
    s = sub.add_parser("build-delta")
    s.add_argument("--patch-src", required=True)
    s.add_argument("--key", required=True)
    s = sub.add_parser("env")
    s.add_argument("--lanes", required=True)
    s.add_argument("--delta", action="store_true")
    s = sub.add_parser("diagnose")
    s.add_argument("--logs", action="store_true")
    for name in ("up", "ready", "health", "verify", "selfcheck", "down"):
        sub.add_parser(name)
    args = parser.parse_args()
    {"images": cmd_images, "build-delta": cmd_build_delta, "env": cmd_env, "up": cmd_up, "ready": cmd_ready, "health": cmd_health,
     "verify": cmd_verify, "selfcheck": cmd_selfcheck, "down": cmd_down, "diagnose": cmd_diagnose}[args.command](args)


if __name__ == "__main__":
    main()
