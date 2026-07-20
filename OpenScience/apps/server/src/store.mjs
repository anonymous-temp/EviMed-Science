import path from "node:path";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { ControlPlaneDatabase, CONTROL_PLANE_SCHEMA } from "./controlPlaneDatabase.mjs";
import {
  assertNoSymlinkPath,
  HttpError,
  ensureDir,
  hashPassword,
  parseCookies,
  randomId,
  safeId,
  setSessionCookie,
  shouldUseSecureCookies,
  verifyPassword,
  writeJsonFileAtomicNoFollow,
} from "./security.mjs";

const stateWriteQueues = new Map();

function serializeStateWrite(file, operation) {
  const key = path.resolve(file);
  const previous = stateWriteQueues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  stateWriteQueues.set(key, current);
  return current.finally(() => {
    if (stateWriteQueues.get(key) === current) stateWriteQueues.delete(key);
  });
}

function sessionKey(sessionId) {
  return createHash("sha256").update(String(sessionId)).digest("hex");
}

function sessionTtlMs(config) {
  const ttl = Math.floor(Number(config.sessionTtlMs));
  if (!Number.isFinite(ttl) || ttl <= 0) {
    throw new HttpError(503, "session_ttl_invalid", "Session TTL must be a positive number of milliseconds.");
  }
  return ttl;
}

function usersRoot(config) {
  return path.join(config.dataDir, "users");
}

async function ensureScopedDir(rootDir, targetDir) {
  await assertNoSymlinkPath(rootDir, targetDir, { allowMissingTail: true });
  await ensureDir(targetDir);
  await assertNoSymlinkPath(rootDir, targetDir);
}

async function ensureUserRoot(config, userRoot) {
  const root = usersRoot(config);
  await ensureScopedDir(config.dataDir, root);
  await ensureScopedDir(root, userRoot);
}

async function ensureProjectsRoot(config, user) {
  await ensureUserRoot(config, user.rootDir);
  const root = path.join(user.rootDir, "projects");
  await ensureScopedDir(user.rootDir, root);
  return root;
}

async function ensureProjectTree(config, project) {
  const userRoot = project.userRoot ?? path.dirname(path.dirname(project.rootDir));
  const projectsRoot = await ensureProjectsRoot(config, { rootDir: userRoot });
  await ensureScopedDir(projectsRoot, project.rootDir);
  await ensureScopedDir(project.rootDir, project.baseDir);
  await ensureScopedDir(project.rootDir, project.runtimeDir);
  await ensureScopedDir(project.rootDir, project.metaDir);
  await assertNoSymlinkPath(project.rootDir, path.join(project.rootDir, "project.json"), { allowMissingTail: true });
  await ensureScopedDir(project.baseDir, project.workspaceDir);
}

async function writeProjectJson(projectRoot, file, value) {
  await writeJsonFileAtomicNoFollow(projectRoot, file, value);
  await assertNoSymlinkPath(projectRoot, file);
}

function isWithin(rootDir, targetPath) {
  const root = path.resolve(rootDir);
  const target = path.resolve(targetPath);
  return target === root || target.startsWith(root + path.sep);
}

function stateRootFor(config, file) {
  return isWithin(config.dataDir, file) ? config.dataDir : path.dirname(file);
}

async function ensureStateParent(config, file) {
  const root = stateRootFor(config, file);
  const dir = path.dirname(file);
  if (path.resolve(root) !== path.resolve(dir)) {
    await ensureScopedDir(root, dir);
    return root;
  }
  await ensureDir(dir);
  return root;
}

async function assertStateFile(config, file, { allowMissingTail = true } = {}) {
  await assertNoSymlinkPath(stateRootFor(config, file), file, { allowMissingTail });
}

async function readJsonState(config, file, fallback) {
  await ensureStateParent(config, file);
  await assertStateFile(config, file, { allowMissingTail: true });
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (err) {
    if (err?.code === "ENOENT") return fallback;
    throw err;
  }
}

async function writeJsonState(config, file, value) {
  return serializeStateWrite(file, async () => {
    const root = await ensureStateParent(config, file);
    await assertStateFile(config, file, { allowMissingTail: true });
    await writeJsonFileAtomicNoFollow(root, file, value);
    await assertStateFile(config, file, { allowMissingTail: false });
  });
}

export class InMemoryStore {
  constructor(config) {
    this.config = config;
    this.sessions = new Map();
    this.users = new Map();
    this.projects = new Map();
    this.deletedUsers = new Set();
    this.usersLoaded = false;
    this.sessionsLoaded = false;
  }

  async ensureUser(req, res) {
    const { user } = await this.ensureSessionUser(req, res);
    return user;
  }

  async ensureSessionUser(req, res) {
    await this.loadSessions();
    const cookies = parseCookies(req.headers.cookie ?? "");
    const sessionId = cookies.get(this.config.sessionCookieName);
    const key = sessionId ? sessionKey(sessionId) : null;
    if (key && this.sessions.has(key)) {
      const session = this.sessions.get(key);
      if (session.expiresAt > Date.now()) {
        const user = await this.userById(session.userId);
        if (user) return { user, session };
      }
      this.sessions.delete(key);
      await this.saveSessions();
    }
    if (!this.config.devAuth) {
      throw new HttpError(401, "unauthorized", "Authentication required.");
    }
    if (this.config.production) {
      throw new HttpError(503, "dev_auth_enabled", "Development authentication is disabled in production mode.");
    }
    const user = await this.devUser();
    const session = await this.createSession(user, req, res);
    return { user, session };
  }

