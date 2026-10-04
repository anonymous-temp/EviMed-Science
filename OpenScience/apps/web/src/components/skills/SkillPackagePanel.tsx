import { Tag } from "@/components/ui/Tag";
import type { SkillAvailabilityView, SkillPackageView } from "@/lib/skillLibraryClient";

/** The fields a record may not know, in the reader's words. */
const UNKNOWN_FIELD: Record<string, string> = { version: "版本", source: "来源", "source.commit": "来源提交", licence: "许可证", digest: "包摘要" };
const DEPENDENCY_KIND: Record<string, string> = {
  "python-package": "Python 库", "r-package": "R 包", "system-tool": "系统工具", "platform-tool": "平台工具", "model-weights": "模型权重", dataset: "数据", compute: "算力",
};

/** The short, copyable form of a digest: enough to compare two packages by eye. */
export const shortDigest = (digest: string | null) => (digest ? digest.replace(/^sha256:/u, "").slice(0, 12) : null);

/**
 * What a skill package is and whether this runtime can supply what it needs.
 *
 * A label beside the package, never a gate: a skill that reads 「受限」 is still
 * listed, still selectable and still callable, and the sentence says what is
 * missing and what still works. A field the record does not know is named as not
 * recorded; it is never left blank to read as "none".
 */
export function SkillPackagePanel({ view, availability }: { view: SkillPackageView | null; availability: SkillAvailabilityView | null }) {
  if (!view && !availability) return <p className="text-ui text-text-2">这个版本保存时没有记录来源和依赖。</p>;
  const missing = view?.unknown.map((entry) => UNKNOWN_FIELD[entry.field] ?? entry.field) ?? [];
  const optional = availability?.notes.map((note) => note.detail).filter(Boolean) ?? [];
  return (
    <section aria-label="技能来源与依赖" className="flex flex-col gap-3">
      {availability && (
        <p className="flex flex-wrap items-center gap-2 text-ui text-text-2">
          <Tag>{availability.label}</Tag>
          <span>{availability.text}</span>
        </p>
      )}
      {view && (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-ui">
          <dt className="text-text-3">来源</dt><dd className="break-words text-text">{view.sourceText}</dd>
          <dt className="text-text-3">许可证</dt><dd className="text-text">{view.licenceText}</dd>
          <dt className="text-text-3">版本</dt><dd className="text-text">{view.version ?? "未记录"}</dd>
          <dt className="text-text-3">包摘要</dt><dd className="text-text">{shortDigest(view.digest) ?? "未记录"}</dd>
          <dt className="text-text-3">内容</dt><dd className="text-text">{view.scripts} 个脚本 · {view.references} 个参考文件</dd>
        </dl>
      )}
      {view && view.dependencies.length > 0 && (
        <details className="text-ui text-text-2">
          <summary>依赖（{view.dependencies.length}）</summary>
          <ul className="mt-2 flex flex-col gap-1">
            {view.dependencies.map((dependency) => (
              <li key={`${dependency.kind}:${dependency.name}`}>
                {dependency.name}{dependency.constraint ? ` ${dependency.constraint}` : ""} · {DEPENDENCY_KIND[dependency.kind] ?? dependency.kind}
                {dependency.optional ? " · 只在个别路径用到" : ""}{dependency.basis === "observed" ? " · 从脚本读出" : ""}
              </li>
            ))}
          </ul>
        </details>
      )}
      {view && view.operations.length > 0 && <p className="text-ui text-text-2">支持的操作：{view.operations.map((operation) => operation.name).join("、")}</p>}
      {optional.length > 0 && <p className="text-caption text-text-3">只在个别路径用到、运行环境没有安装的软件：{optional.join("、")}。</p>}
      {missing.length > 0 && <p className="text-caption text-text-3">未记录：{[...new Set(missing)].join("、")}。</p>}
    </section>
  );
}
