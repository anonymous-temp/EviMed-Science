import { useId, useRef, useState } from "react";
import { ExternalLink } from "lucide-react";
import { VCR_PACK_STATUS_LABELS_ZH } from "@evimed/domain";
import {
  bindVcrPack,
  compareVcrDefinition,
  getVcrLibrary,
  getVcrLibraryDetail,
  getVcrPacks,
  promoteVcrPack,
  requestVcrPlatformPack,
  saveVcrDefinition,
  reuseVcrDefinition,
  type VcrComparison,
  type VcrKnowledge,
  type VcrLibraryEntry,
  type VcrPackSummary,
  type VcrPlatformPackAnswer,
  type VcrPackSource,
} from "@/lib/vcrClient";
import { webErrorMessage } from "@/lib/apiClient";
import { safeLink } from "@/lib/frontierClient";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Disclosure } from "@/components/ui/Disclosure";
import { Drawer } from "@/components/ui/Drawer";
import { Input, Select, Textarea } from "@/components/ui/Input";
import { Tag } from "@/components/ui/Tag";
import { EmptyState } from "@/components/cards/EmptyState";
import { VcrSmdDot } from "./VcrDiagrams";
import { VCR_OFF_SENTENCE, VcrTabSkeleton } from "./VcrStates";
import { useVcrLoad, VcrSection, VcrTabError } from "./vcrTabKit";
import { numberText } from "./vcrText";

/**
 * 病种定义包与人群定义库: which disease pack a study works from and which library
 * definitions it used, and the account's library itself.
 *
 * Hidden knowledge:
 *  - **「AI 草拟」 is shown wherever a draft's content is in use.** A draft is a
 *    pack the AI wrote from literature and guidelines so the study could go on;
 *    it carries the label until somebody who may reviews it and promotes it.
 *    The label is on a live value and never a gate — nothing waits for it.
 *  - **Every source is a link and a licence.** A pack entry rests on sources; the
 *    card lists each one with the licence it is used under and whether it is
 *    reused with attribution, linked only, or authored here.
 *  - **The page computes no difference.** A comparison of two versions of a
 *    definition is the engine's: sizes, overlap and one standardized difference
 *    per covariate, flagged above the floor the engine states.
 *  - One request at a time per control; a second click while one is in flight
 *    does nothing.
 */

const SOURCE_USE: Readonly<Record<string, string>> = Object.freeze({ attribution: "署名使用", "link-only": "仅链接", own: "自撰" });
const SECTION_LABELS: ReadonlyArray<readonly [string, string]> = Object.freeze([
  ["terms", "术语"], ["phenotypes", "表型"], ["endpoints", "终点"], ["criteria", "入排条件"],
]);

/** 「已整理」 / 「AI 草拟」: who stands behind the pack. */
export function PackStatusTag({ status }: { status: VcrPackSummary["status"] }) {
  return <Tag tone={status === "ai-draft" ? "warn" : "neutral"}>{VCR_PACK_STATUS_LABELS_ZH[status]}</Tag>;
}

function packName(pack: Pick<VcrPackSummary, "name" | "nameZh">): string {
  return pack.nameZh ?? pack.name ?? "未命名";
}

