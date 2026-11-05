/**
 * What is in force on an RSI surface, and the operator's two acts on it. Run inside the serving web container, with the release's own code:
 *
 *   docker exec web-open-science-web-1 node scripts/ops/rsi-policy-stop.mjs --surface frontier-selection
 *   docker exec web-open-science-web-1 node scripts/ops/rsi-policy-stop.mjs --surface frontier-selection --apply --reason campaign_operator_stop
 *   docker exec web-open-science-web-1 node scripts/ops/rsi-policy-stop.mjs --surface frontier-selection --restore-promoted --reason campaign_operator_stop
 *
 * With no act it prints the campaign journal or the promoted policy in force, its revision and the revision before it, in one READ ONLY transaction, and changes nothing.
 *
 * `--apply` is about campaigns and never touches a promoted policy: it tries to finish the rollback of each journal left `stopped`, then stops the live campaign through the importer's own halt
 * and rollback. A journal whose rollback cannot run is named by its closed code in `notes` and blocks nothing: a stopped journal selects nothing and holds no surface, so it stays `stopped`, with
 * no state of its own, and the same rollback finishes by itself if a reverted release brings its consumer back.
 *
 * `--restore-promoted` is about the promoted policy: the revision it replaced, or the code default, in force again as a new revision of the document, with the reason and every earlier revision
 * kept. Only the surface the promotion names may do it, and not under a live campaign, whose target is that revision: stop the campaign first.
 *
 * `status` is `applied` only when something changed, and `actions` says what. Each act can be run again. It needs no deployment file: a broken one must not stand between an operator and a stop.
 * `--reason` is a closed code (`campaign_...` or `rsi_...`), for the journal.
 */
const APP = process.env.RSI_EXPORT_APP_ROOT ?? "/app";
const args = process.argv.slice(process.argv.indexOf("-") + 1 || 2);
const arg = (/** @type {string} */ name) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const refused = (/** @type {string} */ reason) => { console.error(JSON.stringify({ status: "refused", reason })); process.exit(2); };
const surface = arg("--surface"), apply = args.includes("--apply"), restore = args.includes("--restore-promoted"), reason = arg("--reason");
if (typeof surface !== "string" || (apply && restore) || ((apply || restore) && !/^(?:campaign|rsi)_[a-z0-9_]{1,80}$/.test(reason ?? "")) || (!apply && !restore && reason !== undefined)) refused("rsi_policy_arguments_invalid");

const load = (/** @type {string} */ path) => import(`file://${APP}/${path}`);
const { loadConfig } = await load("apps/server/src/config.mjs");
const { ControlPlaneDatabase } = await load("apps/server/src/controlPlaneDatabase.mjs");
const { RsiCampaignImporter } = await load("apps/server/src/rsiCampaignImporter.mjs");
const { createRsiServingAdapters, RSI_POLICY_COMPONENTS } = await load("apps/server/src/rsiServingAdapters.mjs");
if (!Object.hasOwn(RSI_POLICY_COMPONENTS, surface)) refused("rsi_policy_surface_unknown");

const config = loadConfig();
// The module policy's owner, as the serving layer and the export read it: the first configured operator.
const policyOwner = config.operatorUsers?.[0] ?? null;
if (!policyOwner) refused("rsi_policy_owner_unavailable");
const moduleId = RSI_POLICY_COMPONENTS[surface][0];
const database = new ControlPlaneDatabase({ ...config, databasePoolMax: 3 });
const serving = createRsiServingAdapters({ config: { ...config, rootDir: APP }, service: { owner: async () => policyOwner }, database });
const notAnImport = async () => { throw new Error("rsi_policy_stop_imports_nothing"); };
const importer = new RsiCampaignImporter({ database, owner: serving.publicationOwnerId, currentTarget: serving.currentTarget, adapters: serving.adapters, verificationOptions: notAnImport, activationPolicy: notAnImport });

