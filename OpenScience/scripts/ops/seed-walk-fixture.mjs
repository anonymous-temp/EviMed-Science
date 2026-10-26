#!/usr/bin/env node
/**
 * The data-rich fixture for the UI walk's `fixture` profile (R19 plan §3 S6, audit D §4 S7).
 *
 * The release walk (`ui-walk.mjs`) reads production as the owner's account, and many of that account's pages hold little: a study with
 * nothing finished, a GEO project with no answers, a card with five sources. A chart, a grid, a long table or a heat map that is never
 * drawn in the walk is never measured, and a layout fault in it is found by the owner. This script makes the other half of the gate: a
 * **local control plane** (the real server on a throwaway PostgreSQL, the mock runtime, local sign-in) furnished through its own stores
 * with one synthetic account's worth of everything the walk visits — and the same walk, run against it with
 * `OPEN_SCIENCE_WALK_PROFILE=fixture`, which accepts no coverage gap and fails on any page the fixture should fill and did not.
 *
 * Nothing here is real: the study, the product, the cards, the people and the messages are invented (no client's name, no patient's row,
 * no e-mail address). It never runs against production — it refuses a database that is not on this machine or not named `evimed_test*`.
 *
 *   # 1. a throwaway PostgreSQL (see RULES: your own cluster, never a shared one)
 *   PGBIN=$(cat ~/.cache/evimed-pg/BIN); "$PGBIN/initdb" -D /tmp/walk-pg/data -U "$USER" --auth=trust -E UTF8
 *   "$PGBIN/pg_ctl" -D /tmp/walk-pg/data -o "-p 55657 -c fsync=off -c listen_addresses=127.0.0.1 -c unix_socket_directories=/tmp/walk-pg" -l /tmp/walk-pg/pg.log start
 *   "$PGBIN/psql" -h 127.0.0.1 -p 55657 -d postgres -c "CREATE DATABASE evimed_test_walk"
 *
 *   # 2. the web app built for the hosted /api base, and the control plane that serves it with the fixture
 *   flock -w 3600 /tmp/r19-build.lock sh -c 'cd OpenScience && VITE_OPEN_SCIENCE_API_URL=/api pnpm --filter @ai4s/web exec vite build --outDir /tmp/walk-dist'
 *   node scripts/ops/seed-walk-fixture.mjs --database-url postgresql://$USER@127.0.0.1:55657/evimed_test_walk \
 *     --data-dir /tmp/walk-data --static-dir /tmp/walk-dist --port 48920 --password-file /tmp/walk-password
 *
 *   # 3. the walk, from another shell, on the fixture profile (the script prints this line with the right values)
 *   OPEN_SCIENCE_WALK_BASE_URL=http://127.0.0.1:48920 OPEN_SCIENCE_WALK_USER=walk-fixture OPEN_SCIENCE_WALK_PASSWORD_FILE=/tmp/walk-password \
 *   OPEN_SCIENCE_WALK_PROFILE=fixture OPEN_SCIENCE_PLAYWRIGHT_CORE=apps/server/node_modules/playwright-core \
 *   OPEN_SCIENCE_WALK_CHROMIUM=/usr/bin/google-chrome OPEN_SCIENCE_WALK_OUT=/tmp/walk-out node scripts/ops/ui-walk.mjs
 *
 * `--simulated-wallet` bills research from the simulated wallet (as the owner's deployment does), so the settings page is 额度 rather than 用量.
 *
 * The release gate runs both walks: production's walk on a throwaway account and this one, locally, on the integrated tree.
 *
 * Seeding is idempotent: the account is made once (a second start finds it and seeds nothing), and `--reseed` drops nothing — to start
 * from nothing, drop the database. Each part is a function of its own below so that a part can be read, run or changed alone.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { furnishAccount } from "./walk-fixture/account.mjs";
import { furnishFrontier } from "./walk-fixture/frontier.mjs";
import { furnishGeo } from "./walk-fixture/geo.mjs";
import { furnishKnowledge, parserStandIn } from "./walk-fixture/knowledge.mjs";
import { furnishRuns } from "./walk-fixture/runs.mjs";
import { furnishVcr } from "./walk-fixture/vcr.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const server = (/** @type {string} */ file) => import(path.join(here, "..", "..", "apps", "server", "src", file));

