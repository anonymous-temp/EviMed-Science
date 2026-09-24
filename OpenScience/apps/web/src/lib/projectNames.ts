import { webErrorMessage, type WebProject } from "@/lib/apiClient";
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
