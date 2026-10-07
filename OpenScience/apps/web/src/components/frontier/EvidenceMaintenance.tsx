import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Switch } from "@/components/ui/Switch";
import { EmptyState } from "@/components/cards/EmptyState";
import { FrontierSkeleton } from "./FrontierSkeleton";
import { evidenceDate } from "./EvidenceReading";
import { useEvidenceScope } from "./useEvidenceScope";
import {
  fetchEvidenceMaintenance,
  saveEvidenceMaintenance,
  refreshEvidenceZone,
  evidenceErrorMessage,
  type EvidenceZone,
  type EvidenceMaintenance as Maintenance,
  type EvidenceAutomation,
} from "@/lib/evidenceZoneClient";

const sources = [
  ["journal", "学术期刊"],
  ["regulator", "监管机构"],
  ["evidence-body", "循证与指南机构"],
  ["preprint", "预印本"],
  ["company", "企业发布"],
  ["media", "媒体报道"],
] as const;
/** The service orders recent jobs newest first; later jobs supersede each card's old checks. */
function hasPendingSourceChecks(data: Maintenance) {
  const seen = new Set<string>();
  return data.recent.some((job) => {
    if (!job.cardId || seen.has(job.cardId)) return false;
    seen.add(job.cardId);
    return job.sourceCheckStatus === "partial";
  });
}
export function EvidenceMaintenance({
  zone,
  onUpdated,
}: {
  zone: EvidenceZone;
  onUpdated: () => void;
}) {
  const [data, setData] = useState<Maintenance | null>(null);
  const [draft, setDraft] = useState<EvidenceAutomation | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [updated, setUpdated] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const capture = useEvidenceScope(`${zone.id}:${refresh}`);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    fetchEvidenceMaintenance(zone.id)
      .then((result) => {
        if (active) {
          setData(result);
          setDraft(result.automation);
        }
      })
      .catch((reason) => {
        if (active) setError(evidenceErrorMessage(reason));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [zone.id, refresh]);
  const awaitingSchedule =
    !!data?.automation.enabled &&
    zone.state === "published" &&
    !!data.automation.nextRunAt &&
    Date.parse(data.automation.nextRunAt) <= Date.now();
  const updating =
    !!data &&
    (data.jobs.running > 0 || data.jobs.pending > 0 || awaitingSchedule);
  useEffect(() => {
    if (!updating) return;
    let active = true;
    const timer = setInterval(() => {
      fetchEvidenceMaintenance(zone.id)
        .then((result) => {
          if (!active) return;
          setData(result);
          const stillScheduled =
            result.automation.enabled &&
            !!result.automation.nextRunAt &&
            Date.parse(result.automation.nextRunAt) <= Date.now();
          if (!result.jobs.running && !result.jobs.pending && !stillScheduled) {
            setMessage(
              hasPendingSourceChecks(result)
                ? "本轮处理已结束；仍有部分来源待复核，可查看当前证据与来源状态。"
                : "本轮更新已结束，可查看当前证据。",
            );
            setUpdated(true);
          }
        })
        .catch((reason) => {
          if (active) setError(evidenceErrorMessage(reason));
        });
    }, 10000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [updating, zone.id]);
  const patch = (value: Partial<EvidenceAutomation>) =>
    setDraft((previous) => (previous ? { ...previous, ...value } : previous));
  const act = async (action: () => Promise<Maintenance>, success: string) => {
    const current = capture();
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await action();
      if (current()) {
        setData(result);
        setDraft(result.automation);
        setMessage(success);
      }
    } catch (reason) {
      if (current()) setError(evidenceErrorMessage(reason));
    } finally {
      if (current()) setBusy(false);
    }
  };
  return (
    <details className="border-t border-border pt-4">
      <summary className="cursor-pointer text-ui font-medium text-text">
        持续更新
      </summary>
      <div className="mt-3 max-w-measure space-y-4">
        {loading ? (
          <FrontierSkeleton />
        ) : error && !data ? (
          <EmptyState
            title={error}
            action={
              <Button
                variant="secondary"
                onClick={() => setRefresh((value) => value + 1)}
              >
                重试
              </Button>
            }
          />
        ) : (
          draft &&
          data && (
            <>
              <form
                className="space-y-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  void act(
                    () => saveEvidenceMaintenance(zone, draft),
                    "更新计划已保存。",
                  );
                }}
              >
                <fieldset className="space-y-4" disabled={busy}>
                  <Switch
                    label="自动寻找新证据"
                    showLabel
                    checked={draft.enabled}
                    onChange={(enabled) => patch({ enabled })}
                    disabled={busy}
                  />
                  {data.billing && (
                    <p className="text-caption text-text-3">
                      {data.billing.payer === "owner"
                        ? "自动更新的模型费用由你的额度支付"
                        : "自动更新的模型费用由平台支付"}
                    </p>
                  )}
                  <Input
                    label="关注的问题或检索词"
                    required
                    minLength={2}
                    maxLength={200}
                    value={draft.query}
                    onChange={(event) => patch({ query: event.target.value })}
                  />
                  <fieldset className="space-y-3">
                    <legend className="mb-2 text-ui font-medium text-text">
                      来源范围
                    </legend>
                    <div className="flex flex-wrap gap-x-4 gap-y-3">
                      {sources.map(([value, label]) => (
                        <Switch
                          key={value}
                          label={label}
                          showLabel
                          checked={draft.sourceTypes.includes(value)}
                          onChange={(checked) =>
                            patch({
                              sourceTypes: checked
                                ? [...draft.sourceTypes, value]
                                : draft.sourceTypes.filter(
                                    (type) => type !== value,
                                  ),
                            })
                          }
                          disabled={busy}
                        />
                      ))}
                    </div>
                  </fieldset>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Input
                      label="更新间隔（小时）"
                      type="number"
                      min={1}
                      max={720}
                      step={1}
                      required
                      value={draft.intervalHours}
                      onChange={(event) =>
                        patch({ intervalHours: Number(event.target.value) })
                      }
                    />
                    <Input
                      label="每次最多新增证据卡"
                      type="number"
                      min={1}
                      max={10}
                      step={1}
                      required
                      value={draft.maxCardsPerRun}
                      onChange={(event) =>
                        patch({ maxCardsPerRun: Number(event.target.value) })
                      }
                    />
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="secondary"
                      type="submit"
                      loading={busy}
                      disabled={
                        !draft.query.trim() || !draft.sourceTypes.length
                      }
                    >
                      保存更新计划
                    </Button>
                    <Button
                      variant="text"
                      disabled={
                        busy ||
                        updating ||
                        zone.state === "draft" ||
                        !data.automation.enabled ||
                        !data.automation.query.trim()
                      }
                      onClick={() => {
                        setUpdated(false);
                        void act(
                          () => refreshEvidenceZone(zone),
                          "已开始寻找与复核新证据。",
                        );
                      }}
                    >
                      立即更新
                    </Button>
                  </div>
                </fieldset>
              </form>
              <div className="space-y-1 text-caption text-text-3">
                {updating && <p role="status">正在寻找与复核新证据</p>}
                {data.automation.lastRunAt && (
                  <p>上次检查 · {evidenceDate(data.automation.lastRunAt)}</p>
                )}
                {data.automation.enabled && data.automation.nextRunAt && (
                  <p>下次更新 · {evidenceDate(data.automation.nextRunAt)}</p>
                )}
                {(data.automation.lastError || data.jobs.failed > 0) && (
                  <p>部分证据更新未完成，可以再次更新。</p>
                )}
                {hasPendingSourceChecks(data) && (
                  <p className="text-warn" role="status">
                    部分来源待复核，已沿用上次保留内容；请查看卡片的来源状态。
                  </p>
                )}
              </div>
              {error && (
                <p role="alert" className="text-ui text-error">
                  {error}
                </p>
              )}
              {message && (
                <p role="status" className="text-caption text-text-2">
                  {message}
                </p>
              )}
              {updated && (
                <Button variant="secondary" onClick={onUpdated}>
                  查看最新证据
                </Button>
              )}
            </>
          )
        )}
      </div>
    </details>
  );
}
