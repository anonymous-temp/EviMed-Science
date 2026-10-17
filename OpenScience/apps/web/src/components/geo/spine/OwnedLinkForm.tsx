import { useState } from "react";
import { webErrorMessage } from "@/lib/apiClient";
import { createGeoOwnedLink, getGeoArticleText, type GeoAction, type GeoActionSource } from "@/lib/geoClient";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

/**
 * 「该发到哪」 for the brand's own channel (R19, audit C §2.5, "没有市场的现状"): with no media market the way an article leaves is a
 * person publishing it on the brand's own platform, and the platform finds out from the page's address. Two things a person does
 * there, both here:
 *
 *  - 复制稿件 — the article as it would leave the platform, onto the clipboard;
 *  - 我已发布，贴链接 — the address of the page they published. It is registered exactly as the run's own `geo_write owned_links`
 *    registers one: the post-publication re-tests (weeks 1, 2, 4, 8, 12) and the citation match read it and nothing else is asked.
 *
 * The address is sent with the article's id: an action moves through the article it names. Pasting the same page again is an
 * update, never a second row.
 */
export function OwnedLinkForm({
  geoId,
  action,
  source,
  articleId,
  onRegistered,
}: {
  geoId: string;
  action: GeoAction;
  source: GeoActionSource;
  /** The article the page is: the one written for this channel. Without one the link is the group's, and no action moves by it. */
  articleId: string | null;
  onRegistered: () => void;
}) {
  const [asking, setAsking] = useState(false);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState<"copy" | "send" | null>(null);

  const copy = () => {
    if (!articleId) return;
    setBusy("copy");
    void getGeoArticleText(geoId, articleId)
      .then(async (text) => {
        if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
        await navigator.clipboard.writeText(text.markdown);
        toast.success("稿件已复制，可以直接贴到平台里。");
      })
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "稿件暂时无法复制，请稍后重试。" })))
      .finally(() => setBusy(null));
  };

  const send = () => {
    const address = url.trim();
    if (!address) return;
    setBusy("send");
    void createGeoOwnedLink(geoId, {
      url: address,
      platform: source.channel ?? "other",
      ...(articleId ? { articleId } : {}),
      ...(action.group ? { groupId: action.group.id } : {}),
    })
      .then(() => {
        toast.success("已登记，发布后第 1、2、4、8、12 周会自动复测。");
        setUrl("");
        setAsking(false);
        onRegistered();
      })
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "这个链接无法登记，请检查地址后重试。" })))
      .finally(() => setBusy(null));
  };

  return (
    <div data-geo-owned-link-form="" className="mt-2 flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {articleId && <Button variant="secondary" size="sm" loading={busy === "copy"} onClick={copy}>复制稿件</Button>}
        {!asking && <Button variant="secondary" size="sm" onClick={() => setAsking(true)}>我已发布，贴链接</Button>}
      </div>
      {asking && (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            send();
          }}
        >
          <Input
            type="url"
            inputMode="url"
            name="owned-link"
            aria-label="发布后的页面链接"
            placeholder="https://"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            className="min-w-0 flex-1"
          />
          <Button type="submit" size="sm" loading={busy === "send"} disabled={!url.trim()}>登记</Button>
          <Button type="button" variant="text" size="sm" onClick={() => { setAsking(false); setUrl(""); }}>取消</Button>
        </form>
      )}
    </div>
  );
}
