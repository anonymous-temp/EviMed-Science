/** Read-only migration of the retired brief form. A navigation is never a persistence acknowledgement. */
export interface LegacyVcrDraft {
  key: string;
  text: string;
  name: string;
  studyId: string | null;
  projectId: string | null;
  state: "recoverable" | "uncertain";
  attachments: Array<{ name: string; state: "selected" | "uploaded" | "failed" }>;
  /** Only used to avoid discarding a draft edited after it was offered. Never sent to an API. */
  storedValue: string;
}
type DraftStorage = Pick<Storage, "length" | "key" | "getItem" | "removeItem">;
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const string = (value: unknown) => typeof value === "string" ? value : "";
const prefixFor = (userId: string, tenantId: string) => `evimed.study-brief.v1:${encodeURIComponent(tenantId)}:${encodeURIComponent(userId)}:`;
const labels = [["population", "目标人群"], ["intervention", "干预与对照"], ["endpoint", "主要终点"], ["materials", "已有材料"], ["output", "希望得到"]] as const;

export function readLegacyVcrDrafts(userId: string, tenantId: string,
  { studyId, storage }: { studyId?: string; storage?: DraftStorage } = {}): LegacyVcrDraft[] {
  if (!userId || !tenantId) return [];
  let source: DraftStorage;
  try { source = storage ?? window.localStorage; } catch { return []; }
  const prefix = prefixFor(userId, tenantId);
  const drafts: LegacyVcrDraft[] = [];
  try {
    for (let i = 0; i < source.length; i += 1) {
      const key = source.key(i);
      if (!key?.startsWith(prefix)) continue;
      let suffix: string;
      try { suffix = decodeURIComponent(key.slice(prefix.length)); } catch { continue; }
      if (!suffix || studyId && suffix !== studyId) continue;
      const storedValue = source.getItem(key);
      if (!storedValue || storedValue.length > 1_048_576) continue;
      let raw: Record<string, unknown>;
      try { raw = object(JSON.parse(storedValue)); } catch { continue; }
      const fields = object(raw.fields), remote = object(raw.remote), request = object(raw.request), recovery = object(raw.recovery);
      if (request.state === "accepted" || recovery.state === "accepted") continue;
      const attachments: LegacyVcrDraft["attachments"] = Array.isArray(raw.attachments) ? raw.attachments.slice(0, 100).flatMap(value => {
        const item = object(value), name = string(item.name);
        if (!name || name.length > 512) return [];
        return [{ name, state: item.state === "uploaded" && string(remote.id) ? "uploaded" as const : item.state === "failed" ? "failed" as const : "selected" as const }];
      }) : [];
      const question = string(fields.question);
      const text = question || labels.some(([key]) => string(fields[key]).trim())
        ? [question, ...labels.filter(([key]) => string(fields[key]).trim()).map(([key, label]) => `${label}：${string(fields[key])}`),
          ...(attachments.length ? [`材料文件：${attachments.map(item => `${item.name}（${item.state === "uploaded" ? "已上传" : item.state === "failed" ? "上传未完成" : "待上传"}）`).join("、")}`] : [])].join("\n\n")
        : string(object(request.payload).brief);
      if (!text.trim()) continue;
      drafts.push({ key, text, name: string(fields.name), studyId: string(remote.id) || (suffix === "new" ? null : suffix),
        projectId: string(remote.projectId) || null, attachments, storedValue,
        state: request.state === "confirming" || raw.recovery != null || raw.missingRemote === true || raw.request != null && !["rejected"].includes(string(request.state))
          ? "uncertain" : "recoverable" });
    }
  } catch { /* Keep the original browser storage unchanged if it cannot be read. */ }
  return drafts;
}

/** Only call after the person explicitly discards this offered copy. */
export function discardLegacyVcrDraft(draft: LegacyVcrDraft, userId: string, tenantId: string,
  storage?: DraftStorage): boolean {
  if (!userId || !tenantId || !draft.key.startsWith(prefixFor(userId, tenantId))) return false;
  try {
    const source = storage ?? window.localStorage;
    if (source.getItem(draft.key) !== draft.storedValue) return false;
    source.removeItem(draft.key);
    return true;
  } catch { return false; }
}
