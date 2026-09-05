#!/bin/sh
set -eu

model="${EVIMED_OLLAMA_MODEL:?EVIMED_OLLAMA_MODEL is required}"
expected="${EVIMED_OLLAMA_MODEL_MANIFEST_SHA256:?EVIMED_OLLAMA_MODEL_MANIFEST_SHA256 is required}"
models="${OLLAMA_MODELS:?OLLAMA_MODELS is required}"
store="${EVIMED_OLLAMA_STORE:?EVIMED_OLLAMA_STORE is required}"
staging_root=""
server_pid=""

case "$model" in
  bge-m3:latest) manifest_relative="manifests/registry.ollama.ai/library/bge-m3/latest" ;;
  *) echo "unsupported embedding model" >&2; exit 1 ;;
esac
case "$expected" in
  *[!0-9a-f]*|'') echo "invalid model manifest digest" >&2; exit 1 ;;
esac
[ "${#expected}" -eq 64 ] || { echo "invalid model manifest digest" >&2; exit 1; }
[ "$models" = "$store/current/models" ] || { echo "invalid embedding model store layout" >&2; exit 1; }
generation="$store/generations/$expected"
generation_models="$generation/models"
legacy_models="$store/models"

verify_models() {
  candidate_models="$1"
  candidate_manifest="$candidate_models/$manifest_relative"
  [ -f "$candidate_manifest" ] || return 1
  [ "$(sha256sum "$candidate_manifest" | cut -d ' ' -f 1)" = "$expected" ] || return 1
  digests="$(grep -oE 'sha256:[0-9a-f]{64}' "$candidate_manifest" | sort -u)"
  [ -n "$digests" ] || return 1
  for digest in $digests; do
    hex="${digest#sha256:}"
    blob="$candidate_models/blobs/sha256-$hex"
    [ -f "$blob" ] || return 1
    [ "$(sha256sum "$blob" | cut -d ' ' -f 1)" = "$hex" ] || return 1
  done
}

cleanup() {
  if [ -n "$server_pid" ]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  if [ -n "$staging_root" ]; then rm -rf "$staging_root"; fi
}
trap cleanup EXIT INT TERM

activate_generation() {
  candidate="$1"
  [ -d "$candidate/models" ] || return 1
  temporary_link="$store/.current.$$"
  rm -f "$temporary_link"
  ln -s "${candidate#"$store/"}" "$temporary_link"
  mv -Tf "$temporary_link" "$store/current"
}

# A verified cache is a complete offline success path. Never contact a mutable
# tag during a normal restart and never replace the last known-good model.
if verify_models "$models"; then
  chown -R 10002:10002 "$store"
  echo "embedding model verified from cache"
  exit 0
fi

# Recover an immutable generation if a previous initializer was killed before
# publishing its one atomic pointer switch.
if verify_models "$generation_models"; then
  activate_generation "$generation"
  chown -R 10002:10002 "$store"
  echo "embedding model generation recovered"
  exit 0
fi

# Adopt the pre-generation layout once. A crash after the directory rename is
# recovered by the generation branch above; no verified bytes are discarded.
if verify_models "$legacy_models"; then
  mkdir -p "$store/generations"
  rm -rf "$generation"
  mkdir -p "$generation"
  mv "$legacy_models" "$generation_models"
  activate_generation "$generation"
  chown -R 10002:10002 "$store"
  echo "embedding model cache migrated"
  exit 0
fi

staging_root="$store/generations/.staging.$$"
staging_models="$staging_root/models"
rm -rf "$staging_root"
mkdir -p "$staging_models"

OLLAMA_MODELS="$staging_models" /bin/ollama serve >/tmp/ollama-init.log 2>&1 &
server_pid=$!

attempt=0
until /bin/ollama list >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 60 ] || { echo "embedding service did not start" >&2; exit 1; }
  sleep 1
done

/bin/ollama pull "$model" >/dev/null 2>&1
verify_models "$staging_models" || { echo "downloaded embedding model failed digest verification" >&2; exit 1; }

kill "$server_pid" 2>/dev/null || true
wait "$server_pid" 2>/dev/null || true
server_pid=""
mkdir -p "$store/generations"
rm -rf "$generation"
mv "$staging_root" "$generation"
staging_root=""
activate_generation "$generation"
chown -R 10002:10002 "$store"
echo "embedding model downloaded and verified"
