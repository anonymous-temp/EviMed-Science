#!/usr/bin/env bash
# Install or refresh the offline RSI campaign from an operator machine that reaches both hosts (2026-10-26).
#
#   rsi-lab-install.sh lab        [--worktree]   build the lab image on the lab host from this checkout, install the launchers,
#                                                the owner inputs, the monthly timer and the bundle channel
#   rsi-lab-install.sh channel                   the bundle channel alone: the lab's read-only `rsi-outbox` account, pinned to production's key and address
#   rsi-lab-install.sh production                install the export, the push, the bundle pull and their timers on the serving host, with the deployment
#                                                records the web container would verify a bundle by. Inert until the deployment's .env names
#                                                OPEN_SCIENCE_RSI_CONFIG_HOST_DIR=/var/lib/evimed-rsi/online (the release switch then composes docker-compose.rsi.yml).
#
# Hosts are ssh aliases: RSI_LAB_SSH (default evimed-test), RSI_PRODUCTION_SSH (default evimed). The lab image is built from
# `git archive HEAD` (the committed tree, so the image names a commit); --worktree builds from the working tree for a rehearsal.
# Keys never leave the host they were generated on: the lab's signers on the lab (rsi-lab-setup), production's pull key on production (the channel step), and only their
# public halves are read back. Every mode can be run again. RSI_LAB_DRY_RUN=1 prints what would reach the hosts and reaches neither; RSI_INSTALL_ROOT prefixes the hosts' paths for a test.
set -euo pipefail
MODE=${1:?lab|channel|production}; WORKTREE=${2:-}
LAB=${RSI_LAB_SSH:-evimed-test} PROD=${RSI_PRODUCTION_SSH:-evimed} LAB_IP=${RSI_LAB_ADDRESS:-123.57.53.47} PROD_IP=${RSI_PRODUCTION_ADDRESS:-82.156.128.153}
R=${RSI_INSTALL_ROOT:-} DRY=${RSI_LAB_DRY_RUN:-}
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
if [ -n "$DRY" ]; then
  ssh() { echo "[dry-run] ssh $*" >&2; cat > /dev/null; }
  scp() { echo "[dry-run] scp $*" >&2; }
fi
PATHS=(apps/server/src apps/server/package.json packages/domain/src packages/domain/index.mjs packages/domain/package.json
  evals/rsi-campaigns evals/frontier-selection/gold.jsonl evals/frontier-selection/metrics.mjs evals/frontier-selection/results
  deploy/rsi-campaign package.json pnpm-lock.yaml pnpm-workspace.yaml deps-version.json)

# The bundle channel, the mirror image of the inbox: production's key may do one thing on the lab, read outbox/bundles through a forced `rrsync -ro`, and only from production's address.
install_channel() {
  local pull
  pull=$(ssh "$PROD" RSI_INSTALL_ROOT="$R" bash -s <<'REMOTE'
set -euo pipefail
KEY=${RSI_INSTALL_ROOT:-}/etc/evimed-rsi/pull_ed25519
sudo install -d -m 0700 "$(dirname "$KEY")"
sudo test -s "$KEY" || sudo ssh-keygen -q -t ed25519 -N '' -C evimed-rsi-bundle-pull -f "$KEY"
sudo cat "$KEY.pub"
REMOTE
)
  [ -n "$pull" ] || [ -n "$DRY" ] || { echo "production gave no pull key" >&2; exit 2; }
  ssh "$LAB" RSI_INSTALL_ROOT="$R" PROD_IP="$PROD_IP" "PULL_PUB='$pull'" bash -s <<'REMOTE'
set -euo pipefail
R=${RSI_INSTALL_ROOT:-}
RRSYNC=$(command -v rrsync || echo /usr/share/doc/rsync/scripts/rrsync)
[ -x "$RRSYNC" ] || { echo "rrsync is missing on the lab" >&2; exit 2; }
HOME_DIR=$R/home/rsi-outbox BUNDLES=$R/srv/rsi-lab/outbox/bundles
id rsi-outbox >/dev/null 2>&1 || useradd --system --create-home --home-dir "$HOME_DIR" --shell /bin/sh rsi-outbox
# No password, and not a locked one: sshd without PAM refuses a key to a locked account.
usermod -p '*' rsi-outbox
# The directory the monthly script publishes into exists before the first bundle, or every pull would fail; only it is world-readable, a month's directory stays the lab's.
install -d -m 0755 "$BUNDLES"
chown 10001:10001 "$BUNDLES"
chmod o+x "$R/srv/rsi-lab/outbox"
install -d -m 0700 "$HOME_DIR/.ssh"
printf 'command="%s -ro %s",from="%s",restrict %s\n' "$RRSYNC" "$BUNDLES" "$PROD_IP" "$PULL_PUB" > "$HOME_DIR/.ssh/authorized_keys.tmp"
chmod 0600 "$HOME_DIR/.ssh/authorized_keys.tmp"
chown -R rsi-outbox:rsi-outbox "$HOME_DIR/.ssh"
mv -f "$HOME_DIR/.ssh/authorized_keys.tmp" "$HOME_DIR/.ssh/authorized_keys"
echo "bundle channel on the lab: $RRSYNC -ro $BUNDLES, from $PROD_IP"
REMOTE
}

