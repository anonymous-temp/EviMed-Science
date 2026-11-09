import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { WebApiError } from "@/lib/apiClient";
import { VcrRefreshContext, VcrRefreshNote, useVcrLoad, type VcrRefreshReporter } from "./vcrTabKit";

/**
 * A read that answered and then failed keeps its answer and reports the failure to the page, which says it once. Without a page to say
 * it, the failure replaces the content as before: a silent stale answer is worse than an error card.
 */
function Reader({ readKey, load }: { readKey: string; load: () => Promise<string> }) {
  const { state, reload } = useVcrLoad(readKey, load);
  return (
    <div>
      <p data-testid="state">{state.kind === "ready" ? `ready:${state.data}` : state.kind === "error" ? `error:${state.message}` : "loading"}</p>
      <button type="button" onClick={reload}>读取</button>
    </div>
  );
}
const down = () => new WebApiError("down", { status: 503, code: "vcr_unavailable" });

describe("a re-read that fails", () => {
  it("keeps what the page showed and tells the page, when there is a page to tell", async () => {
    const report = vi.fn<VcrRefreshReporter>();
    let fail = false;
    const load = async () => { if (fail) throw down(); return "第一次"; };
    render(<VcrRefreshContext.Provider value={report}><Reader readKey="std_1:population" load={load} /></VcrRefreshContext.Provider>);
    await waitFor(() => expect(screen.getByTestId("state")).toHaveTextContent("ready:第一次"));
    expect(report).toHaveBeenLastCalledWith(expect.any(String), null);
    fail = true;
    await userEvent.click(screen.getByRole("button", { name: "读取" }));
    await waitFor(() => expect(report).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ message: expect.any(String), retry: expect.any(Function) })));
    expect(screen.getByTestId("state")).toHaveTextContent("ready:第一次");
    // The page's 重试 is this read's: it reads again, and its success takes the failure away.
    fail = false;
    const failure = report.mock.calls.at(-1)![1]!;
    await act(async () => { failure.retry(); });
    await waitFor(() => expect(report).toHaveBeenLastCalledWith(expect.any(String), null));
    expect(screen.getByTestId("state")).toHaveTextContent("ready:第一次");
  });

  it("replaces the content when nothing was answered yet, when the module is off, or when there is no page to say it", async () => {
    const report = vi.fn<VcrRefreshReporter>();
    const first = render(<VcrRefreshContext.Provider value={report}><Reader readKey="std_1:trial" load={async () => { throw down(); }} /></VcrRefreshContext.Provider>);
    await waitFor(() => expect(screen.getByTestId("state")).toHaveTextContent(/^error:/));
    expect(report).not.toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ message: expect.any(String) }));
    first.unmount();

    let phase = 0;
    const turn = async () => { phase += 1; if (phase === 1) return "ok"; throw new WebApiError("off", { status: 404, code: "vcr_not_enabled" }); };
    render(<VcrRefreshContext.Provider value={report}><Reader readKey="std_1:data" load={turn} /></VcrRefreshContext.Provider>);
    await waitFor(() => expect(screen.getByTestId("state")).toHaveTextContent("ready:ok"));
    await userEvent.click(screen.getAllByRole("button", { name: "读取" }).at(-1)!);
    await waitFor(() => expect(screen.getByTestId("state")).toHaveTextContent(/^error:/));
  });

  it("is an error card where no page provides a place to say it", async () => {
    let fail = false;
    render(<Reader readKey="vcr:models" load={async () => { if (fail) throw down(); return "库"; }} />);
    await waitFor(() => expect(screen.getByTestId("state")).toHaveTextContent("ready:库"));
    fail = true;
    await userEvent.click(screen.getByRole("button", { name: "读取" }));
    await waitFor(() => expect(screen.getByTestId("state")).toHaveTextContent(/^error:/));
  });

  it("does not keep another address's answer under this address's failure", async () => {
    const report = vi.fn<VcrRefreshReporter>();
    function Switch() {
      const [page, setPage] = useState(0);
      return <><Reader readKey={`std_1:rows:${page}`} load={async () => { if (page === 1) throw down(); return `页${page}`; }} /><button type="button" onClick={() => setPage(1)}>下一页</button></>;
    }
    render(<VcrRefreshContext.Provider value={report}><Switch /></VcrRefreshContext.Provider>);
    await waitFor(() => expect(screen.getByTestId("state")).toHaveTextContent("ready:页0"));
    await userEvent.click(screen.getByRole("button", { name: "下一页" }));
    await waitFor(() => expect(screen.getByTestId("state")).toHaveTextContent(/^error:/));
  });
});

describe("the sentence for a read that failed", () => {
  it("says the last answer is still shown and offers 重试", async () => {
    const retry = vi.fn();
    render(<VcrRefreshNote message="服务暂时不可用，请稍后重试。" onRetry={retry} />);
    expect(screen.getByText(/更新暂时失败，仍显示上次结果。服务暂时不可用/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });
});

describe("a changed key", () => {
  function Rows({ readKey, load }: { readKey: string; load: () => Promise<string> }) {
    const { state, last, refreshing, carried } = useVcrLoad(readKey, load);
    return <p data-testid="rows">{`${state.kind}|${last ?? "-"}|${refreshing ? "refreshing" : "-"}|${carried ?? "-"}`}</p>;
  }
  it("never hands out the previous key's answer, not even in the render after the change, and a failed read leaves nothing", async () => {
    function Switch() {
      const [page, setPage] = useState(0);
      return <><Rows readKey={`vcr:rows:${page}`} load={async () => { if (page === 1) throw new WebApiError("no", { status: 403 }); return `页${page}`; }} /><button type="button" onClick={() => setPage(1)}>下一页</button></>;
    }
    render(<Switch />);
    await waitFor(() => expect(screen.getByTestId("rows")).toHaveTextContent("ready|页0|-|页0"));
    await userEvent.click(screen.getByRole("button", { name: "下一页" }));
    await waitFor(() => expect(screen.getByTestId("rows")).toHaveTextContent(/^error\|-\|-\|页0$/));
  });
  it("keeps the answer through a re-read of the same key and says it is refreshing", async () => {
    let release: () => void = () => undefined;
    let calls = 0;
    function Again() {
      const hook = useVcrLoad("vcr:same", async () => { calls += 1; if (calls > 1) await new Promise<void>((resolve) => { release = resolve; }); return `读${calls}`; });
      return <><p data-testid="rows">{`${hook.state.kind}|${hook.last ?? "-"}|${hook.refreshing ? "refreshing" : "-"}`}</p><button type="button" onClick={hook.reload}>读取</button></>;
    }
    render(<Again />);
    await waitFor(() => expect(screen.getByTestId("rows")).toHaveTextContent("ready|读1|-"));
    await userEvent.click(screen.getByRole("button", { name: "读取" }));
    await waitFor(() => expect(screen.getByTestId("rows")).toHaveTextContent("ready|读1|refreshing"));
    await act(async () => { release(); });
    await waitFor(() => expect(screen.getByTestId("rows")).toHaveTextContent("ready|读2|-"));
  });
});
