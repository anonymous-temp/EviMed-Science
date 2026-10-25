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

/** Private workflow methods and essential policies remain available in their owning surfaces. */
export const visiblePlatformSkills = (items: readonly PlatformSkill[], geoGroup?: string) =>
  items.filter(item => !item.requirement?.required && !item.id.startsWith("geo-private:") && (!geoGroup || item.group !== geoGroup));

export function skillPublisher(skill: PlatformSkill): string {
  const source = skill.provenance;
  if (!source) return skill.source === "community" ? "社区" : "EviMed";
  if (source.kind === "first-party-derived") return `${source.publisher}${source.upstreamPublisher ? ` · 参考 ${source.upstreamPublisher}` : " · 自编方法"}`;
  const adapted = ["adapted", "derived", "upstream-adapted"].includes(source.kind);
  return `${source.publisher}${adapted ? " · 适配版" : ""}`;
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
