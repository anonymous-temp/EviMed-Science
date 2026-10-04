import { useState } from "react";
import { Link } from "react-router";
import { X } from "lucide-react";
import { dispatchWebAgentRun, webErrorMessage, type WebAgentRun, type WebConnectorCheck } from "@/lib/apiClient";
import { announceConnectorsChanged, useConnectors } from "@/lib/connectorAttention";
import { continuationText, runCredentialNeeds, runCredentialSentence } from "@/lib/runCredential";
import { announceRunsChanged, OPEN_DOMAIN_ANSWER_AGENT_ID } from "@/lib/runPresentation";
import { toast } from "@/lib/toast";
import { Button, buttonClasses } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { ConnectorCredentialForm } from "@/components/settings/ConnectorCredentialForm";

const DISMISSED_KEY = "evimed.connector-need.dismissed.v1";
/** Runs remembered as dismissed; the oldest go first. */
const DISMISSED_LIMIT = 100;

function dismissedRuns(): string[] {
  try {
    const value = JSON.parse(window.sessionStorage.getItem(DISMISSED_KEY) ?? "[]") as unknown;
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function rememberDismissed(runId: string): void {
  try {
    window.sessionStorage.setItem(DISMISSED_KEY, JSON.stringify([...dismissedRuns().filter((id) => id !== runId), runId].slice(-DISMISSED_LIMIT)));
  } catch {
    // A refused storage only costs the memory of the dismissal.
  }
}

/**
 * Where a conversation says that its last answer went without a data source —
 * and lets the researcher put that right without leaving it.
 *
 * A source nobody configured is the researcher's to configure when they use it
 * (2026-10-04): the run went on with the sources it had and the ledger recorded
 * what it left out (`connectorNeeds`). This strip, above the conversation and
 * outside the kernel's frame, names each one and offers 去配置, which opens the
 * same credential form 设置 → 数据源 uses, in place. Once a source is saved the
 * strip offers 继续, one click: it posts a follow-up turn into the SAME
 * conversation (the existing dispatch route, on the line the run was on) asking
 * the model to redo the part it skipped. Nothing else asks for approval, and 关闭
 * puts the strip away for that run.
 *
 * Only the conversation's latest run is read, so a newer turn — the follow-up
 * included — replaces what the strip says. With the connector list unreadable
 * the form cannot be offered, so 去配置 is a link to the page that has it.
 */
export function ConnectorNeedNotice({ run }: { run: WebAgentRun | null }) {
  const asks = (run?.status === "succeeded" || run?.status === "failed") && (run.connectorNeeds?.length ?? 0) > 0;
  const connectors = useConnectors(asks);
  const needs = runCredentialNeeds(run, connectors);
  const [editing, setEditing] = useState<string | null>(null);
  const [checks, setChecks] = useState<Record<string, WebConnectorCheck>>({});
  const [sending, setSending] = useState(false);
  const [away, setAway] = useState<string[]>(() => dismissedRuns());

  if (!run || needs.length === 0 || away.includes(run.id)) return null;

  const ready = needs.filter((need) => need.state === "configured");

  const close = () => {
    rememberDismissed(run.id);
    setAway((previous) => [...previous, run.id]);
  };

  const continueRun = async () => {
    setSending(true);
    try {
      // The line the skipped part was on: an open conversation keeps its own
      // (the answer line or the capability that routed it), a bound one stays
      // with its capability on its own.
      const line = run.mode === "open-domain"
        ? (run.effectiveAgentId && run.effectiveAgentId !== OPEN_DOMAIN_ANSWER_AGENT_ID ? run.effectiveAgentId : "answer")
        : undefined;
      await dispatchWebAgentRun(
        run.sessionId,
        continuationText(ready.map((need) => need.title)),
        `web-${crypto.randomUUID().replace(/-/g, "")}`,
        line,
      );
      announceRunsChanged();
      // The follow-up is a new turn in this conversation; this strip was about the last one.
      close();
    } catch (caught) {
      toast.error(`无法继续：${webErrorMessage(caught)}`);
    } finally {
      setSending(false);
    }
  };

  return (
    <div role="status" aria-live="polite" data-connector-need="" className="flex shrink-0 items-start gap-3 border-b border-border bg-surface-2 px-4 py-2 text-compact text-text">
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        {needs.map((need) => {
          const connector = connectors?.find((candidate) => candidate.id === need.connectorId) ?? null;
          const refused = checks[need.connectorId] === "rejected";
          return (
            <div key={need.connectorId} className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <p className="min-w-0">
                  {refused ? `${need.title} 已保存，但数据源拒绝了这个凭据，请核对。` : runCredentialSentence(need)}
                </p>
                {need.state === "missing" && editing !== need.connectorId && (connector ? (
                  <Button size="sm" variant="secondary" onClick={() => setEditing(need.connectorId)}>去配置</Button>
                ) : (
                  <Link to="/app/account?tab=connectors" className={buttonClasses({ variant: "secondary", size: "sm" })}>去配置</Link>
                ))}
              </div>
              {connector && editing === need.connectorId && (
                <ConnectorCredentialForm
                  connector={connector}
                  onCancel={() => setEditing(null)}
                  onSaved={(saved) => {
                    setEditing(null);
                    setChecks((previous) => ({ ...previous, [need.connectorId]: saved.check }));
                    // The list the strip reads is the settings page's: tell it, so this need becomes 已配置.
                    announceConnectorsChanged();
                  }}
                />
              )}
            </div>
          );
        })}
        {ready.length > 0 && (
          <div>
            <Button size="sm" loading={sending} onClick={() => void continueRun()}>继续</Button>
          </div>
        )}
      </div>
      <IconButton icon={X} label="关闭提示" size="sm" onClick={close} />
    </div>
  );
}
