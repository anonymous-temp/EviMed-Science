import { useEffect, useState } from "react";
import { formatDay } from "@/lib/format";
import {
  handbookDetail, handbookVersions, retireHandbook, rollbackHandbook, type WebHandbook, type WebHandbookDetail,
} from "@/lib/handbooksClient";
import { announceMemoryChanged } from "@/lib/memoryClient";
import {
  methodSources, methodTitle, methodVersions, retireMethod, rollbackMethod, type ConversationSource, type MethodVersion, type WebMethod,
} from "@/lib/methodsClient";
import { productErrorMessage } from "@/lib/productClient";
import { toast } from "@/lib/toast";
import { MarkdownViewer } from "@/components/markdown-viewer/MarkdownViewer";
import { Button } from "@/components/ui/Button";
import { Drawer } from "@/components/ui/Drawer";
import { ConversationLink } from "./ConversationLink";
import { DrawerSection } from "./DrawerSection";

/** What a drawer can say about a read that has not answered: nothing yet, or that it could not. */
type Loaded<T> = T | null | "failed";

interface PracticeView {
  /** The row's own title, which is also the drawer's. */
  title: string;
  /** What it is: 「做法」, or the research tool a handbook is for. */
  kind: string;
  /** Whose it is: 从你的对话中学到, or 你定下的. */
  origin: string;
  /** Which version the researcher is on, once known. */
  version: number | null;
  at: string | null;
  steps: string | null;
  stepsLoading: boolean;
  whenToUse: string;
  sources: Loaded<ConversationSource[]>;
  versions: Loaded<MethodVersion[]>;
  busy: boolean;
  onGoBack: () => void;
  onStop: () => void;
  onClose: () => void;
}

/**
 * A learned method or a capability handbook, opened from its row (2026-10-07
 * plan §3.2 item 4): how it is done, when it is used, which conversations it
 * was learned from, the versions it has had — and the two things a researcher
 * can do about it, 回到上一版 and 不再使用.
 *
 * There is no form to edit one, and none will be added: a method is what the
 * model learned from the work, never something the researcher types (owner
 * ruling 2026-09-20). To change one they say so in a conversation, and the
 * loop learns it. The drawer is read-only text and two undo buttons.
 *
 * It says nothing about whether the practice has been measured. A handbook's
 * `verification` is the loop's bookkeeping; no evaluator can honestly compare a
 * handbook with and without it under the learning budget, so a state that never
 * moved is not on the page (plan §3.2 item 5, report).
 */
