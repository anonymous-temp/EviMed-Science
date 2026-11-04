#!/usr/bin/env bash
# Build the one Actions secret of the RSI lab (RSI_LAB_BUNDLE) from files and set it, never printing a byte of it.
#
#   make-bundle.sh [--print-size]
#
# Reads the provider keys from the operator's secrets directory and the broker identity from the lab's key directory:
#   SECRETS  (default <workspace>/.evimed-local/secrets): deepseek.api-key dashscope.api-key evimed.api-key typesafe.api-key
#            unpaywall.email materials-project.api-key
#   BROKER   (default /tmp/rsi2-scratch/keys): broker_ed25519 (private key), broker.host (host or host:port), broker.known_hosts
# The result is a base64 tar.gz of `secrets/*` and `broker/*`; it goes to `gh secret set RSI_LAB_BUNDLE --repo REPO` on stdin.
# A bundle above 48 KB is refused: the Actions secret limit is 48 KB and a split would need a second secret name.
set -euo pipefail
set +x
SECRETS="${SECRETS:-/home/coder/workspace/EviMedScience/.evimed-local/secrets}"
BROKER="${BROKER:-/tmp/rsi2-scratch/keys}"
REPO="${REPO:-anonymous-temp/EviMed-Science}"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
umask 077
mkdir -p "$stage/secrets" "$stage/broker"
names=(deepseek.api-key dashscope.api-key evimed.api-key typesafe.api-key materials-project.api-key)
# The Unpaywall contact address is passed to the public-source gateway as in production; OMIT_UNPAYWALL=1 leaves it out of the bundle.
if [ "${OMIT_UNPAYWALL:-0}" != "1" ]; then names+=(unpaywall.email); fi
# Operator addresses that stay out of this public repository (each one line; every file of secrets/ is masked in the job's log): the document
# parsing service production reads PDFs through (document-parser.url, e.g. http://host:port) and the Tokyo edge proxy's host (edge-proxy.host,
# used only to record whether a runner can reach it). A bundle without one leaves that piece out, and the lab says so in every result.
optional=(document-parser.url edge-proxy.host)
for name in "${names[@]}"; do
  test -s "$SECRETS/$name" || { echo "missing secret file: $name" >&2; exit 1; }
  install -m 0600 "$SECRETS/$name" "$stage/secrets/$name"
done
for name in "${optional[@]}"; do
  if [ -s "$SECRETS/$name" ]; then install -m 0600 "$SECRETS/$name" "$stage/secrets/$name"; fi
done
install -m 0600 "$BROKER/broker_ed25519" "$stage/broker/id_ed25519"
install -m 0600 "$BROKER/broker.host" "$stage/broker/host"
install -m 0600 "$BROKER/broker.known_hosts" "$stage/broker/known_hosts"
tar -C "$stage" -czf "$stage/bundle.tgz" secrets broker
base64 -w0 "$stage/bundle.tgz" > "$stage/bundle.b64"
size="$(stat -c %s "$stage/bundle.b64")"
if [ "$size" -gt 48000 ]; then echo "bundle is $size bytes, over the 48 KB secret limit" >&2; exit 1; fi
if [ "${1:-}" = "--print-size" ]; then echo "bundle: $size bytes"; exit 0; fi
gh secret set RSI_LAB_BUNDLE --repo "$REPO" < "$stage/bundle.b64"
echo "RSI_LAB_BUNDLE set ($size bytes)"
