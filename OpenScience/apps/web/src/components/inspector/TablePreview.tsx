import { ScrollRegion } from "@/components/ui/ScrollRegion";
import { formatNumber } from "@/lib/format";

// Shared tabular preview: first row of data is the header (csv and xlsx alike).
export interface TableData {
  columns: string[];
  rows: string[][];
  truncated: boolean;
}

export function TablePreview({ table }: { table: TableData }) {
  return (
    <div className="p-3">
      {/* A table wider than the inspector scrolls in its own box, which a keyboard reaches (axe scrollable-region-focusable). */}
      <ScrollRegion label="表格预览" className="rounded-input border border-border bg-surface">
        <table className="w-full border-collapse text-ui">
          <thead>
            <tr className="border-b border-border text-left text-muted">
              {table.columns.map((c, i) => (
                <th key={i} className="whitespace-nowrap px-3 py-2 font-medium">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, i) => (
              <tr key={i} className="border-b border-border last:border-0">
                {row.map((cell, j) => (
                  <td key={j} className="whitespace-nowrap px-3 py-1.5 font-mono text-ui text-text">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollRegion>
      {table.truncated && (
        <div className="py-2 text-center text-caption text-muted">只显示前 {formatNumber(table.rows.length)} 行</div>
      )}
    </div>
  );
}
