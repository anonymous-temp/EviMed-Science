import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, before, test } from "node:test";
import { ControlPlaneDatabase } from "../src/controlPlaneDatabase.mjs";

/**
 * The import that carries research memory out of the retired usememos database.
 *
 * The source schema is built here from the DDL of
 * `记忆模块/store/migration/{postgres,sqlite}/LATEST.sql` rather than read from
 * that tree, because the tree is being deleted: what the import has to keep
 * working against is the shape of the database on the production host, and this
 * file is now the only statement of that shape we control.
 */
const run = promisify(execFile);
const script = path.resolve(fileURLToPath(import.meta.url), "../../../../scripts/ops/migrate-research-memory.mjs");
const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? "";
if (url) {
  const parsed = new URL(url);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(parsed.hostname));
  assert.match(parsed.pathname, /evimed_test/);
}
const options = { skip: !url && "OPEN_SCIENCE_TEST_POSTGRES_URL is not configured" };

const alpha = `import_alpha_${randomUUID()}`;
const beta = `import_beta_${randomUUID()}`;
const schema = `memos_source_${randomUUID().replaceAll("-", "")}`;
/** @type {any} */ let database;
/** @type {string} */ let workspace;

/** The two digests the retired service derived a user's identity from: one
 *  salt for records, a different one for notes. @param {string} userId */
function digests(userId) {
  return {
    namespace: `evimed-science-${createHash("sha256").update(`evimed/memory-record/user/v1:${userId}`).digest("hex").slice(0, 24)}`,
    tag: createHash("sha256").update(`evimed/memos/user/v1:${userId}`).digest("hex").slice(0, 24),
  };
}

/** @param {number} seconds */
function instant(seconds) {
  return `${new Date(seconds * 1_000).toISOString().slice(0, 19)}Z`;
}

const createdTs = 1_757_000_000;
const updatedTs = 1_757_000_064;
const observedTs = 1_757_000_032;

/** The evidence and revision payload exactly as protojson writes it: camelCase
 *  names, int64 fields as strings, enums by name, zero values omitted. */
function payload() {
  return {
    evidence: [
      {
        sourceType: "conversation_message",
        sourceRef: "sessions/s1/messages/m1",
        quote: "优先给原始证据，并明确保留不确定性。",
        observedTs: String(observedTs),
        weight: 1,
        fingerprint: "1111111111111111abcdefabcdefabcd",
      },
      {
        sourceType: "conversation_message",
        sourceRef: "sessions/s2/messages/m4",
        quote: "再次确认这条偏好。",
        observedTs: String(observedTs + 60),
        weight: 1,
        fingerprint: "2222222222222222abcdefabcdefabcd",
      },
    ],
    revisions: [{
      version: 1,
      value: "Prefer primary evidence.",
      summary: "Primary evidence first.",
      status: "MEMORY_STATUS_PENDING",
      changedTs: String(observedTs),
      reason: "conversation evidence updated the current memory",
    }],
  };
}

/**
 * A memo's payload as usememos stored it: the tag list its own goldmark parse
 * produced, plus whatever properties that parse found. protojson omits empty
 * fields, so a memo with no tags and no properties is written as `{}`.
 * @param {string[]} tags @param {Record<string, boolean>} property
 */
function memoPayload(tags, property = {}) {
  const payload = /** @type {Record<string, any>} */ ({});
  if (tags.length > 0) payload.tags = tags;
  if (Object.keys(property).length > 0) payload.property = property;
  return JSON.stringify(payload);
}

/** A note of the kind this product is full of: a claim, a DOI, a citation link,
 *  a pasted command and one tag the researcher typed. goldmark gives the URLs
 *  to the autolink and link parsers and the indented block to the code parser,
 *  so none of `#section`, `#abstract` and `#outcome` is a tag — they are not in
 *  the payload, and must not appear in the imported note either.
 *  @param {string} tag */
function citationNote(tag) {
  return "二甲双胍的机制见 https://doi.org/10.1000/xyz#section 与 "
    + `[PubMed](https://pubmed.ncbi.nlm.nih.gov/12345/#abstract) #证据\n\n`
    + `    grep #outcome cohort.csv\n\n#evimed-user-${tag}`;
}

