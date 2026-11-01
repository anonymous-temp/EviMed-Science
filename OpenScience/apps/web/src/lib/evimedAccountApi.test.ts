import { afterEach, describe, expect, it, vi } from "vitest";

async function client(base = "/api") {
  vi.resetModules();
  vi.stubEnv("VITE_OPEN_SCIENCE_API_URL", base);
  return import("./apiClient");
}
function response(data: unknown, status = 200) {
  return new Response(JSON.stringify(status === 200 ? { data } : data), {
    status, headers: { "Content-Type": "application/json" },
  });
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("EviMed account client", () => {
  it("loads a captcha through the fixed control-plane route with browser cookies and no caching", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(response({ canvasSrc: "data:image/png;base64,fixture" }));
    const api = await client();
    expect(await api.fetchEvimedCaptcha("13800000000")).toEqual({ canvasSrc: "data:image/png;base64,fixture" });
    expect(fetcher).toHaveBeenCalledWith("/api/auth/evimed/captcha?phoneNumber=13800000000", {
      method: "GET", credentials: "include", cache: "no-store",
    });
  });

  it.each([
    ["login", "25", { purpose: "login", phone: "13800000000", xcode: "25" }],
    ["register", undefined, { purpose: "register", phone: "13800000000" }],
    ["reset", undefined, { purpose: "reset", phone: "13800000000" }],
  ] as const)("keeps the %s SMS purpose explicit without provider fields", async (purpose, offset, payload) => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(response(true));
    const api = await client();
    await api.sendEvimedCode(purpose, "13800000000", offset);
    expect(fetcher).toHaveBeenCalledWith("/api/auth/evimed/send-code", {
      method: "POST", credentials: "include", cache: "no-store",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
  });

  it.each([
    ["password-login", "loginEvimedPassword", ["reader", "pass123"], { username: "reader", password: "pass123" }],
    ["sms-login", "loginEvimedSms", ["13800000000", "123456"], { phone: "13800000000", code: "123456" }],
  ] as const)("establishes a hosted session after %s without retaining upstream credentials", async (route, name, args, payload) => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(response({ user: { id: "reader", name: "Reader" }, csrfToken: "csrf-account" }));
    const storage = vi.spyOn(Storage.prototype, "setItem");
    const api = await client("https://science.example/api");
    const started = vi.fn();
    window.addEventListener(api.WEB_SESSION_STARTED_EVENT, started);
    try {
      await api[name](args[0], args[1]);
      expect(fetcher).toHaveBeenCalledWith(`https://science.example/api/auth/evimed/${route}`, {
        method: "POST", credentials: "include", cache: "no-store",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
      });
      expect(started).toHaveBeenCalledTimes(1);
      expect(api.getWebApiRequestHeaders()["X-Open-Science-CSRF"]).toBe("csrf-account");
      for (const [key, value] of storage.mock.calls) {
        if (key === "openScience.projectId") {
          expect(value).toBe("default");
          continue;
        }
        expect(key).toBe(api.WEB_SESSION_SYNC_STORAGE_KEY);
        const signal = JSON.parse(value);
        expect(Object.keys(signal).sort()).toEqual(["at", "kind", "nonce"]);
        expect(signal).toEqual({ at: expect.any(Number), kind: "started", nonce: expect.any(String) });
        expect(signal.nonce).not.toBe("");
      }
      expect(storage.mock.calls.filter(([key]) => key === api.WEB_SESSION_SYNC_STORAGE_KEY)).toHaveLength(1);
    } finally { window.removeEventListener(api.WEB_SESSION_STARTED_EVENT, started); }
  });

  it("registration, verification and password reset do not signal a successful sign-in", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => response(true));
    const api = await client();
    const started = vi.fn();
    window.addEventListener(api.WEB_SESSION_STARTED_EVENT, started);
    try {
      await api.registerEvimedAccount("13800000000", "123456", "pass123");
      await api.verifyEvimedCode("13800000000", "123456");
      await api.resetEvimedPassword("13800000000", "123456", "next123");
      expect(fetcher.mock.calls.map(([url, init]) => [url, JSON.parse(String(init?.body))])).toEqual([
        ["/api/auth/evimed/register", { phone: "13800000000", code: "123456", password: "pass123" }],
        ["/api/auth/evimed/verify-code", { phone: "13800000000", code: "123456" }],
        ["/api/auth/evimed/reset-password", { phone: "13800000000", code: "123456", password: "next123" }],
      ]);
      expect(started).not.toHaveBeenCalled();
    } finally { window.removeEventListener(api.WEB_SESSION_STARTED_EVENT, started); }
  });

  it("propagates typed rate-limit refusals without emitting a session event", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response({ code: "auth_rate_limited", error: "Limited" }, 429));
    const api = await client();
    const started = vi.fn();
    window.addEventListener(api.WEB_SESSION_STARTED_EVENT, started);
    try {
      await expect(api.loginEvimedPassword("reader", "pass123")).rejects.toMatchObject({ status: 429, code: "auth_rate_limited" });
      expect(started).not.toHaveBeenCalled();
    } finally { window.removeEventListener(api.WEB_SESSION_STARTED_EVENT, started); }
  });

  it("does not call a network endpoint when no backend is configured", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch");
    const api = await client("");
    await expect(api.fetchEvimedCaptcha("13800000000")).rejects.toBeInstanceOf(api.BackendUnavailableError);
    await expect(api.loginEvimedPassword("reader", "pass123")).rejects.toBeInstanceOf(api.BackendUnavailableError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([false, {}, { user: { id: "reader" } }, { csrfToken: "csrf-only" }])("rejects malformed successful login responses before announcing a session: %j", async data => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => response(data));
    const api = await client();
    const started = vi.fn();
    window.addEventListener(api.WEB_SESSION_STARTED_EVENT, started);
    try {
      for (const action of [() => api.loginEvimedWeb(), () => api.loginEvimedPassword("reader", "pass123"), () => api.loginEvimedSms("13800000000", "123456")]) {
        await expect(action()).rejects.toMatchObject({ status: 502, code: "evimed_account_failed" });
      }
      expect(started).not.toHaveBeenCalled();
    } finally { window.removeEventListener(api.WEB_SESSION_STARTED_EVENT, started); }
  });

  it.each([false, {}, null, "true"])("rejects non-success account results instead of advancing verification or recovery: %j", async data => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => response(data));
    const api = await client();
    for (const action of [() => api.sendEvimedCode("register", "13800000000"), () => api.registerEvimedAccount("13800000000", "123456", "pass123"),
      () => api.verifyEvimedCode("13800000000", "123456"), () => api.resetEvimedPassword("13800000000", "123456", "pass123")]) {
      await expect(action()).rejects.toMatchObject({ status: 502, code: "evimed_account_failed" });
    }
  });
});
