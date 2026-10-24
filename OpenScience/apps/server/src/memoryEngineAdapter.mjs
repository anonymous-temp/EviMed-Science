import { HttpError } from "./security.mjs";

/** Select the account's authoritative personal-memory store. Native failure never substitutes legacy records.
 * @param {any} researchMemory @param {any} nativeMemory @param {string} userId
 * @returns {Promise<{ engine: string, store: any }>} */
export async function memoryEngineStore(researchMemory, nativeMemory, userId) {
  const engine = typeof researchMemory?.memoryEngine === "function" ? await researchMemory.memoryEngine(userId) : "legacy";
  if (engine !== "native") return { engine: "legacy", store: researchMemory };
  if (!nativeMemory?.configured) throw new HttpError(503, "memory_engine_unavailable", "The memory service is unavailable.");
  return { engine, store: nativeMemory };
}
