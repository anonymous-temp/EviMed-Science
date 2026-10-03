#!/usr/bin/env python3
"""One fixed, private GEO overlay over the admitted public EviMed CI runtime."""
import argparse
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import re
import select
import shutil
import signal
import stat
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.request
import urllib.parse
import zipfile

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

REPO = "anonymous-temp/EviMed-Science"
SOURCE = "0a4abc9caba5f26f79cc5a58014e99786248e792"
BASE_RUN = 37080537330
OPS_REF = "refs/heads/ops/private-runtime-20261002"
PACK_SHA = "db15ce187c1c063ba40abd8d32c6b5e7bb0fcdc71f0d3370c7e2e2b51c6ebbfd"
TREE_SHA = "15e9e4f85a4e575baf2a77c204fde326ae2f1c839ba597b854e85ed03ef86fd1"
PUBLIC_SHA = "9c07c566f60183f315dc5b69d7eda9cd33cddd2d4e0667a2dd222750846e8e6a"
PACK_BYTES = 1084171
PACK_FILES = 287
PACK_PLAIN_BYTES = 3189367
FLOOR = 10 * 1024**3
MAX_ARCHIVE = 3 * 1024**3
MAX_EXPORT = 20 * 1024**3
SHA = re.compile(r"sha256:[a-f0-9]{64}\Z")
ALLOWED = {".github/workflows/private-runtime.yml", "OpenScience/scripts/ops/private-runtime-overlay.py",
           "OpenScience/scripts/ops/private-runtime-recipient.pub", "OpenScience/scripts/ops/test/test_private_runtime_overlay.py"}
BUDGET_PATH = None


def require(condition, code):
    if not condition:
        raise ValueError(code)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def capacity(path, upcoming=0):
    usage = shutil.disk_usage(path)
    require(usage.free >= FLOOR + upcoming, "private_overlay_capacity_floor")


def private_write(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as out:
        out.write(data)


def command(args, *, log=None, timeout=120):
    # Neither Actions secrets nor its token enter Docker/build subprocesses.
    env = {k: os.environ[k] for k in ["PATH", "HOME", "DOCKER_CONFIG"] if k in os.environ}
    if log is not None:
        child = subprocess.Popen(args, env=env, stdout=log, stderr=log, start_new_session=True)
        deadline = time.monotonic() + timeout
        try:
            while child.poll() is None:
                require(time.monotonic() < deadline, "private_overlay_child_deadline")
                if BUDGET_PATH is not None:
                    capacity(BUDGET_PATH)
                require(os.fstat(log.fileno()).st_size <= 16 * 1024**2, "private_overlay_child_log_bound")
                time.sleep(1)
            require(child.returncode == 0, "private_overlay_child_failed")
        finally:
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGTERM)
                try: child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL); child.wait(timeout=5)
        return None
    result = subprocess.run(args, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    require(result.returncode == 0, "private_overlay_child_failed")
    if log is None:
        require(len(result.stdout) <= 4 * 1024**2, "private_overlay_child_metadata_bound")
        return result.stdout


def admit_context():
    require(os.environ.get("GITHUB_EVENT_NAME") == "push" and os.environ.get("GITHUB_REF") == OPS_REF,
            "private_overlay_trusted_push_required")
    require(os.environ.get("GITHUB_REPOSITORY") == REPO and not os.environ.get("GITHUB_HEAD_REF"),
            "private_overlay_repository_boundary")
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_bytes())
    head = os.environ.get("GITHUB_SHA", "")
    require(re.fullmatch("[a-f0-9]{40}", head) and event.get("head_commit", {}).get("id") == head,
            "private_overlay_push_identity")
    require(event.get("ref") == OPS_REF and event.get("repository", {}).get("full_name") == REPO
            and not event.get("repository", {}).get("fork"), "private_overlay_no_fork")
    require(os.environ.get("GITHUB_WORKFLOW_REF") == f"{REPO}/.github/workflows/private-runtime.yml@{OPS_REF}",
            "private_overlay_workflow_identity")
    require(command(["git", "rev-parse", "HEAD"]).decode().strip() == head, "private_overlay_checkout_identity")
    require(command(["git", "status", "--porcelain", "--untracked-files=all"]) == b"", "private_overlay_dirty_checkout")
    command(["git", "merge-base", "--is-ancestor", SOURCE, "HEAD"])
    changed = set(command(["git", "diff", "--name-only", SOURCE, "HEAD"]).decode().splitlines())
    require(changed and changed <= ALLOWED, "private_overlay_product_source_changed")
    return head


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def api(path, redirect=False):
    request = urllib.request.Request("https://api.github.com/repos/" + REPO + path,
                                    headers={"Authorization": "Bearer " + os.environ["GH_TOKEN"],
                                             "Accept": "application/vnd.github+json"})
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=30) as response:
            raw = response.read(4 * 1024**2 + 1)
            require(len(raw) <= 4 * 1024**2, "private_overlay_api_bound")
            return json.loads(raw)
    except urllib.error.HTTPError as error:
        if redirect and error.code == 302:
            location = error.headers.get("Location", "")
            parsed = urllib.parse.urlsplit(location)
            require(parsed.scheme == "https" and parsed.hostname and
                    parsed.hostname.endswith(".blob.core.windows.net"), "private_overlay_storage_redirect")
            return location
        raise ValueError("private_overlay_api_failed") from None


