#!/usr/bin/env bash
# Fetch the pinned external skill packs into runtime/skills/external/
# (git-ignored; bundled into the hosted runtime image).
# Runs locally and in CI so the skills never live in this repo's git history.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

# ---- ai4s-skills: the default scientific pack ----
AI4S_SKILLS_COMMIT="${AI4S_SKILLS_COMMIT:-8fa2ab0523082c135598909b227ed8feb48263ad}"
OUT_DIR="$ROOT/runtime/skills/external/ai4s-skills"

URL="https://codeload.github.com/ai4s-research/ai4s-skills/tar.gz/${AI4S_SKILLS_COMMIT}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
echo "Downloading $URL"
curl -4 --retry 2 --connect-timeout 15 --max-time 120 -fsSL "$URL" -o "$TMP/skills.tar.gz"
tar -xzf "$TMP/skills.tar.gz" -C "$TMP"

SRC="$(find "$TMP" -maxdepth 1 -type d -name 'ai4s-skills-*' | head -1)"
[ -d "$SRC/skills" ] || { echo "No skills/ directory in archive" >&2; exit 1; }

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"
cp -R "$SRC/skills/." "$OUT_DIR/"
cp "$SRC/LICENSE" "$OUT_DIR/LICENSE.ai4s-skills"
python3 "$ROOT/scripts/dev/patch-ai4s-integrity-auditor.py" "$OUT_DIR"
echo "$AI4S_SKILLS_COMMIT" > "$OUT_DIR/.commit"
rm -rf "$TMP"

echo "Placed ai4s-skills@${AI4S_SKILLS_COMMIT:0:7} in $OUT_DIR:"
ls "$OUT_DIR"

# Office exporters are first-party MIT code in runtime/skills/office. Restricted
# Anthropic document skills are intentionally neither fetched nor packaged.
