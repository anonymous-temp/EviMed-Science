import { CONNECTOR_CREDENTIALS } from "@evimed/domain";
import type { WebAgentRun, WebConnector } from "@/lib/apiClient";

/**
 * Which data sources a finished run went without, and what is true of each one
 * now.
 *
 * A source nobody configured is no longer a failed run (2026-10-04): the run
 * went on with the sources it had and the ledger recorded what it left out
 * (`connectorNeeds`, registry ids) — on a run that finished, and on one that
 * ended with nothing to hand over because its only path needed the source. The conversation then offers the researcher
 * a form for each, and — once saved — a way to ask for the skipped part again.
 * This reads that record against the account's own connector list:
 *
 *  - `missing`: nothing serves the source for this researcher. 去配置.
 *  - `configured`: something does now — they saved it, or the deployment did
 *    since. The run still predates it. 继续.
 *
 * Closed-vocabulary on both sides: the ids come from the registry the ledger
 * wrote them from, so a source this build does not know is not offered.
 */
export interface RunCredentialNeed {
  connectorId: string;
  title: string;
  state: "missing" | "configured";
}

type Spec = { id: string; title: string };
const SPECS = CONNECTOR_CREDENTIALS as unknown as readonly Spec[];

/**
 * The needs of one run, in the order the run met them. Empty for a run that is
 * still going, was stopped, or left nothing out. With no connector list yet
 * (not read, or unreadable) every need reads as missing: the form is offered, and
 * saving is what finds out.
 */
export function runCredentialNeeds(
  run: Pick<WebAgentRun, "status" | "connectorNeeds"> | null | undefined,
  connectors?: readonly WebConnector[] | null,
): RunCredentialNeed[] {
  if (!run || (run.status !== "succeeded" && run.status !== "failed") || !Array.isArray(run.connectorNeeds)) return [];
  const needs: RunCredentialNeed[] = [];
  for (const id of run.connectorNeeds) {
    const spec = SPECS.find((candidate) => candidate.id === id);
    if (!spec || needs.some((need) => need.connectorId === id)) continue;
    const served = connectors?.find((connector) => connector.id === id)?.source;
    needs.push({ connectorId: id, title: spec.title, state: served === "user" || served === "deployment" ? "configured" : "missing" });
  }
  return needs;
}

/** The sentence for one need, in the notice's own words. */
export function runCredentialSentence(need: RunCredentialNeed): string {
  return need.state === "missing"
    ? `${need.title} 还没有配置，相关部分已跳过。`
    : `${need.title} 已配置。`;
}

/**
 * The follow-up a researcher sends with one click once a source is configured:
 * what the model needs to redo the part it skipped, in the researcher's voice.
 * It names the source and nothing about how it was skipped — the model has that
 * in its own turn.
 */
export function continuationText(titles: readonly string[]): string {
  return `我已经配置了 ${titles.join("、")}，请用${titles.length > 1 ? "它们" : "它"}补做刚才因为缺少${titles.length > 1 ? "它们" : "它"}而跳过的部分。`;
}