const inForce = async () => {
  const client = await database.pool.connect();
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    const journals = (await client.query("SELECT payload FROM evimed_product.documents WHERE user_id=$1 AND kind='knowledge' AND payload->>'recordType'='rsi-campaign-import' AND payload->>'surface'=$2 AND deleted_at IS NULL ORDER BY updated_at DESC",
      [serving.publicationOwnerId, surface])).rows.map((row) => row.payload);
    const document = (await client.query("SELECT payload, revision FROM evimed_product.documents WHERE user_id=$1 AND kind='knowledge' AND id=$2 AND deleted_at IS NULL", [policyOwner, `evolution-module-policy-${moduleId}`])).rows[0] ?? null;
    const target = await serving.currentTarget(surface, client);
    await client.query("COMMIT");
    const active = journals.find((row) => !["stopped", "rolled-back", "rejected", "promoted"].includes(row.state)) ?? null;
    const held = document?.payload.status === "active", ours = held && Boolean(document.payload.operationId) && document.payload.surface === surface;
    return { active, stopped: journals.filter((row) => row.state === "stopped"), view: {
      surface, inForce: active ? "campaign" : !held ? "default" : ours ? "promoted-policy" : "module-policy", revision: active && active.mode !== "shadow" ? active.revision : target.baselineRevision, previousRevision: active ? active.previousRevision : ours ? document.payload.previousRevision ?? null : null,
      campaign: active ? { id: active.id, campaignId: active.campaignId, state: active.state, mode: active.mode, stageIndex: active.stageIndex, revision: active.revision, expiresAt: active.expiresAt, candidateExecutions: active.observations?.candidateExecutions ?? 0, errors: active.observations?.errors ?? 0, days: active.observations?.days ?? [] } : null,
      stopped: journals.filter((row) => row.state === "stopped").map((row) => ({ id: row.id, stopReason: row.stopReason ?? null })),
      policy: document ? { revision: document.revision, status: document.payload.status, surface: document.payload.surface ?? null, policy: document.payload.policy ?? null, campaignId: document.payload.campaignId ?? null, operationId: document.payload.operationId ?? null, candidateDigest: document.payload.candidateDigest ?? null, restoredFrom: document.payload.restoredFrom ?? null, stopReason: document.payload.stopReason ?? null } : null } };
  } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; } finally { client.release(); }
};

const closedCode = (/** @type {any} */ error) => (typeof error?.code === "string" ? error.code : "rsi_policy_stop_failed");
let exitCode = 0;
try {
  const before = await inForce();
  /** @type {string[]} */ const actions = [];
  /** @type {{journal:string,code:string}[]} */ const notes = [];
  if (apply) {
    for (const row of before.stopped) {
      try {
        const after = await importer.rollback(row.id);
        if (after.state === "rolled-back") actions.push("rollback-finished"); else notes.push({ journal: row.id, code: after.reason ?? "campaign_rollback_incompatible" });
      } catch (error) { notes.push({ journal: row.id, code: closedCode(error) }); }
    }
    if (before.active) {
      let after = null;
      // The stop commits before its rollback runs, so a rollback that cannot run leaves it stopped: that is a stop, and its code is said.
      try { after = await importer.halt(before.active.operationId, reason); } catch (error) { notes.push({ journal: before.active.id, code: closedCode(error) }); }
      if (after?.state === "stopped") notes.push({ journal: before.active.id, code: after.reason ?? "campaign_rollback_incompatible" });
      if ((await inForce()).active?.id !== before.active.id) actions.push("campaign-stopped");
    }
  }
  if (restore) {
    if (before.active) { const error = new Error("rsi_policy_campaign_active"); Object.assign(error, { code: "rsi_policy_campaign_active" }); throw error; }
    const done = await serving.adapters.policy.restorePromoted({ surface, reason, at: new Date().toISOString() });
    if (done.restored) actions.push("policy-restored");
  }
  console.log(JSON.stringify({ status: !apply && !restore ? "read" : actions.length ? "applied" : "unchanged", actions, notes, ...(apply || restore ? (await inForce()).view : before.view) }));
} catch (error) {
  console.error(JSON.stringify({ status: "failed", reason: closedCode(error) }));
  exitCode = 1;
} finally { await database.close(); }
process.exitCode = exitCode;
