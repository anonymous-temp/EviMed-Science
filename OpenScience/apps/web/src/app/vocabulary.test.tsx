import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { WebAgentRun } from "@/lib/apiClient";
import { RunsPage } from "./routes/RunsPage";

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
 * This is the regression: render the surface with a row carrying every one of
 * those shapes and assert none of them is visible prose. Identifiers are still
 * reachable — behind the row's own labelled disclosure — so the assertion is
 * about what the page *leads with*, and the test reads the row title and tag
 * rather than the whole document.
 */
const listWebAgentRuns = vi.fn();
vi.mock("@/lib/apiClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/apiClient")>()),
  hasWebApi: true,
  listWebAgentRuns: () => listWebAgentRuns(),
}));

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

describe("runtime vocabulary never leads a surface", () => {
  it("titles and tags a run without ids, model names or shouted capability keys", async () => {
    listWebAgentRuns.mockResolvedValue([leakyRun()]);
    render(<MemoryRouter initialEntries={["/app/runs"]}><RunsPage /></MemoryRouter>);

    // Prove the walk happened before asserting what it did not see: an
    // assertion over an empty page passes forever.
    const row = await screen.findByRole("button", { name: /临床证据深度分析/ });
    const visible = row.textContent ?? "";
    expect(visible.length).toBeGreaterThan(0);

    for (const pattern of FORBIDDEN) {
      for (const word of visible.split(/[\s·]+/).filter(Boolean)) {
        expect(word, `${word} matched ${pattern}`).not.toMatch(pattern);
      }
    }
    // And the two positive facts the row must carry instead.
    expect(visible).toContain("临床证据深度分析");
    expect(visible).toContain("开放域");
  });

  it("names the open-domain answer line in words, not by its id", async () => {
    // Seen at 390 px in the 2026-09-16 scripted walk: 「开放域 · open-domain-answer」.
    listWebAgentRuns.mockResolvedValue([{ ...leakyRun(), effectiveAgentId: "open-domain-answer", effectiveRuntimeAgent: null }]);
    render(<MemoryRouter initialEntries={["/app/runs"]}><RunsPage /></MemoryRouter>);
    const row = await screen.findByRole("button", { name: /开放域问答/ });
    expect(row.textContent).not.toMatch(/open-domain-answer/);
  });

  it("keeps the identifiers reachable, labelled, behind one disclosure", async () => {
    listWebAgentRuns.mockResolvedValue([leakyRun()]);
    render(<MemoryRouter initialEntries={["/app/runs"]}><RunsPage /></MemoryRouter>);

    await screen.findByRole("button", { name: /临床证据深度分析/ });
    const details = screen.getByText("技术标识（供排查使用）").closest("details");
    expect(details).not.toBeNull();
    // Closed by default: support can open it, a reader never meets it.
    expect(details).not.toHaveAttribute("open");
    expect(details?.textContent).toContain("run_c657a9e0b079c8e9e401a19ed95f42e7");
    expect(details?.textContent).toContain("ses_0722bc34fffeRehfLDGbxJn4I3");
    expect(details?.textContent).toContain("deepseek/deepseek-v4-pro");
  });
});
