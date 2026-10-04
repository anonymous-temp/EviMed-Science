import { useEffect, useRef, useState } from "react";
import { ExternalLink } from "lucide-react";
import { saveWebConnectorCredential, webErrorMessage, type WebConnector, type WebConnectorCheck } from "@/lib/apiClient";
import { toast } from "@/lib/toast";
import { Button, buttonClasses } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

export interface SavedConnectorCredential {
  expiresAt: string | null;
  /** What the source said about it: advice, never a reason it was not kept. */
  check: WebConnectorCheck;
}

/**
 * The one field a data source's credential is typed into — in 设置 → 数据源 and,
 * since 2026-10-04, in the conversation whose run went without that source
 * (`ConnectorNeedNotice`), so the same form is where both places ask.
 *
 * The value goes in and is never shown again. A malformed one is refused here
 * with the reason; every other is kept, and what the source made of it comes
 * back as `check` for the caller to show beside the value. The caller decides
 * what saving means for the surface it is on (a toast and a reload in settings,
 * a 继续 button in the conversation); this only saves.
 */
export function ConnectorCredentialForm({ connector, onSaved, onCancel, autoFocus = true }: {
  connector: Pick<WebConnector, "id" | "title" | "kind" | "obtainUrl">;
  onSaved: (saved: SavedConnectorCredential) => void | Promise<void>;
  onCancel: () => void;
  /** Take the focus on mount: the person just asked for this field. */
  autoFocus?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => { if (autoFocus) field.current?.focus(); }, [autoFocus]);

  const save = async () => {
    const value = draft.trim();
    if (!value) return;
    setBusy(true);
    try {
      const saved = await saveWebConnectorCredential(connector.id, value);
      // Never kept in this component's state past the save.
      setDraft("");
      await onSaved(saved);
    } catch (caught) {
      toast.error(`无法保存：${webErrorMessage(caught)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(event) => { event.preventDefault(); void save(); }}
    >
      <Input
        ref={field}
        type="password"
        autoComplete="off"
        aria-label={`${connector.title} 凭据`}
        placeholder={connector.kind === "email" ? "联系邮箱" : connector.kind === "jwt" ? "粘贴 JWT 令牌" : "粘贴 API 密钥"}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        className="w-72"
      />
      <Button type="submit" aria-label={`保存 ${connector.title} 凭据`} loading={busy} disabled={!draft.trim()}>保存</Button>
      <Button variant="text" onClick={onCancel}>取消</Button>
      <a
        href={connector.obtainUrl}
        target="_blank"
        rel="noreferrer"
        aria-label={`获取 ${connector.title} 凭据`}
        className={buttonClasses({ variant: "text", className: "text-accent hover:text-accent" })}
      >
        获取<ExternalLink size={16} aria-hidden="true" />
      </a>
    </form>
  );
}
