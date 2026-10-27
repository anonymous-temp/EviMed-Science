/** Account-scoped, read-only OpenList availability. No upstream details leave this boundary.
 * @param {any} connector @param {string} userId
 * @returns {Promise<{state:'ready'|'unconfigured'|'storage_missing'|'permission_denied'|'unavailable'}>}
 */
export async function getOpenListStatus(connector, userId) {
  if (!connector) return { state: "unconfigured" };
  try {
    const storage = await connector.storageStatus();
    if (storage?.storage === "missing") return { state: "storage_missing" };
    if (storage?.storage !== "mounted" || typeof connector.list !== "function" || !userId) return { state: "unavailable" };
    // A sibling account's mount does not establish this account's namespace.
    await connector.list(userId, "/", { page: 1, perPage: 1, timeoutMs: connector.probeTimeoutMs ?? 3000 });
    return { state: "ready" };
  } catch (error) {
    const failure = /** @type {any} */ (error);
    if (failure?.code === "openlist_storage_missing") return { state: "storage_missing" };
    if (["openlist_credential_rejected", "openlist_permission_denied"].includes(failure?.code)
      || [401, 403].includes(failure?.status)
      || failure?.code === "openlist_request_failed" && /HTTP (?:401|403)\./.test(String(failure?.message))) {
      return { state: "permission_denied" };
    }
    return { state: "unavailable" };
  }
}
