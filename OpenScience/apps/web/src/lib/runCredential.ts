import { CONNECTOR_CREDENTIALS } from "@evimed/domain";
import type { WebAgentRun, WebConnector } from "@/lib/apiClient";

/**
 * Which one data source a failed run needed a credential for, if the ledger
 * can say.
 *
 * The credentials banner used to greet every page with seven source names a
 * researcher mostly could not act on (review B §7). The one moment that
 * condition matters to them is when their own run stopped on it, and then the
 * useful thing is to name that one source on that run's row.
 *
 * Two readings, both closed-vocabulary. The gateway names the profile in its
 * own code — `public_source_<profile>_credential_missing`
 * (`publicSourceGateway.mjs`) — so a run whose ledger recorded that code needed
 * exactly that source. Failing that, a capability that lists a connector as a
 * dependency (`CONNECTOR_CREDENTIALS[].capabilities`) and whose connector no
 * one has configured is stated as what it is: this capability needs it, and it
 * is not there. That second sentence claims a dependency, not a cause.
 */
export interface RunCredentialNeed {
  connectorId: string;
  title: string;
  /** `code`: the ledger recorded the gateway refusing for this source. */
  cause: "code" | "capability";
}

type Spec = { id: string; title: string; capabilities: readonly string[] };
const SPECS = CONNECTOR_CREDENTIALS as unknown as readonly Spec[];

const MISSING = /^public_source_([a-z0-9_]+)_credential_missing$/;

function specForCode(code: string | null | undefined): Spec | null {
  const match = code ? MISSING.exec(code) : null;
  if (!match) return null;
  return SPECS.find((spec) => spec.id.replaceAll("-", "_") === match[1]) ?? null;
}

export function runCredentialNeed(
  run: Pick<WebAgentRun, "status" | "errorCode" | "errorSubCode" | "effectiveAgentId" | "agentId">,
  connectors?: readonly WebConnector[] | null,
): RunCredentialNeed | null {
  if (run.status !== "failed") return null;
  const named = specForCode(run.errorCode) ?? specForCode(run.errorSubCode ?? null);
  if (named) return { connectorId: named.id, title: named.title, cause: "code" };
  const capability = run.effectiveAgentId ?? run.agentId;
  if (!capability || !connectors) return null;
  const unmet = SPECS.filter((spec) => spec.capabilities.includes(capability)
    && connectors.some((connector) => connector.id === spec.id && connector.needsAttention));
  return unmet.length === 1 ? { connectorId: unmet[0].id, title: unmet[0].title, cause: "capability" } : null;
}

/** The sentence for the run's row. */
export function runCredentialSentence(need: RunCredentialNeed): string {
  return need.cause === "code"
    ? `这次运行因缺少 ${need.title} 的凭据没能继续。`
    : `这项能力需要 ${need.title} 的凭据，你的账号和本部署都还没有配置。`;
}
