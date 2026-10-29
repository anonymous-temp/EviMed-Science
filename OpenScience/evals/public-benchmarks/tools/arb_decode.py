#!/usr/bin/env python3 -I
"""Stdlib-only decoder for the AutoResearchBench public bundle (scheme public_canary_xor_sha256).

Re-implements decrypt_benchmark.py of CherYou/AutoResearchBench for the *public* scheme only
(no password, no third-party code executed): base64 -> XOR with sha256(canary) stream -> gunzip,
then verifies the sha256 recorded in the bundle's metadata.

Usage: python3 -I tools/arb_decode.py <bundle.obf.json> <out.jsonl>
"""
import base64, gzip, hashlib, json, sys
from pathlib import Path


def decode(bundle_path: str) -> bytes:
    payload = json.loads(Path(bundle_path).read_text(encoding="utf-8"))
    if payload.get("format") != "scienceagent-benchmark-encrypted" or payload.get("version") != 1:
        raise SystemExit("unsupported bundle format")
    if payload.get("scheme") != "public_canary_xor_sha256" or payload.get("compression") != "gzip":
        raise SystemExit("unsupported scheme (this decoder handles the public scheme only)")
    canary = payload["metadata"]["canary_string"]
    ct = base64.b64decode(payload["ciphertext"].encode("ascii"))
    digest = hashlib.sha256(canary.encode("utf-8")).digest()
    mask = digest * (len(ct) // len(digest)) + digest[: len(ct) % len(digest)]
    plain = gzip.decompress(bytes(a ^ b for a, b in zip(ct, mask)))
    want = payload["metadata"].get("original_sha256")
    if want and hashlib.sha256(plain).hexdigest() != want:
        raise SystemExit("integrity check failed")
    return plain


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    Path(sys.argv[2]).write_bytes(decode(sys.argv[1]))
    print("ok", sys.argv[2])