  async login(username, password, req, res) {
    await this.loadUsers();
    const id = safeId(username, "username");
    const user = await this.userById(id);
    if (!user || !verifyPassword(password, user.passwordHash)) {
      throw new HttpError(401, "invalid_credentials", "Invalid username or password.");
    }
    const session = await this.createSession(user, req, res);
    return { user: this.publicUser(user), csrfToken: session.csrfToken };
  }

  async logout(req) {
    await this.loadSessions();
    const cookies = parseCookies(req.headers.cookie ?? "");
    const sessionId = cookies.get(this.config.sessionCookieName);
    if (sessionId) {
      this.sessions.delete(sessionKey(sessionId));
      await this.saveSessions();
    }
  }

  async createSession(user, req, res) {
    await this.loadSessions();
    const newSession = randomId("sess_");
    const ttlMs = sessionTtlMs(this.config);
    const session = {
      userId: user.id,
      csrfToken: randomId("csrf_"),
      createdAt: Date.now(),
      expiresAt: Date.now() + ttlMs,
    };
    this.sessions.set(sessionKey(newSession), session);
    await this.saveSessions();
    setSessionCookie(
      res,
      this.config.sessionCookieName,
      newSession,
      shouldUseSecureCookies(req, this.config),
      Math.max(1, Math.floor(ttlMs / 1000)),
    );
    return session;
  }

  async assertCsrf(req, pathname) {
    if (this.config.devAuth) return;
    const method = (req.method ?? "GET").toUpperCase();
    if (["GET", "HEAD", "OPTIONS"].includes(method)) return;
    if (pathname === "/api/auth/login" || pathname === "/api/auth/dev-login") return;

    await this.loadSessions();
    const cookies = parseCookies(req.headers.cookie ?? "");
    const sessionId = cookies.get(this.config.sessionCookieName);
    const key = sessionId ? sessionKey(sessionId) : null;
    const session = key ? this.sessions.get(key) : null;
    if (!session || session.expiresAt <= Date.now()) {
      if (key) {
        this.sessions.delete(key);
        await this.saveSessions();
      }
      throw new HttpError(401, "unauthorized", "Authentication required.");
    }

    const header = req.headers["x-open-science-csrf"];
    const token = Array.isArray(header) ? header[0] : header;
    if (typeof token !== "string" || token !== session.csrfToken) {
      throw new HttpError(403, "csrf_required", "A valid CSRF token is required.");
    }
  }

  async loadSessions() {
    if (this.sessionsLoaded) return;
    const records = (await readJsonState(this.config, this.config.sessionsFile, { sessions: [] })).sessions ?? [];
    const now = Date.now();
    let pruned = false;
    for (const record of records) {
      if (!record || typeof record !== "object") continue;
      if (typeof record.idHash !== "string" || !/^[a-f0-9]{64}$/.test(record.idHash)) continue;
      if (typeof record.userId !== "string") continue;
      if (typeof record.csrfToken !== "string") continue;
      if (!Number.isFinite(record.createdAt) || !Number.isFinite(record.expiresAt)) continue;
      if (record.expiresAt <= now) {
        pruned = true;
        continue;
      }
      this.sessions.set(record.idHash, {
        userId: record.userId,
        csrfToken: record.csrfToken,
        createdAt: record.createdAt,
        expiresAt: record.expiresAt,
      });
    }
    if (pruned) await this.saveSessions();
    this.sessionsLoaded = true;
  }

  async saveSessions() {
    const now = Date.now();
    const sessions = [];
    for (const [idHash, session] of this.sessions) {
      if (session.expiresAt <= now) {
        this.sessions.delete(idHash);
        continue;
      }
      sessions.push({
        idHash,
        userId: session.userId,
        csrfToken: session.csrfToken,
        createdAt: session.createdAt,
        expiresAt: session.expiresAt,
      });
    }
    sessions.sort((a, b) => b.createdAt - a.createdAt);
    await writeJsonState(this.config, this.config.sessionsFile, { version: 1, sessions });
  }

  publicUser(user) {
    return { id: user.id, name: user.name, tenantId: user.tenantId ?? user.id };
  }

  verifyUserPassword(user, password) {
    if (!user.passwordHash) return true;
    return typeof password === "string" && verifyPassword(password, user.passwordHash);
  }

  async devUser() {
    const id = "dev";
    const userRoot = path.join(this.config.dataDir, "users", id);
    await ensureUserRoot(this.config, userRoot);
    if (this.users.has(id)) return this.users.get(id);
    const user = {
      id,
      tenantId: id,
      name: "Development User",
      rootDir: userRoot,
      passwordHash: null,
      authType: "development",
    };
    this.users.set(id, user);
    return user;
  }

  async loadUsers() {
    if (this.usersLoaded) return;
    const state = await readJsonState(this.config, this.config.usersFile, { users: [], deletedUsers: [] });
    const records = state.users ?? [];
    this.deletedUsers.clear();
    for (const deleted of Array.isArray(state.deletedUsers) ? state.deletedUsers : []) {
      try {
        this.deletedUsers.add(safeId(deleted, "user id"));
      } catch {
        // Ignore invalid tombstones rather than making login impossible.
      }
    }
    for (const record of records) {
      const id = safeId(record.id, "username");
      const authType = record.authType === "oidc" ? "oidc" : "local";
      this.users.set(id, {
        id,
        tenantId: id,
        name: typeof record.name === "string" ? record.name : id,
        passwordHash: authType === "local" ? record.passwordHash : null,
        authType,
        rootDir: path.join(this.config.dataDir, "users", id),
      });
    }
    const bootstrapId = this.config.bootstrapUser ? safeId(this.config.bootstrapUser, "username") : "";
    if (
      this.users.size === 0 &&
      bootstrapId &&
      this.config.bootstrapPassword &&
      !this.deletedUsers.has(bootstrapId)
    ) {
      await this.createUser(this.config.bootstrapUser, this.config.bootstrapPassword, this.config.bootstrapUser);
    }
    this.usersLoaded = true;
  }