const sourceDdl = (name) => `
CREATE SCHEMA "${name}";
CREATE TABLE "${name}".memo (
  id SERIAL PRIMARY KEY,
  uid TEXT NOT NULL UNIQUE,
  creator_id INTEGER NOT NULL,
  created_ts BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW()),
  updated_ts BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW()),
  row_status TEXT NOT NULL DEFAULT 'NORMAL',
  content TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'PRIVATE',
  pinned BOOLEAN NOT NULL DEFAULT FALSE,
  payload JSONB NOT NULL DEFAULT '{}'
);
CREATE TABLE "${name}".memory_record (
  id SERIAL PRIMARY KEY,
  uid TEXT NOT NULL UNIQUE,
  creator_id INTEGER NOT NULL,
  namespace TEXT NOT NULL,
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  memory_key TEXT NOT NULL,
  value TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  origin TEXT NOT NULL,
  status TEXT NOT NULL,
  confidence DOUBLE PRECISION NOT NULL DEFAULT 0,
  importance DOUBLE PRECISION NOT NULL DEFAULT 0,
  sensitive BOOLEAN NOT NULL DEFAULT FALSE,
  evidence_count INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_ts BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW()),
  updated_ts BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW()),
  last_confirmed_ts BIGINT,
  expires_ts BIGINT,
  payload JSONB NOT NULL DEFAULT '{}',
  UNIQUE(creator_id, namespace, scope_type, scope_id, kind, memory_key)
);`;

const sqliteDdl = `
CREATE TABLE memo (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT NOT NULL UNIQUE,
  creator_id INTEGER NOT NULL,
  created_ts BIGINT NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_ts BIGINT NOT NULL DEFAULT (strftime('%s', 'now')),
  row_status TEXT NOT NULL CHECK (row_status IN ('NORMAL', 'ARCHIVED')) DEFAULT 'NORMAL',
  content TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL CHECK (visibility IN ('PUBLIC', 'PROTECTED', 'PRIVATE')) DEFAULT 'PRIVATE',
  pinned INTEGER NOT NULL CHECK (pinned IN (0, 1)) DEFAULT 0,
  payload TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE memory_record (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT NOT NULL UNIQUE,
  creator_id INTEGER NOT NULL,
  namespace TEXT NOT NULL,
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  memory_key TEXT NOT NULL,
  value TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  origin TEXT NOT NULL,
  status TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0,
  importance REAL NOT NULL DEFAULT 0,
  sensitive INTEGER NOT NULL CHECK (sensitive IN (0, 1)) DEFAULT 0,
  evidence_count INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_ts BIGINT NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_ts BIGINT NOT NULL DEFAULT (strftime('%s', 'now')),
  last_confirmed_ts BIGINT,
  expires_ts BIGINT,
  payload TEXT NOT NULL DEFAULT '{}',
  UNIQUE(creator_id, namespace, scope_type, scope_id, kind, memory_key)
);`;

