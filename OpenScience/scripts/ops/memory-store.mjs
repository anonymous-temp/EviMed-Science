/**
 * The research-memory store an operator script writes through, wired to the recall index exactly as the server's is
 * (`server.mjs`: the store enqueues an index job inside each write's own transaction when this deployment has an index
 * a worker applies them to). A script that built the store without its job queue wrote rows the index never heard of:
 * on 2026-10-12 `review-memories.mjs` archived 35 of an account's memories and their index copies stayed — recall
 * re-checks every hit against PostgreSQL, so none came back, but the index no longer matched the record.
 */
import { ResearchMemoryStore } from "../../apps/server/src/researchMemory.mjs";
import { OpenVikingClient } from "../../apps/server/src/openVikingClient.mjs";
import { selectedMemoryIndexProvider } from "../../apps/server/src/memorySubstrate.mjs";
import { ProductJobs } from "../../apps/server/src/productJobs.mjs";

/**
 * @param {Record<string, any>} config the server's configuration (`loadConfig()`)
 * @param {any} database the control-plane database
 * @returns {{ researchMemory: ResearchMemoryStore, openViking: OpenVikingClient, jobs: ProductJobs | null, indexed: boolean }}
 */
export function memoryStoreForOps(config, database) {
  const openViking = new OpenVikingClient(config);
  const indexed = selectedMemoryIndexProvider(config) === "openviking" && Boolean(openViking.configured);
  const jobs = indexed ? new ProductJobs(database) : null;
  return { researchMemory: new ResearchMemoryStore(config, { database, jobs }), openViking, jobs, indexed };
}
