/** Real HTTP application and isolated PostgreSQL for browser acceptance; no provider calls. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../../..");
const serverRoot = path.join(root, "OpenScience/apps/server");
const { createWebApiApp } = await import(pathToFileURL(path.join(serverRoot, "src/server.mjs")));
const { createGeoTestDatabase } = await import(pathToFileURL(path.join(serverRoot, "test/helpers/geoTestDatabase.mjs")));
const { insertSource, insertItem } = await import(pathToFileURL(path.join(serverRoot, "test/helpers/frontierFixtures.mjs")));
const databaseUrl = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
if (!databaseUrl) throw new Error("Set OPEN_SCIENCE_TEST_POSTGRES_URL to a local evimed_test database.");
const isolated = await createGeoTestDatabase(databaseUrl, "frontierbrowser");
const dataDir = await mkdtemp(path.join(tmpdir(), "evimed-frontier-browser-"));
const port = Number(process.env.FRONTIER_ACCEPTANCE_PORT || 5183);
const base = `http://127.0.0.1:${port}`;
const app = createWebApiApp({
  dataDir, port, publicUrl: base, staticDir: path.join(root, "OpenScience/apps/web/dist"),
  runtimeMode: "mock", devAuth: false, authMode: "local", bootstrapUser: "", bootstrapPassword: "",
  stateStore: "postgres", requireSharedStateStore: true, databaseUrl: isolated.url,
  operatorUsers: ["frontier-owner"], operatorMetricsToken: "acceptance-only-metrics",
  frontierEnabled: true, frontierAudience: "all", knowledgePluginUrl: "", knowledgePluginToken: "",
  frontierEmbedder: { configured: false, modelKey: "none@1024", counters: {} },
});
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await app.close().catch(() => {});
  await isolated.drop();
  await rm(dataDir, { recursive: true, force: true });
  process.exit(0);
}
try {
  for (const [id, name] of [["frontier-owner", "Acceptance Author"], ["frontier-reader", "Acceptance Reader"]]) {
    await app.store.createUser(id, "acceptance-only-password", name);
    await app.store.createProject(await app.store.userById(id), "acceptance", "Frontier acceptance");
  }
  await app.listen(port, "127.0.0.1");
  await app.frontierWorker?.close();
  const db = app.store.database;
  await insertSource(db, "nejm");
  const event = await db.query(`INSERT INTO evimed_frontier.events(public_id,title_zh,lane,first_at,last_at,report_count,has_primary)
    VALUES('acceptanceevent01','Acceptance research development','evidence',now(),now(),3,true) RETURNING id`);
  for (let index = 0; index < 45; index += 1) {
    const item = await insertItem(db, { title: `Acceptance reading item ${index + 1}`, selected: true,
      summaryZh: "Browser acceptance content. This is a layout and interaction fixture, not a medical conclusion. ".repeat(5),
      timelineAt: new Date(Date.now() - index * 60_000).toISOString(), visibleAt: new Date().toISOString() });
    if (index < 3) {
      await db.query("UPDATE evimed_frontier.items SET event_id=$1 WHERE id=$2", [event.rows[0].id, item.id]);
      await db.query("INSERT INTO evimed_frontier.event_items(event_id,item_id,role,joined_by) VALUES($1,$2,$3,'operator')", [event.rows[0].id, item.id, index === 0 ? "primary" : "report"]);
    }
  }
  process.stdout.write(JSON.stringify({ base, database: isolated.name, mode: "isolated acceptance", ready: true }) + "\n");
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
} catch (error) {
  process.stderr.write(String(error?.stack ?? "Acceptance startup failed") + "\n");
  await stop();
}
