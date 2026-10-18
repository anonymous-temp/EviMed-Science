import { useCallback, useEffect, useState } from "react";
import { ClipboardList } from "lucide-react";
import { webErrorMessage, listWebAuditLog, type WebAuditRecord } from "@/lib/apiClient";
import { cn } from "@/lib/cn";
import { LEDGER_STATUS_LABEL, auditActionLabel, auditTarget, labelFor } from "@/lib/statusLabel";
import { toast } from "@/lib/toast";
import { formatClock, humanSize } from "@/lib/format";
import { Tooltip } from "@/components/ui/Tooltip";
import { CopyId, OPS_TONE, OpsBody, OpsCard, OpsNothing, OpsRow, OpsRows, type OpsTone } from "./OpsCard";

export function WebAuditCard() {
  const [events, setEvents] = useState<WebAuditRecord[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setEvents(await listWebAuditLog(20));
    } catch (e) {
      toast.error(`无法读取操作审计日志：${webErrorMessage(e)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <OpsCard title="操作审计" description="该工作区最近的项目操作" refresh={{ label: "刷新审计事件", loading, onRefresh: () => void refresh() }}>
      <OpsBody>
        <OpsRows label="项目操作">
          {events.length === 0 ? (
            <OpsNothing>暂无近期审计事件。</OpsNothing>
          ) : (
            events.map((event, index) => {
              const target = auditTarget(event.target, event.command);
              return (
                <OpsRow key={`${event.action ?? event.command ?? "event"}-${event.createdAt}-${index}`}>
                  <ClipboardList size={16} className={cn("shrink-0", OPS_TONE[statusTone(event.status)] || "text-text-3")} aria-hidden="true" />
                  {/* The ledger's own name for the action stays in the tooltip, for whoever has to search the log. */}
                  <Tooltip content={event.action ?? "操作"}>
                    <span className="w-28 shrink-0 truncate text-caption text-text">
                      {auditActionLabel(event.action)}
                    </span>
                  </Tooltip>
                  <Tooltip content={event.status}>
                    <span className={cn("w-20 shrink-0 text-caption", OPS_TONE[statusTone(event.status)])}>
                      {labelFor(LEDGER_STATUS_LABEL, event.status)}
                    </span>
                  </Tooltip>
                  <span className="min-w-0 flex-1 truncate text-caption text-text-3">{target.text}</span>
                  {target.id && <CopyId value={target.id} label={`复制“${target.text}”的标识`} />}
                  <span className="hidden w-16 shrink-0 text-right text-caption text-text-3 sm:block">
                    {event.bytes ? humanSize(event.bytes) : ""}
                  </span>
                  <span className="shrink-0 font-mono text-caption text-text-3">{formatClock(event.createdAt)}</span>
                </OpsRow>
              );
            })
          )}
        </OpsRows>
      </OpsBody>
    </OpsCard>
  );
}

/** A failure is red; what went through is the page's own text. */
function statusTone(status: WebAuditRecord["status"]): OpsTone {
  return status === "failed" ? "failed" : "ok";
}
