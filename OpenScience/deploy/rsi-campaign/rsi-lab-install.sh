#!/usr/bin/env bash
# Install or refresh the offline RSI campaign from an operator machine that reaches both hosts (2026-10-26).
#
#   rsi-lab-install.sh lab        [--worktree]   build the lab image on the lab host from this checkout, install the launcher,
#                                                the owner inputs and the monthly timer
#   rsi-lab-install.sh production                install the export, the push script and its timer on the serving host
#
# Hosts are ssh aliases: RSI_LAB_SSH (default evimed-test), RSI_PRODUCTION_SSH (default evimed). The lab image is built from
# `git archive HEAD` (the committed tree, so the image names a commit); --worktree builds from the working tree for a rehearsal.
# Keys never leave the lab host: they are generated there (rsi-lab-setup) and only their public halves are read back.
set -euo pipefail
MODE=${1:?lab|production}; WORKTREE=${2:-}
LAB=${RSI_LAB_SSH:-evimed-test} PROD=${RSI_PRODUCTION_SSH:-evimed} LAB_IP=${RSI_LAB_ADDRESS:-123.57.53.47}
ROOT=$(git rev-parse --show-toplevel)/OpenScience
HERE=$ROOT/deploy/rsi-campaign
PATHS=(apps/server/src apps/server/package.json packages/domain/src packages/domain/index.mjs packages/domain/package.json
  evals/rsi-campaigns evals/frontier-selection/gold.jsonl evals/frontier-selection/metrics.mjs evals/frontier-selection/results
  deploy/rsi-campaign package.json pnpm-lock.yaml pnpm-workspace.yaml deps-version.json)

if [ "$MODE" = lab ]; then
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
  scp -q "$HERE/rsi-lab-monthly.sh" "$HERE/rsi-lab-skill.sh" "$HERE/systemd/evimed-rsi-campaign.service" "$HERE/systemd/evimed-rsi-campaign.timer" \
    "$ROOT/evals/rsi-campaigns/reports/statistics-v5-qualification.json" "$LAB:/srv/rsi-lab/release/"
  ssh "$LAB" REV="$REV" bash -s <<'REMOTE'
