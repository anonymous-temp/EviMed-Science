import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useFileDrop } from "./useFileDrop";

const dt = (files: File[] = []) => ({ dataTransfer: { types: ["Files"], files } });

function Zone({ onDrop, disabled }: { onDrop: (files: File[]) => void; disabled?: boolean }) {
  const { dragging, dropProps } = useFileDrop({ onDrop, disabled });
  return (
    <div data-testid="zone" {...dropProps}>
      {dragging && <div>松开以添加文件</div>}
    </div>
  );
}

describe("useFileDrop", () => {
  it("highlights while files hover and hands dropped files to the caller", () => {
    const onDrop = vi.fn();
    render(<Zone onDrop={onDrop} />);
    const zone = screen.getByTestId("zone");

    fireEvent.dragEnter(zone, dt());
    expect(screen.getByText("松开以添加文件")).toBeInTheDocument();

    const file = new File(["x"], "data.csv");
    fireEvent.drop(zone, dt([file]));
    expect(onDrop).toHaveBeenCalledWith([file]);
    expect(screen.queryByText("松开以添加文件")).toBeNull();
  });

  it("does not flicker when the pointer crosses a child element (depth counter)", () => {
    render(<Zone onDrop={vi.fn()} />);
    const zone = screen.getByTestId("zone");

    fireEvent.dragEnter(zone, dt());
    fireEvent.dragEnter(zone, dt()); // entering a child fires a second enter
    fireEvent.dragLeave(zone, dt()); // …and a paired leave — still inside
    expect(screen.getByText("松开以添加文件")).toBeInTheDocument();

    fireEvent.dragLeave(zone, dt()); // truly left
    expect(screen.queryByText("松开以添加文件")).toBeNull();
  });

  it("ignores non-file drags and stays inert while disabled", () => {
    const onDrop = vi.fn();
    const { rerender } = render(<Zone onDrop={onDrop} />);
    const zone = screen.getByTestId("zone");

    fireEvent.dragEnter(zone, { dataTransfer: { types: ["text/plain"] } });
    expect(screen.queryByText("松开以添加文件")).toBeNull();

    rerender(<Zone onDrop={onDrop} disabled />);
    fireEvent.dragEnter(zone, dt());
    fireEvent.drop(zone, dt([new File(["x"], "a.txt")]));
    expect(screen.queryByText("松开以添加文件")).toBeNull();
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("prevents the browser default so a drop never opens the file", () => {
    render(<Zone onDrop={vi.fn()} />);
    const zone = screen.getByTestId("zone");
    const over = fireEvent.dragOver(zone, dt());
    const drop = fireEvent.drop(zone, dt([new File(["x"], "a.txt")]));
    expect(over).toBe(false); // false = defaultPrevented
    expect(drop).toBe(false);
  });
});
