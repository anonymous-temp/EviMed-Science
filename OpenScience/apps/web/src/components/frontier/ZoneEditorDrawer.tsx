import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EVIDENCE_ZONE_LIMITS } from "@evimed/domain";
import { Plus, X } from "lucide-react";
import { Link } from "react-router";
import { Button } from "@/components/ui/Button";
import { Drawer } from "@/components/ui/Drawer";
import { IconButton } from "@/components/ui/IconButton";
import { Input, Textarea } from "@/components/ui/Input";
import { List, ListRow } from "@/components/ui/ListRow";
import { Note } from "@/components/ui/Note";
import { PendingFeedback } from "@/components/ui/PendingFeedback";
import { Section } from "@/components/ui/Section";
import { Switch } from "@/components/ui/Switch";
import { WebApiError } from "@/lib/apiClient";
import { isSubmitKey } from "@/lib/compositionKeys";
import { cn } from "@/lib/cn";
import { evidenceErrorMessage } from "@/lib/evidenceZoneClient";
import {
  createZone,
  draftZone,
  previewZone,
  updateZone,
  type ZoneDefinition,
  type ZoneDetail,
  type ZoneDraft,
  type ZoneDraftResult,
  type ZonePreview,
} from "@/lib/evidenceTopicClient";
import type { FrontierItem } from "@/lib/frontierClient";
import { metaTime } from "./frontierText";
import { useEvidenceRequestId } from "./useEvidenceScope";
import { zonePath } from "./zoneLinks";

/**
 * 「新建专区」 and 「编辑」 of 我的专区, one screen in a drawer (owner 2026-10-29; plan `2026-10-29-evidence-zone-topics.md` §4.8): a
 * reader says what they want to keep reading in one sentence, the model drafts the zone, the platform shows what it would have
 * gathered in the last 30 days, and 「建立」 makes it live. There is no approval and no confirmation step.
 *
 * Hidden knowledge:
 *
 *  - Drafting is the model's (`draftZone`); the preview is recall only, no model (`previewZone`), so editing a keyword re-reads it
 *    (debounced) without drafting again. A draft arrives with its own preview; one the reader picks from the readings or the
 *    suggestions has none and is previewed like a hand edit. The suggestions belong to the draft they came with: once the reader
 *    changes anything else they are gone.
 *  - Too wide or too narrow is a hint with a way out, never a block: the reader may create the zone as they wrote it.
 *  - The 算 / 不算 marks on the borderline items become the zone's first `seeds` (`createZone`). They are a creation step only: the
 *    update route takes no seeds, so an edit shows the preview without marks.
 *  - Creating keeps one `requestId` for the same content, so a second press after a lost answer replays rather than makes two.
 *  - The domain's limits (a 30-character title, 4 keywords, 200 characters of scope) are the field limits: the server cuts at the
 *    same numbers.
 */

/** Where a new zone starts from: a sentence, a platform zone to copy, or a frontier item whose tags are the draft. */
export interface ZoneEditorSeed {
  text?: string;
  baseZoneId?: string;
  fromItemId?: string;
  /** Draft at once from `text` (a search for words the reader wants to follow); without it the sentence is only filled in. */
  generate?: boolean;
}

export interface ZoneEditorDrawerProps {
  mode: "create" | "edit";
  /** The zone being edited (`edit`). */
  zone?: ZoneDetail;
  seed?: ZoneEditorSeed;
  onClose: () => void;
  onSaved: (zone: ZoneDetail) => void;
}

const EXAMPLES = ["GLP-1 减重药的心血管结局", "ADC 治疗 HER2 低表达乳腺癌", "国产 PD-1 出海"];
const PREVIEW_DELAY_MS = 500;
const LIMIT_WORDS = "最多可以建 30 个专区，先删掉不用的再建";

/** What recalls items: the keywords and their words. Editing anything else (the title, the scope) does not read the preview again. */
const recallKey = (definition: ZoneDefinition) => JSON.stringify([definition.keywords, definition.excludeTerms]);

type Hints = Pick<ZoneDraftResult, "readings" | "suggestions" | "similar">;

function failure(reason: unknown): string {
  if (reason instanceof WebApiError && reason.code === "evidence_user_zone_limit") return LIMIT_WORDS;
  return evidenceErrorMessage(reason);
}

const itemMeta = (item: FrontierItem) => [item.source.name, metaTime(item)].filter(Boolean).join(" · ");

