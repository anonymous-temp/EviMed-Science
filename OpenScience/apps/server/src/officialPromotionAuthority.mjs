/** Short database authority for publication, never held across model review. */
import { HttpError } from './security.mjs';

const changed = () => new HttpError(409, 'official_promotion_authority_changed', 'Promotion authority changed before publication.');

/** Account ids can be recreated. Bind pending authors and witnesses to the
 * database's exact timestamp text, without millisecond round trips.
 * @param {any} documents @param {string[]} ids @returns {Promise<Map<string,string>>} */
export async function promotionAccountIdentities(documents, ids) {
  if (documents.database?.query) {
    const result = await documents.database.query('SELECT id,created_at::text AS born FROM evimed_control.users WHERE id=ANY($1::text[])', [[...new Set(ids)].sort()]);
    return new Map(result.rows.map(row => [String(row.id), String(row.born)]));
  }
  // A protected test double must explicitly implement this authority. Missing
  // persistence is never read as an account in standing.
  return documents.accountIdentities ? documents.accountIdentities(ids) : new Map();
}

/** Freeze the candidate, one exact witness, and both account incarnations in
 * the same transaction that writes activation. All locks have a stable order.
 * @param {any} documents @returns {((proof:any,operation:()=>Promise<any>)=>Promise<any>)|null} */
export function promotionActivationAuthority(documents) {
  const database = documents.database;
  if (!database?.transaction || !database?.withTransactionClient) return documents.withActivationAuthority?.bind(documents) ?? null;
  return (proof, operation) => database.transaction(async client => {
    const accounts = proof.accounts;
    const pins = [proof.candidate, ...proof.witnesses].sort((a, b) => a.id.localeCompare(b.id));
    if (!Array.isArray(accounts) || accounts.length < 1 || accounts.length > 3 || pins.length < 1 || pins.length > 2
      || new Set(accounts.map(row => row.id)).size !== accounts.length || new Set(pins.map(row => row.id)).size !== pins.length) throw changed();
    const users = await client.query('SELECT id,created_at::text AS born FROM evimed_control.users WHERE id=ANY($1::text[]) ORDER BY id FOR SHARE', [accounts.map(row => row.id).sort()]);
    if (users.rows.length !== accounts.length || accounts.some(pin => !users.rows.some(row => row.id === pin.id && row.born === pin.createdAt))) throw changed();
    const records = await client.query(`SELECT id,revision FROM evimed_product.documents
      WHERE user_id=$1 AND kind='preferences' AND id=ANY($2::text[]) AND deleted_at IS NULL ORDER BY id FOR UPDATE`, [proof.publisherId, pins.map(row => row.id)]);
    if (records.rows.length !== pins.length || pins.some(pin => !records.rows.some(row => row.id === pin.id && Number(row.revision) === pin.revision))) throw changed();
    return database.withTransactionClient(client, operation);
  });
}
