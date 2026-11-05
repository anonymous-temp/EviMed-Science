#!/usr/bin/env bash
# Production side of the bundle channel (2026-11-04), the mirror image of the push: the lab writes bundles, production polls them, and nothing crosses the other way. The key's
# authorized_keys entry on the lab forces `rrsync -ro` on the one directory and pins this host's address; the lab holds no credential for this host. What arrives lands in the
# directory the web container reads through a read-only mount (rsiDirectoryTransport.mjs), where the importer verifies it: this script trusts no file and decides nothing.
#
# A bundle is immutable under the name of its bytes, so an existing file is never touched and nothing is ever deleted (the poller's decision on a digest is kept against
# that name). rsync writes each file under a hidden name and renames it, and those names are no bundle's to the reader; no link is copied; the size is the reader's own bound.
# Idempotent: with nothing new it copies nothing. RSI_LAB_DRY_RUN=1 prints the command and changes nothing. RSI_CONFIG_DIR and RSI_BUNDLE_DIR move the host layout for a test.
set -euo pipefail
umask 022
CONF=${RSI_CONFIG_DIR:-/etc/evimed-rsi} DEST=${RSI_BUNDLE_DIR:-/var/lib/evimed-rsi/online/bundles}
DRY=${RSI_LAB_DRY_RUN:-}
if [ -n "$DRY" ] && [ ! -s "$CONF/lab-host" ]; then LAB=lab.example; else LAB=$(cat "$CONF/lab-host"); fi
SSH="ssh -i $CONF/pull_ed25519 -o UserKnownHostsFile=$CONF/known_hosts -o StrictHostKeyChecking=yes -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=30"
PULL=(rsync -e "$SSH" --recursive --times --ignore-existing --no-links --no-perms --chmod=F644 --max-size=5m --timeout=120 --exclude='*/' --include='[0-9a-f]*.json' --exclude='*' "rsi-outbox@$LAB:./" "$DEST/")
if [ -n "$DRY" ]; then echo "[dry-run] ${PULL[*]}" >&2; exit 0; fi
[ -d "$DEST" ] || { echo "$DEST is missing: run rsi-lab-install.sh production" >&2; exit 2; }
before=$(find "$DEST" -maxdepth 1 -type f -name '*.json' | wc -l)
"${PULL[@]}"
echo "$(date -u +%FT%TZ) pulled $(($(find "$DEST" -maxdepth 1 -type f -name '*.json' | wc -l) - before)) new bundle(s) from $LAB"
