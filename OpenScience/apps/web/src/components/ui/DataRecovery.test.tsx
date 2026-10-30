import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DataTable } from "./DataTable";

const rows = [{ id: "retained", label: "已保留的结果", value: 0 }];
const columns = [{ key: "label", header: "对象", cell: (row: typeof rows[number]) => row.label }, { key: "value", header: "结果", cell: (row: typeof rows[number]) => row.value }];

describe("DataTable refresh recovery", () => {
  it("retains real zero and records during a failed refresh, with local retry", () => {
    const retry = vi.fn();
    render(<DataTable label="保留数据" rows={rows} columns={columns} rowKey={row => row.id} state="error" errorMessage="刷新失败，保留上次结果" onRetry={retry} />);
    expect(within(screen.getByRole("table", { name: "保留数据" })).getByText("0")).toBeInTheDocument();
    expect(screen.getByText("已保留的结果")).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("note")).getByRole("button", { name: "重试" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("keeps rows while refreshing but never fabricates content on first failure", () => {
    const { rerender } = render(<DataTable label="保留数据" rows={rows} columns={columns} rowKey={row => row.id} state="loading" />);
    expect(screen.getByRole("table", { name: "保留数据" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("正在更新");
    rerender(<DataTable label="保留数据" rows={[]} columns={columns} rowKey={row => row.id} state="error" />);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent("暂时无法读取");
  });
});
