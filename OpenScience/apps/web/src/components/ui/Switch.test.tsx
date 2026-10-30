import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { Switch } from "./Switch";
import { AmbiguousMutationError, RejectedMutationError } from "@/lib/mutationOutcome";

it("optimistically flips once and locks repeated activation until confirmed rejection", async()=>{
 let reject!:(reason:Error)=>void;const change=vi.fn(()=>new Promise((_,r)=>{reject=r;}));
 render(<Switch label="Memory" checked={false} onChange={change}/>);const control=screen.getByRole("switch");
 fireEvent.click(control);fireEvent.click(control);expect(change).toHaveBeenCalledOnce();expect(control).toHaveAttribute("aria-checked","true");
 await act(async()=>reject(new RejectedMutationError("Rejected")));expect(control).toHaveAttribute("aria-checked","false");expect(screen.getByText("设置未能保存，请重试。")).toBeInTheDocument();
});
it("retains an ambiguous optimistic result and waits for reconciliation",async()=>{
 const change=vi.fn(async()=>{throw new AmbiguousMutationError("Timeout");});render(<Switch label="Memory" checked={false} onChange={change}/>);
 await act(async()=>fireEvent.click(screen.getByRole("switch")));expect(screen.getByRole("switch")).toHaveAttribute("aria-checked","true");
 fireEvent.click(screen.getByRole("switch"));expect(change).toHaveBeenCalledOnce();expect(screen.getByText(/结果待确认/)).toBeInTheDocument();
});

// R1 P2-2: an unknown outcome is not a "not saved": the old line told a reader to retry a write that may have gone through.
it("never says an unknown outcome was not saved, and uses the caller's own sentence for it",async()=>{
 const own=vi.fn(async()=>{throw new AmbiguousMutationError("写入后的状态暂时无法核对。");});
 const view=render(<Switch label="Memory" checked={false} onChange={own}/>);
 await act(async()=>fireEvent.click(screen.getByRole("switch")));
 expect(screen.getByText("写入后的状态暂时无法核对；结果待确认，请刷新状态")).toBeInTheDocument();
 view.unmount();
 const dropped=vi.fn(async()=>{throw new TypeError("Failed to fetch");});
 render(<Switch label="Memory" checked={false} onChange={dropped}/>);
 await act(async()=>fireEvent.click(screen.getByRole("switch")));
 expect(screen.getByText("没有收到保存结果；结果待确认，请刷新状态")).toBeInTheDocument();
 expect(screen.queryByText(/未能保存|请重试/)).toBeNull();
});

it("unlocks an ambiguous write only after an authoritative reconciliation key changes",async()=>{
 const change=vi.fn(async()=>{throw new AmbiguousMutationError("Timeout");});
 const view=render(<Switch label="Memory" checked={false} reconciliationKey={0} onChange={change}/>);
 await act(async()=>fireEvent.click(screen.getByRole('switch')));
 view.rerender(<Switch label="Memory" checked={false} reconciliationKey={1} onChange={change}/>);
 expect(screen.getByRole('switch')).toHaveAttribute('aria-checked','false');expect(screen.queryByText(/结果待确认/)).toBeNull();
 await act(async()=>fireEvent.click(screen.getByRole('switch')));expect(change).toHaveBeenCalledTimes(2);
});
