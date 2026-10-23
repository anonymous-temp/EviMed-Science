import { createHash } from 'node:crypto';
import { canonicalJson, geoEnrichStatementIdentity, geoClaimAssessmentIdentity, geoClaimForStatement } from '@evimed/domain';
import { errorFingerprint } from './geoErrorIdentity.mjs';

const hash = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
const PROOF_LIMIT = 100;
const legacyFingerprint = statement => errorFingerprint({ claimKey: statement.claimKey, text: statement.text });
const identity = (statement, claims) => geoEnrichStatementIdentity(statement, claims);
const aliasTarget = row => [...(row?.judgment_history ?? [])].reverse().find(receipt => receipt.kind === 'legacy_identity_duplicate')?.survivorId ?? null;

/** Resolve immutable duplicate aliases within the owner/project boundary. Mutations serialize with promotion.
 * @param {any} client @param {string} geoProjectId @param {string[]} ids @param {{ lock?: boolean }} [options] */
export async function resolveGeoErrorIds(client, geoProjectId, ids, { lock = false } = {}) {
  if (lock) await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`geo-error-alias:${geoProjectId}`]);
  if (ids.length > 100) throw new RangeError("Too many error aliases to resolve.");
  const resolved = [], lockIds = new Set();
  for (const id of [...new Set(ids)].slice(0, 100)) {
    let next = id; const visited = new Set();
    for (let depth = 0; depth < 4 && !visited.has(next); depth += 1) {
      visited.add(next);
      const row = (await client.query(`SELECT e.* FROM evimed_geo.errors e JOIN evimed_geo.projects p ON p.id=e.geo_project_id AND p.user_id=e.user_id
        WHERE e.geo_project_id=$1 AND e.id=$2`, [geoProjectId, next])).rows[0];
      if (!row) break;
      lockIds.add(row.id);
      const target = aliasTarget(row);
      if (!target) { resolved.push(row.id); break; }
      next = target;
    }
  }
  if (lock && lockIds.size) await client.query("SELECT id FROM evimed_geo.errors WHERE geo_project_id=$1 AND id=ANY($2::text[]) ORDER BY id FOR UPDATE", [geoProjectId, [...lockIds].sort()]);
  return [...new Set(resolved)];
}

/** Lazy migration is record-only: family lock → all proof facts → alias lock → error locks.
 * Raw current facts remain the write guard; frozen enrichment is only an identity projection.
 * @param {any} client @param {any} snapshot @param {any} statement @param {{ reconcile?: boolean }} [options] */