  async saveUsers() {
    const users = [...this.users.values()]
      .filter((user) => user.passwordHash || user.authType === "oidc")
      .map((user) => ({
        id: user.id,
        name: user.name,
        authType: user.authType === "oidc" ? "oidc" : "local",
        ...(user.passwordHash ? { passwordHash: user.passwordHash } : {}),
      }));
    await writeJsonState(this.config, this.config.usersFile, {
      version: 1,
      users,
      deletedUsers: [...this.deletedUsers].sort(),
    });
  }

  async createUser(username, password, name = username) {
    const id = safeId(username, "username");
    if (typeof password !== "string" || password.length < 8) {
      throw new HttpError(400, "weak_password", "Password must be at least 8 characters.");
    }
    if (this.users.has(id)) throw new HttpError(409, "user_exists", "User already exists.");
    this.deletedUsers.delete(id);
    const userRoot = path.join(this.config.dataDir, "users", id);
    await ensureUserRoot(this.config, userRoot);
    const user = {
      id,
      tenantId: id,
      name: typeof name === "string" && name.trim() ? name.trim() : id,
      passwordHash: hashPassword(password),
      authType: "local",
      rootDir: userRoot,
    };
    this.users.set(id, user);
    await this.saveUsers();
    return this.publicUser(user);
  }

  async upsertOidcUser(userId, name) {
    const id = safeId(userId, "OIDC user id");
    await this.loadUsers();
    const existing = this.users.get(id);
    if (existing && existing.authType !== "oidc") {
      throw new HttpError(409, "identity_collision", "External identity conflicts with an existing account.");
    }
    const displayName = typeof name === "string" && name.trim() ? name.trim().slice(0, 128) : "EviMed User";
    const userRoot = path.join(this.config.dataDir, "users", id);
    await ensureUserRoot(this.config, userRoot);
    const user = existing ?? {
      id,
      tenantId: id,
      name: displayName,
      passwordHash: null,
      authType: "oidc",
      rootDir: userRoot,
    };
    const changed = !existing || user.name !== displayName || this.deletedUsers.has(id);
    user.name = displayName;
    this.deletedUsers.delete(id);
    this.users.set(id, user);
    if (changed) await this.saveUsers();
    return user;
  }

  async userById(id) {
    await this.loadUsers();
    const user = this.users.get(id);
    if (!user) return null;
    await ensureUserRoot(this.config, user.rootDir);
    return user;
  }

  async selectedProject(req, user) {
    const url = new URL(req.url ?? "/", "http://open-science.local");
    const headerProject = req.headers["x-open-science-project"];
    const projectId = Array.isArray(headerProject)
      ? headerProject[0]
      : headerProject || url.searchParams.get("projectId") || "default";
    return this.requireProject(user, projectId);
  }