set -euo pipefail
cd /srv/rsi-lab/release && rm -rf "$REV" && mkdir "$REV" && tar -xzf "$REV.tgz" -C "$REV"
docker build -q --network host -t "evimed-rsi-lab:$REV" -f "$REV/deploy/rsi-campaign/Dockerfile" "$REV" >/dev/null
echo "evimed-rsi-lab:$REV" > /etc/rsi-lab/image
install -d -m 0755 /usr/local/lib/evimed-rsi
install -m 0755 rsi-lab-monthly.sh /usr/local/lib/evimed-rsi/rsi-lab-monthly.sh
install -m 0755 rsi-lab-skill.sh /usr/local/lib/evimed-rsi/rsi-lab-skill.sh
install -m 0644 evimed-rsi-campaign.service evimed-rsi-campaign.timer /etc/systemd/system/
# Owner inputs: the lab configuration, the public trust records, the signers' file paths. Deployment records are 0600 for uid 10001.
O=/etc/rsi-lab/owner-inputs
fp() { openssl pkey -pubin -in "$1" -outform DER | sha256sum | cut -d' ' -f1; }
EV=$(fp $O/evaluator.pub.pem) PUB=$(fp $O/publisher.pub.pem) INSTANCE=$(curl -s -m 3 http://100.100.100.200/latest/meta-data/instance-id)
cat > $O/config.json <<JSON
{"host":{"provider":"alibaba","purpose":"rsi-lab","instanceId":"$INSTANCE","region":"cn-beijing"},
 "transport":{"kind":"none"},
 "signer":{"keyId":"rsi-lab-publisher-2026-10","publicKeySha256":"$PUB"},
 "authority":{"role":"rsi-lab","accountId":"rsi-lab","dataDir":"/srv/rsi-lab","databaseRole":"rsi_lab"},
 "budget":{"campaignCny":1000,"monthCny":30000},
 "providers":{"deepseekFlash":{"provider":"deepseek","model":"deepseek-flash","credentialRef":"lab:deepseek"},"qwenMax":{"provider":"dashscope","model":"qwen3.8-max","credentialRef":"lab:dashscope"}}}
JSON
cat > $O/evaluator-profile.json <<JSON
{"publicKeyPath":"/run/rsi-lab/evaluator.pub.pem","publicKeySha256":"$EV","receiptPath":"/srv/rsi-lab/state/current/receipt.json"}
JSON
cat > $O/evaluator-profile-skill.json <<JSON
{"publicKeyPath":"/run/rsi-lab/evaluator.pub.pem","publicKeySha256":"$EV","receiptPath":"/srv/rsi-lab/state/skill-current/receipt.json"}
JSON
install -m 0644 statistics-v5-qualification.json $O/statistics-qualification.json
Q=$(docker run --rm --network none --user 10001:10001 -v $O:/run/rsi-lab:ro "evimed-rsi-lab:$REV" evals/rsi-campaigns/evaluator.mjs qualification /run/rsi-lab/statistics-qualification.json superiority)
PROCEDURE=$(echo "$Q" | python3 -c 'import json,sys;print(json.load(sys.stdin)["procedureDigest"])') QUALIFICATION=$(echo "$Q" | python3 -c 'import json,sys;print(json.load(sys.stdin)["qualificationDigest"])')
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
chown root:rsi-lab $O/config.json $O/evaluator-profile.json $O/evaluator-profile-skill.json $O/statistics-qualification.json && chmod 0640 $O/config.json $O/evaluator-profile.json $O/evaluator-profile-skill.json && chmod 0644 $O/statistics-qualification.json
chown 10001:10001 $O/finalizer-profile.json $O/finalize.json && chmod 0600 $O/finalizer-profile.json $O/finalize.json
systemctl daemon-reload && systemctl enable --now evimed-rsi-campaign.timer >/dev/null
# Keep the three newest images and source trees.
docker images --format '{{.Repository}}:{{.Tag}} {{.CreatedAt}}' | awk '$1 ~ /^evimed-rsi-lab:/' | sort -k2 -r | tail -n +4 | cut -d' ' -f1 | xargs -r docker rmi -f >/dev/null
ls -1dt /srv/rsi-lab/release/*/ 2>/dev/null | tail -n +4 | xargs -r rm -rf
ls -1t /srv/rsi-lab/release/*.tgz 2>/dev/null | tail -n +4 | xargs -r rm -f
echo "lab installed: $(cat /etc/rsi-lab/image); next run: $(systemctl list-timers evimed-rsi-campaign.timer --no-legend | awk '{print $1, $2, $3}')"
REMOTE
elif [ "$MODE" = production ]; then
  scp -q "$ROOT/scripts/ops/rsi-frontier-export.mjs" "$HERE/production/rsi-frontier-push.sh" "$HERE/production/evimed-rsi-frontier-push.service" \
    "$HERE/production/evimed-rsi-frontier-push.timer" "$PROD:/tmp/"
  ssh "$PROD" LAB_IP="$LAB_IP" bash -s <<'REMOTE'
set -euo pipefail
sudo install -d -m 0755 /usr/local/lib/evimed-rsi && sudo install -d -m 0700 /var/lib/evimed-rsi /etc/evimed-rsi
sudo install -m 0644 /tmp/rsi-frontier-export.mjs /usr/local/lib/evimed-rsi/rsi-frontier-export.mjs
sudo install -m 0755 /tmp/rsi-frontier-push.sh /usr/local/lib/evimed-rsi/rsi-frontier-push.sh
sudo install -m 0644 /tmp/evimed-rsi-frontier-push.service /tmp/evimed-rsi-frontier-push.timer /etc/systemd/system/
echo "$LAB_IP" | sudo tee /etc/evimed-rsi/lab-host >/dev/null
sudo test -s /etc/evimed-rsi/push_ed25519 || { echo "push key missing: run the lab setup first" >&2; exit 2; }
sudo systemctl daemon-reload && sudo systemctl enable --now evimed-rsi-frontier-push.timer >/dev/null
rm -f /tmp/rsi-frontier-export.mjs /tmp/rsi-frontier-push.sh /tmp/evimed-rsi-frontier-push.service /tmp/evimed-rsi-frontier-push.timer
echo "production installed; next push: $(systemctl list-timers evimed-rsi-frontier-push.timer --no-legend | awk '{print $1, $2, $3}')"
REMOTE
else echo "usage: rsi-lab-install.sh lab [--worktree] | production" >&2; exit 2; fi