function PracticeDrawerView({ view }: { view: PracticeView }) {
  const [reading, setReading] = useState<number | null>(null);
  const earlier = Array.isArray(view.versions) ? view.versions.filter((version) => !version.current) : [];
  const canGoBack = Array.isArray(view.versions) && view.versions.length > 1;
  const meta = [view.kind, view.origin, view.version ? `第 ${view.version} 版` : "", formatDay(view.at)].filter(Boolean).join(" · ");

  return (
    <Drawer title={view.title} description={meta} onClose={view.onClose}>
      <div className="flex min-h-full flex-col gap-6">
        {(view.steps || view.stepsLoading) && (
          <DrawerSection label="怎么做">
            {view.steps ? <MarkdownViewer className="text-ui text-text">{view.steps}</MarkdownViewer> : <p role="status" className="text-ui text-text-3">正在读取</p>}
          </DrawerSection>
        )}
        {view.whenToUse && (
          <DrawerSection label="什么时候用">
            <p className="max-w-measure text-ui text-text">{view.whenToUse}</p>
          </DrawerSection>
        )}
        {Array.isArray(view.sources) && view.sources.length > 0 && (
          <DrawerSection label="从哪里学到的">
            <ul className="space-y-1">
              {view.sources.map((source) => (
                <li key={`${source.projectId}:${source.sessionId}`}>
                  <ConversationLink projectId={source.projectId} sessionId={source.sessionId}>
                    {[source.title || "来源对话", formatDay(source.at)].filter(Boolean).join(" · ")}
                  </ConversationLink>
                </li>
              ))}
            </ul>
          </DrawerSection>
        )}
        {view.versions === "failed" && <p className="text-ui text-text-3">暂时读不到以前的版本。</p>}
        {earlier.length > 0 && (
          <DrawerSection label="以前的版本">
            <ul className="space-y-2">
              {earlier.map((version) => (
                <li key={version.revision} className="text-ui text-text-2">
                  <span>{[`第 ${version.version} 版`, formatDay(version.at)].filter(Boolean).join(" · ")} · </span>
                  <button type="button" aria-expanded={reading === version.version} onClick={() => setReading(reading === version.version ? null : version.version)}
                    className="text-accent hover:underline">{reading === version.version ? "收起" : "查看"}</button>
                  {reading === version.version && (
                    <div className="mt-2 space-y-2 border-l border-border pl-3">
                      {version.summary && <p className="text-ui text-text">{version.summary}</p>}
                      {(version.steps || version.body) && <MarkdownViewer className="text-ui text-text-2">{version.steps ?? version.body ?? ""}</MarkdownViewer>}
                      {version.whenToUse && <p className="text-caption text-text-3">什么时候用：{version.whenToUse}</p>}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </DrawerSection>
        )}
        <div className="mt-auto flex gap-2">
          {canGoBack && <Button variant="secondary" disabled={view.busy} onClick={view.onGoBack}>回到上一版</Button>}
          <Button variant="text" disabled={view.busy} onClick={view.onStop}>不再使用</Button>
        </div>
      </div>
    </Drawer>
  );
}

/** Read what a drawer needs from the control plane, once per version of the thing it opens; "failed" says it could not be read. */
function useLoaded<T>(read: () => Promise<T>, key: string): Loaded<T> {
  const [value, setValue] = useState<Loaded<T>>(null);
  useEffect(() => {
    let active = true;
    setValue(null);
    read().then((next) => { if (active) setValue(next); }, () => { if (active) setValue("failed"); });
    return () => { active = false; };
    // The key names the thing and its revision: a new version is a new read, a re-render is not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return value;
}

/** The method's own sentence about its origin: the researcher's words, or what EviMed learned from their work. */
function methodOrigin(method: WebMethod) {
  return method.origin === "explicit" ? "你定下的" : "从你的对话中学到";
}

export function MethodDrawer({ method, onClose, onChanged }: { method: WebMethod; onClose: () => void; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const versions = useLoaded(async () => (await methodVersions(method)).items, `${method.id}:${method.revision}`);
  const sources = useLoaded(async () => (await methodSources(method)).items, `${method.id}:${method.revision}`);
  const title = methodTitle(method);

  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    try {
      await operation();
      announceMemoryChanged();
      onChanged();
    } catch (error) {
      toast.error(productErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  const stop = () => run(async () => {
    const stopped = await retireMethod(method, "在记忆页里停用");
    onClose();
    toast.success(`已停用“${title}”`, {
      action: {
        label: "撤销",
        onClick: () => void rollbackMethod(stopped, stopped.revision - 1)
          .then(() => { announceMemoryChanged(); onChanged(); }, (error) => toast.error(productErrorMessage(error))),
      },
    });
  });
  // What 「回到上一版」 means is the server's to decide from the record: the previous body, never the previous counter.
  const goBack = () => run(async () => {
    await rollbackMethod(method, method.revision - 1);
    onClose();
    toast.success(`“${title}”已回到上一版`);
  });

  return (
    <PracticeDrawerView view={{
      title, kind: "做法", origin: methodOrigin(method), version: method.version ?? 1, at: method.bodyUpdatedAt ?? method.updatedAt,
      // The steps in the researcher's language when there are any; the SKILL.md written for the model otherwise.
      steps: method.steps ?? (method.body || null), stepsLoading: false,
      whenToUse: method.scope?.applicability || method.whenToUse || "",
      sources, versions, busy, onGoBack: () => void goBack(), onStop: () => void stop(), onClose,
    }} />
  );
}

export function HandbookDrawer({ handbook, tool, onClose, onChanged }: { handbook: WebHandbook; tool: string; onClose: () => void; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const key = `${handbook.id}:${handbook.revision}`;
  const detail: Loaded<WebHandbookDetail> = useLoaded(() => handbookDetail(handbook), key);
  const versions = useLoaded(async () => (await handbookVersions(handbook)).items, key);
  const read = detail && detail !== "failed" ? detail : null;
  const current = Array.isArray(versions) ? versions.find((version) => version.current) ?? versions[0] : null;

  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    try {
      await operation();
      announceMemoryChanged();
      onChanged();
    } catch (error) {
      toast.error(productErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  const stop = () => run(async () => {
    const stopped = await retireHandbook(handbook, "在记忆页里停用");
    onClose();
    toast.success(`已停用“${handbook.title}”`, {
      action: {
        label: "撤销",
        onClick: () => void rollbackHandbook(stopped, stopped.revision - 1)
          .then(() => { announceMemoryChanged(); onChanged(); }, (error) => toast.error(productErrorMessage(error))),
      },
    });
  });
  // A handbook goes back to a version by naming it: the one before the one in force.
  const goBack = () => run(async () => {
    const previous = Array.isArray(versions) ? versions.filter((version) => !version.current)[0] : null;
    if (!previous) return;
    await rollbackHandbook(handbook, previous.revision);
    onClose();
    toast.success(`“${handbook.title}”已回到上一版`);
  });

  return (
    <PracticeDrawerView view={{
      title: handbook.title, kind: `用在${tool}`, origin: "从你的对话中学到", version: current?.version ?? null, at: handbook.appliedAt ?? handbook.updatedAt,
      steps: read ? read.steps ?? (read.body || null) : null, stepsLoading: detail === null,
      whenToUse: handbook.whenToUse || read?.whenToUse || "",
      sources: read ? read.sources : detail === "failed" ? "failed" : null, versions, busy, onGoBack: () => void goBack(), onStop: () => void stop(), onClose,
    }} />
  );
}