/** The account the walk signs in as. Not an operator, not an owner of anything real. */
export const FIXTURE_USER = "walk-fixture";
/** The operator the frontier feed bills its model calls to (it needs one to run): an account of its own, which nobody signs in as. */
export const FIXTURE_OPERATOR = "walk-operator";

/** @param {string[]} argv */
export function parseArguments(argv) {
  /** @type {Record<string, string | boolean>} */ const given = {};
  for (let index = 0; index < argv.length; index += 1) {
    const word = argv[index];
    if (!word.startsWith("--")) throw new Error(`unexpected argument ${word}`);
    const name = word.slice(2);
    if (name === "reseed" || name === "simulated-wallet") { given[name] = true; continue; }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`--${name} needs a value`);
    given[name] = value;
    index += 1;
  }
  return {
    databaseUrl: String(given["database-url"] ?? process.env.OPEN_SCIENCE_DATABASE_URL ?? ""),
    dataDir: String(given["data-dir"] ?? ""),
    staticDir: String(given["static-dir"] ?? ""),
    port: Number(given.port ?? 48920),
    user: String(given.user ?? FIXTURE_USER),
    passwordFile: String(given["password-file"] ?? ""),
    pidFile: String(given["pid-file"] ?? ""),
    reseed: given.reseed === true,
    simulatedWallet: given["simulated-wallet"] === true,
  };
}

/**
 * A database this script may write to: on this machine, and named like a test database. The walk's fixture is never furnished into
 * anything else.
 * @param {string} url
 */
