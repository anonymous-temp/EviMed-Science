import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { OnboardingGuide } from "./OnboardingGuide";

const DISMISS_KEY = "ai4s.onboarding.dismissed";

beforeEach(() => {
  localStorage.clear();
});

describe("OnboardingGuide", () => {
  it("renders the three onboarding steps", () => {
    render(<OnboardingGuide />);
    expect(screen.getByText("第一次使用？三步开始")).toBeInTheDocument();
    expect(screen.getByText(/连接科研服务/)).toBeInTheDocument();
    expect(screen.getByText(/选择工作流或直接提问/)).toBeInTheDocument();
    expect(screen.getByText(/查看产物与运行记录/)).toBeInTheDocument();
  });

  it("dismisses on close and persists the dismissal", async () => {
    const { unmount } = render(<OnboardingGuide />);
    await userEvent.click(screen.getByRole("button", { name: "关闭引导" }));

    expect(screen.queryByText("第一次使用？三步开始")).not.toBeInTheDocument();
    expect(localStorage.getItem(DISMISS_KEY)).toBe("1");

    // A fresh mount (next app launch) stays dismissed.
    unmount();
    render(<OnboardingGuide />);
    expect(screen.queryByText("第一次使用？三步开始")).not.toBeInTheDocument();
  });
});
