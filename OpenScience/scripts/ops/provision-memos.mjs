#!/usr/bin/env node
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const baseUrl = String(process.env.OPEN_SCIENCE_MEMOS_URL ?? "http://evimed-memos:5230").replace(/\/+$/, "");
const username = String(process.env.OPEN_SCIENCE_MEMOS_ADMIN_USER ?? "evimed-memory").trim();
const passwordFile = path.resolve(
  process.env.OPEN_SCIENCE_MEMOS_ADMIN_PASSWORD_FILE ?? "/run/secrets/memos-admin-password",
);
const tokenFile = path.resolve(
  process.env.OPEN_SCIENCE_MEMOS_ACCESS_TOKEN_FILE ?? "/run/memos-integration/access-token",
);
const timeoutMs = Math.max(1_000, Math.min(60_000, Number(process.env.OPEN_SCIENCE_MEMOS_PROVISION_TIMEOUT_MS ?? 10_000)));

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function readRegularNoFollow(file, label, maxBytes = 8192) {
  const handle = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw failure("memos_provision_secret_not_regular", `${label} must be a regular file.`);
    if (stat.size <= 0 || stat.size > maxBytes) throw failure("memos_provision_secret_size", `${label} has an invalid size.`);
    return (await handle.readFile("utf8")).replace(/\r?\n$/, "");
  } finally {
    await handle.close();
  }
}

async function request(relative, { method = "GET", token = "", body = null, accept = [] } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(`${baseUrl}${relative}`, {
      method,
      headers: {
        Accept: "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body == null ? {} : { "Content-Type": "application/json" }),
      },
      body: body == null ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    const code = error?.name === "AbortError" ? "memos_provision_timeout" : "memos_provision_unavailable";
    throw failure(code, "Memos is unavailable during integration provisioning.");
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      throw failure("memos_provision_response_invalid", "Memos returned invalid JSON during provisioning.");
    }
  }
  if (!response.ok && !accept.includes(response.status)) {
    throw failure("memos_provision_rejected", `Memos rejected a provisioning request with HTTP ${response.status}.`);
  }
  return { response, body: parsed };
}

async function validExistingToken() {
  const stat = await fsp.lstat(tokenFile).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return false;
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw failure("memos_provision_token_not_regular", "The generated Memos token must be a regular file.");
  }
  const token = await readRegularNoFollow(tokenFile, "Memos access token", 4096);
  if (!token || /\s|\0/.test(token)) throw failure("memos_provision_token_invalid", "The generated Memos token is invalid.");
  const current = await request("/api/v1/auth/me", { token, accept: [401, 403] });
  return current.response.ok;
}

async function signIn(password) {
  const result = await request("/api/v1/auth/signin", {
    method: "POST",
    body: { passwordCredentials: { username, password } },
    accept: [401, 403],
  });
  if (!result.response.ok) return null;
  const token = result.body?.accessToken;
  if (typeof token !== "string" || token.length < 20 || /\s|\0/.test(token)) {
    throw failure("memos_provision_session_invalid", "Memos returned an invalid administrator session.");
  }
  return token;
}

async function ensureAdministrator(password) {
  let session = await signIn(password);
  if (session) return session;
  await request("/api/v1/users", {
    method: "POST",
    body: {
      user: {
        username,
        password,
        role: "ADMIN",
        state: "NORMAL",
        displayName: "EviMed Memory Integration",
      },
    },
    accept: [409],
  });
  session = await signIn(password);
  if (!session) throw failure("memos_provision_admin_auth_failed", "Unable to authenticate the Memos integration administrator.");
  return session;
}

async function writeToken(token) {
  if (typeof token !== "string" || token.length < 20 || token.length > 4096 || /\s|\0/.test(token)) {
    throw failure("memos_provision_token_invalid", "Memos returned an invalid personal access token.");
  }
  const parent = path.dirname(tokenFile);
  await fsp.mkdir(parent, { recursive: true, mode: 0o700 });
  const targetStat = await fsp.lstat(tokenFile).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (targetStat?.isSymbolicLink() || (targetStat && !targetStat.isFile())) {
    throw failure("memos_provision_token_not_regular", "The generated Memos token must be a regular file.");
  }
  const temporary = path.join(parent, `.access-token.${process.pid}.${Date.now().toString(36)}.tmp`);
  const handle = await fsp.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${token}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(temporary, tokenFile);
  await fsp.chmod(tokenFile, 0o600);
}

async function main() {
  if (!/^[a-z0-9][a-z0-9_-]{2,63}$/.test(username)) {
    throw failure("memos_provision_username_invalid", "The Memos integration username is invalid.");
  }
  if (await validExistingToken()) {
    process.stdout.write("Memos integration token check ok.\n");
    return;
  }
  const password = await readRegularNoFollow(passwordFile, "Memos administrator password");
  if (password.length < 24 || /[\r\n\0]/.test(password)) {
    throw failure("memos_provision_password_invalid", "The Memos administrator password is invalid.");
  }
  const session = await ensureAdministrator(password);
  const result = await request(`/api/v1/users/${encodeURIComponent(username)}/personalAccessTokens`, {
    method: "POST",
    token: session,
    body: { description: "EviMed Science production integration", expiresInDays: 0 },
  });
  await writeToken(result.body?.token);
  process.stdout.write("Memos integration provisioning ok.\n");
}

main().catch((error) => {
  process.stderr.write(`${error?.code ?? "memos_provision_failed"}: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