  async listProjects(user) {
    const root = await ensureProjectsRoot(this.config, user);
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    const projects = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const project = await this.projectFor(user, entry.name);
      projects.push({ id: project.id, name: project.name });
    }
    if (!projects.some((project) => project.id === "default")) {
      const project = await this.defaultProject(user);
      projects.push({ id: project.id, name: project.name });
    }
    projects.sort((a, b) => a.name.localeCompare(b.name));
    return projects;
  }

  async listStoredProjects() {
    const root = usersRoot(this.config);
    await assertNoSymlinkPath(this.config.dataDir, root, { allowMissingTail: true });
    const users = await fs.readdir(root, { withFileTypes: true }).catch((err) => {
      if (err?.code === "ENOENT") return [];
      throw err;
    });
    const projects = [];
    for (const userEntry of users) {
      if (userEntry.isSymbolicLink()) {
        throw new HttpError(403, "path_forbidden", "user roots must not be symbolic links.");
      }
      if (!userEntry.isDirectory()) continue;
      let userId;
      try {
        userId = safeId(userEntry.name, "user id");
      } catch {
        continue;
      }
      const userRoot = path.join(root, userId);
      await assertNoSymlinkPath(root, userRoot);
      const projectsRoot = path.join(userRoot, "projects");
      await assertNoSymlinkPath(userRoot, projectsRoot, { allowMissingTail: true });
      const projectEntries = await fs.readdir(projectsRoot, { withFileTypes: true }).catch((err) => {
        if (err?.code === "ENOENT") return [];
        throw err;
      });
      const user = { id: userId, tenantId: userId, name: userId, rootDir: userRoot };
      for (const projectEntry of projectEntries) {
        if (projectEntry.isSymbolicLink()) {
          throw new HttpError(403, "path_forbidden", "project roots must not be symbolic links.");
        }
        if (!projectEntry.isDirectory()) continue;
        try {
          projects.push(await this.projectFor(user, projectEntry.name));
        } catch (err) {
          if (err instanceof HttpError && err.status === 400) continue;
          throw err;
        }
      }
    }
    return projects;
  }

  async createProject(user, id, name = id) {
    const project = await this.projectFor(user, id, name);
    return { id: project.id, name: project.name };
  }

  async deleteProject(user, projectId) {
    const id = safeId(projectId, "project id");
    if (id === "default") {
      throw new HttpError(400, "default_project_protected", "The default project cannot be deleted.");
    }
    const projectsRoot = await ensureProjectsRoot(this.config, user);
    const projectRoot = path.join(projectsRoot, id);
    await assertNoSymlinkPath(projectsRoot, projectRoot, {
      missingCode: "project_not_found",
      missingMessage: "Project not found.",
    });
    const stat = await fs.lstat(projectRoot).catch((err) => {
      if (err?.code === "ENOENT") return null;
      throw err;
    });
    if (!stat?.isDirectory()) {
      throw new HttpError(404, "project_not_found", "Project not found.");
    }
    await fs.rm(projectRoot, { recursive: true, force: true });
    this.projects.delete(`${user.id}:${id}`);
    return { id };
  }

  async deleteUser(user) {
    const id = safeId(user.id, "user id");
    await this.loadUsers();
    await this.loadSessions();
    const root = usersRoot(this.config);
    const userRoot = path.join(root, id);
    await assertNoSymlinkPath(root, userRoot, {
      missingCode: "user_not_found",
      missingMessage: "User not found.",
    });
    const stat = await fs.lstat(userRoot).catch((err) => {
      if (err?.code === "ENOENT") return null;
      throw err;
    });
    if (!stat?.isDirectory()) {
      throw new HttpError(404, "user_not_found", "User not found.");
    }

    await fs.rm(userRoot, { recursive: true, force: true });
    for (const key of [...this.projects.keys()]) {
      if (key.startsWith(`${id}:`)) this.projects.delete(key);
    }
    for (const [sessionId, session] of [...this.sessions.entries()]) {
      if (session.userId === id) this.sessions.delete(sessionId);
    }
    this.deletedUsers.add(id);
    this.users.delete(id);
    await Promise.all([this.saveSessions(), this.saveUsers()]);
    return { id };
  }

  async defaultProject(user) {
    return this.projectFor(user, "default", "Default Project");
  }

  async requireProject(user, projectId = "default") {
    const id = safeId(projectId, "project id");
    if (id === "default") return this.defaultProject(user);
    const projectsRoot = await ensureProjectsRoot(this.config, user);
    const projectRoot = path.join(projectsRoot, id);
    await assertNoSymlinkPath(projectsRoot, projectRoot, {
      missingCode: "project_not_found",
      missingMessage: "Project not found.",
    });
    const stat = await fs.stat(projectRoot).catch((err) => {
      if (err?.code === "ENOENT") return null;
      throw err;
    });
    if (!stat?.isDirectory()) {
      throw new HttpError(404, "project_not_found", "Project not found.");
    }
    return this.projectFor(user, id);
  }

  async projectFor(user, projectId = "default", name = projectId) {
    const id = safeId(projectId, "project id");
    const key = `${user.id}:${id}`;
    if (this.projects.has(key)) {
      const cached = this.projects.get(key);
      await ensureProjectTree(this.config, cached);
      return cached;
    }
    const projectsRoot = await ensureProjectsRoot(this.config, user);
    const projectRoot = path.join(projectsRoot, id);
    const workspaceRoot = path.join(projectRoot, "workspace");
    const runtimeDir = path.join(projectRoot, "runtime");
    const metaDir = path.join(projectRoot, ".openscience");
    await ensureScopedDir(projectsRoot, projectRoot);
    await ensureScopedDir(projectRoot, workspaceRoot);
    await ensureScopedDir(projectRoot, runtimeDir);
    await ensureScopedDir(projectRoot, metaDir);
    const metaFile = path.join(projectRoot, "project.json");
    await assertNoSymlinkPath(projectRoot, metaFile, { allowMissingTail: true });
    let displayName = name;
    let activeWorkspace = "";
    try {
      const meta = JSON.parse(await fs.readFile(metaFile, "utf8"));
      if (typeof meta.name === "string" && meta.name.trim()) displayName = meta.name.trim();
      if (this.isWorkspaceName(meta.activeWorkspace)) activeWorkspace = meta.activeWorkspace;
    } catch (err) {
      if (err?.code !== "ENOENT") throw err;
      await writeProjectJson(projectRoot, metaFile, { id, name: displayName });
    }
    const workspaceDir = activeWorkspace ? path.join(workspaceRoot, activeWorkspace) : workspaceRoot;
    await ensureScopedDir(workspaceRoot, workspaceDir);
    const project = {
      id,
      name: displayName,
      tenantId: user.tenantId ?? user.id,
      userId: user.id,
      userRoot: user.rootDir,
      rootDir: projectRoot,
      workspaceDir,
      baseDir: workspaceRoot,
      runtimeDir,
      metaDir,
      activeWorkspace,
    };
    this.projects.set(key, project);
    return project;
  }

  isWorkspaceName(name) {
    return typeof name === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_. -]{0,127}$/.test(name);
  }

  async setProjectWorkspace(project, name) {
    await ensureProjectTree(this.config, project);
    const activeWorkspace = name || "";
    if (activeWorkspace && !this.isWorkspaceName(activeWorkspace)) {
      throw new HttpError(400, "invalid_workspace", "workspace name contains unsupported characters.");
    }
    const workspaceDir = activeWorkspace ? path.join(project.baseDir, activeWorkspace) : project.baseDir;
    await ensureScopedDir(project.baseDir, workspaceDir);
    project.workspaceDir = workspaceDir;
    project.activeWorkspace = activeWorkspace;
    const metaFile = path.join(project.rootDir, "project.json");
    await writeProjectJson(project.rootDir, metaFile, { id: project.id, name: project.name, activeWorkspace });
    return project;
  }

  async readiness() {
    return { mode: "file", shared: false };
  }

  async loginUserCount() {
    await this.loadUsers();
    return [...this.users.values()].filter((user) => user.passwordHash).length;
  }

  async close() {}
}

function databaseUser(config, row) {
  if (!row) return null;
  return {
    id: row.id,
    tenantId: row.id,
    name: row.name,
    passwordHash: row.password_hash,
    authType: row.auth_type,
    rootDir: path.join(config.dataDir, "users", row.id),
  };
}

