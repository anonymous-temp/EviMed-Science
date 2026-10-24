/** Durable, aggregate-only observations for the existing knowledge and memory queues.
 * No account/source labels, source text, schema writes or independent queue are introduced. */
const WORKLOADS = Object.freeze([
  { workload: "source_sync", table: "evimed_product.jobs", state: "status", condition: "kind='ov-resource-sync'", attempts: "attempts", success: "succeeded", ended: "finished_at" },
  { workload: "wiki_compile", table: "evimed_product.jobs", state: "status", condition: "kind='wiki-compile'", attempts: "attempts", success: "succeeded", ended: "finished_at" },
  { workload: "capsule_index", table: "evimed_product.jobs", state: "status", condition: "kind='memory-index'", attempts: "attempts", success: "succeeded", ended: "finished_at" },
  { workload: "native_extraction", table: "evimed_memory.native_commits", state: "state", condition: "true", attempts: "attempts", success: "completed", ended: "ingested_at" },
  { workload: "native_admission", table: "evimed_memory.native_admissions", state: "state", condition: "true", attempts: "0", success: "completed", ended: "updated_at" },
]);
const PENDING = new Set(["queued", "running", "pending", "failed", "submitting", "uncertain", "suspended"]);
/** @param {any} database @returns {Promise<Array<{name:string,help:string,type:"gauge",series:any[]}>>} */
export async function knowledgeQueueMetricFamilies(database) {
  const observed = { name: "open_science_knowledge_queue_observed", help: "Whether the durable queue ledger could be observed; missing optional tables are reported per workload.", type: /** @type {const} */ ("gauge"), series: /** @type {any[]} */ ([]) };
  if (!database) { observed.series.push({ value: 0 }); return [observed]; }
  const items = [], ages = [], retries = [], completed = [];
  try {
    for (const spec of WORKLOADS) {
      const labels = { workload: spec.workload };
      const exists = (await database.query("SELECT to_regclass($1) AS table_name", [spec.table])).rows[0]?.table_name;
      observed.series.push({ value: exists ? 1 : 0, labels });
      if (!exists) continue;
      // Every interpolated token is from the closed module-owned table above, never from a request.
      const rows = (await database.query(`SELECT ${spec.state} AS state,count(*) AS n,
        sum(greatest(${spec.attempts}-1,0)) AS retries,
        greatest(0,max(extract(epoch FROM (clock_timestamp()-created_at)))) AS oldest,
        max(extract(epoch FROM ${spec.ended})) FILTER(WHERE ${spec.state}='${spec.success}') AS completed
        FROM ${spec.table} WHERE ${spec.condition} GROUP BY ${spec.state}`)).rows;
      if (!rows.length) items.push({ value: 0, labels: { ...labels, state: "empty" } });
      for (const row of rows) {
        const grouped = { ...labels, state: String(row.state) };
        items.push({ value: Number(row.n), labels: grouped });
        retries.push({ value: Number(row.retries), labels: grouped });
        ages.push({ value: PENDING.has(row.state) ? Number(row.oldest) : 0, labels: grouped });
        if (row.completed != null) completed.push({ value: Number(row.completed), labels });
      }
    }
  } catch {
    // A failed partial observation is unknown, never a healthy empty queue.
    return [{ ...observed, series: [{ value: 0 }] }];
  }
  return [observed,
    { name: "open_science_knowledge_queue_items", help: "Persisted items by workload and state; survives process restarts.", type: "gauge", series: items },
    { name: "open_science_knowledge_queue_oldest_seconds", help: "Age of the oldest unresolved item by workload and state.", type: "gauge", series: ages },
    { name: "open_science_knowledge_queue_retries", help: "Attempts beyond the first retained in the existing ledger; refunded deferrals are not retries.", type: "gauge", series: retries },
    { name: "open_science_knowledge_queue_last_success_timestamp_seconds", help: "Latest successful completion still retained in each workload ledger; absent if none is known.", type: "gauge", series: completed },
  ];
}
