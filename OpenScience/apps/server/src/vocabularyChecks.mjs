/**
 * Column CHECKs over a closed vocabulary, brought up to date on a database that
 * already has the table.
 *
 * Hidden knowledge: a module's DDL is `CREATE TABLE IF NOT EXISTS`, and the
 * `CHECK (kind IN (...))` it writes is spliced from the domain's vocabulary at
 * the moment the table is first created. On every later start the statement is
 * a no-op, so a word the domain adds afterwards is refused by the database the
 * first time it is written — on production only, because every test database
 * is created fresh. It happened to 「虚拟临研」's `jobs.kind` the day the
 * engine gained comparator methods (2026-10-04).
 *
 * So, after the DDL has run: every single-column CHECK the DDL declares with an
 * `IN (...)` list is compared with the constraint the database holds on that
 * column, by the set of quoted words, and replaced where they differ. Each
 * replacement runs under its own savepoint: a list that has lost a word some
 * existing row still carries cannot be re-added, and then the old constraint
 * stays and the column is reported, rather than the module failing to start.
 *
 * @module vocabularyChecks
 */

/**
 * The single-column vocabulary CHECKs a module's DDL declares, read from the
 * generated DDL text: a column line inside `CREATE TABLE IF NOT EXISTS
 * <schema>.<table> (`, or an `ALTER TABLE <schema>.<table> ADD COLUMN IF NOT
 * EXISTS <column>` line, whose CHECK holds an `IN (...)` list.
 * @param {string} ddl @param {string} schema
 * @returns {{ table: string, column: string, check: string, words: string[] }[]}
 */
export function declaredVocabularyChecks(ddl, schema) {
  /** @type {Map<string, { table: string, column: string, check: string, words: string[] }>} */
  const found = new Map();
  const escaped = schema.replace(/[^A-Za-z0-9_]/g, "");
  const create = new RegExp(`^\\s*CREATE TABLE IF NOT EXISTS ${escaped}\\.(\\w+)\\s*\\(`);
  const alter = new RegExp(`^\\s*ALTER TABLE ${escaped}\\.(\\w+) ADD COLUMN IF NOT EXISTS (\\w+)\\b.*?(CHECK \\((?:[^()]|\\([^()]*\\))*\\))`);
  const column = /^\s+(\w+)\s+\w+\b[^\n]*?(CHECK \((?:[^()]|\([^()]*\))*\))/;
  /** @type {string | null} */
  let table = null;
  const add = (/** @type {string} */ tableName, /** @type {string} */ columnName, /** @type {string} */ check) => {
    if (!/ IN \(/.test(check) || / NOT IN \(/.test(check)) return;
    const words = [...check.matchAll(/'([^']*)'/g)].map((match) => match[1]);
    if (!words.length) return;
    found.set(`${tableName}.${columnName}`, { table: tableName, column: columnName, check, words });
  };
  for (const line of ddl.split("\n")) {
    const opened = create.exec(line);
    if (opened) { table = opened[1]; continue; }
    const added = alter.exec(line);
    if (added) { add(added[1], added[2], added[3]); continue; }
    if (/^\s*\);/.test(line)) { table = null; continue; }
    if (!table) continue;
    const declared = column.exec(line);
    if (declared && declared[1].toUpperCase() !== "CHECK" && declared[1].toUpperCase() !== "CONSTRAINT") add(table, declared[1], declared[2]);
  }
  return [...found.values()];
}

/**
 * Replace every vocabulary CHECK whose words differ from what the DDL declares.
 * Runs inside the module's own migration transaction (`client`).
 * @param {any} client a pg client inside a transaction
 * @param {string} ddl the module's generated DDL
 * @param {string} schema
 * @returns {Promise<{ replaced: string[], kept: string[] }>} `kept`: a narrowed list the existing rows did not admit
 */
export async function refreshVocabularyChecks(client, ddl, schema) {
  /** @type {string[]} */
  const replaced = [];
  /** @type {string[]} */
  const kept = [];
  for (const { table, column, check, words } of declaredVocabularyChecks(ddl, schema)) {
    const existing = await client.query(
      `SELECT c.conname, pg_get_constraintdef(c.oid) AS definition
         FROM pg_constraint c
         JOIN pg_class r ON r.oid = c.conrelid
         JOIN pg_namespace n ON n.oid = r.relnamespace
         JOIN pg_attribute a ON a.attrelid = r.oid AND a.attnum = c.conkey[1]
        WHERE n.nspname = $1 AND r.relname = $2 AND a.attname = $3 AND c.contype = 'c' AND array_length(c.conkey, 1) = 1`,
      [schema, table, column],
    );
    const wanted = [...new Set(words)].sort().join("\u0000");
    for (const row of existing.rows) {
      const held = [...new Set([...String(row.definition).matchAll(/'([^']*)'::text/g)].map((match) => match[1]))].sort().join("\u0000");
      if (!held || held === wanted) continue;
      const name = `"${String(row.conname).replace(/"/g, '""')}"`;
      await client.query("SAVEPOINT vocabulary_check");
      try {
        await client.query(`ALTER TABLE ${schema}.${table} DROP CONSTRAINT ${name}`);
        await client.query(`ALTER TABLE ${schema}.${table} ADD CONSTRAINT ${name} ${check}`);
        await client.query("RELEASE SAVEPOINT vocabulary_check");
        replaced.push(`${table}.${column}`);
      } catch {
        await client.query("ROLLBACK TO SAVEPOINT vocabulary_check");
        kept.push(`${table}.${column}`);
      }
    }
  }
  return { replaced, kept };
}
