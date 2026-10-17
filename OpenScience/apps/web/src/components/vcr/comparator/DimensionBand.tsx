import { CircleCheck, CircleDashed, TriangleAlert } from "lucide-react";
import type { VcrDimension } from "@/lib/vcrClient";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/Button";
import { Tag } from "@/components/ui/Tag";

/** How far a simulation can reproduce one comparability dimension (plan §5.3). */
const STATE_WORDS: Record<VcrDimension["state"], string> = {
  exact: "精确模拟",
  approximate: "近似",
  not_simulable: "无法模拟",
  unknown: "未评估",
};

/**
 * 可比性的十个维度: ten cells in a band, each a dimension with how far a simulation can reproduce it and why (R19, plan §5.3;
 * audit B §2.4 #15, §4.4).
 *
 * A dimension nobody looked at is not one that passed, so 「未评估」 is its own word — and ten cells that all say it are one thing
 * to say once: until any of them has been assessed the band is a single chip, 「可比性：未评估」, and the one thing to do about it.
 * The band exists to show where the comparison can and cannot be simulated; a table of ten identical rows did not.
 *
 * Hidden knowledge:
 *  - **A state is a word and a mark, never a colour alone** (✓ 精确模拟, ≈ 近似, ⚠ 无法模拟); the reason, when the server gave one,
 *    is in the cell, where a touch screen can read it.
 *  - **The action is the conversation's**: how far a comparison can be simulated is judged from the design, and the judgement is
 *    written by the model in the study's conversation (the draft waits there, unsent). A reader who cannot open it is not offered it.
 */
export function DimensionBand({ dimensions, onAssess }: { dimensions: readonly VcrDimension[]; onAssess?: (() => void) | null }) {
  if (dimensions.length === 0) return null;
  if (dimensions.every((dimension) => dimension.state === "unknown")) {
    return (
      <div data-vcr-dimensions-unassessed="" className="flex flex-wrap items-center gap-3">
        <Tag>可比性：未评估</Tag>
        {onAssess && <Button size="sm" variant="secondary" onClick={onAssess}>评估可比性</Button>}
      </div>
    );
  }
  return (
    <ul data-vcr-dimensions="" aria-label="十个可比性维度的模拟程度" className="grid grid-cols-2 gap-2 sm:grid-cols-5">
      {dimensions.map((dimension) => (
        <li
          key={dimension.key}
          data-vcr-dimension={dimension.key}
          data-vcr-dimension-state={dimension.state}
          className={cn("min-w-0 rounded border border-border px-2.5 py-2", dimension.state === "not_simulable" ? "bg-warn-soft" : "bg-surface")}
        >
          <span className="block truncate text-ui text-text">{dimension.label}</span>
          <span
            className={cn(
              "mt-0.5 inline-flex items-center gap-1 text-caption",
              dimension.state === "exact" ? "text-ok" : dimension.state === "not_simulable" ? "text-warn-strong" : dimension.state === "unknown" ? "text-text-3" : "text-text-2",
            )}
          >
            {dimension.state === "exact" && <CircleCheck size={16} aria-hidden="true" />}
            {dimension.state === "not_simulable" && <TriangleAlert size={16} aria-hidden="true" />}
            {dimension.state === "unknown" && <CircleDashed size={16} aria-hidden="true" />}
            {dimension.state === "approximate" && <span aria-hidden="true">≈</span>}
            {STATE_WORDS[dimension.state] ?? dimension.state}
          </span>
          {dimension.reason && <span className="mt-0.5 line-clamp-2 block text-caption text-text-3">{dimension.reason}</span>}
        </li>
      ))}
    </ul>
  );
}
