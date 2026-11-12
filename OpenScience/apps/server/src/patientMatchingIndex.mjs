/** Matching's own immutable vector generations; never the account-memory embedding index. */
import { profileIdentity } from '@evimed/patient-matching-core';

/** @param {string} status @param {string} summary @param {any} data */
const reply = (status, summary, data) => ({ status, summary, data, artifacts: [] });
/** @param {string} code */
const failure = code => Object.assign(new Error('The matching trial index is unavailable.'), { code });
/** @param {any} vector @param {number} dimensions */
function vectorText(vector, dimensions) {
  if (!Array.isArray(vector) || vector.length !== dimensions || vector.some(value => typeof value !== 'number' || !Number.isFinite(value)) || !vector.some(value => value !== 0)) throw failure('patient_matching_index_vector_invalid');
  return `[${vector.join(',')}]`;
}

/** Records come from a source-authorized registry adapter, not model-supplied document text.
 * @param {{database:any,models:any,authorize:(envelope:any,action:any)=>Promise<any>,loadRecords:(envelope:any,authority:any)=>Promise<any[]>}} dependencies
 */
export function createPatientMatchingIndexPorts({ database, models, authorize, loadRecords }) {
  if (typeof authorize !== 'function' || typeof loadRecords !== 'function') throw new TypeError('Index authorization and registry source adapters are required.');
  const dimensions = Number(models.dimensions);
  if (dimensions !== 1024) throw failure('patient_matching_index_dimensions_unsupported');
  const embeddingBatchSize=models.embeddingBatchSize??10;
  if(!Number.isSafeInteger(embeddingBatchSize)||embeddingBatchSize<1||embeddingBatchSize>20)throw failure('patient_matching_index_batch_invalid');
  let initialized = null;
  async function schema() {
    initialized ??= (async () => {
      const extension = await database.query("SELECT 1 FROM pg_extension WHERE extname='vector'");
      if (!extension.rows.length) throw failure('patient_matching_index_extension_missing');
      await database.query(`CREATE SCHEMA IF NOT EXISTS evimed_matching;
        CREATE TABLE IF NOT EXISTS evimed_matching.trial_index_generations(
          generation text PRIMARY KEY, scope_key text NOT NULL, collection_id text NOT NULL,
          source_digest text NOT NULL, embedding_profile text NOT NULL, dimensions integer NOT NULL,
          expected_records integer NOT NULL, indexed_records integer NOT NULL DEFAULT 0, state text NOT NULL CHECK(state IN ('building','ready')),
          created_at timestamptz NOT NULL DEFAULT clock_timestamp());
        CREATE TABLE IF NOT EXISTS evimed_matching.trial_index_rows(
          generation text NOT NULL REFERENCES evimed_matching.trial_index_generations(generation) ON DELETE CASCADE,
          registry_id text NOT NULL, source_digest text NOT NULL, embedding vector(1024) NOT NULL,
          PRIMARY KEY(generation,registry_id));
        ALTER TABLE evimed_matching.trial_index_generations ADD COLUMN IF NOT EXISTS indexed_records integer NOT NULL DEFAULT -1;`);
    })().catch(error => { initialized = null; throw error; });
    return initialized;
  }
  // A legacy generation counts once. Current builds update this counter under the same generation lock as inserts.
  async function indexedCount(client,row,generation){
    const held=Number(row.indexed_records);if(held>=0)return held;
    const counted=await client.query('SELECT count(*)::integer AS total FROM evimed_matching.trial_index_rows WHERE generation=$1',[generation]);
    const total=Number(counted.rows[0].total);await client.query('UPDATE evimed_matching.trial_index_generations SET indexed_records=$2 WHERE generation=$1',[generation,total]);return total;
  }
  /** @param {any} envelope @param {string} operation */
  async function permission(envelope, operation) {
    const authority = await authorize(envelope, { operation });
    if (!authority || typeof authority.collectionId !== 'string' || !authority.collectionId || typeof authority.sourceDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(authority.sourceDigest)
      || !Number.isSafeInteger(authority.expectedRecords) || authority.expectedRecords < 1) throw failure('patient_matching_index_access_denied');
    // Private/default collections are scoped. Only the host may designate a public registry resource.
    const scopeKey = authority.publicRegistry === true ? 'public-registry' : profileIdentity({ tenantId: envelope.scope.tenantId, projectId: envelope.scope.projectId });
    const generation = profileIdentity({ scopeKey, collection: authority.collectionId, source: authority.sourceDigest, expectedRecords: authority.expectedRecords, embedding: models.embeddingProfileDigest, dimensions });
    return { ...authority, scopeKey, generation };
  }
  return {
    async build(/** @type {any} */ envelope) {
      try {
        const authority = await permission(envelope, 'build');
        if (authority.buildAllowed !== true) throw failure('patient_matching_index_access_denied');
        await schema();
        const records = await loadRecords(envelope, authority);
        if (!Array.isArray(records) || !records.length || records.length > 1000 || new Set(records.map(record => record.registryId)).size !== records.length
          || records.some(record => typeof record.registryId !== 'string' || !record.registryId || typeof record.text !== 'string' || !record.text.trim()
            || typeof record.sourceDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(record.sourceDigest))) throw failure('patient_matching_index_records_invalid');
        await database.query(`INSERT INTO evimed_matching.trial_index_generations(generation,scope_key,collection_id,source_digest,embedding_profile,dimensions,expected_records,state)
          VALUES($1,$2,$3,$4,$5,$6,$7,'building') ON CONFLICT DO NOTHING`, [authority.generation, authority.scopeKey, authority.collectionId, authority.sourceDigest, models.embeddingProfileDigest, dimensions, authority.expectedRecords]);
        const existing = await database.query('SELECT registry_id,source_digest FROM evimed_matching.trial_index_rows WHERE generation=$1 AND registry_id=ANY($2::text[])', [authority.generation, records.map(record => record.registryId)]);
        const held = new Map(existing.rows.map(row => [row.registry_id, row.source_digest]));
        for (const record of records) if (held.has(record.registryId) && held.get(record.registryId) !== record.sourceDigest) throw failure('patient_matching_index_source_changed');
        const missing = records.filter(record => !held.has(record.registryId));
        const current = await database.query('SELECT state FROM evimed_matching.trial_index_generations WHERE generation=$1', [authority.generation]);
        if (current.rows[0]?.state === 'ready' && missing.length) throw failure('patient_matching_index_generation_immutable');
        for (let at = 0; at < missing.length; at += embeddingBatchSize) {
          const batch = missing.slice(at, at + embeddingBatchSize);
          const embedded = await models.embed({ ...envelope, input: { ...envelope.input, texts: batch.map(record => record.text), textType: 'document', dimensions } });
          if (embedded.status !== 'complete' || embedded.data.embeddingProfileDigest !== models.embeddingProfileDigest) throw failure('patient_matching_index_embedding_unavailable');
          if (embedded.data.vectors.length !== batch.length) throw failure('patient_matching_index_vector_invalid');
          await database.transaction(async client => {
            // Concurrent resumptions may finish while the provider call is in flight. The generation row is the
            // mutation fence; a ready generation never gains or changes members, even on a late response.
            const locked = await client.query('SELECT state,expected_records,indexed_records FROM evimed_matching.trial_index_generations WHERE generation=$1 FOR UPDATE', [authority.generation]);
            const present = await client.query('SELECT registry_id,source_digest FROM evimed_matching.trial_index_rows WHERE generation=$1 AND registry_id=ANY($2::text[])', [authority.generation,batch.map(record=>record.registryId)]);
            const countBefore=await indexedCount(client,locked.rows[0],authority.generation);
            const identities = new Map(present.rows.map(row => [row.registry_id,row.source_digest]));
            for (const record of batch) if (identities.has(record.registryId) && identities.get(record.registryId) !== record.sourceDigest) throw failure('patient_matching_index_source_changed');
            const additions = batch.filter(record => !identities.has(record.registryId));
            if (locked.rows[0]?.state === 'ready' && additions.length) throw failure('patient_matching_index_generation_immutable');
            if (countBefore + additions.length > Number(locked.rows[0]?.expected_records)) throw failure('patient_matching_index_manifest_mismatch');
            for (const [index, record] of batch.entries()) await client.query(`INSERT INTO evimed_matching.trial_index_rows(generation,registry_id,source_digest,embedding)
              VALUES($1,$2,$3,$4::vector) ON CONFLICT DO NOTHING`, [authority.generation, record.registryId, record.sourceDigest, vectorText(embedded.data.vectors[index], dimensions)]);
            await client.query('UPDATE evimed_matching.trial_index_generations SET indexed_records=indexed_records+$2 WHERE generation=$1',[authority.generation,additions.length]);
          });
        }
        const { count, state } = await database.transaction(async client => {
          const locked=await client.query('SELECT indexed_records FROM evimed_matching.trial_index_generations WHERE generation=$1 FOR UPDATE', [authority.generation]);
          const total=await indexedCount(client,locked.rows[0],authority.generation);
          if (total > authority.expectedRecords) throw failure('patient_matching_index_manifest_mismatch');
          const nextState = total === authority.expectedRecords ? 'ready' : 'building';
          await client.query('UPDATE evimed_matching.trial_index_generations SET state=$2 WHERE generation=$1', [authority.generation, nextState]);
          return { count: total, state: nextState };
        });
        return reply(state === 'ready' ? 'complete' : 'partial', 'Matching index generation progress saved.', { generation: authority.generation, state, indexed: count, expected: authority.expectedRecords, embeddingProfileDigest: models.embeddingProfileDigest, dimensions, embeddingBatchSize, reused: missing.length === 0 });
      } catch (error) { return reply('unsupported', 'Matching vector index is unavailable; registry retrieval remains available.', { code: error?.code?.startsWith('patient_matching_') ? error.code : 'patient_matching_index_build_failed' }); }
    },
    async query(/** @type {any} */ envelope) {
      try {
        const authority = await permission(envelope, 'query');
        await schema();
        const found = await database.query('SELECT state FROM evimed_matching.trial_index_generations WHERE generation=$1 AND scope_key=$2 AND embedding_profile=$3', [authority.generation, authority.scopeKey, models.embeddingProfileDigest]);
        if (found.rows[0]?.state !== 'ready') throw failure('patient_matching_index_not_ready');
        const query = envelope.input.query;
        const limit = envelope.input.limit ?? 100;
        if (typeof query !== 'string' || !query.trim() || query.length > 8000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw failure('patient_matching_index_query_invalid');
        const embedded = await models.embed({ ...envelope, input: { ...envelope.input, texts: [query], textType: 'query', dimensions } });
        if (embedded.status !== 'complete' || embedded.data.embeddingProfileDigest !== models.embeddingProfileDigest) throw failure('patient_matching_index_embedding_unavailable');
        const vector = vectorText(embedded.data.vectors[0], dimensions);
        const result = await database.query(`SELECT registry_id,source_digest,embedding <=> $2::vector AS distance
          FROM evimed_matching.trial_index_rows WHERE generation=$1 ORDER BY embedding <=> $2::vector,registry_id LIMIT $3`, [authority.generation, vector, limit]);
        return reply('complete', 'Matching semantic candidates retrieved.', { generation: authority.generation, embeddingProfileDigest: models.embeddingProfileDigest, dimensions,
          candidates: result.rows.map((row, index) => ({ registryId: row.registry_id, sourceDigest: row.source_digest, distance: Number(row.distance), rank: index + 1 })), searchMode: 'exact-pgvector' });
      } catch (error) { return reply('unsupported', 'Matching semantic retrieval is unavailable; keep the declared registry coverage.', { code: error?.code?.startsWith('patient_matching_') ? error.code : 'patient_matching_index_query_failed' }); }
    },
  };
}
