import { expect, it, vi } from "vitest";
import { StaleSessionError, WEB_SESSION_ENDED_EVENT, WEB_SESSION_STARTED_EVENT } from "./sessionLifecycle";
const command = vi.hoisted(() => vi.fn());
vi.mock("./apiClient", () => ({ hasWebApi: true, invokeCommand: command }));
import { uploadFilesToWorkspace } from "./backend";
function file(name: string) { return { name, arrayBuffer: async () => new ArrayBuffer(1) } as File; }
it.each([false, true])("stops remaining files after account changes, even on rejection=%s", async reject => {
  command.mockReset();
  let settle!: () => void;
  command.mockImplementationOnce(() => new Promise((yes, no) => { settle = () => reject ? no(new StaleSessionError()) : yes("first"); }));
  const task = uploadFilesToWorkspace([file("a"), file("b")], "knowledge-base", "base", "default");
  await vi.waitFor(() => expect(command).toHaveBeenCalledTimes(1));
  window.dispatchEvent(new Event(WEB_SESSION_ENDED_EVENT)); window.dispatchEvent(new Event(WEB_SESSION_STARTED_EVENT));
  settle(); await expect(task).rejects.toBeInstanceOf(StaleSessionError);
  expect(command).toHaveBeenCalledTimes(1);
});
it("does not send bytes read across a session boundary", async () => {
  command.mockReset(); let finish!: (bytes: ArrayBuffer) => void;
  const task = uploadFilesToWorkspace([{ name: "private", arrayBuffer: () => new Promise<ArrayBuffer>(resolve => { finish = resolve; }) } as File]);
  window.dispatchEvent(new Event(WEB_SESSION_ENDED_EVENT)); finish(new ArrayBuffer(1));
  await expect(task).rejects.toBeInstanceOf(StaleSessionError); expect(command).not.toHaveBeenCalled();
});
it("uploads every file in the same session", async () => {
  command.mockReset().mockResolvedValue("saved");
  await expect(uploadFilesToWorkspace([file("a"), file("b")])).resolves.toEqual(["saved", "saved"]);
});
it("does not send bytes after the owning component unmounts during file reading", async () => {
  command.mockReset(); let mounted = true, finish!: (bytes: ArrayBuffer) => void;
  const task = uploadFilesToWorkspace([{ name: "private", arrayBuffer: () => new Promise<ArrayBuffer>(resolve => { finish = resolve; }) } as File], "", "workspace", "default", () => mounted);
  mounted = false; finish(new ArrayBuffer(1));
  await expect(task).rejects.toBeInstanceOf(StaleSessionError); expect(command).not.toHaveBeenCalled();
});
