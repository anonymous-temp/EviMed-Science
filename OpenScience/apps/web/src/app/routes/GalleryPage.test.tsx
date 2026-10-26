import { act, cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { announce } from "@/lib/announce";
import { GalleryPage } from "./GalleryPage";

vi.mock("@/lib/announce", () => ({ announce: vi.fn(), Announcer: () => null }));
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers(); });

it("keeps gallery skeleton demonstrations passive after sixty seconds", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
  const { container } = render(<MemoryRouter><GalleryPage /></MemoryRouter>);
  const row = container.querySelector('[data-gallery-row="Skeleton / EmptyState / LoadError"]');
  expect(row?.querySelectorAll(".animate-pulse")).toHaveLength(2);
  act(() => vi.advanceTimersByTime(60_000));
  expect(row?.querySelectorAll(".animate-pulse")).toHaveLength(2);
  expect(row?.querySelector("[data-pending-feedback]")).toBeNull();
  expect(vi.mocked(announce).mock.calls.some(([message]) => /正在读取内容|仍在等待本次读取/.test(message))).toBe(false);
});
