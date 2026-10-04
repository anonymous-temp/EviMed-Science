// In-memory doubles for the availability tests: the one table the store writes, and a job queue with the
// ProductJobs surface the collector uses — including the part that matters, a completion that either commits
// its side effect together with the job or rolls both back (`finishWithLease`).

/** The availability table and the job rows, with just the SQL the store sends. */
export class FakeAvailabilityDatabase {
  constructor() {
    /** @type {Map<string, { record: any, updated_at: Date }>} */
    this.rows = new Map();
    /** @type {{ id: string, user_id: string, kind: string, idempotency_key: string, status: string, payload: any }[]} */
    this.jobs = [];
    this.queries = [];
    this.failNextRead = false;
  }

  /** @param {string} text @param {any[]} [values] */
  async query(text, values = []) {
    this.queries.push(text);
    const sql = text.replace(/\s+/g, " ").trim();
    if (sql.startsWith("SELECT pg_advisory_xact_lock")) return { rows: [] };
    if (this.failNextRead && sql.startsWith("SELECT record, updated_at")) { this.failNextRead = false; throw new Error("boom"); }
    if (sql.startsWith("SELECT record FROM evimed_product.availability_operations")) {
      const row = this.rows.get(JSON.stringify(values));
      return { rows: row ? [{ record: row.record }] : [] };
    }
    if (sql.startsWith("INSERT INTO evimed_product.availability_operations")) {
      this.rows.set(JSON.stringify(values.slice(0, 3)), { record: JSON.parse(values[3]), updated_at: new Date("2026-10-04T12:00:00.000Z") });
      return { rows: [] };
    }
    if (sql.startsWith("SELECT record, updated_at FROM evimed_product.availability_operations")) {
      return { rows: [...this.rows.values()].map((row) => ({ record: row.record, updated_at: row.updated_at })) };
    }
    if (sql.startsWith("SELECT idempotency_key FROM evimed_product.jobs")) {
      return { rows: this.jobs.filter((job) => job.user_id === values[0] && job.kind === values[1] && job.idempotency_key.startsWith("availability:run:")).map((job) => ({ idempotency_key: job.idempotency_key })) };
    }
    if (sql.includes("FROM evimed_product.jobs WHERE kind=$1")) {
      const mine = this.jobs.filter((job) => job.kind === values[0]);
      return { rows: [{
        backlog: mine.filter((job) => ["queued", "running"].includes(job.status)).length,
        failed: mine.filter((job) => job.status === "failed").length,
        swept: mine.filter((job) => job.status === "succeeded" && job.payload.sweep === true).length,
      }] };
    }
    if (sql.includes("migrate") || sql.startsWith("CREATE") || sql.startsWith("SELECT 1")) return { rows: [] };
    throw new Error(`the fake database was asked something it does not know: ${sql.slice(0, 120)}`);
  }

  async transaction(work) {
    const snapshot = new Map([...this.rows].map(([key, row]) => [key, { ...row, record: structuredClone(row.record) }]));
    try { return await work(this); } catch (error) { this.rows = snapshot; throw error; }
  }
}

/** The ProductJobs surface the collector and its worker use. */
export class FakeJobs {
  /** @param {FakeAvailabilityDatabase} database */
  constructor(database) {
    this.database = database;
    this.leaseHeld = true;
    this.failures = [];
    this.finished = [];
    this.nextId = 1;
  }

  async enqueue(userId, kind, payload, { idempotencyKey, projectId = null }) {
    const existing = this.database.jobs.find((job) => job.user_id === userId && job.idempotency_key === idempotencyKey);
    if (existing) {
      if (JSON.stringify(existing.payload) !== JSON.stringify(payload)) throw Object.assign(new Error("conflict"), { code: "product_job_idempotency_conflict" });
      return { ...existing };
    }
    const job = { id: `job-${this.nextId++}`, user_id: userId, kind, idempotency_key: idempotencyKey, status: "queued", payload, projectId, leaseToken: `lease-${this.nextId}` };
    this.database.jobs.push(job);
    return { ...job };
  }

  /** Queued and due, or running with a lease that lapsed: what `ProductJobs.claim` hands out. A job waiting out a retry delay is not due. */
  async claim(kinds) {
    const job = this.database.jobs.find((candidate) => kinds.includes(candidate.kind) && !candidate.notBefore
      && (candidate.status === "queued" || (candidate.status === "running" && candidate.leaseLapsed)));
    if (!job) return null;
    job.status = "running";
    job.leaseLapsed = false;
    return { id: job.id, userId: job.user_id, kind: job.kind, payload: job.payload, leaseToken: job.leaseToken, projectId: job.projectId ?? null };
  }

  async renew() { return this.leaseHeld; }

  async finish(userId, id, leaseToken, result) {
    if (!this.leaseHeld) throw Object.assign(new Error("lost"), { code: "product_job_lease_lost" });
    const job = this.database.jobs.find((candidate) => candidate.id === id);
    job.status = "succeeded";
    this.finished.push({ id, result });
    return { ...job };
  }

  /** The completion and its side effect commit together, or neither does. */
  async finishWithLease(userId, id, leaseToken, result, operation) {
    return this.database.transaction(async (client) => {
      await operation(client);
      const job = this.database.jobs.find((candidate) => candidate.id === id);
      if (!this.leaseHeld) { job.leaseLapsed = true; throw Object.assign(new Error("lost"), { code: "product_job_lease_lost" }); }
      job.status = "succeeded";
      this.finished.push({ id, result });
      return { ...job };
    });
  }

  async fail(userId, id, leaseToken, error, options) {
    const job = this.database.jobs.find((candidate) => candidate.id === id);
    job.status = options?.retry ? "queued" : "failed";
    if (options?.retry && options.delayMs) job.notBefore = true;
    this.failures.push({ id, error, options });
    return { ...job };
  }

  async rearm() { return 0; }
}