function SourceList({ sources }: { sources: readonly VcrPackSource[] }) {
  return (
    <ul data-vcr-pack-sources="" className="flex flex-col gap-1.5">
      {sources.map((source) => {
        const link = safeLink(source.url);
        return (
          <li key={source.id} className="flex flex-wrap items-baseline gap-x-2 text-caption text-text-2">
            {link
              ? <a href={link} target="_blank" rel="noreferrer" className="inline-flex min-w-0 items-center gap-1 text-link hover:underline"><span className="truncate">{source.title}</span><ExternalLink size={16} aria-hidden="true" className="shrink-0" /></a>
              : <span className="min-w-0 truncate">{source.title}</span>}
            <span className="shrink-0 text-text-3">{[source.licenceName ?? source.licence, source.use ? SOURCE_USE[source.use] : null, source.accessed].filter(Boolean).join(" · ")}</span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The pack a study works from and the definitions it used, on the overview.
 * Without a pack, a writer may pick one from the catalogue; a lead (or an
 * operator) may promote a reviewed draft.
 */
export function VcrKnowledgeSection({ studyId, knowledge, canWrite, onChanged }: {
  studyId: string; knowledge: VcrKnowledge | null | undefined; canWrite: boolean; onChanged: () => void;
}) {
  if (!knowledge) return null;
  const { pack, definitions } = knowledge;
  if (!pack && definitions.length === 0 && !canWrite) return null;
  return (
    <VcrSection title="病种定义包">
      <div data-vcr-knowledge="" className="flex flex-col gap-4">
        {pack ? <PackRow studyId={studyId} pack={pack} onChanged={onChanged} /> : <BindPack studyId={studyId} canWrite={canWrite} onChanged={onChanged} />}
        {definitions.length > 0 && (
          <ul className="divide-y divide-faint">
            {definitions.map((definition) => (
              <li key={`${definition.definitionId}-${definition.version}`} data-vcr-used-definition={definition.definitionId} className="py-2.5">
                <p className="flex flex-wrap items-center gap-2 text-ui text-text">
                  <span className="min-w-0 font-medium">{`${definition.name} v${definition.version}`}</span>
                  <Tag>定义库</Tag>
                  <span className="text-caption text-text-3">{`共 ${numberText(definition.versions, 0)} 个版本 · 用于 ${numberText(definition.uses, 0)} 个研究`}</span>
                </p>
                {definition.text && <p className="mt-1 text-caption text-text-2">{definition.text}</p>}
                {definition.packRefs.length > 0 && (
                  <p className="mt-1.5 flex flex-wrap gap-1.5">
                    {definition.packRefs.map((ref) => <Tag key={`${ref.section}-${ref.id}`}>{ref.concept ?? ref.id}</Tag>)}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </VcrSection>
  );
}

function PackRow({ studyId, pack, onChanged }: { studyId: string; pack: VcrPackSummary; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const holding = useRef(false);
  const promote = () => {
    if (holding.current) return;
    holding.current = true;
    setBusy(true);
    void promoteVcrPack(studyId)
      .then(() => { toast.success("已标记为已整理。"); onChanged(); })
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "暂时无法标记，请稍后重试。" })))
      .finally(() => { holding.current = false; setBusy(false); });
  };
  const counts = SECTION_LABELS.map(([key, label]) => `${label} ${numberText(pack.counts[key] ?? 0, 0)}`).join(" · ");
  return (
    <div data-vcr-pack={pack.status} className="flex flex-col gap-2">
      <p className="flex flex-wrap items-center gap-2 text-ui text-text">
        <span className="font-medium">{packName(pack)}</span>
        <PackStatusTag status={pack.status} />
        <span className="text-caption text-text-3">{counts}</span>
        {pack.canPromote && <Button size="sm" variant="secondary" loading={busy} onClick={promote}>复核后标为已整理</Button>}
      </p>
      {pack.platform && <PlatformAttribution platform={pack.platform} />}
      {pack.platformRequest && <PlatformRequest studyId={studyId} request={pack.platformRequest} onChanged={onChanged} />}
      {pack.sources.length > 0 && (
        <Disclosure summary={`来源 ${pack.sources.length}`} summaryClassName="text-caption">
          <SourceList sources={pack.sources} />
        </Disclosure>
      )}
    </div>
  );
}

/** A platform pack says whose work it is, by the name they allow, from which of their versions, and when a source has changed — and nothing is rewritten. */
function PlatformAttribution({ platform }: { platform: NonNullable<VcrPackSummary["platform"]> }) {
  return (
    <p data-vcr-platform-pack={platform.state} className="flex flex-wrap items-center gap-2 text-caption text-text-3">
      <Tag tone="accent">平台病种定义包</Tag>
      <span>{platform.author.name ? `${platform.author.name} 整理 · 取自其 v${platform.author.sourceVersion}` : `取自一位已撤回署名的作者的 v${platform.author.sourceVersion}`}</span>
      {platform.state === "retired" && <Tag>已撤回，不再提供给新研究</Tag>}
      {platform.sourceChanged && <Tag>来源有变更</Tag>}
    </p>
  );
}

/**
 * 申请成为平台病种定义包: offered to the lead once the pack is marked curated. The code re-checks the pack; a pack that passes becomes the
 * platform's own version under the author's name, one that fails stays this account's and the page names what failed.
 */
function PlatformRequest({ studyId, request, onChanged }: { studyId: string; request: NonNullable<VcrPackSummary["platformRequest"]>; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<VcrPlatformPackAnswer | null>(null);
  const holding = useRef(false);
  const ask = () => {
    if (holding.current) return;
    holding.current = true;
    setBusy(true);
    void requestVcrPlatformPack(studyId)
      .then((result) => {
        setAnswer(result);
        if (result.state === "passed") { toast.success("复核通过，已成为平台病种定义包。"); onChanged(); }
      })
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "暂时无法申请，请稍后重试。" })))
      .finally(() => { holding.current = false; setBusy(false); });
  };
  const failing = answer ? (answer.state === "failed" ? answer.failing : []) : (request.recheck?.state === "failed" ? request.recheck.failing : []);
  if (!request.canRequest && request.requested) return <p data-vcr-platform-request="done" className="text-caption text-text-3">这份病种定义包已经是平台病种定义包。</p>;
  if (!request.canRequest && failing.length === 0) return null;
  return (
    <div data-vcr-platform-request="" className="flex flex-col gap-2">
      {request.canRequest && (
        <p className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" loading={busy} onClick={ask}>申请成为平台病种定义包</Button>
          <span className="text-caption text-text-3">平台会重新核对结构、授权和来源；通过后所有账号都能选用，并署上你的名字。</span>
        </p>
      )}
      {failing.length > 0 && (
        <div role="status" data-vcr-platform-failing="" className="rounded-card border border-border bg-surface-1 p-3">
          <p className="text-ui font-medium text-text">复核没有通过，病种定义包仍是你账号里的：</p>
          <ul className="mt-1.5 flex flex-col gap-1 text-caption text-text-2">
            {failing.map((entry) => <li key={`${entry.section ?? ""}-${entry.id}-${entry.code}`}>{`${entry.section ? `${entry.section} · ` : ""}${entry.id}：${entry.detail}`}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

/** The catalogue, for a study that has no pack yet. */
function BindPack({ studyId, canWrite, onChanged }: { studyId: string; canWrite: boolean; onChanged: () => void }) {
  const { state } = useVcrLoad("vcr:packs", () => getVcrPacks());
  const [choice, setChoice] = useState("");
  const [busy, setBusy] = useState(false);
  const holding = useRef(false);
  const selectId = useId();
  if (!canWrite) return <p className="text-ui text-text-3">这个研究还没有病种定义包。</p>;
  if (state.kind !== "ready") return <p className="text-ui text-text-3">这个研究还没有病种定义包。</p>;
  if (state.data.length === 0) return <p className="text-ui text-text-3">这个研究还没有病种定义包。</p>;
  const bind = () => {
    if (!choice || holding.current) return;
    holding.current = true;
    setBusy(true);
    void bindVcrPack(studyId, choice)
      .then(() => { toast.success("已绑定病种定义包。"); onChanged(); })
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "暂时无法绑定，请稍后重试。" })))
      .finally(() => { holding.current = false; setBusy(false); });
  };
  return (
    <div data-vcr-bind-pack="" className="flex flex-wrap items-end gap-3">
      <div className="min-w-48">
        <Select id={selectId} label="选用病种定义包" value={choice} onChange={(event) => setChoice(event.target.value)}>
          <option value="">请选择</option>
          {state.data.map((pack) => <option key={`${pack.origin}-${pack.id}`} value={pack.id}>{`${packName(pack)}${pack.status === "ai-draft" ? "（AI 草拟）" : ""}`}</option>)}
        </Select>
      </div>
      <Button variant="secondary" loading={busy} disabled={!choice} onClick={bind}>绑定</Button>
    </div>
  );
}

/* ------------------------------------------------------------------ the population tab's part */

/**
 * 定义库 on the population tab: save a population's definition, use one in this
 * study, and compare two versions of one on the study's dataset.
 */
export function VcrDefinitionsSection({ studyId, knowledge, canWrite, canRun, onChanged }: {
  studyId: string; knowledge: VcrKnowledge | null | undefined; canWrite: boolean; canRun: boolean; onChanged: () => void;
}) {
  const [saving, setSaving] = useState<string | null>(null);
  if (!knowledge) return null;
  const used = knowledge.definitions;
  const comparable = used.filter((definition, index) => definition.versions >= 2 && used.findIndex((other) => other.definitionId === definition.definitionId) === index);
  const nothing = knowledge.savable.length === 0 && used.length === 0 && knowledge.comparisons.length === 0;
  if (nothing && !canWrite) return null;
  return (
    <VcrSection title="定义库">
      <div data-vcr-definitions="" className="flex flex-col gap-4">
        {canWrite && knowledge.savable.length > 0 && (
          <ul className="divide-y divide-faint">
            {knowledge.savable.map((population) => (
              <li key={population.populationId} className="flex items-center justify-between gap-3 py-2">
                <span className="min-w-0 truncate text-ui text-text">{population.name ? `${population.label} · ${population.name}` : population.label}</span>
                <Button size="sm" variant="secondary" onClick={() => setSaving(population.populationId)}>存入定义库</Button>
              </li>
            ))}
          </ul>
        )}
        {canWrite && <UseDefinition studyId={studyId} onChanged={onChanged} />}
        {canRun && comparable.length > 0 && <CompareVersions studyId={studyId} definitions={comparable} onChanged={onChanged} />}
        {knowledge.comparisons.map((comparison) => (
          <ComparisonCard key={comparison.id} comparison={comparison} name={used.find((definition) => definition.definitionId === comparison.definitionId)?.name ?? "人群定义"} />
        ))}
      </div>
      {saving && (
        <SaveDefinitionDrawer
          studyId={studyId}
          populationId={saving}
          suggested={knowledge.savable.find((population) => population.populationId === saving)?.name ?? ""}
          onClose={() => setSaving(null)}
          onSaved={onChanged}
        />
      )}
    </VcrSection>
  );
}

function SaveDefinitionDrawer({ studyId, populationId, suggested, onClose, onSaved }: {
  studyId: string; populationId: string; suggested: string; onClose: () => void; onSaved: () => void;
}) {
  const { state } = useVcrLoad("vcr:library", () => getVcrLibrary());
  const [target, setTarget] = useState("");
  const [name, setName] = useState(suggested);
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const holding = useRef(false);
  const targetId = useId();
  const existing = state.kind === "ready" ? state.data : [];
  const valid = description.trim() !== "" && (target !== "" || name.trim() !== "");
  const save = () => {
    if (!valid || holding.current) return;
    holding.current = true;
    setBusy(true);
    void saveVcrDefinition(studyId, { populationId, text: description, ...(target ? { definitionId: target } : { name }) })
      .then((saved) => { toast.success(`已存入定义库（v${saved.version}）。`); onSaved(); onClose(); })
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "暂时无法存入定义库，请稍后重试。" })))
      .finally(() => { holding.current = false; setBusy(false); });
  };
  return (
    <Drawer title="存入定义库" onClose={onClose} widthClassName="max-w-md">
      <form data-vcr-definition-save="" className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); save(); }}>
        {existing.length > 0 && (
          <Select id={targetId} label="存为" value={target} onChange={(event) => setTarget(event.target.value)}>
            <option value="">新的定义</option>
            {existing.map((entry) => <option key={entry.id} value={entry.id}>{`${entry.name} 的新版本`}</option>)}
          </Select>
        )}
        {target === "" && <Input label="名称" value={name} maxLength={120} onChange={(event) => setName(event.target.value)} autoComplete="off" />}
        <Textarea label="哪些人在里面" rows={4} maxLength={2000} value={description} onChange={(event) => setDescription(event.target.value)} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" type="button" onClick={onClose} disabled={busy}>取消</Button>
          <Button type="submit" loading={busy} disabled={!valid}>存入</Button>
        </div>
      </form>
    </Drawer>
  );
}

/** Pick a library definition (and a version) and define this study's population from it. */
function UseDefinition({ studyId, onChanged }: { studyId: string; onChanged: () => void }) {
  const { state } = useVcrLoad("vcr:library", () => getVcrLibrary());
  const [definitionId, setDefinitionId] = useState("");
  const [version, setVersion] = useState("");
  const [busy, setBusy] = useState(false);
  const holding = useRef(false);
  const definitionSelect = useId();
  const versionSelect = useId();
  if (state.kind !== "ready" || state.data.length === 0) return null;
  const entry = state.data.find((item) => item.id === definitionId) ?? null;
  const use = () => {
    if (!entry || holding.current) return;
    holding.current = true;
    setBusy(true);
    void reuseVcrDefinition(studyId, entry.id, version ? { version: Number(version) } : {})
      .then((done) => {
        const notes = [
          done.renamed.length > 0 ? `已按字段对应改了 ${done.renamed.length} 列` : null,
          done.unmatched.length > 0 ? `${done.unmatched.length} 列在本研究数据里没有对应：${done.unmatched.slice(0, 3).join("、")}` : null,
        ].filter(Boolean);
        toast.success(`已用于本研究（v${done.version}）${notes.length ? `；${notes.join("；")}` : ""}。`);
        onChanged();
      })
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "暂时无法使用这条定义，请稍后重试。" })))
      .finally(() => { holding.current = false; setBusy(false); });
  };
  return (
    <div data-vcr-use-definition="" className="flex flex-wrap items-end gap-3">
      <div className="min-w-48">
        <Select id={definitionSelect} label="用定义库里的定义" value={definitionId} onChange={(event) => { setDefinitionId(event.target.value); setVersion(""); }}>
          <option value="">请选择</option>
          {state.data.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </Select>
      </div>
      {entry && entry.versions > 1 && (
        <div className="w-32">
          <Select id={versionSelect} label="版本" value={version} onChange={(event) => setVersion(event.target.value)}>
            <option value="">最新</option>
            {Array.from({ length: entry.versions }, (_, index) => entry.versions - index).map((number) => <option key={number} value={String(number)}>{`v${number}`}</option>)}
          </Select>
        </div>
      )}
      <Button variant="secondary" loading={busy} disabled={!entry} onClick={use}>用于本研究</Button>
    </div>
  );
}

