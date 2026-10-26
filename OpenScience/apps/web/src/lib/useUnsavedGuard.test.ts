import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useUnsavedGuard } from "./useUnsavedGuard";
it("guards local exits and unload, retains the draft on cancel and closes on explicit discard",()=>{
 const close=vi.fn();const {result,unmount}=renderHook(()=>useUnsavedGuard(true,close));
 act(()=>result.current.requestClose());expect(close).not.toHaveBeenCalled();expect(result.current.confirming).toBe(true);
 act(()=>result.current.keepEditing());expect(result.current.confirming).toBe(false);
 const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);expect(event.defaultPrevented).toBe(true);
 act(()=>result.current.discard());expect(close).toHaveBeenCalledOnce();unmount();
});
