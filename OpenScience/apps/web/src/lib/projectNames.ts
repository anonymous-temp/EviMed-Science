import { useMemo } from "react";
import { webErrorMessage, type WebProject } from "@/lib/apiClient";
import { formatClock, formatDay } from "@/lib/format";
import { useProjectStore } from "@/lib/projects";
import { relativeTime } from "@/lib/runPresentation";

/**
 * What a project is, said once, where the choice is made. A project scopes a
 * container, a workspace, a run ledger and part of memory — the heaviest
 * concept in the product — and until 2026-09-18 nothing anywhere said so
 * (review B §2e). It said 「切换会重启研究运行时」 until switching stopped
 * reloading the page (2026-09-19): a switch starts the other project's runtime
 * if it is not running and leaves this one alone.
 */
export const PROJECT_EXPLAINER = "一个项目 = 独立的工作区、对话与记忆范围，各有自己的研究环境。";

/** The longest name the control plane accepts (contract C4). */
export const PROJECT_NAME_MAX = 40;

/**
 * Why a name cannot be used, or null. Any language is fine: the server derives
 * the id, so there is no character set to refuse any more.
 */
export function projectNameProblem(name: string): string | null {
  const value = name.trim();
  if (!value) return "请给项目起个名字。";
  if ([...value].length > PROJECT_NAME_MAX) return `项目名最多 ${PROJECT_NAME_MAX} 个字。`;
  return null;
}

/**
 * A refusal to create or rename a project, in the reader's words. The one code
 * the error registry has no sentence for is the account's project limit, and
 * its reason is worth saying: each project is its own runtime and workspace.
 */
export function projectErrorMessage(error: unknown, projectCount: number, fallback: string): string {
  return webErrorMessage(error, {
    codes: {
      project_limit_reached: `这个账号已有 ${projectCount} 个项目，达到上限。每个项目都有自己的研究运行时和工作区，所以数量有限；删除一个不再需要的项目后再新建。`,
    },
    fallback,
  });
}

/**
 * 「最近活动 3 小时前」, from what the project list carries, or nothing. How
 * many runs a project holds (「12 次运行」) was the back office's count and
 * went with the 2026-09-23 settings page (inventory §1.10).
 */
export function projectMetaLine(project: WebProject, now = Date.now()): string {
  const last = project.lastActivityAt ? Date.parse(project.lastActivityAt) : Number.NaN;
  return Number.isFinite(last) ? `最近活动 ${relativeTime(last, now)}` : "";
}

/** What a project needs to be told apart from another of its name. */
export type LabelledProject = Pick<WebProject, "id" | "name" | "createdAt">;

/**
 * The names a list of projects is read by, in every place a project is chosen
 * or named — the sidebar, the settings list, the knowledge-base scope menu, the
 * memory project dropdown, and the dialogs that delete or rename one.
 *
 * Two projects can carry one name (a re-run, a second window, two products of
 * one brand), and a list of “波立维” and “波立维” tells the reader nothing. A
 * name that is alone stays as it is. A name that occurs more than once gets the
 * day the project was made — “波立维 · 9月29日”; two made the same day also get
 * the time — “波立维 · 9月29日 14:02”; and a project the store has no day for
 * (or two made in the same minute) gets its place in the list — “波立维 · 第 2 个”,
 * counted in the order they were made, then by id, so the number does not move
 * when the list is read in another order.
 *
 * It is a label and nothing else: the stored name is never changed, a rename
 * starts from the stored name, and the key here is the project's id.
 */
export function projectLabels(projects: readonly LabelledProject[]): Map<string, string> {
  const byName = new Map<string, LabelledProject[]>();
  for (const project of projects) byName.set(project.name, [...(byName.get(project.name) ?? []), project]);
  const labels = new Map<string, string>();
  for (const [name, group] of byName) {
    if (group.length === 1) {
      labels.set(group[0].id, name);
      continue;
    }
    const ordered = [...group].sort((left, right) => (left.createdAt ?? "").localeCompare(right.createdAt ?? "") || left.id.localeCompare(right.id));
    const day = (project: LabelledProject) => formatDay(project.createdAt);
    const sameDay = (project: LabelledProject) => day(project) !== "" && ordered.filter((other) => day(other) === day(project)).length > 1;
    const withTime = (project: LabelledProject) => `${day(project)} ${formatClock(project.createdAt)}`;
    const sameTime = (project: LabelledProject) => ordered.filter((other) => sameDay(other) && withTime(other) === withTime(project)).length > 1;
    ordered.forEach((project, index) => {
      const ordinal = `${name} · 第 ${index + 1} 个`;
      if (day(project) === "") labels.set(project.id, ordinal);
      else if (!sameDay(project)) labels.set(project.id, `${name} · ${day(project)}`);
      else if (!sameTime(project)) labels.set(project.id, `${name} · ${withTime(project)}`);
      else labels.set(project.id, ordinal);
    });
  }
  return labels;
}

/** The label of one project among `projects`: its name, told apart from a namesake when it has one. */
export function labelOf(labels: ReadonlyMap<string, string>, project: Pick<WebProject, "id" | "name">): string {
  return labels.get(project.id) ?? project.name;
}

/** The account's projects as the shared store holds them, labelled (`projectLabels`). */
export function useProjectLabels(): Map<string, string> {
  const projects = useProjectStore((state) => state.projects);
  return useMemo(() => projectLabels(projects), [projects]);
}