function databaseSession(row) {
  if (!row) return null;
  return {
    userId: row.user_id,
    csrfToken: row.csrf_token,
    createdAt: new Date(row.created_at).getTime(),
    expiresAt: new Date(row.expires_at).getTime(),
  };
}

function databaseResearchSession(row) {
  if (!row) return null;
  return Object.freeze({
    sessionId: row.session_id,
    mode: row.mode,
    agentId: row.agent_id,
    agentVersion: row.agent_version,
    runtimeAgent: row.runtime_agent,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  });
}

function databaseConflict(error, code, message) {
  if (error?.code === "23505") return new HttpError(409, code, message);
  return error;
}

async function lockUserIdentity(client, userId) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`evimed-user:${userId}`]);
}

export class PostgresStore extends InMemoryStore {
  constructor(config, options = {}) {
    super(config);
    this.database = new ControlPlaneDatabase(config, { pool: options.databasePool });
    this.stateStoreKind = "postgres";
  }

  async readiness() {
    const health = await this.database.health();
    if (health.schemaVersion !== 1) {
      throw new HttpError(503, "database_schema_mismatch", "The control-plane database schema is not current.");
    }
    return { mode: "postgres", shared: true, schemaVersion: health.schemaVersion };
  }

  async loadUsers() {
    await this.database.migrate();
    let result = await this.database.query(
      `SELECT id, name, password_hash, auth_type FROM ${CONTROL_PLANE_SCHEMA}.users ORDER BY id`,
    );
    const bootstrapId = this.config.bootstrapUser ? safeId(this.config.bootstrapUser, "username") : "";
    if (result.rowCount === 0 && bootstrapId && this.config.bootstrapPassword) {
      await this.database.transaction(async (client) => {
        await lockUserIdentity(client, bootstrapId);
        await client.query(
          `INSERT INTO ${CONTROL_PLANE_SCHEMA}.users(id, name, password_hash, auth_type)
           SELECT $1, $2, $3, 'local'
            WHERE NOT EXISTS (SELECT 1 FROM ${CONTROL_PLANE_SCHEMA}.deleted_users WHERE id = $1)
           ON CONFLICT (id) DO NOTHING`,
          [bootstrapId, this.config.bootstrapUser, hashPassword(this.config.bootstrapPassword)],
        );
      });
      result = await this.database.query(
        `SELECT id, name, password_hash, auth_type FROM ${CONTROL_PLANE_SCHEMA}.users ORDER BY id`,
      );
    }
    this.users.clear();
    for (const row of result.rows) this.users.set(row.id, databaseUser(this.config, row));
    this.usersLoaded = true;
  }

  async saveUsers() {}

  async loadSessions() {
    await this.database.migrate();
    await this.database.query(`DELETE FROM ${CONTROL_PLANE_SCHEMA}.auth_sessions WHERE expires_at <= now()`);
    this.sessionsLoaded = true;
  }

  async saveSessions() {}

  async ensureSessionUser(req, res) {
    const cookies = parseCookies(req.headers.cookie ?? "");
    const sessionId = cookies.get(this.config.sessionCookieName);
    const key = sessionId ? sessionKey(sessionId) : null;
    if (key) {
      const result = await this.database.query(
        `SELECT s.user_id, s.csrf_token, s.created_at, s.expires_at,
                u.id, u.name, u.password_hash, u.auth_type
           FROM ${CONTROL_PLANE_SCHEMA}.auth_sessions s
           JOIN ${CONTROL_PLANE_SCHEMA}.users u ON u.id = s.user_id
          WHERE s.id_hash = $1 AND s.expires_at > now()`,
        [key],
      );
      if (result.rowCount === 1) {
        const row = result.rows[0];
        return { user: databaseUser(this.config, row), session: databaseSession(row) };
      }
      await this.database.query(`DELETE FROM ${CONTROL_PLANE_SCHEMA}.auth_sessions WHERE id_hash = $1`, [key]);
    }
    if (!this.config.devAuth) throw new HttpError(401, "unauthorized", "Authentication required.");
    if (this.config.production) {
      throw new HttpError(503, "dev_auth_enabled", "Development authentication is disabled in production mode.");
    }
    const user = await this.devUser();
    const session = await this.createSession(user, req, res);
    return { user, session };
  }

  async login(username, password, req, res) {
    await this.loadUsers();
    const id = safeId(username, "username");
    const user = await this.userById(id);
    if (!user || !verifyPassword(password, user.passwordHash)) {
      throw new HttpError(401, "invalid_credentials", "Invalid username or password.");
    }
    const session = await this.createSession(user, req, res);
    return { user: this.publicUser(user), csrfToken: session.csrfToken };
  }

  async logout(req) {
    const cookies = parseCookies(req.headers.cookie ?? "");
    const sessionId = cookies.get(this.config.sessionCookieName);
    if (sessionId) {
      await this.database.query(
        `DELETE FROM ${CONTROL_PLANE_SCHEMA}.auth_sessions WHERE id_hash = $1`,
        [sessionKey(sessionId)],
      );
    }
  }

  async createSession(user, req, res) {
    const newSession = randomId("sess_");
    const ttlMs = sessionTtlMs(this.config);
    const session = {
      userId: user.id,
      csrfToken: randomId("csrf_"),
      createdAt: Date.now(),
      expiresAt: Date.now() + ttlMs,
    };
    await this.database.query(
      `INSERT INTO ${CONTROL_PLANE_SCHEMA}.auth_sessions
         (id_hash, user_id, csrf_token, created_at, expires_at)
       VALUES ($1, $2, $3, to_timestamp($4 / 1000.0), to_timestamp($5 / 1000.0))`,
      [sessionKey(newSession), user.id, session.csrfToken, session.createdAt, session.expiresAt],
    );
    setSessionCookie(
      res,
      this.config.sessionCookieName,
      newSession,
      shouldUseSecureCookies(req, this.config),
      Math.max(1, Math.floor(ttlMs / 1000)),
    );
    return session;
  }

