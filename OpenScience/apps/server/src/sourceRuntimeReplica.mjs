import { createHash } from "node:crypto";
import path from "node:path";
import { lstat } from "node:fs/promises";
import { assertProjectCapacity, openScopedFileNoFollow, readStableFileHandle, resolveScopedPath,
  withProjectStorageMutation, writeFileAtomicNoFollow } from "./security.mjs";

/** The existing lifecycle outbox owns this derived replica. It never rewrites authoritative bytes. */
export async function mirrorSourceRuntimeReplica({ documents, sources, store, runtimeManager, config }, job) {
  const event = job.payload;
  const database = documents.database;
  // Legacy imports predate immutable paths. Freeze their verified original before taking
  // the copy fence, using the same advisory -> jobs -> source ordering as registration.
  const legacy = await documents.get(job.userId, "source", event.sourceId);
  if (legacy && (event.generation == null || Number(event.generation) === Number(legacy.payload.generation))) {
    const expected = legacy.payload.fingerprint?.sha256;
    const rel = legacy.payload.paths?.[0];
    if (rel && !rel.includes(`/.evimed-revisions/${expected}/`) && runtimeManager.providerName() !== "docker") {
      const owner = await store.userById(job.userId);
      const project = await store.requireProject(owner, legacy.projectId);
      const opened = await openScopedFileNoFollow(project.baseDir, resolveScopedPath(project.baseDir, rel));
      let bytes;
      try { bytes = await readStableFileHandle(opened.handle, opened.stat); } finally { await opened.handle.close(); }
      if (createHash("sha256").update(bytes).digest("hex") === expected) {
        const frozen = `${path.posix.dirname(rel)}/.evimed-revisions/${expected}/${path.posix.basename(rel)}`;
        await withProjectStorageMutation(project, async () => {
          const target = resolveScopedPath(project.baseDir, frozen);
          await assertProjectCapacity(project, target, bytes.length, config);
          await writeFileAtomicNoFollow(project.baseDir, target, bytes, { mode: 0o600 });
        });
        await sources.freezePublicationPathCurrent(job.userId, legacy, rel, frozen);
      }
    }
  }
  await sources.lockSourceMutation(job.userId, event.sourceId);
  const found = await database.query("SELECT payload,project_id,revision,deleted_at FROM evimed_product.documents WHERE user_id=$1 AND kind='source' AND id=$2 FOR UPDATE",
    [job.userId, event.sourceId]);
  const row = found.rows[0];
  if (!row || row.deleted_at) return { state: "obsolete", code: "source_unavailable" };
  const generation = Number(row.payload.generation);
  if (event.generation != null && Number(event.generation) !== generation) return { state: "obsolete", code: "source_generation_superseded" };
  const sha256 = row.payload.fingerprint?.sha256;
  const original = row.payload.paths?.find(rel => rel.includes(`/.evimed-revisions/${sha256}/`)) ?? row.payload.paths?.[0];
  const user = await store.userById(job.userId);
  if (!user) return { state: "obsolete", code: "source_account_unavailable" };
  const project = await store.requireProject(user, row.project_id);
  const previous = row.payload.runtimeReplica;
  const identity = runtimeManager.runtimeReplicaIdentity(project);
  if (previous && ["acknowledged", "not-needed"].includes(previous.state) && previous.generation === generation
    && previous.sha256 === sha256 && previous.provider === runtimeManager.providerName() && previous.runtimeIdentity === identity) return previous;
  let receipt;
  try {
    const full = resolveScopedPath(project.baseDir, original);
    const opened = await openScopedFileNoFollow(project.baseDir, full);
    let bytes;
    try { bytes = await readStableFileHandle(opened.handle, opened.stat); } finally { await opened.handle.close(); }
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (runtimeManager.providerName() !== "docker" && !original.includes(`/.evimed-revisions/${sha256}/`)) {
      receipt = { state: "retryable-failure", code: "source_replica_requires_immutable_path", sha256 };
    } else if (actual !== sha256) receipt = { state: "retryable-failure", code: "source_replica_digest_mismatch", sha256 };
    else {
      // Recover an interrupted first publication's convenience alias. Existing aliases remain
      // untouched because historical citations may still name them.
      const logical = row.payload.logicalPath;
      if (logical && logical !== original) await withProjectStorageMutation(project, async () => {
        const alias = resolveScopedPath(project.baseDir, logical);
        try { await lstat(alias); return; } catch (error) { if (error?.code !== "ENOENT") throw error; }
        await assertProjectCapacity(project, alias, bytes.length, config);
        await writeFileAtomicNoFollow(project.baseDir, alias, bytes, { mode: 0o600 });
      });
      receipt = await runtimeManager.mirrorWorkspaceUploadReceipt(project, full, bytes);
    }
  } catch (error) { receipt = { state: "retryable-failure", code: String(error?.code ?? "source_replica_read_failed"), sha256 }; }
  const replica = { ...receipt, generation, sha256, checkedAt: new Date().toISOString() };
  // The source row is locked throughout the bounded copy. This overlay changes no revision,
  // so the existing lifecycle trigger deliberately emits no event about its own receipt.
  await database.query(`UPDATE evimed_product.documents SET payload=jsonb_set(payload,'{runtimeReplica}',$3::jsonb,true)
    WHERE user_id=$1 AND kind='source' AND id=$2 AND revision=$4 AND payload->>'generation'=$5 AND deleted_at IS NULL`,
  [job.userId, event.sourceId, JSON.stringify(replica), row.revision, String(generation)]);
  return replica;
}
