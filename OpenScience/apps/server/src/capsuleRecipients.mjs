/**
 * The accounts a list of names reaches, for everything that hands a capsule to people of this deployment: a delivery in the app
 * (`capsuleSharing.mjs`) and a file sealed for named accounts (`capsuleTransferService.mjs`). One rule for both, because a name
 * that reached someone through one door and nobody through the other would be a lookup nobody could predict.
 *
 * A name is an exact account id or an exact display name that exactly one account which can sign in has. Nothing here lists,
 * completes or counts accounts: the caller answers how many names reached someone, in the same words whatever kept the others
 * from reaching anyone (an unknown name, a name two accounts share, an account that cannot sign in, the sender's own).
 *
 * @module capsuleRecipients
 */

/** The accounts a person can address: not a subject an integration made, not a platform account. */
const REACHABLE = "auth_type NOT IN ('subject','platform')";

/**
 * @param {{ query: (sql: string, values?: any[]) => Promise<{ rows: any[] }> }} database
 * @param {string} senderId @param {readonly string[]} refs
 * @returns {Promise<string[]>} the ids reached, each once, never the sender's own
 */
export async function reachableAccounts(database, senderId, refs) {
  const ids = new Set();
  for (const ref of refs) {
    const byId = (await database.query(`SELECT id FROM evimed_control.users WHERE id=$1 AND ${REACHABLE}`, [ref])).rows;
    let id = byId[0]?.id ?? null;
    if (!id) {
      const byName = (await database.query(`SELECT id FROM evimed_control.users WHERE name=$1 AND ${REACHABLE} LIMIT 2`, [ref])).rows;
      id = byName.length === 1 ? byName[0].id : null;
    }
    if (id && id !== senderId) ids.add(id);
  }
  return [...ids];
}
