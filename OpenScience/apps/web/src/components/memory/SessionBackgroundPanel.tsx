import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Drawer } from "@/components/ui/Drawer";
import {
  MEMORY_CHANGED_EVENT,
  announceMemoryChanged,
  archiveMemoryRecord,
  bringBackForSession,
  fetchSessionBackground,
  restoreLearnedMethod,
  retireCapsuleEntry,
  retireLearnedMethod,
  setAsideForSession,
  undoCapsuleEntry,
  undoMemoryRecord,
  type MemoryChange,
  type SessionBackground,
  type SessionBackgroundMemory,
  type SessionBackgroundMethod,
  type SessionExclusion,
  type SessionMemoryState,
} from "@/lib/memoryClient";
import { MEMORY_BASIS_LABELS, memoryKindLabel, memoryStrength } from "@/lib/memoryText";
import { capsuleEntryLabel } from "@/lib/capsuleText";
import { productErrorMessage } from "@/lib/productClient";
import { toast } from "@/lib/toast";

/** While the panel is open, how often it re-reads: a run in progress keeps
 *  recalling, and the panel should show what it pulled in. */
const REFRESH_MS = 20_000;

const METHOD_SOURCE_LABELS: Record<SessionBackgroundMethod["source"], string> = {
  learned: "学到的方法",
  capsule: "胶囊里的方法",
  earlier: "之前装载过",
};

function exclusionFor(item: SessionBackgroundMemory): SessionExclusion {
  return { type: item.type, id: item.id, label: item.summary.slice(0, 60) };
}

function methodExclusion(method: SessionBackgroundMethod): SessionExclusion {
  return { type: "method", id: method.name, label: method.label === method.name ? "" : method.label.slice(0, 60) };
}

function memoryMeta(item: SessionBackgroundMemory): string {
  const kind = item.type === "capsule" ? capsuleEntryLabel(item.kind) : memoryKindLabel(item.kind);
  const origin = item.type === "capsule"
    ? "来自记忆胶囊"
    : item.provenance ? memoryStrength(item.provenance) : item.basis ? MEMORY_BASIS_LABELS[item.basis] : "";
  const used = item.runIds.length > 1 ? `本次对话中用过 ${item.runIds.length} 次` : "本次对话中用过";
  return [kind, origin, used].filter(Boolean).join(" · ");
}

/**
 * 「本次用到的背景」: everything this conversation was handed — the memories
 * each of its runs recalled, the methods its runtime has mounted — and what it
 * wrote down by itself, each with the way to take it back.
 *
 * Two different takebacks, said apart on purpose (proposal §4.5): 「不对」 is
 * about the memory — it stops being used anywhere, as a revision the next
 * toast can undo — while 「本次不用」 is about this conversation only and
 * leaves the memory as it is. Neither asks first.
 */
