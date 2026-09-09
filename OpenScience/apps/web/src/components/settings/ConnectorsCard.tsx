import { useEffect, useState } from "react";
import { ExternalLink, KeyRound, Trash2 } from "lucide-react";
import {
  fetchWebConnectors,
  removeWebConnectorCredential,
  saveWebConnectorCredential,
  type WebConnector,
} from "@/lib/apiClient";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/cn";

/**
 * The external data sources, and where each one's credential comes from.
 *
 * A source the deployment has configured needs nothing from the researcher.
 * One it has not — OpenGWAS is the standing case, its token belongs to a
 * person and expires every fourteen days — can take the researcher's own,
 * which the server keeps encrypted and uses only for their runs. Values go
 * in and are never shown again; the card reports a source, never a value.
 */
export function ConnectorsCard() {
  const [connectors, setConnectors] = useState<WebConnector[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const reload = () =>
    fetchWebConnectors()
      .then((list) => {
        setConnectors(list);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));

  useEffect(() => {
    let active = true;
    void fetchWebConnectors()
      .then((list) => {
        if (active) setConnectors(list);
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      active = false;
    };
  }, []);

  const save = async (connector: WebConnector) => {
    const value = (drafts[connector.id] ?? "").trim();
    if (!value) return;
    setBusy(connector.id);
    try {
      const saved = await saveWebConnectorCredential(connector.id, value);
      setDrafts((d) => ({ ...d, [connector.id]: "" }));
      toast.success(
        saved.expiresAt
          ? `${connector.title} 凭据已保存，有效期至 ${new Date(saved.expiresAt).toLocaleDateString("zh-CN")}。`
          : `${connector.title} 凭据已保存。`,
      );
      await reload();
    } catch (err) {
      toast.error(`保存失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const remove = async (connector: WebConnector) => {
    setBusy(connector.id);
    try {
      await removeWebConnectorCredential(connector.id);
      toast.success(`已移除你的 ${connector.title} 凭据。`);
      await reload();
    } catch (err) {
      toast.error(`移除失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const attention = connectors?.filter((c) => c.needsAttention).length ?? 0;

  return (
    <Card
      className="mt-5"
      title="数据源凭据"
      hint={
        attention > 0
          ? `${attention} 个数据源本部署没有配置凭据；填入你自己的，只用于你的研究运行。`
          : "本部署已为下列数据源配置凭据的，你不需要再填；其余可以填入你自己的。"
      }
    >
      {error && <p className="text-ui text-error">读取数据源状态失败：{error}</p>}
      {!error && !connectors && <p className="text-ui text-muted">正在读取…</p>}
      {connectors && (
        <ul className="flex flex-col divide-y divide-border">
          {connectors.map((connector) => (
            <li key={connector.id} className="flex flex-col gap-2 py-3" data-testid={`connector-${connector.id}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-ui font-medium text-text">{connector.title}</span>
                    <SourceChip connector={connector} />
                  </div>
                  <p className="mt-0.5 text-caption text-muted">{connector.unlocks}</p>
                  {connector.own && (
                    <p className="mt-0.5 text-caption text-muted">
                      你的凭据更新于 {new Date(connector.own.updatedAt).toLocaleDateString("zh-CN")}
                      {connector.own.expiresAt &&
                        `，${connector.own.expired ? "已于" : "有效期至"} ${new Date(connector.own.expiresAt).toLocaleDateString("zh-CN")}${connector.own.expired ? " 过期" : ""}`}
                      。
                    </p>
                  )}
                </div>
                <a
                  href={connector.obtainUrl}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={`获取 ${connector.title} 凭据`}
                  className="flex shrink-0 items-center gap-1 text-caption text-accent hover:underline"
                >
                  获取
                  <ExternalLink size={12} aria-hidden="true" />
                </a>
              </div>
              {connector.source !== "deployment" && (
                <form
                  className="flex items-center gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void save(connector);
                  }}
                >
                  <Input
                    type="password"
                    autoComplete="off"
                    aria-label={`${connector.title} 凭据`}
                    placeholder={connector.kind === "email" ? "联系邮箱" : connector.kind === "jwt" ? "粘贴 JWT 令牌" : "粘贴 API 密钥"}
                    value={drafts[connector.id] ?? ""}
                    onChange={(e) => setDrafts((d) => ({ ...d, [connector.id]: e.target.value }))}
                    className="flex-1"
                  />
                  <Button
                    type="submit"
                    variant="primary"
                    aria-label={`保存 ${connector.title} 凭据`}
                    disabled={busy === connector.id || !(drafts[connector.id] ?? "").trim()}
                  >
                    <KeyRound size={14} aria-hidden="true" />
                    保存
                  </Button>
                  {connector.own && (
                    <Button
                      type="button"
                      variant="ghost"
                      aria-label={`移除 ${connector.title} 凭据`}
                      disabled={busy === connector.id}
                      onClick={() => void remove(connector)}
                    >
                      <Trash2 size={14} aria-hidden="true" />
                    </Button>
                  )}
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-caption text-muted">凭据加密保存，只在你自己的运行里由服务端代为使用；运行环境本身从不持有它。</p>
    </Card>
  );
}

function SourceChip({ connector }: { connector: WebConnector }) {
  const label =
    connector.source === "deployment"
      ? "平台已配置"
      : connector.source === "user"
        ? "已用你的凭据"
        : connector.keyless
          ? "无需凭据"
          : "未配置";
  const tone =
    connector.source === "deployment" || connector.source === "user"
      ? "bg-ok/10 text-ok"
      : connector.keyless
        ? "bg-surface-2 text-muted"
        : "bg-warn/10 text-warn";
  return <span className={cn("rounded-input px-1.5 py-0.5 text-caption", tone)}>{label}</span>;
}
