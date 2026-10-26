import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { Switch } from "./Switch";
import { AmbiguousMutationError, RejectedMutationError } from "@/lib/useMutationState";

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

it("unlocks an ambiguous write only after an authoritative reconciliation key changes",async()=>{
 const change=vi.fn(async()=>{throw new AmbiguousMutationError("Timeout");});
 const view=render(<Switch label="Memory" checked={false} reconciliationKey={0} onChange={change}/>);
 await act(async()=>fireEvent.click(screen.getByRole('switch')));
 view.rerender(<Switch label="Memory" checked={false} reconciliationKey={1} onChange={change}/>);
 expect(screen.getByRole('switch')).toHaveAttribute('aria-checked','false');expect(screen.queryByText(/结果待确认/)).toBeNull();
 await act(async()=>fireEvent.click(screen.getByRole('switch')));expect(change).toHaveBeenCalledTimes(2);
});