if [ "$MODE" = channel ]; then
  install_channel
elif [ "$MODE" = lab ]; then
  TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
  if [ "$WORKTREE" = --worktree ]; then
    REV=wt-$(cd "$ROOT" && tar -cf - "${PATHS[@]}" | sha256sum | cut -c1-12)
    (cd "$ROOT" && tar --exclude='__pycache__' --exclude='.pytest_cache' -czf "$TMP/context.tgz" "${PATHS[@]}")
  else
    [ -z "$(git -C "$ROOT" status --porcelain -- "${PATHS[@]}")" ] || { echo "uncommitted changes under the image paths; commit or pass --worktree" >&2; exit 2; }
    REV=$(git -C "$ROOT" rev-parse --short=12 HEAD)
    git -C "$ROOT" archive --format=tar HEAD "${PATHS[@]/#/}" | gzip -n > "$TMP/context.tgz"
  fi
  scp -q "$TMP/context.tgz" "$LAB:/srv/rsi-lab/release/$REV.tgz"
  scp -q "$HERE/rsi-lab-monthly.sh" "$HERE/rsi-lab-skill.sh" "$HERE/rsi-lab-harness.sh" "$HERE/systemd/evimed-rsi-campaign.service" "$HERE/systemd/evimed-rsi-campaign.timer" \
    "$ROOT/evals/rsi-campaigns/reports/statistics-v5-qualification.json" "$LAB:/srv/rsi-lab/release/"
  ssh "$LAB" REV="$REV" bash -s <<'REMOTE'