  async assertCsrf(req, pathname) {
    if (this.config.devAuth) return;
    const method = (req.method ?? "GET").toUpperCase();
    if (["GET", "HEAD", "OPTIONS"].includes(method)) return;
    if (pathname === "/api/auth/login" || pathname === "/api/auth/dev-login") return;
    const cookies = parseCookies(req.headers.cookie ?? "");
    const sessionId = cookies.get(this.config.sessionCookieName);
    const key = sessionId ? sessionKey(sessionId) : null;
    const result = key
      ? await this.database.query(
          `SELECT csrf_token FROM ${CONTROL_PLANE_SCHEMA}.auth_sessions WHERE id_hash = $1 AND expires_at > now()`,
          [key],
        )
      : { rowCount: 0, rows: [] };
    if (result.rowCount !== 1) {
      if (key) await this.database.query(`DELETE FROM ${CONTROL_PLANE_SCHEMA}.auth_sessions WHERE id_hash = $1`, [key]);
      throw new HttpError(401, "unauthorized", "Authentication required.");
    }
    const header = req.headers["x-open-science-csrf"];
    const token = Array.isArray(header) ? header[0] : header;
    if (typeof token !== "string" || token !== result.rows[0].csrf_token) {
      throw new HttpError(403, "csrf_required", "A valid CSRF token is required.");
    }
  }

  async devUser() {
    const id = "dev";
    await this.database.transaction(async (client) => {
      await lockUserIdentity(client, id);
      await client.query(
        `INSERT INTO ${CONTROL_PLANE_SCHEMA}.users(id, name, password_hash, auth_type)
         VALUES ($1, $2, NULL, 'development') ON CONFLICT (id) DO NOTHING`,
        [id, "Development User"],
      );
    });
    return this.userById(id);
  }

  async createUser(username, password, name = username) {
    const id = safeId(username, "username");
    if (typeof password !== "string" || password.length < 8) {
      throw new HttpError(400, "weak_password", "Password must be at least 8 characters.");
    }
    const displayName = typeof name === "string" && name.trim() ? name.trim() : id;
    try {
      await this.database.transaction(async (client) => {
        await lockUserIdentity(client, id);
        await client.query(`DELETE FROM ${CONTROL_PLANE_SCHEMA}.deleted_users WHERE id = $1`, [id]);
        await client.query(
          `INSERT INTO ${CONTROL_PLANE_SCHEMA}.users(id, name, password_hash, auth_type)
           VALUES ($1, $2, $3, 'local')`,
          [id, displayName, hashPassword(password)],
        );
      });
    } catch (error) {
      throw databaseConflict(error, "user_exists", "User already exists.");
    }
    const user = await this.userById(id);
    return this.publicUser(user);
  }