export async function prepareGeoLegacyError(client, snapshot, statement, { reconcile = false } = {}) {
  const snapshotId = snapshot.snapshotId ?? snapshot.id;
  const source = (await client.query(`SELECT s.*,r.ref->'evaluationBasis'->'claims' AS claims FROM evimed_geo.snapshots s
    LEFT JOIN evimed_geo.rounds r ON r.id=s.round_id WHERE s.id=$1 AND s.user_id=$2 AND s.geo_project_id=$3`, [snapshotId, snapshot.userId, snapshot.geoProjectId])).rows[0];
  if (!source) return { fingerprint: errorFingerprint(statement) };
  const frozenClaim = geoClaimForStatement(source.claims ?? [], statement);
  const keyed = { ...statement, claimKey: statement.claimKey ?? frozenClaim?.key ?? null };
  const enriched = identity(keyed, source.claims ?? []), oldKey = legacyFingerprint(keyed), newKey = errorFingerprint(enriched ?? keyed);
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`geo-error-family:${source.user_id}:${source.geo_project_id}:${source.engine}:${oldKey}`]);
  const candidates = (await client.query(`SELECT * FROM evimed_geo.errors WHERE user_id=$1 AND geo_project_id=$2 AND engine=$3 AND fingerprint=ANY($4::text[])`,
    [source.user_id, source.geo_project_id, source.engine, [oldKey, newKey]])).rows;
  const old = candidates.find(row => row.fingerprint === oldKey);
  const upgraded = candidates.find(row => row.fingerprint === newKey && row.judgment_history.some(receipt => receipt.kind === 'legacy_identity_promoted'));
  if (!old && !upgraded) return { fingerprint: newKey };
  // Current and immutable historical witnesses are bounded together; a truncated proof is never accepted.
  const witnesses = (await client.query(`SELECT witness.*,r.ref->'evaluationBasis'->'claims' AS claims FROM (
    SELECT s.id,f.statements,0 AS revision FROM evimed_geo.snapshots s JOIN evimed_geo.facts f ON f.snapshot_id=s.id
      WHERE s.user_id=$1 AND s.geo_project_id=$2 AND s.engine=$3
    UNION ALL SELECT s.id,v.payload->'assessment'->'statements' AS statements,v.revision FROM evimed_product.revisions v
      JOIN evimed_geo.snapshots s ON s.id=v.payload->>'snapshotId' AND s.user_id=v.user_id
      WHERE s.user_id=$1 AND s.geo_project_id=$2 AND s.engine=$3 AND v.kind='knowledge' AND v.payload->>'recordType'='geo-assessment'
    ) witness JOIN evimed_geo.snapshots s ON s.id=witness.id LEFT JOIN evimed_geo.rounds r ON r.id=s.round_id
    WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(witness.statements,'[]'::jsonb)) x
      WHERE x->>'verdict'='wrong' AND CASE WHEN $4::text IS NULL THEN x->>'claimId'=$5 ELSE (x->>'claimKey'=$4 OR (x->>'claimKey' IS NULL AND x->>'claimId'=$5)) END)
    ORDER BY witness.id,witness.revision LIMIT $6`, [source.user_id, source.geo_project_id, source.engine, keyed.claimKey ?? null, statement.claimId ?? null, PROOF_LIMIT + 1])).rows;
  const proofIds = [...new Set([snapshotId, ...witnesses.map(row => row.id)])].sort();
  const facts = (await client.query(`SELECT f.snapshot_id,f.statements,r.ref->'evaluationBasis'->'claims' AS claims FROM evimed_geo.facts f
    JOIN evimed_geo.snapshots s ON s.id=f.snapshot_id LEFT JOIN evimed_geo.rounds r ON r.id=s.round_id
    WHERE f.user_id=$1 AND f.geo_project_id=$2 AND f.snapshot_id=ANY($3::text[]) ORDER BY f.snapshot_id FOR SHARE OF f`, [source.user_id, source.geo_project_id, proofIds])).rows;
  const target = facts.find(row => row.snapshot_id === snapshotId);
  if (!target) return { fingerprint: newKey };
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`geo-error-alias:${source.geo_project_id}`]);
  const locked = (await client.query(`SELECT * FROM evimed_geo.errors WHERE user_id=$1 AND geo_project_id=$2 AND engine=$3 AND fingerprint=ANY($4::text[]) ORDER BY id FOR UPDATE`,
    [source.user_id, source.geo_project_id, source.engine, [oldKey, newKey]])).rows;
  const legacyRow = locked.find(row => row.fingerprint === oldKey), canonicalRow = locked.find(row => row.fingerprint === newKey);
  const survivor = legacyRow ?? canonicalRow;
  if (!survivor) return { fingerprint: newKey };
  const expected = enriched ? geoClaimAssessmentIdentity(enriched) : null;
  const relevant = witnesses.flatMap(row => (row.statements ?? []).filter(item => item.verdict === 'wrong' && (keyed.claimKey ? item.claimKey === keyed.claimKey || item.claimKey == null && item.claimId === statement.claimId : item.claimId === statement.claimId)).map(item => ({ item, claims: row.claims ?? [] })));
  const valid = Boolean(expected && relevant.length && witnesses.length <= PROOF_LIMIT && witnesses.some(row => row.id === survivor.first_snapshot_id) && witnesses.some(row => row.id === survivor.last_snapshot_id)
    && relevant.every(({ item, claims }) => { const normalized = identity(item, claims), frozen = geoClaimForStatement(claims, item); return normalized && frozen && geoClaimAssessmentIdentity(frozen) === expected && geoClaimAssessmentIdentity(normalized) === expected; }));
  const append = async (row, receipt) => {
    const receiptKey = hash(receipt);
    if (row.judgment_history.some(entry => entry.receiptKey === receiptKey)) return;
    await client.query('UPDATE evimed_geo.errors SET judgment_history=judgment_history || jsonb_build_array($2::jsonb) WHERE id=$1', [row.id, JSON.stringify({ ...receipt, receiptKey })]);
  };
  if (!valid) {
    await append(survivor, { kind: 'legacy_identity_unresolved', legacyFingerprint: oldKey, reason: witnesses.length > PROOF_LIMIT ? 'proof_limit' : 'missing_or_mixed_frozen_identity' });
    return { fingerprint: newKey };
  }
  if (legacyRow && canonicalRow && legacyRow.id !== canonicalRow.id) {
    const mechanical = legacyRow.first_snapshot_id === canonicalRow.first_snapshot_id && legacyRow.last_snapshot_id === canonicalRow.last_snapshot_id
      && canonicalRow.materials.length === 0 && canonicalRow.status === 'open' && canonicalRow.closed_snapshot_id == null
      && canonicalRow.judgment_history.length === 0 && new Date(canonicalRow.updated_at).getTime() === new Date(canonicalRow.created_at).getTime();
    if (!mechanical) {
      await append(legacyRow, { kind: 'legacy_identity_unresolved', legacyFingerprint: oldKey, canonicalFingerprint: newKey, reason: 'independently_handled_duplicate', duplicateId: canonicalRow.id });
      return { fingerprint: oldKey, collision: true };
    }
    const receipt = { kind: 'legacy_identity_duplicate', survivorId: legacyRow.id, fingerprint: canonicalRow.fingerprint, previous: canonicalRow };
    await client.query(`UPDATE evimed_geo.errors SET fingerprint=$2,judgment_state='withdrawn',judgment_correction=$3::jsonb,
      judgment_history=judgment_history || jsonb_build_array($3::jsonb) WHERE id=$1`, [canonicalRow.id, `retired-duplicate:${canonicalRow.id}`, JSON.stringify(receipt)]);
    await client.query('UPDATE evimed_geo.errors SET notified_at=coalesce(notified_at,$2) WHERE id=$1', [legacyRow.id, canonicalRow.notified_at]);
  }
  if (legacyRow && oldKey !== newKey) {
    await client.query('UPDATE evimed_geo.errors SET fingerprint=$2 WHERE id=$1', [legacyRow.id, newKey]);
    await append(legacyRow, { kind: 'legacy_identity_promoted', legacyFingerprint: oldKey, canonicalFingerprint: newKey, identity: expected, proofSnapshotIds: proofIds });
  }
  if (reconcile) {
    const currentReadings = facts.flatMap(row => row.statements.map(item => identity(item, row.claims ?? []) ?? item));
    const residual = currentReadings.some(item => item.verdict === 'wrong' && geoClaimAssessmentIdentity(item) === expected);
    const replacements = target.statements.map(item => identity(item, target.claims ?? []) ?? item).filter(item => geoClaimAssessmentIdentity(item) === expected);
    if (!residual && replacements.length && replacements.every(item => ['correct', 'unverifiable'].includes(item.verdict)) && survivor.judgment_state !== 'withdrawn') {
      const receipt = { kind: replacements.every(item => item.verdict === 'correct') ? 'assessment_correction' : 'assessment_superseded_unknown', snapshotId, identity: expected };
      await client.query(`UPDATE evimed_geo.errors SET judgment_state='withdrawn',judgment_correction=$2::jsonb,judgment_history=judgment_history || jsonb_build_array($2::jsonb) WHERE id=$1`, [survivor.id, JSON.stringify(receipt)]);
    }
  }
  return { fingerprint: newKey };
}
