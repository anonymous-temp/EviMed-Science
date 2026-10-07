import { useMemo, useRef, useState } from "react";
import { editVcrCard, getVcrCardSettings, type VcrCardKind, type VcrCardSetting } from "@/lib/vcrClient";
import { WebApiError, webErrorMessage } from "@/lib/apiClient";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/Button";
import { Drawer } from "@/components/ui/Drawer";
import { Input } from "@/components/ui/Input";
import { LoadError } from "@/components/cards/LoadError";
import { VcrTabSkeleton } from "./VcrStates";
import { useVcrLoad } from "./vcrTabKit";

/**
 * 「改设定」: the numbers a study's population, one of its designs or its criteria rest on, editable where they are read — the
 * way an assumption card already is.
 *
 * What is offered is what the server says the object holds (`GET …/cards`): each number named, with its unit and the range it
 * takes, never a field the engine does not read. Saving writes the object's **next version** and the programme computes what stood
 * on the old one again, so the drawer says so before the reader presses 保存; a value the engine would refuse comes back as one
 * sentence naming the setting, and nothing is written. Only changed numbers are sent, and 保存 is not offered until one is.
 */
export function VcrSettingsDrawer({ studyId, kind, objectId, title, description, onClose, onSaved }: {
  studyId: string;
  kind: VcrCardKind;
  /** A design's id; absent for the population and the criteria, which are the study's one current object. */
  objectId?: string | null;
  title: string;
  description?: string;
  onClose: () => void;
  /** After the next version is written: the page re-reads. */
  onSaved: () => void;
}) {
  const { state, reload } = useVcrLoad(`${studyId}:card:${kind}:${objectId ?? ""}`, () => getVcrCardSettings(studyId, kind, objectId));
  return (
    <Drawer title={title} description={description} onClose={onClose} widthClassName="max-w-md">
      <div data-vcr-settings={kind}>
        {state.kind === "loading" ? <VcrTabSkeleton rows={4} />
          : state.kind === "error" ? <LoadError message={state.message} onRetry={reload} />
            : state.data.settings.length === 0
              ? <p className="py-6 text-ui text-text-3">这里没有可以直接改的数字。需要改别的，在对话里说。</p>
              : <SettingsForm studyId={studyId} kind={kind} objectId={state.data.objectId} settings={state.data.settings} onSaved={onSaved} onClose={onClose} />}
      </div>
    </Drawer>
  );
}

/** What is wrong with a typed value for its setting, or null. Mirrors the server's closed range so a slip is told in place. */
export function settingProblem(setting: VcrCardSetting, typed: string): string | null {
  const text = typed.trim();
  if (text === "") return "要填一个数字";
  const value = Number(text);
  if (!Number.isFinite(value)) return "要填一个数字";
  if (setting.integer && !Number.isInteger(value)) return "要填整数";
  if (setting.min !== null && value < setting.min) return `不能小于 ${setting.min}`;
  if (setting.max !== null && value > setting.max) return `不能大于 ${setting.max}`;
  return null;
}

function SettingsForm({ studyId, kind, objectId, settings, onSaved, onClose }: {
  studyId: string;
  kind: VcrCardKind;
  objectId: string;
  settings: readonly VcrCardSetting[];
  onSaved: () => void;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState<Record<string, string>>(() => Object.fromEntries(settings.map((setting) => [setting.path, String(setting.value)])));
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const holding = useRef(false);

  const problems = useMemo(() => Object.fromEntries(settings.map((setting) => [setting.path, settingProblem(setting, typed[setting.path] ?? "")])), [settings, typed]);
  const changed = settings.filter((setting) => problems[setting.path] === null && Number(typed[setting.path]) !== setting.value);
  const blocked = settings.some((setting) => problems[setting.path] !== null);

  const save = () => {
    if (holding.current || blocked || changed.length === 0) return;
    holding.current = true;
    setBusy(true);
    setRefused(null);
    void editVcrCard(studyId, { kind, objectId: kind === "trial_scenario" ? objectId : null, set: Object.fromEntries(changed.map((setting) => [setting.path, Number(typed[setting.path])])) })
      .then(() => {
        toast.success("已保存，依赖它的结果会重新计算。");
        onSaved();
        onClose();
      })
      .catch((error: unknown) => {
        // The refusal of a value names the setting: that sentence is the answer, not the dictionary's general one.
        setRefused(error instanceof WebApiError && error.code === "vcr_card_edit_refused" && error.message
          ? error.message : webErrorMessage(error, { fallback: "暂时无法保存，请稍后重试。" }));
      })
      .finally(() => { holding.current = false; setBusy(false); });
  };

  return (
    <form className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); save(); }}>
      <p className="text-caption text-text-3">保存会生成新的版本；用到它的结果标为过期，并按新的数字重新计算。</p>
      <div className="flex flex-col gap-3">
        {settings.map((setting) => {
          const problem = typed[setting.path] !== String(setting.value) ? problems[setting.path] : null;
          return (
            <Input
              key={setting.path}
              data-vcr-setting={setting.path}
              label={setting.unit ? `${setting.label}（${setting.unit}）` : setting.label}
              type="number"
              step={setting.integer ? 1 : "any"}
              inputMode="decimal"
              value={typed[setting.path] ?? ""}
              onChange={(event) => setTyped((current) => ({ ...current, [setting.path]: event.target.value }))}
              error={problem ?? undefined}
            />
          );
        })}
      </div>
      {refused && <p role="alert" className="rounded bg-danger-soft px-3 py-2 text-ui text-danger-strong">{refused}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>取消</Button>
        <Button type="submit" loading={busy} disabled={blocked || changed.length === 0 || busy}>保存</Button>
      </div>
    </form>
  );
}
