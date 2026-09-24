import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationsSection } from "./NotificationsSection";

const feature = vi.hoisted(() => ({ value: "on" as "loading" | "on" | "off" | "error" }));
vi.mock("@/lib/frontierClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/frontierClient")>()),
  useFrontierFeature: () => feature.value,
}));
vi.mock("./FeishuRows", () => ({ FeishuPushRow: () => <div>飞书推送行</div> }));
vi.mock("./FrontierDigestRow", () => ({ FrontierDigestRow: ({ feature: offered }: { feature: string }) => (offered === "on" ? <div>前沿日报行</div> : null) }));

describe("通知", () => {
  beforeEach(() => { feature.value = "on"; });

  it("is one group: Feishu where the IM module runs, and the daily where the feed is offered — no in-app card", () => {
    render(<NotificationsSection imEnabled />);
    expect(screen.getByRole("heading", { name: "通知" })).toBeInTheDocument();
    expect(screen.getByText("飞书推送行")).toBeInTheDocument();
    expect(screen.getByText("前沿日报行")).toBeInTheDocument();
    for (const gone of [/站内通知/, /始终开启/, /手机通知/, /暂不可用/]) expect(screen.queryByText(gone)).not.toBeInTheDocument();
  });

  it("hides the phone row where the IM module is off", () => {
    render(<NotificationsSection imEnabled={false} />);
    expect(screen.queryByText("飞书推送行")).not.toBeInTheDocument();
    expect(screen.getByText("前沿日报行")).toBeInTheDocument();
  });

  it("says one line where there is nothing to set", () => {
    feature.value = "off";
    render(<NotificationsSection imEnabled={false} />);
    expect(screen.getByText("没有可设置的通知")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "通知" })).not.toBeInTheDocument();
  });
});
