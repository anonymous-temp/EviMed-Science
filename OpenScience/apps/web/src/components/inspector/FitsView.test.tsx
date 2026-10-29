import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FitsView } from "./FitsView";
import { FITS_IMAGE_2D_B64, FITS_SPECTRUM_1D_B64 } from "@/lib/fits.fixtures";

function toBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

describe("FitsView", () => {
  it("mounts the image viewer with dimensions, unit, and stretch/colormap controls", () => {
    const { container } = render(<FitsView filename="sky.fits" bytes={toBuffer(FITS_IMAGE_2D_B64)} />);
    expect(container.textContent).toContain("sky.fits");
    expect(container.textContent).toContain("8×8");
    expect(container.textContent).toContain("Jy/beam");
    expect(container.querySelector("canvas")).not.toBeNull();
    // stretch + colormap segmented controls are present
    for (const label of ["linear", "log", "asinh", "magma", "viridis", "gray"]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
  });

  it("renders the spectrum viewer as an SVG line for 1D data", () => {
    const { container } = render(
      <FitsView filename="spec.fits" bytes={toBuffer(FITS_SPECTRUM_1D_B64)} />,
    );
    expect(screen.getByText(/光谱 · 16 个采样点/)).toBeInTheDocument();
    const path = container.querySelector("path");
    expect(path).not.toBeNull();
    expect(path!.getAttribute("d")!.startsWith("M")).toBe(true);
    // WAVE axis label from CTYPE1
    expect(screen.getByText(/WAVE/)).toBeInTheDocument();
  });

  it("shows a friendly error for a non-FITS buffer", () => {
    render(<FitsView filename="bad.fits" bytes={new Uint8Array([1, 2, 3, 4]).buffer} />);
    expect(screen.getByText(/无法读取此 FITS 文件/)).toBeInTheDocument();
  });
});

it("reads image data without hovering", () => {
  render(<FitsView filename="sky.fits" bytes={toBuffer(FITS_IMAGE_2D_B64)} />);
  fireEvent.click(screen.getByRole("button", { name: "读取像素" }));
  expect(screen.getByRole("status")).toHaveTextContent("像素 (0, 0)");
  fireEvent.keyDown(screen.getByRole("region", { name: "FITS 像素视图" }), { key: "ArrowRight" });
  expect(screen.getByRole("status")).toHaveTextContent("像素 (1, 0)");
});

it.each(["X", "Y"].flatMap((axis) => ["", "0.5", "-1", "Infinity", "1e", "1e2", "8"].map((draft) => [axis, draft])))("preserves invalid coordinate %s draft %j without indexing or clamping", (axis, draft) => {
  render(<FitsView filename="sky.fits" bytes={toBuffer(FITS_IMAGE_2D_B64)} />);
  fireEvent.click(screen.getByRole("button", { name: "读取像素" }));
  fireEvent.change(screen.getByLabelText(`像素 ${axis}`), { target: { value: draft } });
  expect(screen.getByLabelText(`像素 ${axis}`)).toHaveValue(draft);
  expect(screen.getByRole("button", { name: "读取像素" })).toBeDisabled();
  expect(screen.getByRole("status")).toHaveTextContent("像素 (0, 0)");
});

it("accepts genuine zero after an invalid draft", () => {
  render(<FitsView filename="sky.fits" bytes={toBuffer(FITS_IMAGE_2D_B64)} />);
  fireEvent.change(screen.getByLabelText("像素 X"), { target: { value: "0.5" } });
  fireEvent.change(screen.getByLabelText("像素 X"), { target: { value: "0" } });
  fireEvent.click(screen.getByRole("button", { name: "读取像素" }));
  expect(screen.getByRole("status")).toHaveTextContent("像素 (0, 0)");
});

it("retains a non-finite scientific pixel as missing data, while zero stays zero", () => {
  const bytes = toBuffer(FITS_IMAGE_2D_B64);
  // FITS header occupies one 2880-byte block; image samples are big-endian float32.
  new DataView(bytes).setFloat32(2880, NaN, false);
  render(<FitsView filename="missing.fits" bytes={bytes} />);
  fireEvent.click(screen.getByRole("button", { name: "读取像素" }));
  expect(screen.getByRole("status")).toHaveTextContent("像素 (0, 0) = 无数据");
  fireEvent.change(screen.getByLabelText("像素 X"), { target: { value: "1" } });
  fireEvent.click(screen.getByRole("button", { name: "读取像素" }));
  expect(screen.getByRole("status")).toHaveTextContent("像素 (1, 0) = 1.0000");
});

it("keeps explicit pixel selection through passive pointer motion, while click selects anew", () => {
  render(<FitsView filename="sky.fits" bytes={toBuffer(FITS_IMAGE_2D_B64)} />);
  const view = screen.getByRole("region", { name: "FITS 像素视图" });
  Object.defineProperty(view, "getBoundingClientRect", { value: () => ({ left: 0, top: 0, width: 100, height: 100 }) });
  fireEvent.keyDown(view, { key: "ArrowRight" });
  fireEvent(view, new MouseEvent("pointermove", { bubbles: true, clientX: 0, clientY: 99 }));
  expect(screen.getByRole("status")).toHaveTextContent("像素 (1, 0)");
  fireEvent.click(view, { clientX: 0, clientY: 99 });
  expect(screen.getByRole("status")).toHaveTextContent("像素 (0, 0)");
});
