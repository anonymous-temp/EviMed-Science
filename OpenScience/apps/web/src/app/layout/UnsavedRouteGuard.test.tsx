import { act, fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider, useNavigate } from "react-router";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useUnsavedGuard } from "@/lib/useUnsavedGuard";
import { UnsavedRouteGuard } from "./UnsavedRouteGuard";

const NativeRequest = globalThis.Request;
beforeAll(() => {
  globalThis.Request = class extends NativeRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      super(input, init ? { ...init, signal: undefined } : init);
    }
  };
});
afterAll(() => { globalThis.Request = NativeRequest; });

function Editor() {
  const guard = useUnsavedGuard(true, () => undefined);
  const navigate = useNavigate();
  return <><UnsavedRouteGuard /><h1>Draft</h1><button onClick={() => { guard.markSaved(); void navigate("/next"); }}>Save and open</button><button onClick={guard.requestClose}>Close draft</button>{guard.confirming && <div role="alertdialog">Local discard confirmation</div>}</>;
}

describe("host dirty navigation", () => {
  it("keeps the draft until a blocked route is explicitly discarded", async () => {
    const router = createMemoryRouter([{ path: "/edit", element: <Editor /> }, { path: "/next", element: <h1>Next</h1> }], { initialEntries: ["/edit"] });
    render(<RouterProvider router={router} />);
    await act(() => router.navigate("/next"));
    expect(router.state.location.pathname).toBe("/edit");
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.getByRole("heading", { name: "Draft" })).toBeInTheDocument();
    await act(() => router.navigate("/next"));
    fireEvent.click(screen.getByRole("button", { name: "放弃修改并离开" }));
    expect(await screen.findByRole("heading", { name: "Next" })).toBeInTheDocument();
  });
  it("keeps an existing local discard confirmation as the only confirmation", async () => {
    const router = createMemoryRouter([{ path: "/edit", element: <Editor /> }, { path: "/next", element: <h1>Next</h1> }], { initialEntries: ["/edit"] });
    render(<RouterProvider router={router} />);
    fireEvent.click(screen.getByRole("button", { name: "Close draft" }));
    await act(() => router.navigate("/next"));
    expect(screen.getAllByRole("alertdialog")).toHaveLength(1);
    expect(router.state.location.pathname).toBe("/edit");
  });
  it("allows a confirmed save to navigate in the same event without an old dirty closure blocking it", async () => {
    const router = createMemoryRouter([{ path: "/edit", element: <Editor /> }, { path: "/next", element: <h1>Next</h1> }], { initialEntries: ["/edit"] });
    render(<RouterProvider router={router} />);
    fireEvent.click(screen.getByRole("button", { name: "Save and open" }));
    expect(await screen.findByRole("heading", { name: "Next" })).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });
  it("acknowledges only the saved draft and keeps an unrelated draft protected", async () => {
    function OtherDraft() { useUnsavedGuard(true, () => undefined); return null; }
    const router = createMemoryRouter([{ path: "/edit", element: <><Editor /><OtherDraft /></> }, { path: "/next", element: <h1>Next</h1> }], { initialEntries: ["/edit"] });
    render(<RouterProvider router={router} />);
    fireEvent.click(screen.getByRole("button", { name: "Save and open" }));
    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/edit");
  });
});

it("mounts route confirmation outside an inert dialog host and preserves its draft on Cancel", async () => {
  function DialogEditor() {
    useUnsavedGuard(true, () => undefined);
    return <div inert><UnsavedRouteGuard /><div role="dialog" aria-label="Draft dialog"><input aria-label="Draft input" defaultValue="Unsaved draft" /></div></div>;
  }
  const router = createMemoryRouter([{ path: "/edit", element: <DialogEditor /> }, { path: "/next", element: <h1>Next</h1> }], { initialEntries: ["/edit"] });
  render(<RouterProvider router={router} />);
  await act(() => router.navigate("/next"));
  const dialog = screen.getByRole("alertdialog");
  expect(dialog.closest("[inert]")).toBeNull();
  expect(dialog.parentElement?.parentElement).toBe(document.body);
  expect(screen.getByRole("button", { name: "取消" })).toHaveFocus();
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(router.state.location.pathname).toBe("/edit");
  expect(screen.getByRole("textbox", { name: "Draft input" })).toHaveValue("Unsaved draft");
  await act(() => router.navigate("/next"));
  fireEvent.click(screen.getByRole("button", { name: "放弃修改并离开" }));
  expect(await screen.findByRole("heading", { name: "Next" })).toBeInTheDocument();
});