export function assertThrowawayDatabase(url) {
  const parsed = new URL(url);
  if (!["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)) throw new Error(`refusing ${parsed.hostname}: the fixture is only furnished into a database on this machine`);
  if (!/^\/evimed_test[a-z0-9_]*$/.test(parsed.pathname)) throw new Error(`refusing database ${parsed.pathname.slice(1)}: its name must start with evimed_test`);
}

/** Save only the synthetic engine's bytes, preserving the same fixture across process restarts. */
export async function saveFixtureEngine(engine, file, databaseUrl, user) {
  assertThrowawayDatabase(databaseUrl);
  const identity = createHash("sha256").update(`${databaseUrl}|${user}`).digest("hex");
  const files = [...engine.files].map(([uri, value]) => ({ uri, body: value.content.toString("base64"), tags: value.tags, modTime: value.modTime }));
  await writeFile(file, JSON.stringify({ version: 1, identity, files }), { mode: 0o600 });
}

/** A fixture restart restores its stand-in, never replacing production memory reads with overlay data. */
export async function restoreFixtureEngine(engine, database, file, databaseUrl, user) {
  assertThrowawayDatabase(databaseUrl);
  const identity = createHash("sha256").update(`${databaseUrl}|${user}`).digest("hex");
  let snapshot = null;
  try { snapshot = JSON.parse(await readFile(file, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (snapshot) {
    if (snapshot.version !== 1 || snapshot.identity !== identity || !Array.isArray(snapshot.files)) throw new Error("The engine snapshot belongs to a different fixture or has an invalid format.");
    for (const value of snapshot.files) engine.files.set(value.uri, { content: Buffer.from(value.body, "base64"), tags: value.tags, modTime: value.modTime });
    return snapshot.files.length;
  }
  // Older synthetic fixtures have no snapshot. Their exact preserved native files can seed the stand-in once.
  const rows = (await database.query("SELECT uri,body,memory_type,project_id,updated_at FROM evimed_memory.native_files WHERE user_id=$1 AND body IS NOT NULL", [user])).rows;
  for (const row of rows) engine.files.set(row.uri, { content: Buffer.from(row.body, "utf8"), tags: [`memory_type=${row.memory_type}`, ...(row.project_id ? [`project=${row.project_id}`] : [])], modTime: new Date(row.updated_at).toISOString() });
  if (!rows.length) throw new Error("The existing fixture has no preserved engine files; furnish a fresh throwaway database.");
  await saveFixtureEngine(engine, file, databaseUrl, user);
  return rows.length;
}

/** Restore only the synthetic module session inventory that furnishing originally created. No model prompt is submitted. */
export async function warmFixtureConversations(app, user, fixtureUser = FIXTURE_USER) {
  if (user.id !== fixtureUser) throw new Error("Fixture conversation restoration requires its exact synthetic account.");
  if (app.config.runtimeMode !== "mock") throw new Error("Fixture conversation restoration requires the mock runtime.");
  const rows = (await app.store.database.query("SELECT project_id,conversation_session_id FROM evimed_geo.projects WHERE user_id=$1 AND deleted_at IS NULL", [user.id])).rows;
  // The module's own conversations: the control plane keeps the main one as a pointer document (`geo-native-primary`, with the session
  // document it names), not in the project row, and proves it from that document alone. A restart empties the mock kernel's inventory
  // and not the document, so without them the header's 「对话」 met a session the kernel had never heard of.
  const registered = new Map();
  for (const row of (await app.store.database.query(
    "SELECT project_id,payload->>'sessionId' AS session_id FROM evimed_product.documents WHERE user_id=$1 AND kind='geo-plan-context' AND deleted_at IS NULL AND payload->>'recordType' IN ('geo-native-primary','geo-native-session')",
    [user.id])).rows) {
    if (typeof row.session_id !== "string" || !row.session_id) continue;
    registered.set(row.project_id, [...(registered.get(row.project_id) ?? []), row.session_id]);
  }
  let restored = 0;
  for (const row of rows) {
    const project = await app.store.requireProject(user, row.project_id);
    if (project.userId !== fixtureUser || project.id !== row.project_id) throw new Error("Fixture conversation project identity changed.");
    const runs = await app.agentRuns.list(project);
    const sessions = [...new Set([row.conversation_session_id, ...(registered.get(row.project_id) ?? []), ...runs.map(run => run.sessionId)].filter(value => typeof value === "string" && value))];
    // The runtime is up whether or not a session is registered yet: a project with none opens its main conversation through the server,
    // which looks for the project's runtime in the manager's table, and the walk refuses the browser's own `start_runtime`.
    const runtime = await app.runtimeManager.start(project);
    if (runtime.kind !== "mock") throw new Error("Fixture restoration cannot alter a real runtime.");
    // The mock has no provider token. Give this one process epoch the named synthetic generation
    // seam native-routing tests use, so real generation and inventory checks remain exercised.
    runtime.modelGatewayTokenJti ??= `walk-fixture-generation-${randomBytes(18).toString("hex")}`;
    for (const sessionId of sessions) {
      await app.runtimeManager.callKernel(runtime, project, "session/create", { request: {
        sessionId, cwd: runtime.proxyWorkspaceDir ?? project.workspaceDir, title: "Synthetic restored module conversation", agentPreset: "evimed-universal",
      } }, AbortSignal.timeout(10000));
      restored += 1;
    }
  }
  return restored;
}

/** @param {string} line */
const log = (line) => process.stderr.write(`${new Date().toISOString()} walk-fixture ${line}\n`);

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!options.databaseUrl || !options.dataDir || !options.passwordFile) {
    process.stderr.write("usage: seed-walk-fixture.mjs --database-url <url> --data-dir <dir> --password-file <file> [--static-dir <dir>] [--port <n>] [--user <name>] [--pid-file <file>] [--simulated-wallet]\n");
    process.exit(2);
  }
  assertThrowawayDatabase(options.databaseUrl);
  await mkdir(options.dataDir, { recursive: true });
  const password = await passwordOf(options.passwordFile);

  const { createWebApiApp } = await server("server.mjs");
  // The engine the knowledge base compiles with is OpenViking's stand-in from the page contract's tests: it holds the files in memory and
  // writes what `compile` says a compile wrote (set by the knowledge part of the fixture); nothing here reaches a network.
  const { createOpenVikingStub } = await import(pathToFileURL(path.join(here, "..", "..", "apps", "server", "test", "helpers", "openVikingResourcesStub.mjs")).href);
  const { OpenVikingClient } = await server("openVikingClient.mjs");
  /** @type {(request: any, stub: any) => void} */
  let compile = () => {};
  const engine = createOpenVikingStub({ compile: (/** @type {any} */ request, /** @type {any} */ stub) => compile(request, stub) });
  const client = new OpenVikingClient({ openVikingUrl: "http://openviking.test", openVikingApiKey: "stub-key", openVikingAccount: "evimed", openVikingRequestTimeoutMs: 5000 },
    { fetchImpl: /** @type {any} */ (engine.fetch) });
  const app = createWebApiApp({
    dataDir: options.dataDir, stateStore: "postgres", databaseUrl: options.databaseUrl, runtimeMode: "mock", authMode: "local", devAuth: false,
    bootstrapUser: "", bootstrapPassword: "", staticDir: options.staticDir, port: options.port, host: "127.0.0.1",
    frontierEnabled: true, geoEnabled: true, geoAudience: "all", vcrEnabled: true, vcrAudience: "all", autopilotEnabled: true, memoryMapEnabled: true,
    // Today's issue is due from midnight: at the default 07:30 a fixture started between midnight and 07:30 in Beijing wrote yesterday's issue
    // and the walk, which opens today's, found the 日报 empty (r19-guards3: the first walk after 16:00 UTC).
    frontierDailyTime: "00:00",
    // The module's own state: the data plane the generated patients are written into, and a worker that does not tick (no engine is here to
    // run a job, and the studies are furnished in the states the walk reads them in).
    vcrDataPlaneDir: path.join(options.dataDir, "vcr-plane"), vcrPollMs: 3_600_000,
    operatorUsers: [FIXTURE_OPERATOR],
    // The knowledge base: documents read by the platform's worker (a PDF through the parser's stand-in), pages and a graph compiled by the engine's.
    sourceIngestionEnabled: true, sourceIngestionPollMs: 200, sourceIngestionLeaseMs: 5_000, documentParserUrl: "http://parser.test", documentParserToken: "sk-walk-fixture",
    documentParserFetch: parserStandIn, sourceMetadataFetch: async () => new Response("{}", { status: 404 }),
    memoryIndexProvider: "builtin", ovKnowledgeEnabled: true, openVikingClient: client, memoryEngineEnabled: true, knowledgePagesDebounceMs: 0, knowledgePagesMinSources: 2, knowledgePagesPollMs: 200,
    kbSearchEnabled: false,
    // The kernel's window, as production has it (the shell places its frame over a conversation's pane: 定时任务's task page). The origin
    // answers nothing — port 9, nothing listens — so a frame is minted and placed and never loads: no walk starts a runtime anyway.
    runtimeUiProxyEnabled: true, runtimeUiPublicOrigin: "http://127.0.0.1:9",
    // With `--simulated-wallet` the deployment bills research from the control plane's simulated wallet (no money moves), as production does: the
    // settings page is then 额度 (the allowance, its lots, the statements) and not 用量.
    ...(options.simulatedWallet ? { evimedCreditsEnabled: true, evimedCreditsSimulated: true, evimedCreditsPerCny: 1, evimedCreditsSimulatedStartCredits: 60, researchBillingEnabled: true } : {}),
    // The key the account's own data-source credentials are sealed under (random, kept nowhere): without it 设置 → 数据源 answers 503.
    modelGatewaySigningSecret: randomBytes(36).toString("base64url"),
  });
  const address = await app.listen(options.port, "127.0.0.1");
  log(`listening on http://127.0.0.1:${typeof address === "object" && address ? address.port : options.port}`);
  if (options.pidFile) await writeFile(options.pidFile, `${process.pid}\n`);

  const existing = await app.store.userById(options.user).catch(() => null);
  if (!existing || options.reseed) {
    if (!existing) await app.store.createUser(options.user, password, "walk fixture");
    if (!(await app.store.userById(FIXTURE_OPERATOR).catch(() => null))) await app.store.createUser(FIXTURE_OPERATOR, randomBytes(24).toString("base64url"), "walk operator");
    const user = await app.store.userById(options.user);
    await furnish(app, user, { password, base: `http://127.0.0.1:${options.port}`, engine, setCompile: (/** @type {any} */ script) => { compile = script; } });
    await saveFixtureEngine(engine, path.join(options.dataDir, "walk-engine-snapshot.json"), options.databaseUrl, options.user);
    // The module's own conversations are opened in the mock kernel the same as after a restart: a first start that skipped it answered the
    // header's 「对话」 with 「服务暂时不可用」 (the native session inventory is empty until a runtime holds the sessions), and only the
    // second start of the same fixture walked clean.
    const conversations = await warmFixtureConversations(app, await app.store.userById(options.user), options.user);
    log(`the fixture is furnished; ${conversations} mock module conversations opened`);
  } else {
    const restored = await restoreFixtureEngine(engine, app.store.database, path.join(options.dataDir, "walk-engine-snapshot.json"), options.databaseUrl, options.user);
    const conversations = await warmFixtureConversations(app, await app.store.userById(options.user), options.user);
    log(`the account exists: restored ${restored} synthetic engine files and ${conversations} mock module conversations; no database data was furnished again`);
  }

  process.stdout.write(
    `OPEN_SCIENCE_WALK_BASE_URL=http://127.0.0.1:${options.port} OPEN_SCIENCE_WALK_USER=${options.user} OPEN_SCIENCE_WALK_PASSWORD_FILE=${options.passwordFile} `
    + "OPEN_SCIENCE_WALK_PROFILE=fixture node scripts/ops/ui-walk.mjs\n",
  );
  const stop = async () => { setTimeout(() => process.exit(0), 8_000).unref(); try { await app.close(); } finally { process.exit(0); } };
  process.on("SIGTERM", () => void stop());
  process.on("SIGINT", () => void stop());
}

/**
 * The password: the file's, or a random one written to it (mode 600) the first time. Never printed.
 * @param {string} file
 */
async function passwordOf(file) {
  try {
    return (await readFile(file, "utf8")).trim();
  } catch {
    const made = randomBytes(18).toString("base64url");
    await writeFile(file, `${made}\n`, { mode: 0o600 });
    return made;
  }
}

/**
 * Everything the walk visits, furnished through the app's own stores.
 * @param {any} app @param {any} user
 * @param {{ password: string, base: string, engine: any, setCompile: (script: (request: any, stub: any) => void) => void }} context
 */
async function furnish(app, user, { password, base, engine, setCompile }) {
  const context = { log, engine };
  const studies = await furnishVcr(app, user, context);
  await writeFile(path.join(app.config.vcrDataPlaneDir, "walk-calculation-fixture.json"), `${JSON.stringify(studies.calculation, null, 2)}\n`, { mode: 0o600 });
  const geo = await furnishGeo(app, user, context);
  await furnishFrontier(app, user, context);
  await furnishAccount(app, user, { geoProjectId: geo.projectId, studies, projects: { geo: geo.controlProjectId, finished: studies.projects.finished, mixed: studies.projects.mixed } }, context);
  await furnishKnowledge(app, user, password, { engine, setCompile, base, log });
  await furnishRuns(app, user, context);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => { process.stderr.write(`${error?.stack ?? error}\n`); process.exit(1); });
}
