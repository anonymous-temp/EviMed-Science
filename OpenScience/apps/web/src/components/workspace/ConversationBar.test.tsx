import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { ConversationBar } from "./ConversationBar";

describe("ConversationBar", () => {
  it("opens the conversation with nothing, or with what was typed, unsent", async () => {
    const onOpen = vi.fn();
    render(<ConversationBar onOpen={onOpen} />);
    await userEvent.click(screen.getByRole("button", { name: "打开对话" }));
    expect(onOpen).toHaveBeenLastCalledWith(undefined);
    await userEvent.type(screen.getByRole("textbox"), "补两个问题");
    await userEvent.click(screen.getByRole("button", { name: "放进对话" }));
    expect(onOpen).toHaveBeenLastCalledWith("补两个问题");
  });

  it("takes Enter as opening, Shift+Enter as a line, and leaves a composing input method alone", () => {
    const onOpen = vi.fn();
    render(<ConversationBar onOpen={onOpen} />);
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "问" } });
    fireEvent.keyDown(box, { key: "Enter", isComposing: true });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledWith("问");
  });

  it("gives a role that reads a link to the kept conversation and nothing to type into", () => {
    render(<MemoryRouter><ConversationBar readOnlyTo="/app/geo/g/chat/s" /></MemoryRouter>);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByRole("link", { name: "查看项目对话" })).toHaveAttribute("href", "/app/geo/g/chat/s");
  });

  it("draws nothing for a role with neither", () => {
    const { container } = render(<ConversationBar />);
    expect(container).toBeEmptyDOMElement();
  });
});
