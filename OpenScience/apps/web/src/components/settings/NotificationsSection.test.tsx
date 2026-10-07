import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationsSection } from "./NotificationsSection";

const feature = vi.hoisted(() => ({ value: "on" as "loading" | "on" | "off" | "error" }));
const im = vi.hoisted(() => ({ binding: null as null | { notifications: boolean }, enabledArg: undefined as boolean | undefined }));
vi.mock("@/lib/frontierClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/frontierClient")>()),
  useFrontierFeature: () => feature.value,
}));
vi.mock("./FeishuRows", () => ({
  useImStatus: (enabled?: boolean) => { im.enabledArg = enabled; return { binding: im.binding }; },
  FeishuRow: () => <div>飞书行</div>,
}));
vi.mock("./FrontierDigestRow", () => ({
  FrontierDigestRow: ({ feature: offered, label = "前沿日报", description }: { feature: string; label?: string; description?: string }) => (
    offered === "on" ? <div>{label}行：{description}</div> : null),
}));

describe("通知", () => {
  beforeEach(() => { feature.value = "on"; im.binding = null; im.enabledArg = undefined; });

  it("is one group: Feishu where the IM module runs, and the daily where the feed is offered — no in-app card", () => {
    render(<NotificationsSection imEnabled />);
    expect(screen.getByRole("heading", { name: "通知" })).toBeInTheDocument();
    expect(screen.getByText("飞书行")).toBeInTheDocument();
    expect(screen.getByText(/^前沿日报行/)).toBeInTheDocument();
    expect(screen.getByText(/^前沿周刊行/)).toBeInTheDocument();
    expect(screen.getByText(/^相关安全警示行/)).toBeInTheDocument();
    for (const gone of [/站内通知/, /始终开启/, /手机通知/, /暂不可用/]) expect(screen.queryByText(gone)).not.toBeInTheDocument();
  });

  it("says where each notice is delivered: the inbox, and Feishu too once it is bound and the push is on", () => {
    const { rerender } = render(<NotificationsSection imEnabled />);
    expect(screen.getByText("前沿日报行：每天的医学前沿日报，发到收件箱")).toBeInTheDocument();
    expect(screen.getByText("前沿周刊行：每周的医学前沿周刊，发到收件箱")).toBeInTheDocument();
    expect(screen.getByText("相关安全警示行：药品安全公告，发到收件箱")).toBeInTheDocument();
    // Bound, with the push off: still only the inbox.
    im.binding = { notifications: false };
    rerender(<NotificationsSection imEnabled />);
    expect(screen.getByText("前沿日报行：每天的医学前沿日报，发到收件箱")).toBeInTheDocument();
    im.binding = { notifications: true };
    rerender(<NotificationsSection imEnabled />);
    expect(screen.getByText("前沿日报行：每天的医学前沿日报，发到收件箱，并推送到飞书")).toBeInTheDocument();
    expect(screen.getByText("前沿周刊行：每周的医学前沿周刊，发到收件箱，并推送到飞书")).toBeInTheDocument();
    expect(screen.getByText("相关安全警示行：药品安全公告，发到收件箱，并推送到飞书")).toBeInTheDocument();
  });

  it("hides the Feishu row where the IM module is off, asks it nothing, and never claims a push", () => {
    im.binding = { notifications: true };
    render(<NotificationsSection imEnabled={false} />);
    expect(screen.queryByText("飞书行")).not.toBeInTheDocument();
    expect(im.enabledArg).toBe(false);
    expect(screen.getByText("前沿日报行：每天的医学前沿日报，发到收件箱")).toBeInTheDocument();
    expect(screen.getByText(/^前沿周刊行/)).toBeInTheDocument();
    expect(screen.getByText(/^相关安全警示行/)).toBeInTheDocument();
  });

  it("says one line where there is nothing to set", () => {
    feature.value = "off";
    render(<NotificationsSection imEnabled={false} />);
    expect(screen.getByText("没有可设置的通知")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "通知" })).not.toBeInTheDocument();
  });
});
