import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Input";
import {
  fileTopicRequest,
  listTopicRequests,
  secondTopicRequest,
  topicRequestErrorMessage,
  type TopicRequest,
  type TopicRequestFiled,
} from "@/lib/evidenceTopicRequestClient";

/** The requests a reader sees before asking for the rest. */
const SHOWN = 5;
const TITLE_MIN = 4;
const TITLE_MAX = 200;

/** The list's own order: most requesters first, the earlier request first among equals. */
const ordered = (items: TopicRequest[]) =>
  [...items].sort((a, b) => b.requesters - a.requesters || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));

/**
 * 「申请选题」 — a compact block on the zones list: say which topic you want evidence on, see what others asked for, and second it.
 * The list is ordered by how many accounts asked and by nothing else; the daily limit is the server's, and its refusal is shown as it words it.
 * The page mounts it only where the public pages are on (the routes answer 404 otherwise).
 */
export function TopicRequests({ zones = [] }: { zones?: { id: string; title: string }[] }) {
  const [items, setItems] = useState<TopicRequest[]>([]);
  const [seconded, setSeconded] = useState<Set<string>>(new Set());
  const [remaining, setRemaining] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [zoneId, setZoneId] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [all, setAll] = useState(false);

  const load = useCallback(async (isCurrent: () => boolean) => {
    setLoading(true);
    setLoadError(null);
    try {
      const list = await listTopicRequests();
      if (!isCurrent()) return;
      setItems(ordered(list.items));
      setSeconded(new Set(list.seconded ?? []));
      setRemaining(typeof list.remainingToday === "number" ? list.remainingToday : null);
    } catch (reason) {
      if (isCurrent()) setLoadError(topicRequestErrorMessage(reason));
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, []);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    void load(() => active);
    return () => {
      active = false;
    };
  }, [load, reload]);

  /** What the server says a vote came to, folded into the list without another read. */
  const applied = (result: TopicRequestFiled) => {
    setItems((previous) => ordered([...previous.filter((item) => item.id !== result.request.id), result.request]));
    setSeconded((previous) => new Set(previous).add(result.request.id));
    if (result.seconded) setRemaining((previous) => (previous === null ? previous : Math.max(0, previous - 1)));
    setNotice(
      result.alreadySeconded
        ? "你已经附议过这条申请。"
        : result.filed
          ? "已提交申请。申请的人越多，越靠前。"
          : "这个选题已经有人申请，已为你附议。",
    );
  };

  const submit = async () => {
    const text = title.trim();
    if (busy || [...text].length < TITLE_MIN) return;
    setBusy("file");
    setError(null);
    setNotice(null);
    try {
      applied(await fileTopicRequest(text, zoneId || null));
      setTitle("");
      setZoneId("");
    } catch (reason) {
      // What the reader wrote stays where it is: a refused request is not a lost one.
      setError(topicRequestErrorMessage(reason));
    } finally {
      setBusy(null);
    }
  };
  const second = async (item: TopicRequest) => {
    if (busy) return;
    setBusy(item.id);
    setError(null);
    setNotice(null);
    try {
      applied(await secondTopicRequest(item.id));
    } catch (reason) {
      setError(topicRequestErrorMessage(reason));
    } finally {
      setBusy(null);
    }
  };

  const shown = all ? items : items.slice(0, SHOWN);
  const tooShort = [...title.trim()].length < TITLE_MIN;
  return (
    <section aria-label="申请选题" className="mt-8 border-t border-border pt-6">
      <h2 className="text-ui font-medium text-text">申请选题</h2>
      <p className="mt-1 max-w-measure text-caption text-text-3">
        想看哪个主题的证据，写下来；申请的人越多越靠前，谁申请都一样。
        {remaining !== null && `今天还能申请或附议 ${remaining} 次。`}
      </p>
      <form
        className="mt-3 flex flex-wrap items-start gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="w-full md:flex-1">
          <Input
            aria-label="选题"
            placeholder="例如：房颤合并肾功能不全的抗凝选择"
            minLength={TITLE_MIN}
            maxLength={TITLE_MAX}
            value={title}
            disabled={busy === "file"}
            onChange={(event) => setTitle(event.target.value)}
          />
        </div>
        {zones.length > 0 && (
          <Select aria-label="关联专区（可选）" className="md:w-auto" value={zoneId} disabled={busy === "file"} onChange={(event) => setZoneId(event.target.value)}>
            <option value="">不指定专区</option>
            {zones.map((zone) => (
              <option key={zone.id} value={zone.id}>
                {zone.title}
              </option>
            ))}
          </Select>
        )}
        <Button type="submit" variant="secondary" loading={busy === "file"} disabled={tooShort}>
          提交申请
        </Button>
      </form>
      {error && (
        <p role="alert" className="mt-2 text-ui text-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="mt-2 text-caption text-text-2">
          {notice}
        </p>
      )}
      {loadError ? (
        <p role="alert" className="mt-4 flex flex-wrap items-center gap-2 text-ui text-error">
          {loadError}
          <Button variant="text" size="sm" onClick={() => setReload((value) => value + 1)}>
            重试
          </Button>
        </p>
      ) : loading && items.length === 0 ? null : items.length === 0 ? (
        <p className="mt-4 text-caption text-text-3">还没有人申请选题。</p>
      ) : (
        <>
          <ul className="mt-4 divide-y divide-border" aria-label="选题申请">
            {shown.map((item) => {
              const done = seconded.has(item.id);
              return (
                <li key={item.id} className="flex items-center justify-between gap-4 py-3">
                  <div className="min-w-0">
                    <p className="break-words text-ui text-text">{item.title}</p>
                    <p className="mt-1 text-caption text-text-3">
                      {item.requesters} 人申请{item.zoneTitle ? ` · ${item.zoneTitle}` : ""}
                    </p>
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={busy === item.id}
                    disabled={done}
                    aria-label={done ? `已附议：${item.title}` : `附议：${item.title}`}
                    onClick={() => void second(item)}
                  >
                    {done ? "已附议" : "附议"}
                  </Button>
                </li>
              );
            })}
          </ul>
          {items.length > SHOWN && (
            <Button className="mt-2" variant="text" size="sm" onClick={() => setAll((value) => !value)}>
              {all ? "收起" : `显示全部 ${items.length} 条`}
            </Button>
          )}
        </>
      )}
    </section>
  );
}