export function SessionBackgroundPanel({
  sessionId,
  incognito,
  onClose,
  onStateChange,
}: {
  sessionId: string;
  incognito: boolean;
  onClose: () => void;
  onStateChange: (state: SessionMemoryState) => void;
}) {
  const [background, setBackground] = useState<SessionBackground | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setBackground(await fetchSessionBackground(sessionId));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    const reload = () => void load();
    window.addEventListener(MEMORY_CHANGED_EVENT, reload);
    return () => { clearInterval(timer); window.removeEventListener(MEMORY_CHANGED_EVENT, reload); };
  }, [load]);

  const act = async (key: string, operation: () => Promise<void>) => {
    setBusy(key);
    try {
      await operation();
    } catch (error) {
      toast.error(`没有完成：${productErrorMessage(error)}`);
    } finally {
      setBusy(null);
      announceMemoryChanged();
    }
  };

  const toggleAside = (key: string, item: SessionExclusion, setAside: boolean) => act(key, async () => {
    onStateChange(setAside ? await bringBackForSession(sessionId, item) : await setAsideForSession(sessionId, item));
    toast.success(setAside ? "已恢复：这段对话会重新用到它" : "这段对话里不再用它，记忆本身没有改动");
  });

  const wrongMemory = (item: SessionBackgroundMemory) => act(`wrong:${item.type}:${item.id}`, async () => {
    if (item.type === "memory" && item.version) {
      const archived = await archiveMemoryRecord(item.id, item.version);
      toast.success("已停用这条记忆，之后的对话不会再用到它", {
        action: { label: "撤销", onClick: () => void undoMemoryRecord(item.id, archived.version).then(announceMemoryChanged, (error) => toast.error(productErrorMessage(error))) },
      });
    } else if (item.type === "capsule" && item.capsuleId && item.revision) {
      const capsuleId = item.capsuleId;
      const retired = await retireCapsuleEntry(capsuleId, item.id, item.revision);
      toast.success("已停用这条胶囊内容", {
        action: { label: "撤销", onClick: () => void undoCapsuleEntry(capsuleId, retired).then(announceMemoryChanged, (error) => toast.error(productErrorMessage(error))) },
      });
    }
  });

  const wrongMethod = (method: SessionBackgroundMethod) => act(`wrong:method:${method.name}`, async () => {
    if (method.source === "learned" && method.methodId && method.revision) {
      const { methodId, revision } = method;
      const retired = await retireLearnedMethod(methodId, revision);
      toast.success("已停用这个方法，下次启动运行时不再装载", {
        action: { label: "撤销", onClick: () => void restoreLearnedMethod(methodId, retired.revision, revision).then(announceMemoryChanged, (error) => toast.error(productErrorMessage(error))) },
      });
    } else if (method.source === "capsule" && method.capsuleId && method.entryId && method.revision) {
      const capsuleId = method.capsuleId;
      const retired = await retireCapsuleEntry(capsuleId, method.entryId, method.revision);
      toast.success("已停用这个方法，下次启动运行时不再装载", {
        action: { label: "撤销", onClick: () => void undoCapsuleEntry(capsuleId, retired).then(announceMemoryChanged, (error) => toast.error(productErrorMessage(error))) },
      });
    }
  });

  const undoWritten = (change: MemoryChange) => act(`undo:${change.id}`, async () => {
    await undoMemoryRecord(change.id, change.version);
    toast.success(change.change === "created" ? "已撤销：这条没有记下" : "已撤销这次改动");
  });

  const memories = background?.memories ?? [];
  const methods = background?.methods ?? [];
  const written = background?.written ?? [];
  const empty = background !== null && memories.length === 0 && methods.length === 0 && written.length === 0;

  return (
    <Drawer
      title="本次用到的背景"
      description="「不对」会停用这一条，可撤销；「本次不用」只在这段对话里不再用它。"
      onClose={onClose}
      widthClassName="max-w-md"
    >
      {incognito && (
        <p className="mb-4 rounded-card border border-border bg-surface-2 px-4 py-3 text-ui text-text">
          无痕对话：开启之后，这段对话不再调取记忆，结束后也不会记下任何内容。项目里已装载的方法和胶囊中的基本偏好仍会生效。
        </p>
      )}
      {failed && background === null ? (
        <div role="alert" className="flex flex-col items-start gap-3 text-ui text-muted">
          <p>暂时读不到这段对话的背景。对话本身不受影响。</p>
          <Button variant="ghost" size="sm" onClick={() => void load()}>重试</Button>
        </div>
      ) : background === null ? (
        <p role="status" className="text-ui text-muted">正在读取…</p>
      ) : empty ? (
        <p className="text-ui text-muted">这段对话还没有用到记忆或方法，也没有记下新内容。</p>
      ) : (
        <div className="flex flex-col gap-6">
          <section aria-labelledby="session-memories">
            <h3 id="session-memories" className="text-ui font-medium text-text">记忆（{memories.length}）</h3>
            {memories.length === 0 ? (
              <p className="mt-2 text-ui text-muted">这段对话还没有调取记忆。</p>
            ) : (
              <ul className="mt-2 divide-y divide-border rounded-card border border-border">
                {memories.map((item) => {
                  const key = `${item.type}:${item.id}`;
                  return (
                    <li key={key} className="px-4 py-3">
                      <p className="text-ui text-text">{item.available ? item.summary : "这条记忆之后已被删除。"}</p>
                      <p className="mt-0.5 text-caption text-muted">{memoryMeta(item)}{item.setAside ? " · 本次不用" : ""}</p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {item.available && item.type !== "note" && (
                          <Button variant="ghost" size="sm" loading={busy === `wrong:${key}`} disabled={busy !== null}
                            onClick={() => void wrongMemory(item)}>不对</Button>
                        )}
                        <Button variant="ghost" size="sm" loading={busy === `aside:${key}`} disabled={busy !== null}
                          aria-pressed={item.setAside}
                          onClick={() => void toggleAside(`aside:${key}`, exclusionFor(item), item.setAside)}>
                          {item.setAside ? "恢复使用" : "本次不用"}
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section aria-labelledby="session-methods">
            <h3 id="session-methods" className="text-ui font-medium text-text">方法（{methods.length}）</h3>
            {methods.length === 0 ? (
              <p className="mt-2 text-ui text-muted">这个项目的运行时没有装载方法。</p>
            ) : (
              <ul className="mt-2 divide-y divide-border rounded-card border border-border">
                {methods.map((method) => {
                  const key = `method:${method.name}`;
                  return (
                    <li key={key} className="px-4 py-3">
                      <p className="text-ui text-text">{method.label}</p>
                      {method.description && method.description !== method.label && (
                        <p className="mt-0.5 text-ui text-muted">{method.description}</p>
                      )}
                      <p className="mt-0.5 text-caption text-muted">
                        {[METHOD_SOURCE_LABELS[method.source], method.trial ? "试用中" : "",
                          method.used ? "本次对话中用过" : "已装载，本次还没用到", method.setAside ? "本次不用" : ""]
                          .filter(Boolean).join(" · ")}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {method.source !== "earlier" && method.available !== false && (
                          <Button variant="ghost" size="sm" loading={busy === `wrong:${key}`} disabled={busy !== null}
                            onClick={() => void wrongMethod(method)}>不对</Button>
                        )}
                        <Button variant="ghost" size="sm" loading={busy === `aside:${key}`} disabled={busy !== null}
                          aria-pressed={method.setAside}
                          onClick={() => void toggleAside(`aside:${key}`, methodExclusion(method), method.setAside)}>
                          {method.setAside ? "恢复使用" : "本次不用"}
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section aria-labelledby="session-written">
            <h3 id="session-written" className="text-ui font-medium text-text">本次新记下（{written.length}）</h3>
            {written.length === 0 ? (
              <p className="mt-2 text-ui text-muted">{incognito ? "无痕对话不会记下新内容。" : "这段对话还没有记下新内容。"}</p>
            ) : (
              <ul className="mt-2 divide-y divide-border rounded-card border border-border">
                {written.map((change) => (
                  <li key={change.id} className="px-4 py-3">
                    <p className="text-ui text-text">{change.summary}</p>
                    <p className="mt-0.5 text-caption text-muted">
                      {[memoryKindLabel(change.kind), change.provenance ? memoryStrength(change.provenance) : "",
                        change.replaced ? `替换了「${change.replaced.summary}」` : change.change === "created" ? "新记下" : "更新"]
                        .filter(Boolean).join(" · ")}
                    </p>
                    <div className="mt-2">
                      <Button variant="ghost" size="sm" loading={busy === `undo:${change.id}`} disabled={busy !== null}
                        onClick={() => void undoWritten(change)}>撤销</Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </Drawer>
  );
}
