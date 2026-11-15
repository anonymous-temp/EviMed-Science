import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

// Keep the component, API client, envelope parsing and CSRF path real; fake only the HTTP boundary.
it("creates and revokes through the actual browser client with session cookies and CSRF", async () => {
  vi.stubEnv("VITE_OPEN_SCIENCE_API_URL", "/api");
  const record = { id: "agk_local", name: "My DSH", scopes: ["memory.read", "memory.write"], projectId: null, createdAt: "2026-11-15T00:00:00Z", lastUsedAt: null, revokedAt: null, expiresAt: null };
  const mutations: RequestInit[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    expect(init?.credentials).toBe("include");
    const path = String(input);
    if (path === "/api/agent-memory/v1/openapi.json") return json({ openapi: "3.1.0" });
    if (path === "/api/me") return json({ data: { csrfToken: "csrf-capsule-test" } });
    if (path === "/api/agent-keys" && (!init?.method || init.method === "GET")) return json({ data: { keys: [], scopes: ["memory.read", "memory.write"] } });
    if (path === "/api/agent-keys" && init?.method === "POST") {
      mutations.push(init);
      expect(JSON.parse(String(init.body))).toEqual({ name: "My DSH", scopes: ["memory.read", "memory.write"] });
      return json({ data: { ...record, key: "evk_integration_once" } }, 201);
    }
    if (path === "/api/agent-keys/agk_local" && init?.method === "DELETE") {
      mutations.push(init);
      return json({ data: { ...record, revokedAt: "2026-11-15T01:00:00Z" } });
    }
    throw new Error(`Unexpected request: ${path}`);
  });
  const { AgentKeysSection } = await import("./AgentKeysSection");
  const user = userEvent.setup(); render(<AgentKeysSection />);
  await user.click(await screen.findByRole("button", { name: "创建密钥" }));
  await user.type(screen.getByLabelText("密钥名称"), "My DSH");
  await user.click(screen.getByLabelText("提出待确认的记忆"));
  await user.click(screen.getByRole("button", { name: "创建" }));
  expect(await screen.findByLabelText("新密钥（仅显示这一次）")).toHaveValue("evk_integration_once");
  await user.click(screen.getByRole("button", { name: "撤销密钥“My DSH”" }));
  await waitFor(() => expect(screen.queryByDisplayValue("evk_integration_once")).not.toBeInTheDocument());
  expect(screen.getByText("已撤销")).toBeInTheDocument();
  expect(mutations).toHaveLength(2);
  for (const mutation of mutations) expect(new Headers(mutation.headers).get("X-Open-Science-CSRF")).toBe("csrf-capsule-test");
  expect(screen.queryByText("agk_local")).not.toBeInTheDocument();
}, 20_000); // create, copy and revoke through real user events: about 5.4 s on the lab runner, over the 5 s default
