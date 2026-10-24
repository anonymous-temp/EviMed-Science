import { useEffect, useState } from "react";
import {
  FRONTIER_ONBOARDING_LIMITS,
  FRONTIER_READER_ROLE_LABELS_ZH,
  FRONTIER_READER_ROLES,
  FRONTIER_SPECIALTY_GROUPS,
  FRONTIER_SPECIALTY_LABELS_ZH,
} from "@evimed/domain";
import { FRONTIER_FOLLOWS_CHANGED, frontierErrorMessage } from "@/lib/frontierClient";
import { fetchFrontierPrefs, saveFrontierPrefs, type FrontierPrefs } from "@/lib/frontierPrefs";
import { trackFrontierOnboarding } from "@/lib/frontierTracking";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/Button";
import { FilterChip } from "@/components/ui/FilterChips";
import { Note } from "@/components/ui/Note";
import { rememberTagName, useHotTags } from "./useFrontierTags";

type Step = "role" | "specialties" | "interests";
const STEPS: readonly Step[] = ["role", "specialties", "interests"];
const QUESTIONS: Record<Step, string> = { role: "你的角色", specialties: "你的专科", interests: "关注几个标签" };
/** Tags offered for the chosen specialties: their most used of 30 days. */
const TAGS_OFFERED = 12;

/**
 * 与我相关's onboarding (ct-track, 2026-10-24; the owner approved it as a skippable step): an inline card at the top of the block —
 * never a dialog — that asks three things, one at a time: 角色, 专科 (one to three), and a few tags (offered from the tree for the
 * chosen specialties). 跳过 is always there, and whatever was chosen before it is kept. Finished or skipped, the card is gone for
 * good; the answer is changed later in 「管理关注」 (`mode="edit"`, the same card with 取消 instead of 跳过). The ranking that reads
 * the answer is the server's; the card only asks.
 */