def wait_base():
    deadline = time.monotonic() + 30 * 60
    while time.monotonic() < deadline:
        run = api(f"/actions/runs/{BASE_RUN}")
        require(run["head_sha"] == SOURCE and run["event"] == "push"
                and run["head_branch"] == "codex/release-research-workbench-20261002"
                and run["path"] == ".github/workflows/web.yml" and run["run_attempt"] == 1,
                "private_overlay_base_run_identity")
        jobs = api(f"/actions/runs/{BASE_RUN}/jobs?per_page=100")["jobs"]
        selected = [job for job in jobs if job["name"] == "docker-hosted"]
        if selected:
            require(len(selected) == 1, "private_overlay_base_job_ambiguity")
            steps = {step["name"]: step for step in selected[0]["steps"]}
            upload = steps.get("Upload exact candidate core image subset", {})
            if upload.get("status") == "completed":
                require(upload.get("conclusion") == "success", "private_overlay_base_upload_failed")
                for name in ["Package verified full-release images", "Package bounded core and isolated VCR image subsets"]:
                    require(steps.get(name, {}).get("conclusion") == "success", "private_overlay_base_package_failed")
                artifacts = api(f"/actions/runs/{BASE_RUN}/artifacts?per_page=100")["artifacts"]
                matches = [item for item in artifacts if item["name"] == "evimed-core-release-" + SOURCE and not item["expired"]]
                require(len(matches) == 1 and SHA.fullmatch(matches[0].get("digest", "")), "private_overlay_base_artifact")
                return matches[0], selected[0]["id"]
            require(selected[0].get("conclusion") not in ["failure", "cancelled", "timed_out"], "private_overlay_base_job_failed")
        require(run.get("conclusion") not in ["failure", "cancelled", "timed_out"], "private_overlay_base_failed")
        time.sleep(30)
    raise ValueError("private_overlay_base_wait_timeout")