before(async () => {
  if (!url) return;
  workspace = await mkdtemp(path.join(os.tmpdir(), "evimed-memory-import-"));
  database = new ControlPlaneDatabase({ databaseUrl: url, databasePoolMax: 4, databaseConnectionTimeoutMs: 5_000 });
  await database.query(
    "INSERT INTO evimed_control.users(id,name,auth_type) SELECT id,'Import owner','development' FROM unnest($1::text[]) AS id",
    [[alpha, beta]]);
  await database.query(sourceDdl(schema));
  const alphaDigests = digests(alpha);
  const betaDigests = digests(beta);
  await database.query(`INSERT INTO "${schema}".memory_record
    (uid,creator_id,namespace,scope_type,scope_id,kind,memory_key,value,summary,origin,status,confidence,importance,
     sensitive,evidence_count,version,created_ts,updated_ts,last_confirmed_ts,expires_ts,payload)
    VALUES
    ('recordalpha1',1,$1,'MEMORY_SCOPE_USER','','MEMORY_KIND_PREFERENCE','response.evidence_depth',
     'Prefer primary evidence and explicit uncertainty.','Primary evidence first.','MEMORY_ORIGIN_INFERRED',
     'MEMORY_STATUS_ACTIVE',0.7,0.9,false,2,3,$3,$4,$5,NULL,$6::jsonb),
    ('recordalpha2',1,$1,'MEMORY_SCOPE_PROJECT','study-one','MEMORY_KIND_RUN_SUMMARY','run.abc',
     '{"question":"二甲双胍的作用机制是什么"}','Conversation about a run.','MEMORY_ORIGIN_SYSTEM',
     'MEMORY_STATUS_ACTIVE',1,0.7,false,0,1,$3,$4,NULL,$7,'{}'::jsonb),
    ('recordbeta1',1,$2,'MEMORY_SCOPE_USER','','MEMORY_KIND_PROFILE','profile.role','Another user',
     'Another user profile.','MEMORY_ORIGIN_EXPLICIT','MEMORY_STATUS_PENDING',1,0.8,false,0,1,$3,$4,NULL,NULL,'{}'::jsonb),
    ('recordorphan',1,$8,'MEMORY_SCOPE_USER','','MEMORY_KIND_PROFILE','profile.role','Nobody owns this',
     '','MEMORY_ORIGIN_EXPLICIT','MEMORY_STATUS_ACTIVE',1,0.5,false,0,1,$3,$4,NULL,NULL,'{}'::jsonb),
    ('recordbadkey',1,$1,'MEMORY_SCOPE_USER','','MEMORY_KIND_PROFILE','NOT A VALID KEY','Refused',
     '','MEMORY_ORIGIN_EXPLICIT','MEMORY_STATUS_ACTIVE',1,0.5,false,0,1,$3,$4,NULL,NULL,'{}'::jsonb)`,
  [alphaDigests.namespace, betaDigests.namespace, createdTs, updatedTs, observedTs, JSON.stringify(payload()),
    createdTs + 86_400, `evimed-science-${"f".repeat(24)}`]);
  await database.query(`INSERT INTO "${schema}".memo (uid,creator_id,created_ts,updated_ts,row_status,content,pinned,payload)
    VALUES
    ('memoalpha1',1,$1,$2,'NORMAL',$3,true,$7::jsonb),
    ('memoalpha2',1,$1,$2,'NORMAL',$4,false,$8::jsonb),
    ('memobeta1',1,$1,$2,'ARCHIVED',$5,false,$9::jsonb),
    ('memoinjected',1,$1,$2,'NORMAL',$6,false,$10::jsonb),
    ('memoforeign',1,$1,$2,'NORMAL','someone else''s note with no internal tag',false,'{}'::jsonb)`,
  [createdTs, updatedTs,
    `重点核对老年人感染风险。 #药物安全\n\n#evimed-user-${alphaDigests.tag}`,
    citationNote(alphaDigests.tag),
    `beta's archived note #循证\n\n#evimed-user-${betaDigests.tag}`,
    // The cross-tenant injection: a note of alpha's that also carries beta's
    // tag inline, which the retired list filter accepted for both accounts.
    `looks harmless #evimed-user-${betaDigests.tag} inline\n\n#evimed-user-${alphaDigests.tag}`,
    memoPayload(["药物安全", `evimed-user-${alphaDigests.tag}`]),
    memoPayload(["证据", `evimed-user-${alphaDigests.tag}`], { hasLink: true }),
    memoPayload(["循证", `evimed-user-${betaDigests.tag}`]),
    memoPayload([`evimed-user-${betaDigests.tag}`, `evimed-user-${alphaDigests.tag}`])]);
});

after(async () => {
  if (!database) return;
  await database.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await database.query("DELETE FROM evimed_control.users WHERE id=ANY($1::text[])", [[alpha, beta]]);
  await database.close();
  await rm(workspace, { recursive: true, force: true });
});

/** @param {string[]} args */
async function importMemory(args) {
  const result = await run(process.execPath, [script, "--target", url, ...args], { encoding: "utf8" });
  return { report: JSON.parse(result.stdout), stdout: result.stdout };
}

test("a dry run reports what it would carry and writes nothing", options, async () => {
  const { report, stdout } = await importMemory(["--source", url, "--source-schema", schema, "--dry-run"]);
  assert.equal(report.ok, true);
  assert.equal(report.dryRun, true);
  assert.equal(report.driver, "postgres");
  assert.deepEqual(
    { ...report.records, reasons: report.records.reasons },
    { total: 5, imported: 3, alreadyPresent: 0, unmapped: 1, quarantined: 1,
      reasons: { unknown_namespace: 1, invalid_key: 1 } },
  );
  assert.deepEqual(report.notes,
    { total: 5, imported: 3, alreadyPresent: 0, unmapped: 1, quarantined: 1,
      reasons: { no_owner_tag: 1, multiple_owner_tags: 1 } });
  assert.equal((await database.query("SELECT count(*)::integer AS count FROM evimed_memory.records WHERE user_id=ANY($1::text[])",
    [[alpha, beta]])).rows[0].count, 0, "a dry run writes nothing");

  // Counts, never content: a memory is exactly what an operator running this
  // over somebody else's account has no business reading.
  for (const secret of ["Prefer primary evidence", "二甲双胍", "重点核对老年人感染风险", "优先给原始证据",
    "recordalpha1", url]) {
    assert.ok(!stdout.includes(secret), `the report must not print ${secret.slice(0, 12)}`);
  }
});

