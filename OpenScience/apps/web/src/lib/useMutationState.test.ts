import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { AmbiguousMutationError, useMutationState } from "./useMutationState";
it("locks concurrent calls and preserves ambiguous failures until reconciliation",async()=>{
 const {result}=renderHook(()=>useMutationState());let reject!:(e:Error)=>void;
 const operation=vi.fn(()=>new Promise((_,r)=>{reject=r;}));let task!:Promise<unknown>;
 act(()=>{task=result.current.run(operation);});await act(async()=>{await result.current.run(operation);});expect(operation).toHaveBeenCalledOnce();
 await act(async()=>{reject(new AmbiguousMutationError("Unknown outcome"));await expect(task).rejects.toThrow("Unknown outcome");});
 expect(result.current.ambiguous).toBe(true);expect(result.current.pending).toBe(false);act(()=>result.current.reconcile());expect(result.current.error).toBeNull();
});

it("treats transport failures as unknown outcomes and refuses another write until readback",async()=>{
 const {result}=renderHook(()=>useMutationState());const operation=vi.fn(async()=>{throw new TypeError('Failed to fetch');});
 await act(async()=>{await expect(result.current.run(operation)).rejects.toThrow('Failed to fetch');});
 expect(result.current.ambiguous).toBe(true);await act(async()=>{await result.current.run(operation);});expect(operation).toHaveBeenCalledOnce();
 act(()=>result.current.reconcile());await act(async()=>{await expect(result.current.run(operation)).rejects.toThrow();});expect(operation).toHaveBeenCalledTimes(2);
});
