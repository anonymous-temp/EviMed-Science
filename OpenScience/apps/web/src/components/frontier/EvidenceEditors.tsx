import { useContext, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { UNSAFE_DataRouterContext, useBlocker } from "react-router";
import { useEvidenceScope } from "./useEvidenceScope";
import type { FrontierItem } from "@/lib/frontierClient";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Input, Textarea, inputClasses } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import {
  saveEvidenceZone,
  saveEvidenceCard,
  type EvidenceZone,
  type EvidenceCard,
  type EvidenceCardInput,
} from "@/lib/evidenceZoneClient";
import { evidenceErrorMessage } from "@/lib/evidenceZoneClient";

export function ZoneEditor({
  zone,
  onSaved,
  onCancel,
}: {
  zone?: EvidenceZone;
  onSaved: (zone: EvidenceZone) => void;
  onCancel: () => void;
}) {
  const capture = useEvidenceScope(zone?.id || "new-zone");
  const request = useRef({ payload: "", id: "" });
  const [title, setTitle] = useState(zone?.title || "");
  const [description, setDescription] = useState(zone?.description || "");
  const [background, setBackground] = useState(zone?.background || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const dirty =
    title !== (zone?.title || "") ||
    description !== (zone?.description || "") ||
    background !== (zone?.background || "");
  useDirtyWarning(dirty && !saved);
  return (
    <>
      <DirtyNavigation dirty={dirty && !saved} />
      <form
        className="space-y-4 rounded-card bg-surface-2 p-4"
        onSubmit={(event) => {
          event.preventDefault();
          const current = capture();
          setBusy(true);
          setError(null);
          saveEvidenceZone(
            { title: title.trim(), description, background },
            zone,
            submissionId(request, {
              title: title.trim(),
              description,
              background,
            }),
          )
            .then((saved) => {
              if (current()) {
                flushSync(() => setSaved(true));
                onSaved(saved);
              }
            })
            .catch((reason) => {
              if (current()) setError(evidenceErrorMessage(reason));
            })
            .finally(() => {
              if (current()) setBusy(false);
            });
        }}
      >
        <fieldset disabled={busy} className="space-y-4">
          <Input
            label="专区名称"
            required
            maxLength={300}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
          <Textarea
            maxLength={12000}
            label="专区简介"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
          <details>
            <summary className="cursor-pointer text-ui text-text-3">
              领域背景
            </summary>
            <div className="mt-3">
              <Textarea
                maxLength={50000}
                label="领域背景"
                value={background}
                onChange={(event) => setBackground(event.target.value)}
              />
            </div>
          </details>
          {error && (
            <p role="alert" className="text-ui text-error">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <Button type="submit" loading={busy} disabled={!title.trim()}>
              保存专区
            </Button>
            <Button
              variant="text"
              disabled={busy}
              onClick={() => (dirty ? setConfirm(true) : onCancel())}
            >
              取消
            </Button>
          </div>
        </fieldset>
      </form>
      {confirm && (
        <ConfirmDialog
          title="放弃未保存的修改？"
          body="保存专区后再离开可以保留修改。"
          confirmLabel="放弃修改"
          onConfirm={onCancel}
          onCancel={() => setConfirm(false)}
        />
      )}
    </>
  );
}
export function CardEditor({
  zoneId,
  card,
  sourceItem,
  onSaved,
  onCancel,
}: {
  zoneId: string;
  card?: EvidenceCard;
  sourceItem?: FrontierItem;
  onSaved: (card: EvidenceCard) => void;
  onCancel: () => void;
}) {
  const capture = useEvidenceScope(`${zoneId}:${card?.id || "new"}`);
  const request = useRef({ payload: "", id: "" });
  const [input, setInput] = useState<EvidenceCardInput>({
    title: card?.title || sourceItem?.title || "",
    subtype: card?.subtype === "academic" ? "academic" : "knowledge",
    summary: card?.summary || sourceItem?.summary || "",
    body: card?.body || sourceItem?.summary || sourceItem?.title || "",
    limitations: card?.limitations || "",
    sources:
      card?.sources ||
      (sourceItem
        ? [
            {
              title: sourceItem.source.name,
              url: sourceItem.url,
              excerpt: null,
            },
          ]
        : []),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = (
    key: "title" | "summary" | "body" | "limitations",
    value: string,
  ) => setInput((previous) => ({ ...previous, [key]: value }));
  const [saved, setSaved] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const dirty =
    JSON.stringify(input) !==
    JSON.stringify({
      title: card?.title || sourceItem?.title || "",
      subtype: card?.subtype === "academic" ? "academic" : "knowledge",
      summary: card?.summary || sourceItem?.summary || "",
      body: card?.body || sourceItem?.summary || sourceItem?.title || "",
      limitations: card?.limitations || "",
      sources:
        card?.sources ||
        (sourceItem
          ? [
              {
                title: sourceItem.source.name,
                url: sourceItem.url,
                excerpt: null,
              },
            ]
          : []),
    });
  useDirtyWarning(dirty && !saved);
  return (
    <>
      <DirtyNavigation dirty={dirty && !saved} />
      <form
        className="space-y-4 rounded-card bg-surface-2 p-4"
        onSubmit={(event) => {
          event.preventDefault();
          const current = capture();
          setBusy(true);
          setError(null);
          saveEvidenceCard(
            zoneId,
            {
              ...input,
              ...(sourceItem ? { sourceItemId: sourceItem.id } : {}),
            },
            card,
            submissionId(request, input),
          )
            .then((saved) => {
              if (current()) {
                flushSync(() => setSaved(true));
                onSaved(saved);
              }
            })
            .catch((reason) => {
              if (current()) setError(evidenceErrorMessage(reason));
            })
            .finally(() => {
              if (current()) setBusy(false);
            });
        }}
      >
        <fieldset disabled={busy} className="space-y-4">
          <Input
            label="证据标题"
            required
            maxLength={300}
            value={input.title}
            onChange={(event) => field("title", event.target.value)}
          />
          <label className="block text-ui text-text">
            证据类型
            <select
              className={inputClasses({ className: "mt-2" })}
              value={input.subtype}
              onChange={(event) =>
                setInput((previous) => ({
                  ...previous,
                  subtype: event.target.value as EvidenceCardInput["subtype"],
                }))
              }
            >
              <option value="knowledge">知识证据卡片</option>
              <option value="academic">学术证据</option>
            </select>
          </label>
          <Textarea
            maxLength={12000}
            label="摘要"
            value={input.summary}
            onChange={(event) => field("summary", event.target.value)}
          />
          <Textarea
            maxLength={50000}
            label="证据正文"
            value={input.body}
            onChange={(event) => field("body", event.target.value)}
          />
          <Textarea
            maxLength={12000}
            label="适用范围与局限"
            value={input.limitations}
            onChange={(event) => field("limitations", event.target.value)}
          />
          <fieldset className="space-y-3">
            <legend className="mb-2 text-ui font-medium text-text">
              来源与引用
            </legend>
            <p className="text-caption text-text-3">
              每个来源需填写标题；网页链接和原文引句至少填写一项。
            </p>
            {input.sources.map((source, index) => (
              <div key={index} className="space-y-2">
                <Input
                  label={`来源 ${index + 1} 标题`}
                  required
                  maxLength={500}
                  value={source.title}
                  onChange={(event) =>
                    setInput((previous) => ({
                      ...previous,
                      sources: previous.sources.map((item, at) =>
                        at === index
                          ? { ...item, title: event.target.value }
                          : item,
                      ),
                    }))
                  }
                />
                <Input
                  label={`来源 ${index + 1} 链接`}
                  maxLength={2000}
                  type="url"
                  value={source.url || ""}
                  onChange={(event) =>
                    setInput((previous) => ({
                      ...previous,
                      sources: previous.sources.map((item, at) =>
                        at === index
                          ? { ...item, url: event.target.value }
                          : item,
                      ),
                    }))
                  }
                />
                <Textarea
                  label={`来源 ${index + 1} 引文`}
                  maxLength={12000}
                  value={source.excerpt || ""}
                  onChange={(event) =>
                    setInput((previous) => ({
                      ...previous,
                      sources: previous.sources.map((item, at) =>
                        at === index
                          ? { ...item, excerpt: event.target.value }
                          : item,
                      ),
                    }))
                  }
                />
                <Button
                  variant="text"
                  size="sm"
                  onClick={() =>
                    setInput((previous) => ({
                      ...previous,
                      sources: previous.sources.filter((_, at) => at !== index),
                    }))
                  }
                >
                  移除此来源
                </Button>
              </div>
            ))}
            <Button
              variant="secondary"
              size="sm"
              disabled={input.sources.length >= 50}
              onClick={() =>
                setInput((previous) => ({
                  ...previous,
                  sources: [
                    ...previous.sources,
                    { title: "", url: "", excerpt: "" },
                  ],
                }))
              }
            >
              添加来源
            </Button>
          </fieldset>
          {error && (
            <p role="alert" className="text-ui text-error">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <Button type="submit" loading={busy} disabled={!input.title.trim()}>
              保存证据
            </Button>
            <Button
              variant="text"
              disabled={busy}
              onClick={() => (dirty ? setConfirm(true) : onCancel())}
            >
              取消
            </Button>
          </div>
        </fieldset>
      </form>
      {confirm && (
        <ConfirmDialog
          title="放弃未保存的修改？"
          body="保存证据后再离开可以保留修改。"
          confirmLabel="放弃修改"
          onConfirm={onCancel}
          onCancel={() => setConfirm(false)}
        />
      )}
    </>
  );
}

function submissionId(
  ref: { current: { payload: string; id: string } },
  input: unknown,
) {
  const payload = JSON.stringify(input);
  if (ref.current.payload !== payload || !ref.current.id)
    ref.current = { payload, id: crypto.randomUUID() };
  return ref.current.id;
}

function useDirtyWarning(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
}

function DirtyNavigation({ dirty }: { dirty: boolean }) {
  const router = useContext(UNSAFE_DataRouterContext);
  return router ? <DirtyNavigationGuard dirty={dirty} /> : null;
}
function DirtyNavigationGuard({ dirty }: { dirty: boolean }) {
  const blocker = useBlocker(dirty);
  return blocker.state === "blocked" ? (
    <ConfirmDialog
      title="离开并放弃未保存的修改？"
      body="保存草稿后再离开可以保留修改。"
      confirmLabel="离开"
      onConfirm={() => blocker.proceed()}
      onCancel={() => blocker.reset()}
    />
  ) : null;
}