set -euo pipefail
cd /srv/rsi-lab/release && rm -rf "$REV" && mkdir "$REV" && tar -xzf "$REV.tgz" -C "$REV"
docker build -q --network host -t "evimed-rsi-lab:$REV" -f "$REV/deploy/rsi-campaign/Dockerfile" "$REV" >/dev/null
echo "evimed-rsi-lab:$REV" > /etc/rsi-lab/image
install -d -m 0755 /usr/local/lib/evimed-rsi
install -m 0755 rsi-lab-monthly.sh /usr/local/lib/evimed-rsi/rsi-lab-monthly.sh
install -m 0755 rsi-lab-skill.sh /usr/local/lib/evimed-rsi/rsi-lab-skill.sh
install -m 0755 rsi-lab-harness.sh /usr/local/lib/evimed-rsi/rsi-lab-harness.sh
install -m 0644 evimed-rsi-campaign.service evimed-rsi-campaign.timer /etc/systemd/system/
# Owner inputs: the lab configuration, the public trust records, the signers' file paths. Deployment records are 0600 for uid 10001.
# The lab calls one model: Qwen 3.8 Max, the frontier jury (owner 2026-11-03, after a measurement), and holds that one provider credential
# (/etc/rsi-lab/credentials/dashscope.key, read-only into the jury's calibrate and label steps of rsi-lab-monthly.sh and nowhere else). Every other model
# role (improvers, the other judges) runs on the operator's box, so the configuration names no other provider and the skill and harness scripts
# mount no credential.
O=/etc/rsi-lab/owner-inputs
fp() { openssl pkey -pubin -in "$1" -outform DER | sha256sum | cut -d' ' -f1; }
EV=$(fp $O/evaluator.pub.pem) PUB=$(fp $O/publisher.pub.pem) INSTANCE=$(curl -s -m 3 http://100.100.100.200/latest/meta-data/instance-id)
cat > $O/config.json <<JSON
{"host":{"provider":"alibaba","purpose":"rsi-lab","instanceId":"$INSTANCE","region":"cn-beijing"},
 "transport":{"kind":"none"},
 "signer":{"keyId":"rsi-lab-publisher-2026-10","publicKeySha256":"$PUB"},
 "authority":{"role":"rsi-lab","accountId":"rsi-lab","dataDir":"/srv/rsi-lab","databaseRole":"rsi_lab"},
 "budget":{"campaignCny":1000,"monthCny":30000},
 "providers":{"qwenMax":{"provider":"dashscope","model":"qwen3.8-max","credentialRef":"lab:dashscope"}}}
JSON
cat > $O/evaluator-profile.json <<JSON
{"publicKeyPath":"/run/rsi-lab/evaluator.pub.pem","publicKeySha256":"$EV","receiptPath":"/srv/rsi-lab/state/current/receipt.json"}
JSON
cat > $O/evaluator-profile-skill.json <<JSON
{"publicKeyPath":"/run/rsi-lab/evaluator.pub.pem","publicKeySha256":"$EV","receiptPath":"/srv/rsi-lab/state/skill-current/receipt.json"}
JSON
# The harness-patch campaigns share one receipt path; rsi-lab-harness.sh points `harness-current` at the family it is signing, under a lock.
cat > $O/evaluator-profile-harness.json <<JSON
{"publicKeyPath":"/run/rsi-lab/evaluator.pub.pem","publicKeySha256":"$EV","receiptPath":"/srv/rsi-lab/state/harness-current/receipt.json"}
JSON
install -m 0644 statistics-v5-qualification.json $O/statistics-qualification.json
Q=$(docker run --rm --network none --user 10001:10001 -v $O:/run/rsi-lab:ro "evimed-rsi-lab:$REV" evals/rsi-campaigns/evaluator.mjs qualification /run/rsi-lab/statistics-qualification.json superiority)
PROCEDURE=$(echo "$Q" | python3 -c 'import json,sys;print(json.load(sys.stdin)["procedureDigest"])') QUALIFICATION=$(echo "$Q" | python3 -c 'import json,sys;print(json.load(sys.stdin)["qualificationDigest"])')
# What this image's consumer digest is, for `production` to compare with the serving release's: a bundle imports only where the two are one.
echo "$Q" | python3 -c 'import json,sys;print(json.load(sys.stdin)["consumerDigest"])' > $O/consumer-digest
cat > $O/finalizer-profile.json <<JSON
{"publicKey":$(python3 -c 'import json,sys;print(json.dumps(open(sys.argv[1]).read()))' $O/evaluator.pub.pem),"publicKeySha256":"$EV","procedureDigests":["$PROCEDURE"],"qualificationDigests":["$QUALIFICATION"]}
JSON
cat > $O/finalize.json <<JSON
{"purpose":"production","inputPath":"/srv/rsi-lab/state/current/finalize-input.json","outputPath":"/srv/rsi-lab/state/current/bundle.json",
 "profileRef":"/run/rsi-lab/finalizer-profile.json","consumerRoot":"/opt/evimed/OpenScience","closurePaths":[],"currentTarget":"manifest",
 "publisher":{"provider":"file","keyId":"rsi-lab-publisher-2026-10","publicKeySha256":"$PUB","path":"/run/rsi-keys/publisher.pem"},
 "evaluator":{"provider":"file","keyId":"rsi-lab-evaluator-2026-10","publicKeySha256":"$EV","path":"/run/rsi-keys/evaluator.pem"},
 "statisticsPython":"/usr/local/bin/python3","statisticsModulePath":"/opt/evimed/rsi-python","closureSettings":{"model":"deepseek-flash","provider":"deepseek"},"closurePins":{}}
JSON
chown root:rsi-lab $O/config.json $O/evaluator-profile.json $O/evaluator-profile-skill.json $O/evaluator-profile-harness.json $O/statistics-qualification.json && chmod 0640 $O/config.json $O/evaluator-profile.json $O/evaluator-profile-skill.json $O/evaluator-profile-harness.json && chmod 0644 $O/statistics-qualification.json
chown root:rsi-lab $O/consumer-digest && chmod 0640 $O/consumer-digest
chown 10001:10001 $O/finalizer-profile.json $O/finalize.json && chmod 0600 $O/finalizer-profile.json $O/finalize.json
systemctl daemon-reload && systemctl enable --now evimed-rsi-campaign.timer >/dev/null
# Keep the three newest images and source trees.
docker images --format '{{.Repository}}:{{.Tag}} {{.CreatedAt}}' | awk '$1 ~ /^evimed-rsi-lab:/' | sort -k2 -r | tail -n +4 | cut -d' ' -f1 | xargs -r docker rmi -f >/dev/null
ls -1dt /srv/rsi-lab/release/*/ 2>/dev/null | tail -n +4 | xargs -r rm -rf
ls -1t /srv/rsi-lab/release/*.tgz 2>/dev/null | tail -n +4 | xargs -r rm -f
echo "lab installed: $(cat /etc/rsi-lab/image); next run: $(systemctl list-timers evimed-rsi-campaign.timer --no-legend | awk '{print $1, $2, $3}')"
REMOTE
  install_channel
elif [ "$MODE" = production ]; then
  # What the web container verifies a bundle by, from the lab: public halves and digests, nothing else crosses.
  FACTS=$(mktemp -d); trap 'rm -rf "$FACTS"' EXIT
  ssh "$LAB" RSI_INSTALL_ROOT="$R" bash -s > "$FACTS/rsi-lab-facts.json" <<'REMOTE'
set -euo pipefail
python3 - "${RSI_INSTALL_ROOT:-}/etc/rsi-lab/owner-inputs" <<'PY'
import json, sys
inputs = sys.argv[1]
read = lambda name: open(f'{inputs}/{name}').read()
finalize, profile = json.loads(read('finalize.json')), json.loads(read('finalizer-profile.json'))
print(json.dumps({'publisher': {'keyId': finalize['publisher']['keyId'], 'publicKey': read('publisher.pub.pem')}, 'evaluator': {'keyId': finalize['evaluator']['keyId'], 'publicKey': read('evaluator.pub.pem')},
                  'procedureDigests': profile['procedureDigests'], 'consumerDigest': read('consumer-digest').strip()}))
PY
REMOTE
  [ -s "$FACTS/rsi-lab-facts.json" ] || [ -n "$DRY" ] || { echo "the lab gave no records: run rsi-lab-install.sh lab first" >&2; exit 2; }
  # A directory of the ssh user's own, made on the host: what `sudo` installs or runs is read from it, and a name under /tmp is one another local user could have taken first.
  FROM=$(ssh "$PROD" RSI_INSTALL_ROOT="$R" bash -s <<'REMOTE'
mktemp -d "${RSI_INSTALL_ROOT:-}/tmp/rsi-install.XXXXXXXXXX"
REMOTE
)
  [ -n "$FROM" ] || [ -n "$DRY" ] || { echo "production gave no private directory" >&2; exit 2; }
  scp -q "$ROOT/scripts/ops/rsi-frontier-export.mjs" "$ROOT/scripts/ops/rsi-signals-export.mjs" "$HERE/production/rsi-frontier-push.sh" "$HERE/production/evimed-rsi-frontier-push.service" "$HERE/production/evimed-rsi-frontier-push.timer" \
    "$HERE/production/rsi-bundle-pull.sh" "$HERE/production/evimed-rsi-bundle-pull.service" "$HERE/production/evimed-rsi-bundle-pull.timer" "$HERE/production/rsi-consumer-digest.mjs" "$HERE/production/rsi-online-records.py" \
    "$FACTS/rsi-lab-facts.json" "$PROD:${FROM:-/tmp/rsi-install.dry-run}/"
  ssh "$PROD" LAB_IP="$LAB_IP" RSI_INSTALL_ROOT="$R" FROM="$FROM" bash -s <<'REMOTE'
set -euo pipefail
trap 'rm -rf "$FROM"' EXIT
R=${RSI_INSTALL_ROOT:-} ETC=${RSI_INSTALL_ROOT:-}/etc/evimed-rsi LIB=${RSI_INSTALL_ROOT:-}/usr/local/lib/evimed-rsi UNITS=${RSI_INSTALL_ROOT:-}/etc/systemd/system ONLINE=${RSI_INSTALL_ROOT:-}/var/lib/evimed-rsi/online
WEB=${RSI_EXPORT_WEB_CONTAINER:-web-open-science-web-1}
sudo install -d -m 0755 "$LIB" && sudo install -d -m 0700 "$R/var/lib/evimed-rsi" "$ETC"
sudo install -m 0644 "$FROM/rsi-frontier-export.mjs" "$LIB/rsi-frontier-export.mjs"
sudo install -m 0644 "$FROM/rsi-signals-export.mjs" "$LIB/rsi-signals-export.mjs"
sudo install -m 0755 "$FROM/rsi-frontier-push.sh" "$LIB/rsi-frontier-push.sh"
sudo install -m 0755 "$FROM/rsi-bundle-pull.sh" "$LIB/rsi-bundle-pull.sh"
sudo install -d -m 0755 "$UNITS"
sudo install -m 0644 "$FROM/evimed-rsi-frontier-push.service" "$FROM/evimed-rsi-frontier-push.timer" "$FROM/evimed-rsi-bundle-pull.service" "$FROM/evimed-rsi-bundle-pull.timer" "$UNITS/"
echo "$LAB_IP" | sudo tee "$ETC/lab-host" >/dev/null
sudo test -s "$ETC/push_ed25519" || { echo "push key missing: run the lab setup first" >&2; exit 2; }
sudo test -s "$ETC/pull_ed25519" || { echo "pull key missing: run rsi-lab-install.sh channel first" >&2; exit 2; }
# The directory the overlay binds read-only into the web container (compose never creates it): the records beside the bundles the pull brings. The server's own digest of its consumer
# is what the registry admits and what a bundle's target is compared with, so it comes from the running release.
sudo install -d -m 0755 "$ONLINE" "$ONLINE/bundles"
CONSUMER=$(sudo docker exec -i "$WEB" node --input-type=module - < "$FROM/rsi-consumer-digest.mjs")
sudo python3 -I "$FROM/rsi-online-records.py" "$ONLINE" "$FROM/rsi-lab-facts.json" "$CONSUMER"
LAB_CONSUMER=$(python3 -I -c 'import json,sys;print(json.load(open(sys.argv[1]))["consumerDigest"])' "$FROM/rsi-lab-facts.json")
[ "$LAB_CONSUMER" = "$CONSUMER" ] || echo "NOTE: the lab image's frontier consumer is $LAB_CONSUMER and the serving release's is $CONSUMER: a bundle signed by that image will not import here; run rsi-lab-install.sh lab from the serving commit" >&2
sudo systemctl daemon-reload && sudo systemctl enable --now evimed-rsi-frontier-push.timer evimed-rsi-bundle-pull.timer >/dev/null
echo "production installed; next push: $(systemctl list-timers evimed-rsi-frontier-push.timer --no-legend | awk '{print $1, $2, $3}'); next pull: $(systemctl list-timers evimed-rsi-bundle-pull.timer --no-legend | awk '{print $1, $2, $3}')"
echo "deployment records in $ONLINE, consumer $CONSUMER; the import is off until the deployment's .env names OPEN_SCIENCE_RSI_CONFIG_HOST_DIR=${ONLINE#"$R"}"
REMOTE
else echo "usage: rsi-lab-install.sh lab [--worktree] | channel | production" >&2; exit 2; fi