def acquire_core(artifact, work):
    require(0 < artifact["size_in_bytes"] <= MAX_ARCHIVE, "private_overlay_archive_size")
    capacity(work, artifact["size_in_bytes"] * 2)
    target = work / "core.zip"
    location = api(f"/actions/artifacts/{artifact['id']}/zip", redirect=True)
    # Request authentication is never forwarded to signed storage.
    with urllib.request.build_opener(NoRedirect).open(location, timeout=60) as source, target.open("xb") as out:
        os.chmod(target, 0o600)
        h = hashlib.sha256(); size = 0
        while True:
            chunk = source.read(1024**2)
            if not chunk:
                break
            size += len(chunk); require(size <= artifact["size_in_bytes"], "private_overlay_archive_grew")
            capacity(work); out.write(chunk); h.update(chunk)
    require(size == artifact["size_in_bytes"] and "sha256:" + h.hexdigest() == artifact["digest"], "private_overlay_archive_hash")
    root = work / "core"; root.mkdir(mode=0o700)
    with zipfile.ZipFile(target) as archive:
        entries = archive.infolist()
        require({entry.filename for entry in entries} == {"images.tar.gz", "images.tar.gz.sha256", "manifest.json",
                "prepared-export.json", "images.txt", "release-manifest.json", "image-qualification.json"}, "private_overlay_zip_inventory")
        require(all(entry.filename == "images.tar.gz" or entry.file_size <= 32 * 1024**2 for entry in entries), "private_overlay_metadata_bound")
        require(sum(entry.file_size for entry in entries) <= MAX_ARCHIVE + 16 * 1024**2, "private_overlay_zip_expanded_bound")
        require(1 <= len(entries) <= 32 and len({e.filename for e in entries}) == len(entries), "private_overlay_zip_entries")
        for entry in entries:
            require(re.fullmatch(r"[a-zA-Z0-9_.-]+", entry.filename) and not entry.is_dir()
                    and entry.file_size <= MAX_ARCHIVE and not stat.S_ISLNK(entry.external_attr >> 16), "private_overlay_zip_path")
            capacity(work, entry.file_size)
            with archive.open(entry) as source, (root / entry.filename).open("xb") as out:
                os.chmod(out.name, 0o600)
                shutil.copyfileobj(source, out, 1024**2)
    target.unlink()
    manifest = json.loads((root / "manifest.json").read_bytes())
    prepared = json.loads((root / "prepared-export.json").read_bytes())
    require(manifest["sourceRevision"] == SOURCE and str(manifest["workflowRun"]) == str(BASE_RUN)
            and str(manifest["workflowAttempt"]) == "1", "private_overlay_core_manifest_identity")
    require(prepared["sourceRevision"] == SOURCE and prepared["scope"] == "candidate-core-image-subset",
            "private_overlay_core_scope")
    image_hash = hashlib.sha256()
    with (root / "images.tar.gz").open("rb") as stream:
        while chunk := stream.read(1024**2):
            image_hash.update(chunk)
    checksum = (root / "images.tar.gz.sha256").read_text().split()
    require(checksum == [image_hash.hexdigest(), "images.tar.gz"], "private_overlay_core_archive_hash")
    reference = prepared["roles"]["runtime"]["reference"]
    matches = [image for image in manifest["verifiedImages"] if reference in image["references"]]
    for item in prepared["files"]:
        require(re.fullmatch(r"[a-zA-Z0-9_.-]+", item["path"]) and item["bytes"] <= 32 * 1024**2, "private_overlay_prepared_file_path")
        data = (root / item["path"]).read_bytes()
        require(len(data) == item["bytes"] and digest(data) == item["sha256"], "private_overlay_prepared_file_hash")
    require(len(matches) == 1 and matches[0]["platform"] == "linux/amd64"
            and SHA.fullmatch(matches[0]["configDigest"]), "private_overlay_runtime_role")
    base = matches[0]
    require(base["configDigest"] == prepared["roles"]["runtime"]["imageId"], "private_overlay_prepared_config_identity")
    require(base["labels"]["org.opencontainers.image.revision"] == SOURCE, "private_overlay_runtime_source_label")
    return root, base, reference, image_hash.hexdigest()


def tree_measure(root):
    files = []
    for directory, dirs, names in os.walk(root, followlinks=False):
        require(not any((Path(directory) / name).is_symlink() for name in dirs), "private_overlay_pack_symlink")
        for name in names:
            p = Path(directory) / name
            require(p.is_file() and not p.is_symlink(), "private_overlay_pack_file")
            raw = p.read_bytes(); files.append((p.relative_to(root).as_posix(), len(raw), digest(raw)))
    files.sort()
    h = hashlib.sha256()
    for name, size, sha in files:
        h.update((name + "\0" + str(size) + "\0sha256:" + sha + "\n").encode())
    skills = sum(name.startswith("skills/") and name.endswith("/SKILL.md") and name.count("/") == 2 for name, _, _ in files)
    return {"files": len(files), "skills": skills, "plainBytes": sum(size for _, size, _ in files), "treeSha256": h.hexdigest()}