/** Two versions of one definition, applied to the study's dataset by the engine. */
function CompareVersions({ studyId, definitions, onChanged }: {
  studyId: string; definitions: ReadonlyArray<VcrKnowledge["definitions"][number]>; onChanged: () => void;
}) {
  const [definitionId, setDefinitionId] = useState(definitions[0]?.definitionId ?? "");
  const entry = definitions.find((definition) => definition.definitionId === definitionId) ?? definitions[0];
  const versions = Array.from({ length: entry?.versions ?? 0 }, (_, index) => index + 1);
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [busy, setBusy] = useState(false);
  const holding = useRef(false);
  const ids = [useId(), useId(), useId()];
  const valid = a !== "" && b !== "" && a !== b;
  const compare = () => {
    if (!valid || !entry || holding.current) return;
    holding.current = true;
    setBusy(true);
    void compareVcrDefinition(studyId, entry.definitionId, { versionA: Number(a), versionB: Number(b) })
      .then(() => { toast.success("已交给引擎比较，完成后显示在下面。"); onChanged(); })
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "暂时无法比较，请稍后重试。" })))
      .finally(() => { holding.current = false; setBusy(false); });
  };
  return (
    <div data-vcr-compare-versions="" className="flex flex-wrap items-end gap-3">
      {definitions.length > 1 && (
        <div className="min-w-40">
          <Select id={ids[0]} label="定义" value={entry?.definitionId ?? ""} onChange={(event) => { setDefinitionId(event.target.value); setA(""); setB(""); }}>
            {definitions.map((definition) => <option key={definition.definitionId} value={definition.definitionId}>{definition.name}</option>)}
          </Select>
        </div>
      )}
      <div className="w-28">
        <Select id={ids[1]} label="比较" value={a} onChange={(event) => setA(event.target.value)}>
          <option value="">版本</option>
          {versions.map((number) => <option key={number} value={String(number)}>{`v${number}`}</option>)}
        </Select>
      </div>
      <div className="w-28">
        <Select id={ids[2]} label="与" value={b} onChange={(event) => setB(event.target.value)}>
          <option value="">版本</option>
          {versions.map((number) => <option key={number} value={String(number)}>{`v${number}`}</option>)}
        </Select>
      </div>
      <Button variant="secondary" loading={busy} disabled={!valid} onClick={compare}>比较版本</Button>
    </div>
  );
}