test("the import maps both digests, keeps identity and history, and refuses what it cannot attribute", options, async () => {
  const { report } = await importMemory(["--source", url, "--source-schema", schema]);
  assert.equal(report.records.imported, 3);
  assert.equal(report.notes.imported, 3);

  const rows = (await database.query(
    "SELECT * FROM evimed_memory.records WHERE user_id=$1 ORDER BY key", [alpha])).rows;
  assert.deepEqual(rows.map((row) => row.id), ["recordalpha1", "recordalpha2"],
    "ids survive, because a feedback ledger and an OpenViking URI both name them");
  const [preference, summary] = rows;
  assert.equal(preference.scope, "user");
  assert.equal(preference.kind, "preference");
  assert.equal(preference.origin, "inferred");
  assert.equal(preference.status, "active");
  assert.equal(preference.version, 3, "the version travels, so the next compare-and-swap still means something");
  assert.equal(new Date(preference.created_at).toISOString(), instant(createdTs).replace("Z", ".000Z"));
  assert.equal(new Date(preference.updated_at).toISOString(), instant(updatedTs).replace("Z", ".000Z"));
  assert.equal(new Date(preference.last_confirmed_at).toISOString(), instant(observedTs).replace("Z", ".000Z"));
  assert.deepEqual(preference.evidence.map((item) => item.fingerprint),
    ["1111111111111111abcdefabcdefabcd", "2222222222222222abcdefabcdefabcd"],
    "fingerprints travel unchanged, or a re-observed quote would count twice");
  assert.deepEqual(preference.evidence.map((item) => item.observedAt),
    [instant(observedTs), instant(observedTs + 60)], "int64 seconds arrive as strings and become instants");
  assert.equal(preference.evidence[0].weight, 1);
  assert.deepEqual(preference.revisions, [{
    version: 1, value: "Prefer primary evidence.", summary: "Primary evidence first.", status: "pending",
    changedAt: instant(observedTs), reason: "conversation evidence updated the current memory",
  }], "a revision's enum is mapped too, not left as a proto name");
  assert.equal(summary.scope, "project");
  assert.equal(summary.scope_id, "study-one");
  assert.equal(new Date(summary.expires_at).toISOString(), instant(createdTs + 86_400).replace("Z", ".000Z"));
  assert.deepEqual(preference.evidence.length, 2);

  const notes = (await database.query("SELECT * FROM evimed_memory.notes WHERE user_id=$1 ORDER BY id", [alpha])).rows;
  assert.deepEqual(notes.map((note) => note.id), ["memoalpha1", "memoalpha2"],
    "the note carrying two accounts' tags is quarantined, not handed to either of them");
  assert.equal(notes[0].content, "重点核对老年人感染风险。 #药物安全", "the internal tag line is not stored");
  assert.deepEqual(notes[0].tags, ["药物安全"]);
  assert.equal(notes[0].pinned, true);
  assert.equal(notes[0].state, "normal");
  // The tags are the ones usememos computed with goldmark and its UI already
  // filters on, not a second reading of the text: re-deriving them would add a
  // tag for a URL fragment or a word in a pasted command, and the account's
  // project-deletion rule is decided on exactly this list.
  assert.deepEqual(notes[1].tags, ["证据"],
    "only the tag the researcher typed survives; the internal tag is dropped from the stored list");
  assert.ok(notes[1].content.includes("#outcome"), "the note's own text is carried over whole");

  const betaNotes = (await database.query("SELECT * FROM evimed_memory.notes WHERE user_id=$1", [beta])).rows;
  assert.deepEqual(betaNotes.map((note) => [note.id, note.state]), [["memobeta1", "archived"]]);
  assert.equal((await database.query("SELECT count(*)::integer AS count FROM evimed_memory.records WHERE user_id=$1",
    [beta])).rows[0].count, 1);
  assert.equal((await database.query("SELECT count(*)::integer AS count FROM evimed_memory.records WHERE id='recordorphan'"))
    .rows[0].count, 0, "an orphan namespace is reported, never attached to an account");
});

test("running the import again is a no-op", options, async () => {
  const { report } = await importMemory(["--source", url, "--source-schema", schema]);
  assert.deepEqual([report.records.imported, report.records.alreadyPresent], [0, 3]);
  assert.deepEqual([report.notes.imported, report.notes.alreadyPresent], [0, 3]);
  assert.equal((await database.query("SELECT count(*)::integer AS count FROM evimed_memory.records WHERE user_id=ANY($1::text[])",
    [[alpha, beta]])).rows[0].count, 3);
  // A rerun after an interrupted import adds what is missing and touches
  // nothing else: the row the operator may have edited since keeps its edit.
  await database.query("UPDATE evimed_memory.records SET value='edited after the import' WHERE user_id=$1 AND id='recordalpha1'",
    [alpha]);
  await importMemory(["--source", url, "--source-schema", schema]);
  assert.equal((await database.query("SELECT value FROM evimed_memory.records WHERE user_id=$1 AND id='recordalpha1'",
    [alpha])).rows[0].value, "edited after the import");
});

