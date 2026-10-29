import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TOAST_DURATIONS } from "@evimed/design-tokens";
import { MAX_TOASTS, toast, toastDuration, useToastStore } from "./toast";

describe("toast store", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useToastStore.setState({ toasts: [] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // Spec §22.1, appendix E #7: a success 5 s, with an action 10 s, and an
  // error stays until it is closed.
  it("keeps a success for 5 s, one with an action for 10 s, and an error until it is closed", () => {
    toast.success("已保存");
    toast.success("已归档", { action: { label: "撤销", onClick: () => {} } });
    toast.error("无法保存 b.svg");
    expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual(["已保存", "已归档", "无法保存 b.svg"]);

    vi.advanceTimersByTime(4999);
    expect(useToastStore.getState().toasts).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual(["已归档", "无法保存 b.svg"]);

    vi.advanceTimersByTime(5000);
    expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual(["无法保存 b.svg"]);

    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual(["无法保存 b.svg"]);
  });

  it("reads its durations from the token table", () => {
    expect(toastDuration("success", false)).toBe(TOAST_DURATIONS.success);
    expect(toastDuration("success", true)).toBe(TOAST_DURATIONS.action);
    expect(toastDuration("error", false)).toBeNull();
    expect(toastDuration("error", true)).toBeNull();
  });

  it("shows at most three, and a fourth sends the oldest away", () => {
    toast.error("一");
    toast.success("二");
    toast.success("三");
    toast.success("四");
    expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual(["二", "三", "四"]);
    expect(MAX_TOASTS).toBe(3);
  });

  it("dismisses a single toast by id", () => {
    toast.success("one");
    toast.success("two");
    const [first] = useToastStore.getState().toasts;
    useToastStore.getState().dismiss(first.id);
    expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual(["two"]);
  });

  it("pause freezes the timer and resume continues with the remaining time", () => {
    toast.success("hover me");
    const [{ id }] = useToastStore.getState().toasts;

    vi.advanceTimersByTime(1000); // 4000ms left
    useToastStore.getState().pause(id);
    vi.advanceTimersByTime(10000);
    expect(useToastStore.getState().toasts).toHaveLength(1);

    useToastStore.getState().resume(id);
    vi.advanceTimersByTime(3999);
    expect(useToastStore.getState().toasts).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it("stores an optional action on the toast", () => {
    const onClick = vi.fn();
    toast.success("Archived", { action: { label: "撤销", onClick } });
    const [t] = useToastStore.getState().toasts;
    expect(t.action).toEqual({ label: "撤销", onClick });
  });
});

it("counts repeated explicit event identities and keeps unrelated tasks and legacy calls separate",()=>{
 useToastStore.setState({toasts:[]});toast.error('Failure',{eventId:'write',entityId:'a'});toast.error('  Failure ',{eventId:'write',entityId:'a'});
 expect(useToastStore.getState().toasts).toHaveLength(1);expect(useToastStore.getState().toasts[0].occurrences).toBe(2);
 toast.error('Failure',{eventId:'write',entityId:'b'});expect(useToastStore.getState().toasts).toHaveLength(2);
 useToastStore.setState({toasts:[]});toast.error('Same text');toast.error('Same text');expect(useToastStore.getState().toasts).toHaveLength(2);
});
it("preserves separate undo actions even when event labels repeat",()=>{
 useToastStore.setState({toasts:[]});const first=vi.fn(),second=vi.fn();toast.success('Removed',{eventId:'remove',entityId:'same',action:{label:'Undo',onClick:first}});toast.success('Removed',{eventId:'remove',entityId:'same',action:{label:'Undo',onClick:second}});
 expect(useToastStore.getState().toasts).toHaveLength(2);expect(useToastStore.getState().toasts.map(t=>t.action?.onClick)).toEqual([first,second]);
});

it("clears retained messages/actions/timers and refuses former-session producers", async () => {
 const { WEB_SESSION_ENDED_EVENT, WEB_SESSION_STARTED_EVENT, sessionGeneration } = await import("./sessionLifecycle");
 vi.useFakeTimers(); const owner = sessionGeneration(); const undo = vi.fn();
 toast.error("private A", {action:{label:"Undo", onClick:undo}});
 window.dispatchEvent(new Event(WEB_SESSION_ENDED_EVENT)); window.dispatchEvent(new Event(WEB_SESSION_STARTED_EVENT));
 expect(useToastStore.getState().toasts).toEqual([]);
 toast.success("late A", {sessionGeneration:owner}); expect(useToastStore.getState().toasts).toEqual([]);
 toast.success("B"); expect(useToastStore.getState().toasts.map(item=>item.message)).toEqual(["B"]);
 window.dispatchEvent(new Event(WEB_SESSION_STARTED_EVENT)); vi.runAllTimers();
 expect(useToastStore.getState().toasts).toEqual([]); expect(undo).not.toHaveBeenCalled(); vi.useRealTimers();
});
