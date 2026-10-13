import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { assertNoSymlinkPath } from "./security.mjs";

/**
 * Whether the OpenViking engine's volume has a recent, verified, encrypted copy: what the host's backup timer recorded
 * after its last capture (`scripts/ops/openviking-backup.mjs`), read through the status-only mount the backup overlay
 * gives this container. Reported under `checks.backup.openviking` in `/api/ready` and as
 * `open_science_openviking_backup_*` in the operator metrics.
 *
 * Hidden knowledge:
 *
 *  - **A notice, never a failure.** The volume became a store of record on 2026-10-13, and this check is new: it ships
 *    as a notice and needs an observed distribution before it may block (development principle 4). A red `backup`
 *    check is a red `/api/ready`, which is the web container's own health check — an outage over a copy that is a day
 *    old. So every finding is a `code` beside `healthy: false`, and the operator alert reads the metric.
 *  - **The receipt is the host's.** Nothing here runs a backup, asks Docker or reads the archive: the capture holds
 *    Docker authority the web container must never have, and the receipt carries no secret and no path that would
 *    tell this process where the archives are.
 *  - **The copy is checked where it was made.** `lastDrillAt` is the moment the encrypted archive that was kept was
 *    decrypted again and every file was checked against the manifest taken while the engine was frozen; a capture
 *    that was never checked is not reported healthy.
 *
 * @param {Record<string, any>} config `openVikingBackupStateFile`, `openVikingBackupMaxAgeSeconds`
 * @param {number} [now]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function openVikingBackupReadiness(config, now = Date.now()) {
  const file = String(config.openVikingBackupStateFile ?? "").trim();
  if (!file) return { required: false, healthy: false, configured: false, code: "openviking_backup_state_unconfigured" };
  const notice = (/** @type {string} */ code, /** @type {Record<string, unknown>} */ details = {}) => ({ required: false, healthy: false, configured: true, code, ...details });
  if (!path.isAbsolute(file)) return notice("openviking_backup_state_invalid");
  let state;
  try {
    const root = path.parse(file).root;
    await assertNoSymlinkPath(path.join(root, file.slice(root.length).split(path.sep)[0]), file, { missingCode: "openviking_backup_state_missing" });
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      // The host writes it 0644 as root; anything another uid could have written is not its receipt.
      if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > 64 * 1024 || stat.mode & 0o022) return notice("openviking_backup_state_invalid");
      state = JSON.parse(await handle.readFile("utf8"));
    } finally {
      await handle.close();
    }
  } catch (error) {
    const code = /** @type {any} */ (error)?.code;
    return notice(code === "openviking_backup_state_missing" || code === "ENOENT" ? "openviking_backup_state_missing" : "openviking_backup_state_invalid");
  }
  if (!state || typeof state !== "object" || Array.isArray(state) || state.schemaVersion !== 1) return notice("openviking_backup_state_invalid");
  const maxAgeSeconds = Number.isSafeInteger(Number(config.openVikingBackupMaxAgeSeconds)) ? Number(config.openVikingBackupMaxAgeSeconds) : 90_000;
  const instant = (/** @type {unknown} */ value) => {
    const parsed = Date.parse(String(value ?? ""));
    return Number.isFinite(parsed) && parsed <= now + 5 * 60_000 ? parsed : null;
  };
  const lastSuccess = instant(state.lastSuccessAt);
  const lastDrill = instant(state.lastDrillAt);
  const known = {
    lastAttemptAt: typeof state.lastAttemptAt === "string" ? state.lastAttemptAt : null,
    lastSuccessAt: lastSuccess == null ? null : new Date(lastSuccess).toISOString(),
    ageSeconds: lastSuccess == null ? null : Math.max(0, Math.round((now - lastSuccess) / 1000)),
    maxAgeSeconds,
  };
  if (state.status !== "healthy") {
    return notice("openviking_backup_unhealthy", { ...known, lastCode: typeof state.code === "string" ? state.code.slice(0, 80) : null });
  }
  if (lastSuccess == null || lastDrill == null || lastDrill < lastSuccess - 5 * 60_000 || state.encrypted !== true
    || !["paused", "found-paused", "stopped"].includes(state.consistency)) {
    return notice("openviking_backup_state_invalid", known);
  }
  if (now - lastSuccess > maxAgeSeconds * 1000) return notice("openviking_backup_stale", known);
  const count = (/** @type {unknown} */ value) => (Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null);
  return {
    required: false, healthy: true, configured: true, ...known,
    lastDrillAt: new Date(lastDrill).toISOString(), encrypted: true, consistency: state.consistency,
    files: count(state.files), contentBytes: count(state.contentBytes), pausedMs: count(state.pausedMs), offBox: state.offBox === true,
  };
}