def extract_pack(raw, destination):
    require(len(raw) == PACK_BYTES and digest(raw) == PACK_SHA, "private_overlay_pack_archive_hash")
    destination.mkdir(mode=0o700)
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:gz") as archive:
        seen = set(); total = 0
        for member in archive:
            parts = Path(member.name).parts
            require(member.isfile() and not member.issparse() and len(parts) >= 2 and parts[0] == "geo-private"
                    and not any(p in ["..", "."] for p in parts) and not Path(member.name).is_absolute()
                    and member.name not in seen and 0 <= member.size <= 8 * 1024**2, "private_overlay_pack_member")
            seen.add(member.name); total += member.size
            require(len(seen) <= PACK_FILES and total <= PACK_PLAIN_BYTES, "private_overlay_pack_bound")
            target = destination.joinpath(*parts[1:]); target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            with archive.extractfile(member) as source:
                data = source.read(member.size + 1)
                require(len(data) == member.size, "private_overlay_pack_size")
                private_write(target, data)
        require(len(seen) == PACK_FILES, "private_overlay_pack_count")
    measured = tree_measure(destination)
    require(measured == {"files": PACK_FILES, "skills": 51, "plainBytes": PACK_PLAIN_BYTES, "treeSha256": TREE_SHA},
            "private_overlay_pack_tree")
    for directory, dirs, files in os.walk(destination):
        os.chmod(directory, 0o555)
        for name in files:
            os.chmod(Path(directory) / name, 0o444)
    return measured


class CipherSink:
    def __init__(self, out, encryptor):
        self.out = out; self.encryptor = encryptor; self.bytes = 0; self.sha = hashlib.sha256()

    def write(self, raw):
        cipher = self.encryptor.update(raw); self.out.write(cipher); self.sha.update(cipher); self.bytes += len(cipher)
        return len(raw)

    def flush(self):
        self.out.flush()


def encrypt_bundle(stream, logs, destination, public_pem, provenance):
    public = serialization.load_pem_public_key(public_pem)
    require(isinstance(public, rsa.RSAPublicKey) and public.key_size >= 3072, "private_overlay_rsa_key")
    key = os.urandom(32); nonce = os.urandom(12)
    encryptor = Cipher(algorithms.AES(key), modes.GCM(nonce)).encryptor()
    encryptor.authenticate_additional_data(canonical(provenance))
    with destination.open("xb") as out:
        os.chmod(destination, 0o600); sink = CipherSink(out, encryptor)
        with zipfile.ZipFile(sink, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=1) as archive:
            with archive.open("images.tar", "w", force_zip64=True) as target:
                count = 0
                while chunk := stream.read(1024**2):
                    count += len(chunk); require(count <= MAX_EXPORT, "private_overlay_export_bound")
                    capacity(destination.parent); target.write(chunk)
            for name, content in logs.items():
                require(re.fullmatch(r"[a-z_.-]+", name) and len(content) <= 16 * 1024**2, "private_overlay_log_bound")
                archive.writestr(name, content)
        final = encryptor.finalize(); out.write(final); sink.sha.update(final)
        out.flush(); os.fsync(out.fileno())
    wrapped = public.encrypt(key, padding.OAEP(mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=None))
    return {"schemaVersion": 1, "provenance": provenance, "protection": {"algorithm": "AES-256-GCM", "keyWrapping": "RSA-OAEP-SHA256",
            "recipientPemSha256": digest(public_pem), "wrappedKey": base64.b64encode(wrapped).decode(),
            "nonce": base64.b64encode(nonce).decode(), "tag": base64.b64encode(encryptor.tag).decode(),
            "ciphertextSha256": sink.sha.hexdigest(), "ciphertextBytes": destination.stat().st_size}}


