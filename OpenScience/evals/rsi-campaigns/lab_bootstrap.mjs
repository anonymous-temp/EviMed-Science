/**
 * Prepare the lab database for campaigns (idempotent): the control-plane and product-ledger schemas the checkpoint store and
 * the budget ledger use, and the lab's own account. The lab database holds no production data.
 *
 *   RSI_LAB_DATABASE_URL=... node lab_bootstrap.mjs /run/rsi-lab/config.json
 */
import { readFile } from 'node:fs/promises';
import { ControlPlaneDatabase } from '../../apps/server/src/controlPlaneDatabase.mjs';
import { migrateProductStore } from '../../apps/server/src/productPersistence.mjs';
import { rsiLabConfigurationIssues } from '../../apps/server/src/rsiLabConfiguration.mjs';

const configuration = JSON.parse(await readFile(process.argv[2], 'utf8'));
const issues = rsiLabConfigurationIssues(configuration);
if (issues.length) { console.log(JSON.stringify({ status: 'not-ready', issues })); process.exit(2); }
const database = new ControlPlaneDatabase({ databaseUrl: process.env.RSI_LAB_DATABASE_URL, databasePoolMax: 2, databaseConnectionTimeoutMs: 5000 });
try {
  const identity = (await database.query('SELECT current_user AS role, current_database() AS database')).rows[0];
  if (identity.database !== 'evimed_rsi_lab' && !/evimed_test/.test(identity.database)) throw new Error('campaign_lab_database_unexpected');
  await database.migrate();
  await migrateProductStore(database);
  await database.query(`INSERT INTO evimed_control.users (id, name, auth_type) VALUES ($1, 'RSI lab', 'development') ON CONFLICT (id) DO NOTHING`, [configuration.authority.accountId]);
  console.log(JSON.stringify({ status: 'ready', role: identity.role, database: identity.database, account: configuration.authority.accountId }));
} finally { await database.close(); }
