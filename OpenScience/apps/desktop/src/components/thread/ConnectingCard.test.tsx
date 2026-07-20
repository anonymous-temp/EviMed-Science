import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectingCard } from "./ConnectingCard";

// Platform flags are module-level reads inside the component; hoist mutable
// copies so each test can flip them before render.
const flags = vi.hoisted(() => ({ tauri: true, mac: true }));
vi.mock("@/lib/tauri", () => ({ get isTauri() { return flags.tauri; } }));
vi.mock("@/lib/platform", () => ({ isMacPlatform: () => flags.mac }));

beforeEach(() => {
  vi.useFakeTimers();
  flags.tauri = true;
  flags.mac = true;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ConnectingCard", () => {
  it("opens with the first-launch initialization explanation", () => {
    render(<ConnectingCard />);
    expect(screen.getByText("正在启动 EviMed 科研服务")).toBeInTheDocument();
    expect(screen.getByText(/首次启动需要初始化本地运行环境/)).toBeInTheDocument();
    expect(screen.getByText("初始化运行环境")).toBeInTheDocument();
    expect(screen.getByText("连接就绪")).toBeInTheDocument();
  });

  it("rotates the staged copy as the wait grows", () => {
    render(<ConnectingCard />);
    act(() => vi.advanceTimersByTime(13_000));
    expect(screen.getByText(/正在启动科研服务并建立连接/)).toBeInTheDocument();
    expect(screen.getByText("已等待 13 秒")).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(35_000));
    expect(screen.getByText(/比预期更久/)).toBeInTheDocument();
  });

  it("shows the macOS permission hint on long Tauri waits only", () => {
    render(<ConnectingCard />);
    expect(screen.queryByText(/权限请求/)).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(31_000));
    expect(screen.getByText(/权限请求/)).toBeInTheDocument();
  });

  it("never shows the macOS hint on other platforms", () => {
    flags.mac = false;
    render(<ConnectingCard />);
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.queryByText(/权限请求/)).not.toBeInTheDocument();
  });

  it("never shows the macOS hint on hosted web", () => {
    flags.tauri = false;
    render(<ConnectingCard />);
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.queryByText(/权限请求/)).not.toBeInTheDocument();
  });
});
