import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FlaskConical } from "lucide-react";
import { describe, expect, it, vi } from "vitest";
import { EmptyState } from "./EmptyState";

describe("EmptyState", () => {
  it("renders icon, title, description, and the optional primary action", async () => {
    const onRetry = vi.fn();
    render(
      <EmptyState
        icon={FlaskConical}
        title="尚无运行记录"
        description="运行代码后，执行方案和产物会记录于此。"
        action={<button onClick={onRetry}>重试</button>}
      />,
    );
    expect(screen.getByText("尚无运行记录")).toBeInTheDocument();
    expect(screen.getByText("运行代码后，执行方案和产物会记录于此。")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("renders the title alone when icon, description, and action are omitted", () => {
    const { container } = render(<EmptyState title="知识库服务暂时不可用" />);
    expect(screen.getByText("知识库服务暂时不可用")).toBeInTheDocument();
    expect(container.querySelector("svg")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