// In production the source and the target are one database, and the string that
// reaches it carries a password. `--source same` reads the memos tables through
// the connection the script already opens, so the command line holds no
// credential — an argument is readable in `ps` and in `/proc/<pid>/cmdline` for
// the length of the run, and stays in shell history afterwards.
test("the production form needs no connection string on the command line", options, async () => {
  for (const table of ["evimed_memory.notes", "evimed_memory.records"]) {
    await database.query(`DELETE FROM ${table} WHERE user_id=ANY($1::text[])`, [[alpha, beta]]);
  }
  const argv = ["--source", "same", "--source-schema", schema];
  assert.ok(!argv.some((argument) => argument.includes("://")), "no argument is a connection string");
  const result = await run(process.execPath, [script, ...argv],
    { encoding: "utf8", env: { ...process.env, OPEN_SCIENCE_DATABASE_URL: url } });
  const report = JSON.parse(result.stdout);
  assert.equal(report.driver, "postgres");
  assert.deepEqual([report.records.imported, report.notes.imported], [3, 3],
    "the same rows arrive, read through the target's own connection");
  assert.ok(!result.stdout.includes(url), "and the report still prints no connection string");
});

// Local development ran memos on SQLite, so the file is the other half of the
// source side. Same rows, same rules, one driver apart.
test("a SQLite source imports the same way", options, async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const file = path.join(workspace, "memos_dev.db");
  const source = new DatabaseSync(file);
  try {
    source.exec(sqliteDdl);
    const alphaDigests = digests(alpha);
    source.prepare(`INSERT INTO memory_record
      (uid,creator_id,namespace,scope_type,scope_id,kind,memory_key,value,summary,origin,status,confidence,importance,
       sensitive,evidence_count,version,created_ts,updated_ts,last_confirmed_ts,expires_ts,payload)
      VALUES(?,1,?,'MEMORY_SCOPE_USER','','MEMORY_KIND_BEHAVIOR','behavior.review',
      'Reviews systematic reviews first.','Reviews systematic reviews first.','MEMORY_ORIGIN_INFERRED',
      'MEMORY_STATUS_ACTIVE',0.6,0.5,0,2,2,?,?,NULL,NULL,?)`)
      .run("sqliterecord1", alphaDigests.namespace, createdTs, updatedTs, JSON.stringify(payload()));
    const memo = source.prepare(
      "INSERT INTO memo (uid,creator_id,created_ts,updated_ts,row_status,content,pinned,payload) VALUES(?,1,?,?,'NORMAL',?,0,?)");
    memo.run("sqlitememo1", createdTs, updatedTs, `本地开发笔记 #本地\n\n#evimed-user-${alphaDigests.tag}`,
      memoPayload(["本地", `evimed-user-${alphaDigests.tag}`]));
    // A row whose payload is the column's own default says nothing about
    // whether the parse ever ran, so that one — and only that one — is read
    // from its text.
    memo.run("sqlitememo2", createdTs, updatedTs, `没有 payload 的旧笔记 #旧标签\n\n#evimed-user-${alphaDigests.tag}`, "{}");
  } finally { source.close(); }

  const { report } = await importMemory(["--source", `sqlite:${file}`]);
  assert.equal(report.driver, "sqlite");
  assert.equal(report.records.imported, 1);
  assert.equal(report.notes.imported, 2);
  const row = (await database.query("SELECT * FROM evimed_memory.records WHERE user_id=$1 AND id='sqliterecord1'",
    [alpha])).rows[0];
  assert.equal(row.kind, "behavior");
  assert.equal(row.sensitive, false, "SQLite integers become the booleans the column declares");
  assert.equal(row.version, 2);
  assert.equal(row.evidence.length, 2);
  assert.equal(row.evidence[0].observedAt, instant(observedTs));
  const note = (await database.query("SELECT * FROM evimed_memory.notes WHERE user_id=$1 AND id='sqlitememo1'",
    [alpha])).rows[0];
  assert.deepEqual(note.tags, ["本地"]);
  const derived = (await database.query("SELECT * FROM evimed_memory.notes WHERE user_id=$1 AND id='sqlitememo2'",
    [alpha])).rows[0];
  assert.deepEqual(derived.tags, ["旧标签"], "a note with no stored tag list is read from its own text");
  assert.equal((await importMemory(["--source", `sqlite:${file}`])).report.records.imported, 0, "and it is idempotent too");
});
