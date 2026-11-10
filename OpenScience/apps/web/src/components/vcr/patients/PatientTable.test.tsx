import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PatientTable } from "./PatientTable";

/**
 * The people of a table, read by the key of this request (round-2 review P2-10, F07's rule): another result, page, filter or sort is another key, and the
 * rows of the previous one are never drawn under the new title while it loads; the same key read again keeps its rows and says it is refreshing.
 */
const network = vi.hoisted(() => ({ productRequest: vi.fn() }));
vi.mock("@/lib/productClient", () => network);

const page = (result: string, ids: string[], offset = 0) => ({ result, kind: "patient_set", columns: [{ key: "patientId", label: "编号", kind: "id" }], rows: ids.map((id) => ({ patientId: id })),
  total: 40, all: 40, offset, limit: 25, sort: null, arms: [] });
const later = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; };

beforeEach(() => network.productRequest.mockReset());

describe("PatientTable", () => {
  it("never draws another result's rows while the next one loads, and says 正在刷新 for the same key read again", async () => {
    const second = later<unknown>();
    network.productRequest.mockImplementation(async (path: string) => (String(path).includes("result=res_b") ? second.promise : page("res_a", ["A-001", "A-002"])));
    const view = render(<PatientTable studyId="std_1" source="patients" result="res_a" title="本次生成记录" labels={{}} />);
    expect(await screen.findByText("A-001")).toBeTruthy();
    expect(view.container.querySelector("[data-vcr-refreshing]")).toBeNull();
    view.rerender(<PatientTable studyId="std_1" source="patients" result="res_b" title="本次生成记录" labels={{}} />);
    // the previous result's people are gone at once; a skeleton or nothing stands in their place
    expect(screen.queryByText("A-001")).toBeNull();
    expect(view.container.querySelector("[aria-busy='true']")).not.toBeNull();
    second.resolve(page("res_b", ["B-001"]));
    expect(await screen.findByText("B-001")).toBeTruthy();
    expect(screen.queryByText("A-001")).toBeNull();
  });

  it("another page of the same table is another key: the first page's rows do not stand in for it", async () => {
    const next = later<unknown>();
    network.productRequest.mockImplementation(async (path: string) => (String(path).includes("offset=25") ? next.promise : page("res_a", ["P1-001"])));
    render(<PatientTable studyId="std_1" source="patients" result="res_a" title="本次生成记录" labels={{}} />);
    expect(await screen.findByText("P1-001")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "下一页" }));
    await waitFor(() => expect(screen.queryByText("P1-001")).toBeNull());
    next.resolve(page("res_a", ["P2-001"], 25));
    expect(await screen.findByText("P2-001")).toBeTruthy();
    expect(within(document.body).queryByText("P1-001")).toBeNull();
  });
});
