import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { heldTypedFollow, TypedFollowInput, typedFollowWords } from "./TypedFollowInput";

const client = vi.hoisted(() => ({ addFrontierFollow: vi.fn() }));
vi.mock("@/lib/frontierClient", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/frontierClient")>()), ...client }));

const held = { id: "4", kind: "query", key: "glp-1 和胰腺炎", label: "GLP-1 和胰腺炎", muted: false } as const;
beforeEach(() => { client.addFrontierFollow.mockReset().mockImplementation(async (input: Record<string, unknown>) => ({ id: "new", muted: false, ...input })); });

describe("the words a reader typed", () => {
  it("are read as the server reads them: NFKC, one space between words", () => {
    expect(typedFollowWords("  ＧＬＰ-1   和胰腺炎 ")).toBe("GLP-1 和胰腺炎");
    expect(typedFollowWords("   ")).toBe("");
  });

  it("are held by an earlier follow of the same words, whatever their case, and by no other kind of follow", () => {
    expect(heldTypedFollow([held], "glp-1 和胰腺炎")?.id).toBe("4");
    expect(heldTypedFollow([held], "GLP-1")).toBeUndefined();
    expect(heldTypedFollow([{ ...held, kind: "topic" }], "glp-1 和胰腺炎")).toBeUndefined();
  });
});

describe("the input", () => {
  it("adds nothing for empty words, adds the words once on Enter, clears, and hands the follow to the page", async () => {
    const onAdded = vi.fn();
    render(<TypedFollowInput held={[]} onAdded={onAdded} />);
    const input = screen.getByLabelText("关注一个药物、试验或问题");
    expect(screen.getByRole("button", { name: "关注" })).toBeDisabled();
    fireEvent.submit(input.closest("form")!);
    expect(client.addFrontierFollow).not.toHaveBeenCalled();
    await userEvent.type(input, "司美格鲁肽 SELECT{Enter}");
    await waitFor(() => expect(onAdded).toHaveBeenCalledTimes(1));
    expect(client.addFrontierFollow).toHaveBeenCalledTimes(1);
    expect(client.addFrontierFollow).toHaveBeenCalledWith({ kind: "query", key: "司美格鲁肽 SELECT", label: "司美格鲁肽 SELECT" });
    expect(input).toHaveValue("");
  });

  it("says 「已经关注了」 for words already held and makes no request", async () => {
    const onAdded = vi.fn();
    render(<TypedFollowInput held={[held]} onAdded={onAdded} />);
    await userEvent.type(screen.getByLabelText("关注一个药物、试验或问题"), "GLP-1  和胰腺炎{Enter}");
    expect(await screen.findByRole("status")).toHaveTextContent("已经关注了“GLP-1 和胰腺炎”");
    expect(client.addFrontierFollow).not.toHaveBeenCalled();
    expect(onAdded).not.toHaveBeenCalled();
  });

  it("keeps the words and says why when the follow could not be made, and busies the button while it waits", async () => {
    let fail!: (error: Error) => void;
    client.addFrontierFollow.mockReturnValue(new Promise((_resolve, reject) => { fail = reject; }));
    render(<TypedFollowInput held={[]} onAdded={vi.fn()} />);
    const input = screen.getByLabelText("关注一个药物、试验或问题");
    await userEvent.type(input, "心衰{Enter}");
    await waitFor(() => expect(input).toHaveAttribute("aria-busy", "true"));
    expect(screen.getByRole("button", { name: "关注" })).toBeDisabled();
    fail(new Error("busy"));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(input).toHaveValue("心衰");
    expect(input).not.toHaveAttribute("aria-busy");
  });

  it("takes the words as the field's name where it is compact, and shows no visible label", () => {
    render(<TypedFollowInput held={[]} onAdded={vi.fn()} compact />);
    const input = screen.getByRole("textbox", { name: "关注一个药物、试验或问题" });
    expect(input).toHaveAttribute("placeholder", "药物、试验或问题");
    expect(screen.queryByText("关注一个药物、试验或问题", { selector: "label" })).not.toBeInTheDocument();
  });

  it("holds the words to sixty characters", () => {
    render(<TypedFollowInput held={[]} onAdded={vi.fn()} />);
    expect(screen.getByLabelText("关注一个药物、试验或问题")).toHaveAttribute("maxlength", "60");
  });
});