def decrypt_bundle(source, metadata, private_pem, destination):
    """Local operator only; authenticate before publishing any plaintext archive."""
    protection = metadata["protection"]
    require(metadata.get("schemaVersion") == 1 and protection["algorithm"] == "AES-256-GCM"
            and protection["keyWrapping"] == "RSA-OAEP-SHA256", "private_overlay_cipher_suite")
    private = serialization.load_pem_private_key(private_pem, password=None)
    require(isinstance(private, rsa.RSAPrivateKey), "private_overlay_rsa_private_key")
    public_pem = private.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
    require(digest(public_pem) == protection["recipientPemSha256"], "private_overlay_recipient_mismatch")
    key = private.decrypt(base64.b64decode(protection["wrappedKey"], validate=True),
                          padding.OAEP(mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=None))
    nonce = base64.b64decode(protection["nonce"], validate=True)
    tag = base64.b64decode(protection["tag"], validate=True)
    require(len(key) == 32 and len(nonce) == 12 and len(tag) == 16, "private_overlay_cipher_dimensions")
    decryptor = Cipher(algorithms.AES(key), modes.GCM(nonce, tag)).decryptor()
    decryptor.authenticate_additional_data(canonical(metadata["provenance"]))
    require(not destination.exists(), "private_overlay_plaintext_exists")
    partial = destination.with_name(destination.name + ".partial")
    created = False
    try:
        with source.open("rb") as stream:
            fd = os.open(partial, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            created = True
            with os.fdopen(fd, "wb") as out:
                h = hashlib.sha256(); size = 0
                while chunk := stream.read(1024**2):
                    size += len(chunk); require(size <= MAX_EXPORT, "private_overlay_cipher_bound")
                    h.update(chunk); out.write(decryptor.update(chunk))
                require(size == protection["ciphertextBytes"] and h.hexdigest() == protection["ciphertextSha256"], "private_overlay_cipher_hash")
                out.write(decryptor.finalize()); out.flush(); os.fsync(out.fileno())
        # link is an atomic no-replace publication; rename would overwrite a racing file.
        os.link(partial, destination, follow_symlinks=False)
        partial.unlink()
    except BaseException:
        if created:
            partial.unlink(missing_ok=True)
        raise


UPDATE_SCRIPT = r'''const fs=require('fs'),path=require('path'),cp=require('child_process');
const crypto=require('crypto');
const primary='/opt/evimed/skills/geo-private', preset='/opt/evimed/socket/presets/evimed-universal/skills/geo-private';
const seed='/opt/evimed/dsh-home-seed', loaded=fs.realpathSync(seed+'/profiles/evimed-runtime/node_modules/@evimed/dsh-socket/presets/evimed-universal/skills/geo-private');
if(!(loaded.startsWith(seed+'/')||loaded===preset))throw Error('private_overlay_loaded_root');
for(const target of new Set([preset,loaded])){fs.rmSync(target,{recursive:true,force:true});fs.cpSync(primary,target,{recursive:true,preserveTimestamps:true});}
function measure(root){const files=[];function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isSymbolicLink())throw Error('private_overlay_pack_link');if(e.isDirectory())walk(p);else if(e.isFile()){const b=fs.readFileSync(p);files.push({name:path.relative(root,p),size:b.length,sha:crypto.createHash('sha256').update(b).digest('hex')});}}}walk(root);files.sort((a,b)=>Buffer.compare(Buffer.from(a.name),Buffer.from(b.name)));const h=crypto.createHash('sha256');for(const f of files)h.update(f.name+'\0'+f.size+'\0sha256:'+f.sha+'\n');return {files:files.length,skills:files.filter(f=>/^skills\/[^/]+\/SKILL\.md$/.test(f.name)).length,plainBytes:files.reduce((n,f)=>n+f.size,0),treeSha256:h.digest('hex')};}
const copies=[['primary',primary],['preset',preset],['loaded-seed',loaded]].map(([root,p])=>({root,...measure(p)}));
if(copies.some(c=>c.files!==287||c.skills!==51||c.plainBytes!==3189367||c.treeSha256!=='15e9e4f85a4e575baf2a77c204fde326ae2f1c839ba597b854e85ed03ef86fd1'))throw Error('private_overlay_three_copies');
cp.execFileSync('node',['/usr/local/bin/evimed-profile-seed.mjs','seal',seed,'evimed-runtime'],{stdio:'pipe'});
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const seal=fs.readFileSync(seed+'/.evimed-profile-seed.json');
const dump=cp.execFileSync('dsh',['--profile','evimed-runtime','--dump-config'],{env:{...process.env,DSH_HOME:seed},maxBuffer:4*1024*1024});
const baseline=fs.readFileSync('/opt/evimed/dump-config.baseline.json');if(!dump.equals(baseline))throw Error('private_overlay_dump_changed');
const evidence={copies,profileSealSha256:hash(seal),profileDigest:JSON.parse(seal).digest,dumpConfigSha256:hash(dump),baselineDumpConfigSha256:hash(baseline),smokeScriptSha256:hash(fs.readFileSync('/usr/local/bin/evimed-build-smoke')),installScriptSha256:hash(fs.readFileSync('/usr/local/lib/evimed/install-runtime.sh'))};
fs.writeFileSync('/opt/evimed/private-pack-evidence.json',JSON.stringify(evidence)+'\n',{mode:0o444});
for(const target of new Set([primary,preset,loaded,seed]))cp.execFileSync('chmod',['-R','a-w',target]);
'''


class DeadlineReader:
    """Bound actual export pipe reads, including a stalled Docker daemon."""
    def __init__(self, stream, deadline):
        self.stream = stream; self.deadline = deadline

    def read(self, size):
        while True:
            remaining = self.deadline - time.monotonic()
            require(remaining > 0, "private_overlay_export_pipe_deadline")
            if select.select([self.stream], [], [], min(remaining, 1))[0]:
                return os.read(self.stream.fileno(), size)
            if BUDGET_PATH is not None:
                capacity(BUDGET_PATH)


def read_image_evidence(tag, work):
    """Read only the derived image's fixed evidence; remove its exact anonymous volumes."""
    cidfile = work / "evidence.cid"
    try:
        command(["docker", "create", "--cidfile", str(cidfile), "--network", "none", "--read-only",
                 "--memory", "128m", "--memory-swap", "128m", "--cpus", "0.5", "--pids-limit", "32",
                 "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--entrypoint", "cat", tag,
                 "/opt/evimed/private-pack-evidence.json"])
        cid = cidfile.read_text().strip()
        require(re.fullmatch(r"[a-f0-9]{64}", cid), "private_overlay_owned_container")
        raw = command(["docker", "cp", cid + ":/opt/evimed/private-pack-evidence.json", "-"])
        with tarfile.open(fileobj=io.BytesIO(raw)) as archive:
            files = archive.getmembers()
            require(len(files) == 1 and files[0].isfile() and files[0].name == "private-pack-evidence.json"
                    and files[0].size < 65536, "private_overlay_evidence_file")
            content = archive.extractfile(files[0]).read(65536)
            return {**json.loads(content), "evidenceFileSha256": digest(content)}
    finally:
        if cidfile.exists():
            cid = cidfile.read_text().strip()
            require(re.fullmatch(r"[a-f0-9]{64}", cid), "private_overlay_owned_container")
            command(["docker", "rm", "--volumes", cid])


def execute(work, public_out, public_pem_file):
    global BUDGET_PATH
    head = admit_context()
    run, attempt = os.environ["GITHUB_RUN_ID"], os.environ["GITHUB_RUN_ATTEMPT"]
    require(re.fullmatch(r"[0-9]+", run) and re.fullmatch(r"[0-9]+", attempt), "private_overlay_job_identity")
    runner_temp = Path(os.environ["RUNNER_TEMP"]).resolve(strict=True)
    require(work == runner_temp / f"evimed-private-runtime-{run}-{attempt}"
            and public_out == runner_temp / f"evimed-private-runtime-public-{run}-{attempt}", "private_overlay_temp_scope")
    work.mkdir(mode=0o700); public_out.mkdir(mode=0o700)
    BUDGET_PATH = work
    public_pem = public_pem_file.read_bytes(); require(digest(public_pem) == PUBLIC_SHA, "private_overlay_recipient_changed")
    parts = [os.environ.pop(f"EVIMED_GEO_CHUNK_{n:02}", "") for n in range(1, 37)]
    require(all(0 < len(p) <= 40960 and re.fullmatch(r"[A-Za-z0-9+/=]+", p) for p in parts), "private_overlay_secret_chunks")
    raw = base64.b64decode("".join(parts), validate=True); del parts
    context = work / "context"; context.mkdir(mode=0o700)
    pack = extract_pack(raw, context / "geo-private"); del raw
    artifact, job_id = wait_base(); core, base, reference, archive_sha = acquire_core(artifact, work)
    os.environ.pop("GH_TOKEN", None)
    inventory = json.loads((core / "manifest.json").read_bytes())
    capacity(work, inventory["archive"]["conservativeDownloadAndLoadBytes"] + 2 * 1024**3)
    engine = json.loads(command(["docker", "info", "--format", "{{json .}}"]))
    require(os.stat(work).st_dev == os.stat(engine["DockerRootDir"]).st_dev
            == os.stat("/var/lib/containerd").st_dev, "private_overlay_unmeasured_storage_plane")
    log_file = work / "smoke-build.log"
    private_write(log_file, b"")
    with log_file.open("ab") as log:
        command(["docker", "load", "--input", str(core / "images.tar.gz")], log=log, timeout=900)
        before = json.loads(command(["docker", "image", "inspect", reference]))[0]
        require(before["Id"] == base["configDigest"] and before["RootFS"]["Layers"] == base["rootfs"]["diff_ids"]
                and before["Os"] == "linux" and before["Architecture"] == "amd64" and not before["Config"].get("OnBuild"), "private_overlay_loaded_base_identity")
        alias = "evimed-private-runtime-base:" + base["configDigest"][7:]
        command(["docker", "tag", before["Id"], alias], log=log)
        # A fixed script uses base64 rather than ambiguous shell/JSON escaping.
        socket_version = before["Config"]["Labels"]["io.open-science.socket.version"]
        require(re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?", socket_version), "private_overlay_socket_identity")
        recipe = f"FROM {alias}\nCOPY geo-private /opt/evimed/skills/geo-private\nRUN printf '%s' '{base64.b64encode(UPDATE_SCRIPT.encode()).decode()}' | base64 -d | node\nRUN SOCKET_VERSION={socket_version} bash /usr/local/lib/evimed/install-runtime.sh smoke\n"
        private_write(context / "Dockerfile", recipe.encode())
        tag = "evimed-private-runtime:" + SOURCE[:12] + "-geo-" + os.environ["GITHUB_RUN_ID"]
        metadata_file = work / "buildkit.json"
        command(["docker", "buildx", "build", "--platform", "linux/amd64", "--network", "none", "--pull=false", "--load",
                 "--metadata-file", str(metadata_file), "--tag", tag,
                 "--label", "io.evimed.private-pack.tree=" + TREE_SHA,
                 "--label", "io.evimed.private-pack.base-config=" + base["configDigest"], str(context)], log=log, timeout=1800)
        after = json.loads(command(["docker", "image", "inspect", tag]))[0]
        rootfs = after["RootFS"]["Layers"]
        require(rootfs[:len(before["RootFS"]["Layers"])] == before["RootFS"]["Layers"] and len(rootfs) > len(before["RootFS"]["Layers"]), "private_overlay_base_prefix")
        for name in ["User", "Env", "Entrypoint", "Cmd", "WorkingDir", "ExposedPorts", "Volumes", "Healthcheck", "StopSignal", "Shell"]:
            require(before["Config"].get(name) == after["Config"].get(name), "private_overlay_base_configuration_changed")
        require(after["Config"]["Labels"]["org.opencontainers.image.revision"] == SOURCE, "private_overlay_derived_source")
        native = json.loads(metadata_file.read_bytes())
        require(SHA.fullmatch(native.get("containerimage.config.digest", "")) and SHA.fullmatch(native.get("containerimage.digest", "")), "private_overlay_native_export_identity")
        require(after["Id"] == native["containerimage.config.digest"] or after.get("Descriptor", {}).get("digest") == native["containerimage.digest"], "private_overlay_native_config_binding")
        physical = read_image_evidence(tag, work)
        require(len(physical["copies"]) == 3 and all(item["treeSha256"] == TREE_SHA
                and item["files"] == PACK_FILES and item["skills"] == 51
                and item["plainBytes"] == PACK_PLAIN_BYTES for item in physical["copies"]), "private_overlay_evidence_binding")
        require(physical["dumpConfigSha256"] == physical["baselineDumpConfigSha256"], "private_overlay_dump_binding")
    proof = {"kind": "private-runtime-derivation", "recipeRevision": head, "baseSourceRevision": SOURCE,
             "recipeSha256": digest(recipe.encode()), "updateScriptSha256": digest(UPDATE_SCRIPT.encode()),
             "producerWorkflow": {"repository": REPO, "runId": int(os.environ["GITHUB_RUN_ID"]),
                                  "attempt": int(os.environ["GITHUB_RUN_ATTEMPT"]), "ref": OPS_REF, "sourceRevision": head},
             "baseWorkflow": {"repository": REPO, "runId": BASE_RUN, "attempt": 1, "jobId": job_id,
                              "artifactId": artifact["id"], "artifactSha256": artifact["digest"], "archiveSha256": archive_sha},
             "baseRuntime": {"reference": reference, "configDigest": base["configDigest"], "platform": "linux/amd64",
                             "orderedRootfs": before["RootFS"]["Layers"], "labels": base["labels"]},
             "derivedRuntime": {"reference": tag, "producerStore": "github-actions-docker", "nativeImageId": after["Id"], "configDigest": native["containerimage.config.digest"],
                                "exportDigest": native["containerimage.digest"], "platform": "linux/amd64", "orderedRootfs": rootfs,
                                "labels": after["Config"]["Labels"]},
             "privatePack": {"archiveSha256": PACK_SHA, **pack, **physical,
                             "originalSmoke": {"passed": True, "scriptSha256": physical["smokeScriptSha256"], "entryScriptSha256": physical["installScriptSha256"], "logSha256": digest(log_file.read_bytes())}},
             "qualified": False, "privatePackPublishedInPlaintext": False}
    with (work / "export-stderr.log").open("xb") as err:
        os.chmod(err.name, 0o600)
        child = subprocess.Popen(["docker", "save", tag], stdout=subprocess.PIPE, stderr=err,
                                 env={k: os.environ[k] for k in ["PATH", "HOME", "DOCKER_CONFIG"] if k in os.environ}, start_new_session=True)
        try:
            envelope = encrypt_bundle(DeadlineReader(child.stdout, time.monotonic() + 1800), {"smoke-build.log": log_file.read_bytes(), "buildkit.json": metadata_file.read_bytes()},
                                      public_out / "runtime.bundle.enc", public_pem, proof)
            require(child.wait(timeout=30) == 0, "private_overlay_export_failed")
        finally:
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGTERM)
                try: child.wait(timeout=5)
                except subprocess.TimeoutExpired: os.killpg(child.pid, signal.SIGKILL); child.wait(timeout=5)
    private_write(public_out / "protection.json", canonical(envelope) + b"\n")
    private_write(public_out / "protection.json.sha256", (digest((public_out / "protection.json").read_bytes()) + "  protection.json\n").encode())
    print(json.dumps({"state": "encrypted_export_complete", "files": PACK_FILES, "skills": 51, "treeSha256": TREE_SHA,
                      "ciphertextBytes": envelope["protection"]["ciphertextBytes"], "ciphertextSha256": envelope["protection"]["ciphertextSha256"]}))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--work", required=True, type=Path)
    parser.add_argument("--public-out", required=True, type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    try:
        execute(args.work, args.public_out, Path(__file__).with_name("private-runtime-recipient.pub"))
    except BaseException:
        # Do not expose URLs, base64 inputs, decrypted method text or child logs.
        print("private_runtime_overlay_failed", file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
