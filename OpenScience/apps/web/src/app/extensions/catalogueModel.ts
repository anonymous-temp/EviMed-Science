import type { ExtensionInstallation, ExtensionSelection } from "@/lib/extensionsClient";
import type { PlatformSkill, SkillActivation } from "@/lib/skillLibraryClient";

/** Account installation and project activation are independent records. */
export function extensionAvailability(installation: ExtensionInstallation, selection?: ExtensionSelection): string {
  const phase = selection?.phase ?? installation.phase;
  if (["failed", "rolled-back", "rolled_back", "unsupported"].includes(phase)) {
    return selection?.effective ? "更改未生效，原设置仍在使用" : "需要处理";
  }
  if (phase === "connection-needed") return "需要连接账户";
  if (selection && ["waiting", "applying", "pending"].includes(phase)) return "等待当前任务结束后生效";
  if (selection && phase === "saved") return "生效状态待确认";
  if (selection?.enabled && selection.effective === true) return "已启用";
  if (selection && !selection.enabled && selection.effective === false) return "已关闭";
  if (selection) return "生效状态待确认";
  if (installation.phase === "preparing") return "正在准备";
  if (installation.phase === "removed") return "已从个人库移除";
  return "未在当前项目启用";
}

export function skillActivationText(enabled: boolean, activation?: SkillActivation): string {
  if (!activation) return "生效状态待确认";
  if (activation.phase === "saved") return "生效状态待确认";
  if (activation.phase === "waiting") return "等待当前任务结束后生效";
  if (activation.phase === "failed" || activation.phase === "rolled-back") return "更改未生效，请重试";
  return enabled ? "已启用" : "已关闭";
}

/**
 * The disabled list a switch sends: what the project holds, without the one being switched and without any id the page was
 * not given a row for (a skill a release removed is not re-sent for the server to refuse).
 */
export function nextDisabled(policy: { payload: { disabled: string[] }; items: ReadonlyArray<{ id: string }> }, id: string, enabled: boolean): string[] {
  const kept = policy.payload.disabled.filter(item => item !== id && policy.items.some(row => row.id === item));
  return enabled ? kept : [...kept, id];
}

/** Private workflow methods and essential policies remain available in their owning surfaces. */
export const visiblePlatformSkills = (items: readonly PlatformSkill[], geoGroup?: string) =>
  items.filter(item => !item.requirement?.required && !item.id.startsWith("geo-private:") && (!geoGroup || item.group !== geoGroup));

export type CatalogueOrigin = "first-party" | "third-party" | "personal";
export const catalogueOrigins: ReadonlyArray<{ value: CatalogueOrigin; label: string }> = [
  { value: "third-party", label: "第三方" },
  { value: "first-party", label: "EviMed Science" },
  { value: "personal", label: "我的技能" },
];

export function skillOrigin(skill: PlatformSkill): CatalogueOrigin {
  if (!skill.provenance) return skill.source === "community" ? "third-party" : "first-party";
  return ["first-party", "first-party-derived", "proprietary"].includes(skill.provenance.kind) ? "first-party" : "third-party";
}

export function skillPublisher(skill: PlatformSkill): string {
  const source = skill.provenance;
  if (skillOrigin(skill) === "first-party") return "EviMed Science";
  return source?.publisher ?? "社区";
}

export function skillRepositoryUrl(repository: string | null | undefined): string | null {
  if (!repository) return null;
  if (/^[\w.-]+\/[\w.-]+$/.test(repository)) return `https://github.com/${repository}`;
  try {
    const url = new URL(repository);
    return url.protocol === "https:" && !url.username && !url.password && url.hostname === "github.com"
      ? url.href : null;
  } catch { return null; }
}

/** Discovery needs a complete installation set before it can offer Add accurately. */
export async function allInstalledExtensions(read: (cursor?: string | null) => Promise<{ items: ExtensionInstallation[]; nextCursor: string | null }>) {
  const found = new Map<string, ExtensionInstallation>(), cursors = new Set<string>();
  let cursor: string | null | undefined;
  for (let page = 0; page < 100; page++) {
    const result = await read(cursor);
    for (const item of result.items) found.set(item.id, item);
    if (!result.nextCursor) return { items: [...found.values()], nextCursor: null };
    if (cursors.has(result.nextCursor)) throw new Error("插件列表未能完整读取，请重试。");
    cursor = result.nextCursor; cursors.add(cursor);
  }
  throw new Error("插件列表未能完整读取，请重试。");
}
