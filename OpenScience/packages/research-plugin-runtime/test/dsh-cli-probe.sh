#!/bin/sh
# Run in an isolated DSH+R environment with local packed dependencies.
set -eu
: "${VCR_TEST_TARBALLS:?directory containing packed tgz files}"
: "${VCR_TEST_ENGINE:?separately installed VCR engine root}"
: "${VCR_TEST_KERNEL_MODULES:?DSH installation's @deepseek-ai module directory}"
: "${PLUGIN_PACKAGE:?one domain package name}"
: "${PLUGIN_CASE:?matching underscore tool prefix}"
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
export DSH_HOME="$scratch/home" npm_config_store_dir="$scratch/store"
export VCR_PLUGIN_MODE=standalone VCR_PLUGIN_WORKSPACE="$scratch/workspace" VCR_ENGINE_ROOT="$VCR_TEST_ENGINE"
mkdir -p "$VCR_PLUGIN_WORKSPACE"
dsh --profile headless --dump-config >/dev/null
cat > "$DSH_HOME/profiles/headless/pnpm-workspace.yaml" <<END
overrides:
  '@evimed/domain': file:$VCR_TEST_TARBALLS/evimed-domain-0.1.0.tgz
  '@evimed/design-tokens': file:$VCR_TEST_TARBALLS/evimed-design-tokens-3.1.0.tgz
  '@evimed/harness-port': file:$VCR_TEST_TARBALLS/evimed-harness-port-0.1.0.tgz
  '@evimed/research-plugin-runtime': file:$VCR_TEST_TARBALLS/evimed-research-plugin-runtime-0.1.0.tgz
END
dsh plugin --profile headless add "$VCR_TEST_TARBALLS/evimed-harness-port-0.1.0.tgz" "$VCR_TEST_TARBALLS/evimed-$PLUGIN_PACKAGE-0.1.0.tgz" --ignore-scripts --offline
dsh --profile headless --dump-config | grep -q "id: evimed-$PLUGIN_PACKAGE"
# Node's standalone probe resolves the same kernel modules used by the DSH CLI.
ln -s "$VCR_TEST_KERNEL_MODULES" "$DSH_HOME/profiles/headless/node_modules/@deepseek-ai"
cp "$(dirname "$0")/installed-native.mjs" "$DSH_HOME/profiles/headless/installed-native.mjs"
WORKSPACE="$VCR_PLUGIN_WORKSPACE" ENGINE_ROOT="$VCR_ENGINE_ROOT" node "$DSH_HOME/profiles/headless/installed-native.mjs"
dsh plugin --profile headless remove "@evimed/$PLUGIN_PACKAGE"
if dsh --profile headless --dump-config | grep -q "id: evimed-$PLUGIN_PACKAGE"; then exit 1; fi