/** The engine's comparison: both sizes, who is in both, and each covariate's standardized difference. */
export function ComparisonCard({ comparison, name }: { comparison: VcrComparison; name: string }) {
  const floor = comparison.floor ?? 0.1;
  const rows = comparison.covariates
    .filter((entry) => entry.standardizedDifference != null || entry.skipped)
    .sort((x, y) => Math.abs(y.standardizedDifference ?? 0) - Math.abs(x.standardizedDifference ?? 0));
  return (
    <Card title={`${name}：v${comparison.versionA} 与 v${comparison.versionB}`}>
      <div data-vcr-comparison={comparison.id}>
        <p className="flex flex-wrap gap-x-6 gap-y-1 text-ui tabular-nums text-text">
          <span>{`v${comparison.versionA} 保留 `}<span className="font-semibold">{numberText(comparison.cohortSizeA, 0)}</span>{" 人"}</span>
          <span>{`v${comparison.versionB} 保留 `}<span className="font-semibold">{numberText(comparison.cohortSizeB, 0)}</span>{" 人"}</span>
          <span className="text-text-2">{`两版都在 ${numberText(comparison.overlap.both ?? null, 0)} · 只在 v${comparison.versionA} ${numberText(comparison.overlap.onlyA ?? null, 0)} · 只在 v${comparison.versionB} ${numberText(comparison.overlap.onlyB ?? null, 0)}`}</span>
        </p>
        {rows.length > 0 && (
          <table className="mt-3 w-full border-collapse text-caption">
            <caption className="sr-only">两个版本的基线特征标准化差异</caption>
            <thead>
              <tr className="border-b border-border text-text-3">
                <th scope="col" className="py-1 pr-2 text-left font-normal">特征</th>
                <th scope="col" className="px-2 py-1 text-right font-normal">{`v${comparison.versionA}`}</th>
                <th scope="col" className="px-2 py-1 text-right font-normal">{`v${comparison.versionB}`}</th>
                <th scope="col" className="py-1 pl-2 text-right font-normal">|SMD|</th>
                <th scope="col" className="w-20 py-1 pl-2 font-normal"><span className="sr-only">{`界值 ${floor}`}</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((entry) => {
                const smd = entry.standardizedDifference ?? null;
                const flagged = smd !== null && Math.abs(smd) > floor;
                return (
                  <tr key={entry.covariate} data-vcr-comparison-row={entry.covariate} className={cn("border-b border-faint", flagged && "bg-warn-soft")}>
                    <th scope="row" className="py-1.5 pr-2 text-left font-normal text-text">{entry.covariate}</th>
                    <td className="px-2 py-1.5 text-right tabular-nums text-text-2">{entry.skipped ? "—" : numberText(entry.meanA ?? null, 2)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-text-2">{entry.skipped ? "—" : numberText(entry.meanB ?? null, 2)}</td>
                    <td className={cn("py-1.5 pl-2 text-right tabular-nums", flagged ? "font-medium text-warn-strong" : "text-text-2")}>
                      {smd !== null ? Math.abs(smd).toFixed(2) : "未比较"}
                    </td>
                    <td className="py-1.5 pl-2">{smd !== null && <VcrSmdDot smd={smd} floor={floor} label={entry.covariate} />}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </Card>
  );
}

/* ----------------------------------------------------------------------- the module home */

/** 人群定义库 on the module home: the account's definitions, their versions and the studies that used them. */
export function VcrDefinitionsPanel() {
  const { state, reload } = useVcrLoad("vcr:library", () => getVcrLibrary());
  if (state.kind === "error" && state.off) return <p className="py-12 text-center text-ui text-text-3">{VCR_OFF_SENTENCE}</p>;
  if (state.kind === "loading") return <VcrTabSkeleton />;
  if (state.kind === "error") return <VcrTabError message={state.message} onRetry={reload} />;
  if (state.data.length === 0) return <EmptyState title="定义库里还没有定义" />;
  return (
    <ul data-vcr-library="" className="divide-y divide-border">
      {state.data.map((entry) => <LibraryRow key={entry.id} entry={entry} />)}
    </ul>
  );
}

function LibraryRow({ entry }: { entry: VcrLibraryEntry }) {
  const [open, setOpen] = useState(false);
  const { state } = useVcrLoad(open ? `vcr:library:${entry.id}` : "vcr:library:closed", () => (open ? getVcrLibraryDetail(entry.id) : Promise.resolve(null)));
  return (
    <li data-vcr-library-entry={entry.id} className="py-4">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full flex-col gap-1 text-left"
      >
        <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-body font-semibold text-text">{entry.name}</span>
          <span className="text-caption tabular-nums text-text-3">{`${numberText(entry.versions, 0)} 个版本 · 用于 ${numberText(entry.uses, 0)} 个研究`}</span>
        </span>
        {entry.latest?.text && <span className="text-ui text-text-2">{entry.latest.text}</span>}
      </button>
      {open && state.kind === "ready" && state.data && (
        <div className="mt-3 flex flex-col gap-3">
          {state.data.versions.map((version) => (
            <div key={version.version} data-vcr-library-version={version.version} className="rounded border border-border p-3">
              <p className="text-ui font-medium text-text">{`v${version.version}`}</p>
              {version.text && <p className="mt-1 text-caption text-text-2">{version.text}</p>}
              {version.rules.length > 0 && (
                <p className="mt-2 flex flex-wrap gap-1.5">{version.rules.map((rule, index) => <Tag key={`${rule.name ?? index}`}>{rule.name ?? `条件 ${index + 1}`}</Tag>)}</p>
              )}
              {version.packRefs.length > 0 && (
                <p className="mt-2 flex flex-wrap gap-1.5">{version.packRefs.map((ref) => <Tag key={`${ref.section}-${ref.id}`} tone="accent">{ref.concept ?? ref.id}</Tag>)}</p>
              )}
            </div>
          ))}
          {state.data.studies.length > 0 && (
            <p className="text-caption text-text-3">{`用过的研究：${[...new Set(state.data.studies.map((study) => study.studyName || "未命名研究"))].join("、")}`}</p>
          )}
        </div>
      )}
      {open && state.kind === "error" && <p className="mt-3 text-ui text-text-3">{state.message}</p>}
    </li>
  );
}
