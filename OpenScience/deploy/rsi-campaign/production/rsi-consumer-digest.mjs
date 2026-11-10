/**
 * The frontier-selection consumer's dependency digest as this release serves it: the serving adapters' own `currentTarget`, the value a bundle's target is compared with at import.
 * Read-only, run inside the serving web container with the release's own code. It touches no database: the client it hands the adapters answers the incumbent read with no row, and
 * the incumbent is not what is asked for.
 *
 *   docker exec -i web-open-science-web-1 node --input-type=module - < rsi-consumer-digest.mjs
 */
const APP = process.env.RSI_EXPORT_APP_ROOT ?? "/app";
const load = (/** @type {string} */ path) => import(`file://${APP}/${path}`);
const { loadConfig } = await load("apps/server/src/config.mjs");
const { createRsiServingAdapters } = await load("apps/server/src/rsiServingAdapters.mjs");
const adapters = createRsiServingAdapters({ config: { ...loadConfig(), rootDir: APP }, service: { owner: async () => "" }, database: {}, documents: {} });
const target = await adapters.currentTarget("frontier-selection", { query: async () => ({ rows: [] }) });
if (!target.qualified) { console.error((target.issues ?? []).join(",") || "campaign_closure_unqualified"); process.exit(1); }
console.log(target.dependencyDigest);
