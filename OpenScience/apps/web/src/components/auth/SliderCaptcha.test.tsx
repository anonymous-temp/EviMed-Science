import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SliderCaptcha } from "./SliderCaptcha";

const DATA = { canvasSrc: "fixture-base", blockSrc: "fixture-piece", blockX: 0, blockY: 20, canvasWidth: 350, canvasHeight: 200, blockWidth: 50, blockHeight: 50 };

beforeEach(() => {
  vi.stubGlobal("Image", class {
    onerror: (() => void) | null = null;
    set src(_value: string) { queueMicrotask(() => this.onerror?.()); }
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("captcha image failures", () => {
  it("shows one complete error and a reload action instead of unusable puzzle controls", async () => {
    const refresh = vi.fn(), complete = vi.fn();
    render(<SliderCaptcha data={DATA} busy={false} onRefresh={refresh} onComplete={complete} />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("验证图片加载失败，请重新加载后再试。");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.queryByRole("slider")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "验证并发送短信" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "重新加载图片" }));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(complete).not.toHaveBeenCalled();
  });

  it("prevents duplicate reloads while a request is working", async () => {
    const refresh = vi.fn();
    render(<SliderCaptcha data={DATA} busy onRefresh={refresh} onComplete={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    const reload = screen.getByRole("button", { name: "重新加载图片" });
    expect(reload).toBeDisabled();
    await userEvent.click(reload);
    expect(refresh).not.toHaveBeenCalled();
  });
});