  async upsertOidcUser(userId, name) {
    const id = safeId(userId, "OIDC user id");
    const displayName = typeof name === "string" && name.trim() ? name.trim().slice(0, 128) : "EviMed User";
    return this.database.transaction(async (client) => {
      await lockUserIdentity(client, id);
      const existing = await client.query(
        `SELECT id, name, password_hash, auth_type FROM ${CONTROL_PLANE_SCHEMA}.users WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (existing.rowCount && existing.rows[0].auth_type !== "oidc") {
        throw new HttpError(409, "identity_collision", "External identity conflicts with an existing account.");
      }
      await client.query(`DELETE FROM ${CONTROL_PLANE_SCHEMA}.deleted_users WHERE id = $1`, [id]);
      const result = await client.query(
        `INSERT INTO ${CONTROL_PLANE_SCHEMA}.users(id, name, password_hash, auth_type)
         VALUES ($1, $2, NULL, 'oidc')
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, updated_at = now()
         RETURNING id, name, password_hash, auth_type`,
        [id, displayName],
      );
      const user = databaseUser(this.config, result.rows[0]);
      await ensureUserRoot(this.config, user.rootDir);
      return user;
    });
  }

  async userById(id) {
    const result = await this.database.query(
      `SELECT id, name, password_hash, auth_type FROM ${CONTROL_PLANE_SCHEMA}.users WHERE id = $1`,
      [id],
    );
    const user = databaseUser(this.config, result.rows[0]);
    if (user) await ensureUserRoot(this.config, user.rootDir);
    return user;
  }

  async loginUserCount() {
    await this.loadUsers();
    const result = await this.database.query(
      `SELECT count(*)::integer AS count FROM ${CONTROL_PLANE_SCHEMA}.users WHERE password_hash IS NOT NULL`,
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async projectFromRow(user, row) {
    if (!row) return null;
    const id = safeId(row.id, "project id");
    const projectsRoot = await ensureProjectsRoot(this.config, user);
    const projectRoot = path.join(projectsRoot, id);
    const workspaceRoot = path.join(projectRoot, "workspace");
    const runtimeDir = path.join(projectRoot, "runtime");
    const metaDir = path.join(projectRoot, ".openscience");
    await ensureScopedDir(projectsRoot, projectRoot);
    await ensureScopedDir(projectRoot, workspaceRoot);
    await ensureScopedDir(projectRoot, runtimeDir);
    await ensureScopedDir(projectRoot, metaDir);
    const activeWorkspace = this.isWorkspaceName(row.active_workspace) ? row.active_workspace : "";
    const workspaceDir = activeWorkspace ? path.join(workspaceRoot, activeWorkspace) : workspaceRoot;
    await ensureScopedDir(workspaceRoot, workspaceDir);
    const project = {
      id,
      name: row.name,
      tenantId: user.tenantId ?? user.id,
      userId: user.id,
      userRoot: user.rootDir,
      rootDir: projectRoot,
      workspaceDir,
      baseDir: workspaceRoot,
      runtimeDir,
      metaDir,
      activeWorkspace,
      maxBytes: Number(row.quota_bytes),
    };
    this.projects.set(`${user.id}:${id}`, project);
    return project;
  }

  async ensureDefaultProject(user) {
    await this.database.query(
      `INSERT INTO ${CONTROL_PLANE_SCHEMA}.projects(user_id, id, name, quota_bytes)
       VALUES ($1, 'default', 'Default Project', $2)
       ON CONFLICT (user_id, id) DO NOTHING`,
      [user.id, this.config.maxProjectBytes],
    );
  }

  async listProjects(user) {
    await this.ensureDefaultProject(user);
    const result = await this.database.query(
      `SELECT id, name FROM ${CONTROL_PLANE_SCHEMA}.projects WHERE user_id = $1 ORDER BY name, id`,
      [user.id],
    );
    return result.rows.map((row) => ({ id: row.id, name: row.name }));
  }

  async listStoredProjects() {
    return this.database.transaction(async (client) => {
      const result = await client.query(
        `SELECT p.id, p.name, p.active_workspace, p.quota_bytes,
                u.id AS user_id, u.name AS user_name, u.password_hash, u.auth_type
           FROM ${CONTROL_PLANE_SCHEMA}.projects p
           JOIN ${CONTROL_PLANE_SCHEMA}.users u ON u.id = p.user_id
          ORDER BY p.user_id, p.id
          FOR SHARE OF p`,
      );
      const projects = [];
      for (const row of result.rows) {
        const user = databaseUser(this.config, {
          id: row.user_id,
          name: row.user_name,
          password_hash: row.password_hash,
          auth_type: row.auth_type,
        });
        await ensureUserRoot(this.config, user.rootDir);
        projects.push(await this.projectFromRow(user, row));
      }
      return projects;
    });
  }

  async createProject(user, rawId, name = rawId) {
    const id = safeId(rawId, "project id");
    const displayName = typeof name === "string" && name.trim() ? name.trim() : id;
    try {
      await this.database.transaction(async (client) => {
        const result = await client.query(
          `INSERT INTO ${CONTROL_PLANE_SCHEMA}.projects(user_id, id, name, quota_bytes)
           VALUES ($1, $2, $3, $4)
           RETURNING id, name, active_workspace, quota_bytes`,
          [user.id, id, displayName, this.config.maxProjectBytes],
        );
        await this.projectFromRow(user, result.rows[0]);
      });
    } catch (error) {
      throw databaseConflict(error, "project_exists", "Project already exists.");
    }
    return { id, name: displayName };
  }

  async defaultProject(user) {
    await this.ensureDefaultProject(user);
    return this.requireProject(user, "default");
  }

  async requireProject(user, projectId = "default") {
    const id = safeId(projectId, "project id");
    if (id === "default") await this.ensureDefaultProject(user);
    return this.database.transaction(async (client) => {
      const result = await client.query(
        `SELECT id, name, active_workspace, quota_bytes
           FROM ${CONTROL_PLANE_SCHEMA}.projects
          WHERE user_id = $1 AND id = $2 FOR SHARE`,
        [user.id, id],
      );
      if (result.rowCount !== 1) throw new HttpError(404, "project_not_found", "Project not found.");
      return this.projectFromRow(user, result.rows[0]);
    });
  }

  async projectFor(user, projectId = "default", name = projectId) {
    const id = safeId(projectId, "project id");
    const displayName = typeof name === "string" && name.trim() ? name.trim() : id;
    return this.database.transaction(async (client) => {
      await client.query(
        `INSERT INTO ${CONTROL_PLANE_SCHEMA}.projects(user_id, id, name, quota_bytes)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, id) DO NOTHING`,
        [user.id, id, displayName, this.config.maxProjectBytes],
      );
      const result = await client.query(
        `SELECT id, name, active_workspace, quota_bytes
           FROM ${CONTROL_PLANE_SCHEMA}.projects
          WHERE user_id = $1 AND id = $2 FOR SHARE`,
        [user.id, id],
      );
      if (result.rowCount !== 1) throw new HttpError(404, "project_not_found", "Project not found.");
      return this.projectFromRow(user, result.rows[0]);
    });
  }

  async deleteProject(user, projectId) {
    const id = safeId(projectId, "project id");
    if (id === "default") {
      throw new HttpError(400, "default_project_protected", "The default project cannot be deleted.");
    }
    await this.database.transaction(async (client) => {
      const locked = await client.query(
        `SELECT id FROM ${CONTROL_PLANE_SCHEMA}.projects
          WHERE user_id = $1 AND id = $2 FOR UPDATE`,
        [user.id, id],
      );
      if (locked.rowCount !== 1) throw new HttpError(404, "project_not_found", "Project not found.");
      const projectsRoot = await ensureProjectsRoot(this.config, user);
      const projectRoot = path.join(projectsRoot, id);
      await assertNoSymlinkPath(projectsRoot, projectRoot, { allowMissingTail: true });
      await fs.rm(projectRoot, { recursive: true, force: true });
      await client.query(
        `DELETE FROM ${CONTROL_PLANE_SCHEMA}.projects WHERE user_id = $1 AND id = $2`,
        [user.id, id],
      );
    });
    this.projects.delete(`${user.id}:${id}`);
    return { id };
  }

  async setProjectWorkspace(project, name) {
    const activeWorkspace = name || "";
    if (activeWorkspace && !this.isWorkspaceName(activeWorkspace)) {
      throw new HttpError(400, "invalid_workspace", "workspace name contains unsupported characters.");
    }
    const workspaceDir = activeWorkspace ? path.join(project.baseDir, activeWorkspace) : project.baseDir;
    await this.database.transaction(async (client) => {
      const locked = await client.query(
        `SELECT id FROM ${CONTROL_PLANE_SCHEMA}.projects
          WHERE user_id = $1 AND id = $2 FOR UPDATE`,
        [project.userId, project.id],
      );
      if (locked.rowCount !== 1) throw new HttpError(404, "project_not_found", "Project not found.");
      await ensureScopedDir(project.baseDir, workspaceDir);
      await client.query(
        `UPDATE ${CONTROL_PLANE_SCHEMA}.projects
            SET active_workspace = $3, updated_at = now()
          WHERE user_id = $1 AND id = $2`,
        [project.userId, project.id, activeWorkspace],
      );
    });
    project.workspaceDir = workspaceDir;
    project.activeWorkspace = activeWorkspace;
    return project;
  }

  async deleteUser(user) {
    const id = safeId(user.id, "user id");
    const root = usersRoot(this.config);
    const userRoot = path.join(root, id);
    const deleted = await this.database.transaction(async (client) => {
      await lockUserIdentity(client, id);
      const locked = await client.query(
        `SELECT id FROM ${CONTROL_PLANE_SCHEMA}.users WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (locked.rowCount !== 1) return false;
      await assertNoSymlinkPath(root, userRoot, { allowMissingTail: true });
      await fs.rm(userRoot, { recursive: true, force: true });
      const result = await client.query(`DELETE FROM ${CONTROL_PLANE_SCHEMA}.users WHERE id = $1`, [id]);
      if (result.rowCount !== 1) return false;
      await client.query(
        `INSERT INTO ${CONTROL_PLANE_SCHEMA}.deleted_users(id) VALUES ($1)
         ON CONFLICT (id) DO UPDATE SET deleted_at = now()`,
        [id],
      );
      return true;
    });
    if (!deleted) throw new HttpError(404, "user_not_found", "User not found.");
    for (const key of [...this.projects.keys()]) if (key.startsWith(`${id}:`)) this.projects.delete(key);
    this.users.delete(id);
    return { id };
  }