export function ZoneEditorDrawer({ mode, zone, seed, onClose, onSaved }: ZoneEditorDrawerProps) {
  const editing = mode === "edit" && zone !== undefined;
  const original = editing ? zone : undefined;
  const [sentence, setSentence] = useState(seed?.text ?? "");
  const [work, setWork] = useState<ZoneDraft | null>(original?.definition ? { title: original.title, definition: original.definition } : null);
  const [hints, setHints] = useState<Hints | null>(null);
  const [preview, setPreview] = useState<ZonePreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [marks, setMarks] = useState<Record<string, "in" | "out">>({});
  const [published, setPublished] = useState(original?.published ?? false);
  const [keyword, setKeyword] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The recall the shown preview belongs to; a work whose recall differs is previewed again (a draft arrives with its own).
  const previewed = useRef<string | null>(null);
  const draftToken = useRef(0);
  const alive = useRef(true);
  const requestFor = useEvidenceRequestId();
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const base = original?.id ?? seed?.baseZoneId;
  const fromItemId = seed?.fromItemId;

  const draft = useCallback(async (text: string) => {
    const token = ++draftToken.current;
    setDrafting(true);
    setError(null);
    try {
      const result = await draftZone({ text, baseZoneId: base ?? null, fromItemId: fromItemId ?? null });
      if (!alive.current || token !== draftToken.current) return;
      previewed.current = recallKey(result.draft.definition);
      setWork(result.draft);
      setPreview(result.preview);
      setHints({ readings: result.readings, suggestions: result.suggestions, similar: result.similar });
      setMarks({});
    } catch (reason) {
      if (alive.current && token === draftToken.current) setError(failure(reason));
    } finally {
      if (alive.current && token === draftToken.current) setDrafting(false);
    }
  }, [base, fromItemId]);

  // A seed that names an item or a zone to copy drafts at once; so does words the reader searched for. Once, on opening.
  const started = useRef(false);
  useEffect(() => {
    if (started.current || editing) return;
    started.current = true;
    if (seed?.fromItemId || seed?.baseZoneId || (seed?.generate && seed.text?.trim())) void draft(seed?.text?.trim() ?? "");
  }, [draft, editing, seed]);

  // The preview of the work, read again a moment after its keywords change (and at once when an edit opens).
  const definition = work?.definition ?? null;
  const key = definition ? recallKey(definition) : null;
  const latest = useRef(definition);
  latest.current = definition;
  useEffect(() => {
    if (!latest.current || key === null || previewed.current === key) return;
    const first = previewed.current === null;
    let active = true;
    const timer = setTimeout(() => {
      setPreviewing(true);
      previewZone(latest.current!)
        .then((answer) => { if (active) { previewed.current = key; setPreview(answer); } })
        .catch(() => { if (active) { previewed.current = key; setPreview(null); } })
        .finally(() => { if (active) setPreviewing(false); });
    }, first ? 0 : PREVIEW_DELAY_MS);
    return () => { active = false; clearTimeout(timer); };
  }, [key]);

  /** The reader chose another reading or suggestion: it replaces the draft, and the hints that came with the old one go. */
  const replace = (next: ZoneDraft) => { setWork(next); setHints(null); setMarks({}); setError(null); };
  const change = (patch: Partial<ZoneDraft["definition"]>) => {
    setWork((current) => (current ? { ...current, definition: { ...current.definition, ...patch } } : current));
  };

  const addKeyword = () => {
    const label = keyword.replace(/\s+/g, " ").trim();
    if (!label || !work) return;
    setKeyword("");
    if (work.definition.keywords.some((entry) => entry.label.toLowerCase() === label.toLowerCase())) return;
    if (work.definition.keywords.length >= EVIDENCE_ZONE_LIMITS.keywordsMax) return;
    setHints(null);
    change({ keywords: [...work.definition.keywords, { label, terms: [label] }] });
  };
  const removeKeyword = (label: string) => {
    if (!work) return;
    setHints(null);
    change({ keywords: work.definition.keywords.filter((entry) => entry.label !== label) });
  };

  const borderline = useMemo(() => preview?.borderline ?? [], [preview]);
  const canSave = Boolean(work && work.title.trim() && work.definition.scope.trim() && work.definition.keywords.length > 0) && !drafting && !saving;

  const save = async () => {
    if (!work || !canSave) return;
    setSaving(true);
    setError(null);
    try {
      let saved: ZoneDetail;
      if (original) {
        saved = await updateZone(original, {
          ...(work.title !== original.title ? { title: work.title.trim() } : {}),
          ...(original.definition && JSON.stringify(work.definition) !== JSON.stringify(original.definition) ? { definition: work.definition } : {}),
          ...(published !== original.published ? { published } : {}),
        });
      } else {
        const shown = new Set(borderline.map((item) => item.id));
        const seeds = {
          positive: Object.entries(marks).filter(([id, mark]) => mark === "in" && shown.has(id)).map(([id]) => id),
          negative: Object.entries(marks).filter(([id, mark]) => mark === "out" && shown.has(id)).map(([id]) => id),
        };
        const title = work.title.trim();
        saved = await createZone({ title, definition: work.definition, seeds, published, requestId: requestFor(JSON.stringify([title, work.definition, seeds, published])) });
      }
      if (alive.current) onSaved(saved);
    } catch (reason) {
      if (alive.current) setError(failure(reason));
    } finally {
      if (alive.current) setSaving(false);
    }
  };

  const band = preview?.band ?? null;
  const suggestions = band === "broad" ? hints?.suggestions.narrower : band === "narrow" ? hints?.suggestions.broader : undefined;
  const sentenceLabel = editing ? "想怎么调整？" : "想持续看什么？";
  const mark = (item: FrontierItem, value: "in" | "out") => setMarks((current) => {
    const next = { ...current };
    if (next[item.id] === value) delete next[item.id]; else next[item.id] = value;
    return next;
  });

  return (
    <Drawer
      title={editing ? "编辑专区" : "新建专区"}
      onClose={onClose}
      widthClassName="max-w-2xl"
      busy={saving}
      footer={work ? (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <Note action={<Switch checked={published} onChange={setPublished} label="公开到平台" showLabel />}>公开后，平台里的其他人也能看到和关注</Note>
          <Button variant="primary" loading={saving} disabled={!canSave} onClick={() => void save()}>{editing ? "保存" : "建立"}</Button>
        </div>
      ) : undefined}
    >
      <div className="space-y-6">
        <div className="space-y-3">
          <Textarea
            label={sentenceLabel}
            rows={2}
            maxLength={EVIDENCE_ZONE_LIMITS.draftTextChars}
            value={sentence}
            placeholder={editing ? "例如：加上替尔泊肽" : undefined}
            onChange={(event) => setSentence(event.target.value)}
            onKeyDown={(event) => { if (isSubmitKey(event) && sentence.trim() && !drafting) { event.preventDefault(); void draft(sentence.trim()); } }}
          />
          <div className="flex flex-wrap items-center gap-2">
            {!editing && !work && EXAMPLES.map((example) => (
              <Button key={example} variant="secondary" size="sm" onClick={() => setSentence(example)}>{example}</Button>
            ))}
            <Button variant={work ? "secondary" : "primary"} className="ml-auto" loading={drafting} disabled={!sentence.trim()} onClick={() => void draft(sentence.trim())}>生成</Button>
          </div>
        </div>

        {drafting && (
          <PendingFeedback stage="正在生成专区草稿">
            <div className="animate-pulse space-y-3" aria-hidden="true">
              <div className="h-9 w-2/3 rounded bg-surface-2" />
              <div className="h-7 w-full rounded bg-surface-2" />
              <div className="h-16 w-full rounded bg-surface-2" />
            </div>
          </PendingFeedback>
        )}

        {!drafting && work && hints && hints.readings.length > 0 && (
          <div role="group" aria-label="你指的是" className="flex flex-wrap items-center gap-2">
            <span className="text-ui text-text">你指的是：</span>
            {hints.readings.map((reading) => (
              <Button key={reading.label} variant="secondary" size="sm" onClick={() => replace(reading.draft)}>{reading.label}</Button>
            ))}
          </div>
        )}

        {!drafting && work && (
          <>
            <Input
              label="名称"
              value={work.title}
              maxLength={EVIDENCE_ZONE_LIMITS.titleChars}
              onChange={(event) => setWork({ ...work, title: event.target.value })}
            />

            <div>
              <p id="zone-keywords" className="mb-2 text-ui text-text">关键词</p>
              <ul aria-labelledby="zone-keywords" className="mb-2 flex flex-wrap gap-2">
                {work.definition.keywords.map((entry) => (
                  <li key={entry.label} className="inline-flex h-sm items-center gap-0.5 rounded bg-surface-2 pl-2.5 pr-0.5 text-ui text-text">
                    <span className="min-w-0 truncate">{entry.label}</span>
                    <IconButton icon={X} size="sm" label={`移除关键词“${entry.label}”`} onClick={() => removeKeyword(entry.label)} />
                  </li>
                ))}
              </ul>
              {work.definition.keywords.length < EVIDENCE_ZONE_LIMITS.keywordsMax && (
                <Input
                  aria-label="添加关键词"
                  placeholder="添加关键词"
                  value={keyword}
                  maxLength={EVIDENCE_ZONE_LIMITS.termChars}
                  onChange={(event) => setKeyword(event.target.value)}
                  onKeyDown={(event) => { if (isSubmitKey(event)) { event.preventDefault(); addKeyword(); } }}
                  trailing={<IconButton icon={Plus} size="sm" label="添加" disabled={!keyword.trim()} onClick={addKeyword} />}
                />
              )}
            </div>

            <Textarea
              label="范围"
              rows={2}
              maxLength={EVIDENCE_ZONE_LIMITS.scopeChars}
              value={work.definition.scope}
              onChange={(event) => change({ scope: event.target.value })}
            />

            <div className={cn("space-y-4", previewing && "opacity-disabled")} aria-busy={previewing || undefined}>
              {preview ? (
                <p className="text-ui tabular-nums text-text">
                  {preview.count30 > 0 ? `近 30 天 ${preview.count30} 条 · 约每周 ${preview.perWeek} 条` : "近 30 天没有匹配的动态"}
                </p>
              ) : (
                <p className="text-ui text-text-3">{previewing ? "正在估算数量" : "暂时看不到预览"}</p>
              )}

              {suggestions && suggestions.length > 0 && (
                <Note
                  action={(
                    <span className="flex flex-wrap gap-2">
                      {suggestions.map((suggestion) => (
                        <Button key={suggestion.label} variant="secondary" size="sm" onClick={() => replace(suggestion.draft)}>
                          {suggestion.label}{suggestion.perWeek !== null ? ` · 约每周 ${suggestion.perWeek} 条` : ""}
                        </Button>
                      ))}
                    </span>
                  )}
                >
                  {band === "broad" ? "范围偏宽，加一个限定会更聚焦：" : "范围偏窄，放宽一点会多一些："}
                </Note>
              )}

              {hints && hints.similar.length > 0 && (
                <Note
                  action={(
                    <span className="flex flex-wrap gap-x-3 gap-y-1">
                      {hints.similar.map((similar) => <Link key={similar.id} to={zonePath(similar)} className="rounded text-link underline underline-offset-4">{similar.title}</Link>)}
                    </span>
                  )}
                >
                  已有相近的专区：
                </Note>
              )}

              {preview && preview.recent.length > 0 && (
                <Section title="最近的几条" level="sub">
                  <List divided label="最近的几条">
                    {preview.recent.map((item) => <ListRow key={item.id} title={item.title} meta={itemMeta(item)} />)}
                  </List>
                </Section>
              )}

              {!editing && borderline.length > 0 && (
                <Section title="这几条算不算？" level="sub">
                  <List divided label="边界样例">
                    {borderline.map((item) => (
                      <ListRow
                        key={item.id}
                        title={item.title}
                        meta={itemMeta(item)}
                        actions={(
                          <>
                            <Button variant="secondary" size="sm" aria-pressed={marks[item.id] === "in"} aria-label={`算：${item.title}`}
                              className={cn(marks[item.id] === "in" && "bg-accent-soft text-accent hover:bg-accent-soft")} onClick={() => mark(item, "in")}>算</Button>
                            <Button variant="secondary" size="sm" aria-pressed={marks[item.id] === "out"} aria-label={`不算：${item.title}`}
                              className={cn(marks[item.id] === "out" && "bg-accent-soft text-accent hover:bg-accent-soft")} onClick={() => mark(item, "out")}>不算</Button>
                          </>
                        )}
                      />
                    ))}
                  </List>
                </Section>
              )}
            </div>
          </>
        )}

        {error && <p role="alert" className="text-ui text-error">{error}</p>}
      </div>
    </Drawer>
  );
}
