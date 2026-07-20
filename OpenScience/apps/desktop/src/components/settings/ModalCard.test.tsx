import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ModalCard } from "./ModalCard";

// In the test (non-Tauri) environment isTauri is false, so the card renders its
// "desktop app" fallback without invoking any Rust command — a mount smoke test.
describe("ModalCard", () => {
  it("renders the Modal compute card without crashing", () => {
    render(<ModalCard />);
    expect(screen.getByText(/云端算力 \(Modal\)/)).toBeInTheDocument();
    expect(screen.getByText(/请在桌面应用中使用|未安装|就绪/)).toBeInTheDocument();
  });
});
