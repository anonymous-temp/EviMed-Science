import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { Checkbox } from "./Checkbox";
import { Radio } from "./Radio";
import { Combobox, type ComboboxOption } from "./Combobox";
import { DateRange } from "./DateField";
import { FileDrop } from "./FileDrop";
afterEach(() => vi.useRealTimers());
it("uses native mixed checkbox and linked error feedback", () => {
 render(<Checkbox label="Select page" mixed error="Unavailable" />);
 const box = screen.getByRole("checkbox", { name: "Select page" });
 expect(box).toHaveProperty("indeterminate", true); expect(box).toHaveAttribute("aria-checked", "mixed"); expect(box).toHaveAccessibleDescription("Unavailable");
});
it("keeps radios in their native named group", async () => {
 const user = userEvent.setup(); render(<fieldset><legend>Format</legend><Radio label="PDF" name="format" defaultChecked /><Radio label="DOCX" name="format" /></fieldset>);
 await user.click(screen.getByRole("radio", { name: "DOCX" })); expect(screen.getByRole("radio", { name: "PDF" })).not.toBeChecked();
});
it("selects stable IDs with duplicate labels and ignores IME Enter", () => {
 const onChange = vi.fn(); render(<Combobox label="Project" value={null} onChange={onChange} options={[{ id: "a", label: "Same" }, { id: "b", label: "Same" }]} />);
 const input = screen.getByRole("combobox"); fireEvent.focus(input); fireEvent.keyDown(input, { key: "ArrowDown" }); fireEvent.compositionStart(input); fireEvent.keyDown(input, { key: "Enter" }); expect(onChange).not.toHaveBeenCalled(); fireEvent.compositionEnd(input); fireEvent.keyDown(input, { key: "Enter" }); expect(onChange).toHaveBeenCalledWith("a");
});
it("debounces, aborts and fences late asynchronous results", async () => {
 vi.useFakeTimers(); const resolvers: ((options: ComboboxOption[]) => void)[] = []; const signals: AbortSignal[] = [];
 const loader = vi.fn((_q: string, signal: AbortSignal) => { signals.push(signal); return new Promise<ComboboxOption[]>(resolve => resolvers.push(resolve)); });
 render(<Combobox label="Search" value={null} onChange={() => undefined} loadOptions={loader} />);
 const input = screen.getByRole("combobox"); fireEvent.focus(input); fireEvent.change(input, { target: { value: "first" } });
 await act(async () => { vi.advanceTimersByTime(249); }); expect(loader).not.toHaveBeenCalled();
 await act(async () => { vi.advanceTimersByTime(1); }); fireEvent.change(input, { target: { value: "second" } }); expect(signals[0].aborted).toBe(true);
 await act(async () => { vi.advanceTimersByTime(250); await Promise.resolve(); resolvers[1]([{ id: "new", label: "Latest" }]); });
 await act(async () => { resolvers[0]([{ id: "old", label: "Stale" }]); });
 expect(screen.getByRole("option", { name: "Latest" })).toBeInTheDocument(); expect(screen.queryByText("Stale")).not.toBeInTheDocument();
});
it("preserves leap-day calendar values and flags reversed inclusive ranges", () => {
 render(<DateRange label="Study" start="2028-02-29" end="2028-02-28" onChange={() => undefined} />);
 expect(screen.getByLabelText("Study开始日期")).toHaveValue("2028-02-29"); expect(screen.getByRole("alert")).toHaveTextContent("开始日期不能晚于结束日期");
});
it("uses the same validation for picker/drop and reports partial file states without invented progress", () => {
 const onFiles = vi.fn(); render(<FileDrop label="Files" validate={file => file.name.endsWith(".pdf") ? null : "PDF only"} onFiles={onFiles} items={[{ id: "a", name: "a.pdf", state: "transferred" }, { id: "b", name: "b.pdf", state: "failed", error: "Offline" }]} />);
 const good = new File(["a"], "a.pdf"); const bad = new File(["b"], "b.txt");
 fireEvent.change(screen.getByLabelText(/Files/, { selector: "input" }), { target: { files: [good, bad] } }); expect(onFiles).toHaveBeenLastCalledWith([good]);
 fireEvent.drop(screen.getByRole("region", { name: "Files" }), { dataTransfer: { files: [bad] } }); expect(onFiles).toHaveBeenCalledTimes(1);
 expect(screen.getByRole("alert")).toHaveTextContent("b.txt：PDF only"); expect(screen.queryByRole("progressbar")).not.toBeInTheDocument(); expect(screen.getByText(/已传输，等待读取/)).toBeInTheDocument();
});

it("opens upward at the last option, preserves free text as a query and clears only via explicit action", () => {
 const change = vi.fn(); render(<Combobox label="Choice" value="a" onChange={change} options={[{ id: "a", label: "One" }, { id: "b", label: "Two" }]} />);
 const input = screen.getByRole("combobox"); fireEvent.focus(input); fireEvent.keyDown(input, { key: "ArrowUp" }); fireEvent.keyDown(input, { key: "Enter" }); expect(change).toHaveBeenLastCalledWith("b");
 change.mockClear(); fireEvent.change(input, { target: { value: "Unknown free text" } }); fireEvent.keyDown(input, { key: "Enter" }); expect(change).not.toHaveBeenCalled();
 fireEvent.keyDown(input, { key: "Escape" }); expect(input).toHaveValue("One"); fireEvent.click(screen.getByRole("button", { name: "清除Choice" })); expect(change).toHaveBeenCalledWith(null);
});
