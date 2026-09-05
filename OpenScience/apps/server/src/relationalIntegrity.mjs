const orphanChecks = Object.freeze([
  ["product_documents_user", "SELECT count(*)::integer AS count FROM evimed_product.documents d LEFT JOIN evimed_control.users u ON u.id=d.user_id WHERE u.id IS NULL"],
  ["product_documents_project", "SELECT count(*)::integer AS count FROM evimed_product.documents d LEFT JOIN evimed_control.projects p ON p.user_id=d.user_id AND p.id=d.project_id WHERE d.project_id IS NOT NULL AND p.id IS NULL"],
  ["product_jobs_user", "SELECT count(*)::integer AS count FROM evimed_product.jobs j LEFT JOIN evimed_control.users u ON u.id=j.user_id WHERE u.id IS NULL"],
  ["product_jobs_project", "SELECT count(*)::integer AS count FROM evimed_product.jobs j LEFT JOIN evimed_control.projects p ON p.user_id=j.user_id AND p.id=j.project_id WHERE j.project_id IS NOT NULL AND p.id IS NULL"],
  ["product_revisions_document", "SELECT count(*)::integer AS count FROM evimed_product.revisions r LEFT JOIN evimed_product.documents d ON d.user_id=r.user_id AND d.kind=r.kind AND d.id=r.id WHERE d.id IS NULL"],
  ["memory_index_user", "SELECT count(*)::integer AS count FROM evimed_product.memory_index_state s LEFT JOIN evimed_control.users u ON u.id=s.user_id WHERE u.id IS NULL"],
  ["inbox_notifications_user", "SELECT count(*)::integer AS count FROM evimed_inbox.notifications n LEFT JOIN evimed_control.users u ON u.id=n.user_id WHERE u.id IS NULL"],
  ["inbox_notifications_project", "SELECT count(*)::integer AS count FROM evimed_inbox.notifications n LEFT JOIN evimed_control.projects p ON p.user_id=n.user_id AND p.id=n.project_id WHERE n.project_id IS NOT NULL AND p.id IS NULL"],
  ["inbox_preferences_user", "SELECT count(*)::integer AS count FROM evimed_inbox.preferences p LEFT JOIN evimed_control.users u ON u.id=p.user_id WHERE u.id IS NULL"],
  ["usage_model_requests_user", "SELECT count(*)::integer AS count FROM evimed_usage.model_requests r LEFT JOIN evimed_control.users u ON u.id=r.user_id WHERE u.id IS NULL"],
  ["usage_model_requests_project", "SELECT count(*)::integer AS count FROM evimed_usage.model_requests r LEFT JOIN evimed_control.projects p ON p.user_id=r.user_id AND p.id=r.project_id WHERE p.id IS NULL"],
]);

const relationships = Object.freeze([
  ["product_documents_user", "evimed_product", "documents", "FOREIGN KEY (user_id) REFERENCES evimed_control.users(id)"],
  ["product_documents_project", "evimed_product", "documents", "FOREIGN KEY (user_id, project_id) REFERENCES evimed_control.projects(user_id, id)"],
  ["product_revisions_document", "evimed_product", "revisions", "FOREIGN KEY (user_id, kind, id) REFERENCES evimed_product.documents(user_id, kind, id)"],
  ["product_jobs_user", "evimed_product", "jobs", "FOREIGN KEY (user_id) REFERENCES evimed_control.users(id)"],
  ["product_jobs_project", "evimed_product", "jobs", "FOREIGN KEY (user_id, project_id) REFERENCES evimed_control.projects(user_id, id)"],
  ["memory_index_user", "evimed_product", "memory_index_state", "FOREIGN KEY (user_id) REFERENCES evimed_control.users(id)"],
  ["inbox_notifications_user", "evimed_inbox", "notifications", "FOREIGN KEY (user_id) REFERENCES evimed_control.users(id)"],
  ["inbox_notifications_project", "evimed_inbox", "notifications", "FOREIGN KEY (user_id, project_id) REFERENCES evimed_control.projects(user_id, id)"],
  ["inbox_preferences_user", "evimed_inbox", "preferences", "FOREIGN KEY (user_id) REFERENCES evimed_control.users(id)"],
  ["usage_model_requests_user", "evimed_usage", "model_requests", "FOREIGN KEY (user_id) REFERENCES evimed_control.users(id)"],
  ["usage_model_requests_project", "evimed_usage", "model_requests", "FOREIGN KEY (user_id, project_id) REFERENCES evimed_control.projects(user_id, id)"],
]);

function identifier(value) { return `"${String(value).replaceAll('"', '""')}"`; }

/** Audit existing ownership rows and the validation state of every required FK. */
export async function relationalIntegrity(database, { validate = false } = {}) {
  const counts = {};
  for (const [name, query] of orphanChecks) counts[name] = Number((await database.query(query)).rows[0]?.count ?? 0);
  const orphanTotal = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const rows = (await database.query(`SELECT n.nspname AS schema_name,t.relname AS table_name,c.conname,c.convalidated,
    pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
    JOIN pg_namespace n ON n.oid=t.relnamespace WHERE c.contype='f'
    AND n.nspname IN ('evimed_product','evimed_inbox','evimed_usage')`)).rows;
  const matched = new Map();
  for (const [name, schema, table, prefix] of relationships) {
    const row = rows.find((candidate) => candidate.schema_name === schema && candidate.table_name === table
      && String(candidate.definition).startsWith(prefix));
    if (row) matched.set(name, { ...row, schema, table });
  }
  const missing = relationships.map(([name]) => name).filter((name) => !matched.has(name));
  let unvalidated = [...matched].filter(([, row]) => !row.convalidated).map(([name]) => name);
  if (validate && orphanTotal === 0 && missing.length === 0 && unvalidated.length > 0) {
    await database.transaction(async (client) => {
      for (const name of unvalidated) {
        const row = matched.get(name);
        await client.query(`ALTER TABLE ${identifier(row.schema)}.${identifier(row.table)} VALIDATE CONSTRAINT ${identifier(row.conname)}`);
      }
    });
    unvalidated = [];
  }
  return { ok: orphanTotal === 0 && missing.length === 0 && unvalidated.length === 0,
    orphanTotal, counts, missing, unvalidated, validated: validate && orphanTotal === 0 && missing.length === 0 };
}
