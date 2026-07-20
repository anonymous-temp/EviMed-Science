import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, X } from "lucide-react";
import {
  hpcCancel,
  hpcCheck,
  hpcConfig,
  hpcJobs,
  isTauri,
  listSshHosts,
  setHpcConfig,
  type HpcCheck,
  type HpcJob,
} from "@/lib/tauri";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/cn";

/**
 * Cluster (HPC) over SSH (P2-2). The app uses the user's own ssh keys/config —
 * nothing is installed on the cluster. Connecting here (a) verifies SSH + Slurm
 * and (b) records the host in the workspace's .openscience/hpc.json, where the
 * bundled hpc-slurm skill picks it up so the agent can submit batch jobs.
 * This card is also where the user watches and cancels their queued jobs.
 */
export function ClusterCard() {
  const [hosts, setHosts] = useState<string[]>([]);
  const [host, setHost] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [check, setCheck] = useState<HpcCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<HpcJob[] | null>(null);
  const [loadingJobs, setLoadingJobs] = useState(false);

  const loadJobs = useCallback(async (h: string) => {
    setLoadingJobs(true);
    try {
      setJobs(await hpcJobs(h));
    } catch (e) {
      setJobs(null);
      toast.error(`无法读取队列：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoadingJobs(false);
    }
  }, []);

  useEffect(() => {
    if (!isTauri) return;
    void listSshHosts().then(setHosts).catch(() => undefined);
    void hpcConfig()
      .then((h) => {
        if (!h) return;
        setHost(h);
        void hpcCheck(h).then(setCheck).catch(() => undefined);
        void loadJobs(h);
      })
      .catch((e: unknown) => {
        // A corrupt hand-edited hpc.json must not look like "no cluster".
        toast.error(
          `无法读取集群配置 (.openscience/hpc.json)：${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      });
  }, [loadJobs]);

  const connect = async () => {
    const h = draft.trim();
    if (!h) return;
    setChecking(true);
    setConnectError(null);
    try {
      const c = await hpcCheck(h);
      if (!c.reachable) {
        setConnectError(c.message ?? "连接失败");
        return;
      }
      await setHpcConfig(h);
      setHost(h);
      setCheck(c);
      setDraft("");
      void loadJobs(h);
    } catch (e) {
      setConnectError(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
  };

  const remove = async () => {
    try {
      await setHpcConfig(null);
      setHost(null);
      setCheck(null);
      setJobs(null);
    } catch (e) {
      toast.error(`无法移除：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const cancel = async (id: string) => {
    if (!host) return;
    try {
      await hpcCancel(host, id);
      toast.success(`作业 ${id} 已取消`);
      void loadJobs(host);
    } catch (e) {
      toast.error(`无法取消作业 ${id}：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <section className="mt-5 rounded-card border border-border bg-surface shadow-card">
      <header className="border-b border-border px-5 py-3">
        <h2 className="font-serif text-body text-text">集群计算 (HPC)</h2>
        <p className="mt-0.5 text-xs text-muted">
          通过 SSH 在你的 Slurm 集群上运行重负载任务 — 连接一次，之后直接吩咐智能体。
        </p>
      </header>
      <div className="px-5 py-4">
        {!isTauri ? (
          <p className="text-ui text-muted">请在桌面应用中使用。</p>
        ) : !host ? (
          <>
            <div className="flex items-center gap-2">
              <input
                list="ssh-hosts"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void connect()}
                placeholder={
                  hosts.length > 0
                    ? `user@login.hpc.edu — 或从 ~/.ssh/config 中选择（${hosts.length} 个）`
                    : "user@login.hpc.edu"
                }
                className={inputCls("flex-1 font-mono")}
              />
              <datalist id="ssh-hosts">
                {hosts.map((h) => (
                  <option key={h} value={h} />
                ))}
              </datalist>
              <button
                className={btnAccent()}
                onClick={() => void connect()}
                disabled={checking || !draft.trim()}
              >
                {checking ? <Loader2 size={12} className="animate-spin" /> : null}
                {checking ? "检查中…" : "连接"}
              </button>
            </div>
            {connectError && <p className="mt-2 text-xs text-error">{connectError}</p>}
            <p className="mt-2.5 text-xs leading-relaxed text-muted">
              使用你自己的 SSH 密钥 — 不会在集群上安装任何组件。连接后，智能体可以为你编写并提交
              Slurm 批处理脚本，并把结果取回工作区。
            </p>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2.5 text-ui">
              <span
                className={cn(
                  "h-1.5 w-1.5 shrink-0 rounded-full",
                  check?.slurm ? "bg-ok" : check ? "bg-warn" : "bg-muted",
                )}
              />
              <span className="font-mono font-medium text-text">{host}</span>
              <span className="truncate text-xs text-muted">
                {check?.slurm ?? check?.message ?? "检查中…"}
              </span>
              <div className="flex-1" />
              <button
                className="flex h-7 w-7 items-center justify-center rounded-input text-muted transition-colors hover:bg-surface-2 hover:text-text disabled:opacity-50"
                onClick={() => void loadJobs(host)}
                disabled={loadingJobs}
                title="刷新作业队列"
                aria-label="刷新作业队列"
              >
                <RefreshCw size={13} className={cn(loadingJobs && "animate-spin")} />
              </button>
              <button
                className="text-xs text-muted transition-colors hover:text-error"
                onClick={() => void remove()}
                title="断开此集群"
              >
                移除
              </button>
            </div>

            <div className="mt-3 overflow-hidden rounded-input border border-border">
              {jobs === null ? (
                <p className="bg-surface px-3 py-2.5 text-ui text-muted">
                  {loadingJobs ? "正在读取队列…" : "队列不可用。"}
                </p>
              ) : jobs.length === 0 ? (
                <p className="bg-surface px-3 py-2.5 text-ui text-muted">
                  队列中没有作业。
                </p>
              ) : (
                jobs.map((j, i) => (
                  <div
                    key={j.id}
                    className={cn(
                      "flex h-9 items-center gap-2.5 bg-surface px-3 text-ui",
                      i > 0 && "border-t border-border",
                    )}
                  >
                    <span className="font-mono text-xs text-muted">{j.id}</span>
                    <span
                      className={cn(
                        "rounded-full px-2 py-0.5 text-caption font-medium uppercase tracking-wide ring-1 ring-border",
                        j.state === "RUNNING"
                          ? "text-ok"
                          : j.state === "PENDING"
                            ? "text-warn"
                            : "text-muted",
                      )}
                    >
                      {j.state}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-text">{j.name}</span>
                    <span className="font-mono text-xs text-muted">{j.time}</span>
                    <span className="text-xs text-muted">{j.partition}</span>
                    <button
                      className="flex h-6 w-6 items-center justify-center rounded-input text-muted transition-colors hover:bg-surface-2 hover:text-error"
                      onClick={() => void cancel(j.id)}
                      title={`取消作业 ${j.id}`}
                      aria-label={`取消作业 ${j.id}`}
                    >
                      <X size={13} />
                    </button>
                  </div>
                ))
              )}
            </div>
            <p className="mt-2.5 text-xs text-muted">
              可以让智能体在集群上运行分析 — 它会向这里提交批处理脚本，并把结果取回工作区。
            </p>
          </>
        )}
      </div>
    </section>
  );
}

const inputCls = (extra = "") =>
  cn(
    "h-9 rounded-input border border-border bg-surface px-3 text-ui text-text outline-none",
    "placeholder:text-muted focus:border-accent/60",
    extra,
  );

const btnAccent = (extra = "") =>
  cn(
    "flex h-9 shrink-0 items-center gap-1.5 rounded-input bg-accent px-3.5 text-ui font-medium",
    "text-accent-fg transition-opacity hover:opacity-90 disabled:opacity-50",
    extra,
  );
