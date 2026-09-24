import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebAgentRun } from "@/lib/apiClient";
import { ProjectBrowser } from "@/components/sidebar/ProjectBrowser";

/**
 * Runtime vocabulary must not reach the page (§23.2 rule 11).
 *
 * The 2026-09-15 walk found the run ledger leading with
 * `run_c657a9e0b079c8e9e401a19ed95f42e7` as a title, `ses_0722bc34fffe…` as a
 * chip, `deepseek/deepseek-v4-pro` beside it and `CLINICAL-EVIDENCE-SYNTHESIS`
 * shouted in the tag — four ids where a reader expected the question they
 * asked and the capability that answered it (D1/D2). Each was fixed by hand,
 * and a fix by hand is a fix that comes back.
 *
 * This is the regression, now over the surface that survived: the run ledger
 * page was deleted on 2026-09-20, and the list of a project's conversations in
 * the sidebar is the one place those rows are drawn. Identifiers are still
 * reachable — behind the row's own menu, as 「复制诊断信息」 — so the assertion
 * is about what a row *leads with*.
 */
const mocks = vi.hoisted(() => ({
  listWebProjects: vi.fn(),
  listWebAgentRuns: vi.fn(),
  fetchWebMe: vi.fn(),
}));

vi.mock("@/lib/apiClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/apiClient")>()),
  hasWebApi: true,
  listWebProjects: mocks.listWebProjects,
  listWebAgentRuns: mocks.listWebAgentRuns,
  fetchWebMe: mocks.fetchWebMe,
}));
vi.mock("@/lib/runtimeWarm", () => ({ warmWebRuntime: vi.fn() }));

/** The shapes §23.2 rule 11 forbids in prose, as the walk found them. */
const FORBIDDEN = [
  /^run_[0-9a-f]{32}$/,
  /^ses_[A-Za-z0-9]{8,}$/,
  /deepseek\//,
  /^[A-Z][A-Z-]{6,}$/,
];

function leakyRun(): WebAgentRun {
  const now = new Date().toISOString();
  return {
    id: "run_c657a9e0b079c8e9e401a19ed95f42e7",
    dispatchId: null,
    question: null,
    dispatchStatus: "accepted",
    sessionId: "ses_0722bc34fffeRehfLDGbxJn4I3",
    mode: "open-domain",
    agentId: null,
    agentVersion: null,
    runtimeAgent: null,
    effectiveAgentId: "clinical-evidence-synthesis",
    effectiveAgentVersion: "1.0.0",
    effectiveRuntimeAgent: "evimed-clinical-evidence-synthesis",
    model: "deepseek/deepseek-v4-pro",
    status: "succeeded",
    createdAt: now,
    startedAt: now,
    finishedAt: now,
    durationMs: 14_000,
    errorCode: null,
    artifacts: [],
  };
}

function renderBrowser() {
  return render(<MemoryRouter initialEntries={["/app/chat"]}><ProjectBrowser /></MemoryRouter>);
}

beforeEach(() => {
  mocks.listWebProjects.mockReset();
  mocks.listWebAgentRuns.mockReset();
  mocks.fetchWebMe.mockReset();
  mocks.listWebProjects.mockResolvedValue([{ id: "default", name: "我的研究" }]);
  mocks.fetchWebMe.mockResolvedValue({ project: { id: "default" } });
});

describe("runtime vocabulary never leads a surface", () => {
  it("names a conversation without ids, model names or shouted capability keys", async () => {
    mocks.listWebAgentRuns.mockResolvedValue([leakyRun()]);
    renderBrowser();

    // Prove the walk happened before asserting what it did not see: an
    // assertion over an empty page passes forever.
    const row = await screen.findByRole("link", { name: /临床证据深度分析/ });
    const visible = row.textContent ?? "";
    expect(visible.length).toBeGreaterThan(0);

    for (const pattern of FORBIDDEN) {
      for (const word of visible.split(/[\s·]+/).filter(Boolean)) {
        expect(word, `${word} matched ${pattern}`).not.toMatch(pattern);
      }
    }
    expect(visible).toContain("临床证据深度分析");
  });

  it("names the open-domain answer line in words, not by its id", async () => {
    // Seen at 390 px in the 2026-09-16 scripted walk: 「开放域 · open-domain-answer」.
    mocks.listWebAgentRuns.mockResolvedValue([{ ...leakyRun(), effectiveAgentId: "open-domain-answer", effectiveRuntimeAgent: null }]);
    renderBrowser();
    const row = await screen.findByRole("link", { name: /普通问答/ });
    expect(row.textContent).not.toMatch(/open-domain-answer/);
  });

  it("keeps the identifiers reachable for an operator, behind the row's own menu", async () => {
    const written: string[] = [];
    Object.assign(navigator, { clipboard: { writeText: (text: string) => { written.push(text); return Promise.resolve(); } } });
    mocks.fetchWebMe.mockResolvedValue({ project: { id: "default" }, operator: true });
    mocks.listWebAgentRuns.mockResolvedValue([leakyRun()]);
    renderBrowser();

    await screen.findByRole("link", { name: /临床证据深度分析/ });
    await userEvent.click(screen.getByRole("button", { name: /的操作$/ }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "复制诊断信息" }));

    await waitFor(() => expect(written).toHaveLength(1));
    expect(written[0]).toContain("run_c657a9e0b079c8e9e401a19ed95f42e7");
    expect(written[0]).toContain("ses_0722bc34fffeRehfLDGbxJn4I3");
    expect(written[0]).toContain("deepseek/deepseek-v4-pro");
  });

  it("offers a researcher no identifiers to copy", async () => {
    mocks.listWebAgentRuns.mockResolvedValue([leakyRun()]);
    renderBrowser();

    await screen.findByRole("link", { name: /临床证据深度分析/ });
    await userEvent.click(screen.getByRole("button", { name: /的操作$/ }));
    await screen.findByRole("menuitem", { name: "重命名" });
    expect(screen.queryByRole("menuitem", { name: "复制诊断信息" })).toBeNull();
  });
});
