import { listCapsules, type CapsuleRecord } from "@/lib/productClient";
import { useCapsuleData } from "./useCapsuleData";

/** A capsule someone else shared: imported, never mixed into the researcher's own. */
export function isReceived(capsule: CapsuleRecord) {
  return (capsule.payload as { imported?: boolean }).imported === true;
}

/**
 * 「收到的胶囊」: what other people shared, kept on a shelf of its own — it
 * never mixes into the researcher's own capsule.
 */
export function ReceivedShelf() {
  const { data, failed, reload } = useCapsuleData(async () => (await listCapsules()).items.filter(isReceived));
  if (failed && data === null) {
    return (
      <p role="alert" className="text-ui text-muted">
        暂时读不到收到的胶囊。<button type="button" className="text-link hover:underline" onClick={reload}>重试</button>
      </p>
    );
  }
  if (data === null) return <p role="status" className="text-ui text-muted">正在读取…</p>;
  if (data.length === 0) return <p className="text-ui text-muted">还没有人分享胶囊给你。收到的 .evimedcap 文件在下面「分享」里导入。</p>;
  return (
    <ul className="divide-y divide-border rounded-card border border-border bg-surface">
      {data.map((capsule) => (
        <li key={capsule.id} className="px-4 py-3">
          <p className="text-ui text-text">{capsule.payload.title}</p>
          {capsule.payload.description && <p className="mt-0.5 text-caption text-muted">{capsule.payload.description}</p>}
        </li>
      ))}
    </ul>
  );
}
