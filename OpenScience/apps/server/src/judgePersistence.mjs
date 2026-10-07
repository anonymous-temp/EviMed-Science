/** Content-free drift observations, partitioned by model and prompt policy. */
const migrations = new WeakMap();
export function migrateJudgeDrift(database) {
  if (!migrations.has(database)) {
    const work = database
      .transaction(async (client) => {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtext('evimed-judge-drift-v1'))",
        );
        await client.query(
          `CREATE SCHEMA IF NOT EXISTS evimed_judge; CREATE TABLE IF NOT EXISTS evimed_judge.drift (id bigserial PRIMARY KEY,site text NOT NULL,model text NOT NULL,prompt_fingerprint text NOT NULL,agreement boolean NOT NULL,created_at timestamptz NOT NULL DEFAULT now()); CREATE INDEX IF NOT EXISTS judge_drift_site_time_idx ON evimed_judge.drift(site,created_at)`,
        );
      })
      .catch((error) => {
        migrations.delete(database);
        throw error;
      });
    migrations.set(database, work);
  }
  return migrations.get(database);
}
export async function recordJudgeDrift(
  database,
  { site, model, promptFingerprint, agreement },
) {
  await migrateJudgeDrift(database);
  await database.query(
    "INSERT INTO evimed_judge.drift(site,model,prompt_fingerprint,agreement) VALUES($1,$2,$3,$4)",
    [site, model, promptFingerprint, agreement],
  );
  await database.query(
    "DELETE FROM evimed_judge.drift WHERE created_at < now() - interval '35 days'",
  );
}
/** Seven completed consecutive UTC days; missing observations never imply agreement. */
export async function judgeDriftSummary(database, config) {
  if (!database) return [];
  await migrateJudgeDrift(database);
  const rows = await database.query(
    `SELECT site,model,prompt_fingerprint,(created_at AT TIME ZONE 'UTC')::date::text AS day,count(*)::int AS observations,avg(agreement::int)::float AS agreement FROM evimed_judge.drift WHERE created_at >= ((now() AT TIME ZONE 'UTC')::date - 7) AT TIME ZONE 'UTC' AND created_at < (now() AT TIME ZONE 'UTC')::date AT TIME ZONE 'UTC' GROUP BY site,model,prompt_fingerprint,(created_at AT TIME ZONE 'UTC')::date`,
  );
  return driftSummaryFromRows(rows.rows, config);
}
export function driftSummaryFromRows(rows, config, at = new Date()) {
  const days = Array.from({ length: 7 }, (_, i) =>
    new Date(
      Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() - i - 1),
    )
      .toISOString()
      .slice(0, 10),
  );
  const results = [];
  for (const [site, pin] of Object.entries(config.jevSites ?? {})) {
    const relevant = rows.filter(
      (row) =>
        row.site === site &&
        row.model === config.reviewJevModel &&
        row.prompt_fingerprint === pin.promptFingerprint,
    );
    const baseline = Number(pin.baselineAgreement);
    const below =
      Number.isFinite(baseline) &&
      baseline > 0 &&
      days.every((day) =>
        relevant.some(
          (row) => row.day === day && Number(row.agreement) < baseline,
        ),
      );
    const n = relevant.reduce((sum, row) => sum + Number(row.observations), 0);
    results.push({
      site,
      observations: n,
      agreement: n
        ? relevant.reduce(
            (sum, row) =>
              sum + Number(row.agreement) * Number(row.observations),
            0,
          ) / n
        : null,
      belowBaselineSevenDays: below,
      baselineConfigured: Number.isFinite(baseline) && baseline > 0,
    });
  }
  return results;
}