export function FrontierOnboarding({ initial = null, mode = "first", onClose }: {
  /** The answer so far (editing it). */
  initial?: FrontierPrefs | null;
  /** `first`: shown in 与我相关 until finished or skipped; `edit`: opened from 「管理关注」. */
  mode?: "first" | "edit";
  /** The card is done: saved (`saved` true) or let go. */
  onClose: (saved: boolean) => void;
}) {
  const [step, setStep] = useState<Step>("role");
  const [role, setRole] = useState<string | null>(initial?.role ?? null);
  const [specialties, setSpecialties] = useState<string[]>(initial?.specialties ?? []);
  const [interests, setInterests] = useState<string[]>(initial?.interests ?? []);
  const [saving, setSaving] = useState(false);
  const hot = useHotTags(step === "interests" ? specialties : []);
  const known = (initial?.interestTags ?? []).filter((tag) => interests.includes(tag.slug));
  for (const tag of known) rememberTagName(tag.slug, tag.name);
  const offered = [...known, ...hot.tags.filter((tag) => !known.some((held) => held.slug === tag.slug))].slice(0, Math.max(TAGS_OFFERED, known.length));

  useEffect(() => { if (mode === "first") trackFrontierOnboarding("onboarding-shown"); }, [mode]);

  const index = STEPS.indexOf(step);
  const toggle = (list: string[], value: string, max: number) => (list.includes(value) ? list.filter((entry) => entry !== value)
    : list.length >= max ? list : [...list, value]);

  const save = async (finish: boolean) => {
    if (saving) return;
    setSaving(true);
    try {
      // Skipping keeps what was already chosen: a role told is a role known.
      await saveFrontierPrefs(finish ? { role, specialties, interests, done: true }
        : { ...(role ? { role } : {}), ...(specialties.length ? { specialties } : {}), skipped: true });
      // Changing an answer later is not onboarding: only the first card counts.
      if (mode === "first") trackFrontierOnboarding(finish ? "onboarding-done" : "onboarding-skipped", finish ? undefined : step);
      onClose(true);
    } catch (error) {
      toast.error(frontierErrorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const ready = step === "role" ? role !== null : step === "specialties" ? specialties.length >= FRONTIER_ONBOARDING_LIMITS.specialtiesMin : true;
  // The chosen specialties have no tag in use yet: nothing to pick, and finishing is the one thing left.
  const noTags = step === "interests" && !hot.loading && offered.length === 0;
  const finish = <Button size="sm" loading={saving} disabled={specialties.length < FRONTIER_ONBOARDING_LIMITS.specialtiesMin} onClick={() => void save(true)}>完成</Button>;
  return (
    <section aria-labelledby="frontier-onboarding-title" data-frontier-onboarding="" className="rounded-card border border-border bg-surface p-4">
      <header className="flex items-center gap-2">
        <h2 id="frontier-onboarding-title" className="min-w-0 flex-1 text-body font-semibold leading-6 text-text">{QUESTIONS[step]}</h2>
        <span className="shrink-0 text-caption tabular-nums text-text-3" aria-label={`第 ${index + 1} 步，共 ${STEPS.length} 步`}>{index + 1}/{STEPS.length}</span>
        {mode === "first"
          ? <Button variant="text" size="sm" disabled={saving} onClick={() => void save(false)}>跳过</Button>
          : <Button variant="text" size="sm" disabled={saving} onClick={() => onClose(false)}>取消</Button>}
      </header>

      <div className="mt-3">
        {step === "role" && (
          <div role="group" aria-label={QUESTIONS.role} className="flex flex-wrap gap-1">
            {FRONTIER_READER_ROLES.map((key) => (
              <FilterChip key={key} pressed={role === key} onClick={() => setRole(role === key ? null : key)}>{FRONTIER_READER_ROLE_LABELS_ZH[key]}</FilterChip>
            ))}
          </div>
        )}
        {step === "specialties" && (
          <div className="space-y-2">
            {FRONTIER_SPECIALTY_GROUPS.map((group) => (
              <div key={group.key} role="group" aria-label={group.label} className="flex flex-wrap items-center gap-1">
                <span className="w-16 shrink-0 text-caption text-text-3">{group.label}</span>
                {group.specialties.map((key) => {
                  const chosen = specialties.includes(key);
                  return (
                    <FilterChip key={key} pressed={chosen} disabled={!chosen && specialties.length >= FRONTIER_ONBOARDING_LIMITS.specialtiesMax}
                      onClick={() => setSpecialties(toggle(specialties, key, FRONTIER_ONBOARDING_LIMITS.specialtiesMax))}>
                      {FRONTIER_SPECIALTY_LABELS_ZH[key] ?? key}
                    </FilterChip>
                  );
                })}
              </div>
            ))}
          </div>
        )}
        {noTags && <Note action={finish}>这些专科还没有常用标签</Note>}
        {step === "interests" && !noTags && (
          <div role="group" aria-label={QUESTIONS.interests} aria-busy={hot.loading} className="flex min-h-sm flex-wrap gap-1">
            {offered.map((tag) => {
              const chosen = interests.includes(tag.slug);
              return (
                <FilterChip key={tag.slug} pressed={chosen} disabled={!chosen && interests.length >= FRONTIER_ONBOARDING_LIMITS.interestsMax}
                  onClick={() => setInterests(toggle(interests, tag.slug, FRONTIER_ONBOARDING_LIMITS.interestsMax))}>#{tag.name}</FilterChip>
              );
            })}
          </div>
        )}
      </div>

      <footer className="mt-4 flex items-center gap-2">
        {index > 0 && <Button variant="secondary" size="sm" disabled={saving} onClick={() => setStep(STEPS[index - 1])}>上一步</Button>}
        {step !== "interests"
          ? <Button size="sm" disabled={!ready || saving} onClick={() => setStep(STEPS[index + 1])}>下一步</Button>
          : !noTags && finish}
      </footer>
    </section>
  );
}

/**
 * Where the onboarding answer is changed later (owner: 「the choices editable later where follows are managed」): a row in
 * 「管理关注」 — the answer in a few words and 「修改」, which opens the same card in place. Saving it tells the page, which reads
 * 与我相关 again. A server without the route shows no row.
 */
export function FrontierPrefsRow() {
  const [prefs, setPrefs] = useState<FrontierPrefs | null>(null);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    let active = true;
    fetchFrontierPrefs().then((value) => { if (active) setPrefs(value); }, () => { /* no route here: no row */ });
    return () => { active = false; };
  }, []);
  if (!prefs) return null;
  if (editing) {
    return (
      <FrontierOnboarding mode="edit" initial={prefs} onClose={(saved) => {
        setEditing(false);
        if (!saved) return;
        void fetchFrontierPrefs().then(setPrefs, () => undefined);
        window.dispatchEvent(new Event(FRONTIER_FOLLOWS_CHANGED));
      }} />
    );
  }
  const parts = [
    prefs.role ? FRONTIER_READER_ROLE_LABELS_ZH[prefs.role] ?? null : null,
    prefs.specialties.map((key) => FRONTIER_SPECIALTY_LABELS_ZH[key] ?? key).join("、") || null,
    prefs.interests.length ? `${prefs.interests.length} 个标签` : null,
  ].filter(Boolean);
  return (
    <div className="flex items-center gap-3 text-ui">
      <span className="shrink-0 text-text-2">我的专业</span>
      <span className="min-w-0 flex-1 truncate text-text">{parts.length ? parts.join(" · ") : "未填写"}</span>
      <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>{parts.length ? "修改" : "填写"}</Button>
    </div>
  );
}