  async listResearchSessions(project) {
    const result = await this.database.query(
      `SELECT session_id, mode, agent_id, agent_version, runtime_agent, created_at, updated_at
         FROM ${CONTROL_PLANE_SCHEMA}.research_sessions
        WHERE user_id = $1 AND project_id = $2 ORDER BY updated_at DESC`,
      [project.userId, project.id],
    );
    return result.rows.map(databaseResearchSession);
  }

  async getResearchSession(project, sessionId) {
    const result = await this.database.query(
      `SELECT session_id, mode, agent_id, agent_version, runtime_agent, created_at, updated_at
         FROM ${CONTROL_PLANE_SCHEMA}.research_sessions
        WHERE user_id = $1 AND project_id = $2 AND session_id = $3`,
      [project.userId, project.id, sessionId],
    );
    return databaseResearchSession(result.rows[0]);
  }

  async putResearchSession(project, record, { maximum = 1_000 } = {}) {
    return this.database.transaction(async (client) => {
      const parent = await client.query(
        `SELECT 1 FROM ${CONTROL_PLANE_SCHEMA}.projects
          WHERE user_id = $1 AND id = $2 FOR UPDATE`,
        [project.userId, project.id],
      );
      if (parent.rowCount !== 1) throw new HttpError(404, "project_not_found", "Project not found.");
      const existing = await client.query(
        `SELECT mode, agent_id, agent_version, runtime_agent, created_at
           FROM ${CONTROL_PLANE_SCHEMA}.research_sessions
          WHERE user_id = $1 AND project_id = $2 AND session_id = $3 FOR UPDATE`,
        [project.userId, project.id, record.sessionId],
      );
      if (!existing.rowCount) {
        const count = await client.query(
          `SELECT count(*)::integer AS count FROM ${CONTROL_PLANE_SCHEMA}.research_sessions
            WHERE user_id = $1 AND project_id = $2`,
          [project.userId, project.id],
        );
        if (Number(count.rows[0]?.count ?? 0) >= maximum) {
          throw new HttpError(409, "research_session_limit_reached", "This project has reached its research session metadata limit.");
        }
      }
      const previous = existing.rows[0];
      if (previous && (
        previous.mode !== record.mode ||
        previous.agent_id !== record.agentId ||
        previous.agent_version !== record.agentVersion ||
        previous.runtime_agent !== record.runtimeAgent
      )) {
        throw new HttpError(409, "research_session_identity_conflict", "Research session identity cannot change after it is created.");
      }
      const result = await client.query(
        `INSERT INTO ${CONTROL_PLANE_SCHEMA}.research_sessions
           (user_id, project_id, session_id, mode, agent_id, agent_version, runtime_agent, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (user_id, project_id, session_id)
         DO UPDATE SET updated_at = EXCLUDED.updated_at
         RETURNING session_id, mode, agent_id, agent_version, runtime_agent, created_at, updated_at`,
        [
          project.userId,
          project.id,
          record.sessionId,
          record.mode,
          record.agentId,
          record.agentVersion,
          record.runtimeAgent,
          record.createdAt,
          record.updatedAt,
        ],
      );
      return databaseResearchSession(result.rows[0]);
    });
  }

  async close() {
    await this.database.close();
  }
}

export function createStore(config, options = {}) {
  if (config.stateStore === "file") return new InMemoryStore(config);
  if (config.stateStore === "postgres") return new PostgresStore(config, options);
  throw new HttpError(503, "state_store_invalid", "The control-plane state store must be file or postgres.");
}
