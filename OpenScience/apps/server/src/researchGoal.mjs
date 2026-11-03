/**
 * 「发起研究」 on 主动科研: the person writes a goal and nothing else. The prompt carries `/loopx`, the kernel's own gesture for a skill: it
 * injects the skill's instructions into the turn and arms LoopX's driver (`exactUserActivation`), which an ordinary sentence asking for the
 * skill did not do when tried on production (2026-11-01: no goal, no continuation). The run is listed by the person's sentence. The route
 * names the run that set the goal, which is how the page lists a goal from its first second instead of from its first continuation.
 */
export const RESEARCH_GOAL_ROUTE = "research-goal";

/** What the kernel receives as the person's message. @param {string} goal */
export function researchGoalPrompt(goal) {
  return `/loopx ${goal}`;
}

/**
 * Whether a run is the one that set a research goal, by the route the control plane minted for it (never by anything the person wrote).
 * @param {{ effectiveRouteReason?: unknown } | null | undefined} run
 */
export function isResearchGoalRun(run) {
  const route = String(run?.effectiveRouteReason ?? "");
  return route === RESEARCH_GOAL_ROUTE || route.endsWith(`:${RESEARCH_GOAL_ROUTE}`);
}

/**
 * The person's sentence in the message `researchGoalPrompt` made: the gesture at its head is the platform's and is taken out. One closed
 * token that stands alone, not a reading of language; used for the messages of a run `isResearchGoalRun` names, so that what memory and
 * learning see is what the person wrote. (The learning digest, in `@evimed/domain`, takes the same token out of the same message.)
 * @param {unknown} text
 */
export function withoutResearchGoalGesture(text) {
  return String(text ?? "").replace(/^\s*\/loopx(?:\s+|$)/, "");
}

/** What the run's context adds, so a goal that looks small still starts as a goal. */
export function researchGoalBlock() {
  return `\n\n<evimed-research-goal>
The person set this as a long research goal from the research page. The \`loopx\` skill's instructions are in this turn: start the goal with its CLI and complete the thread binding before any research work, then work the goal across turns until it is done. What they connected for this research is in the project's knowledge base: look through it before you plan. Write to them about the research only, never about the skill, the goal machinery or its commands.
</evimed-research-goal>`;
}
