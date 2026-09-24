import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { parseClaimMatrix } from "@/lib/claimCitations";
import { MarkdownViewer } from "./MarkdownViewer";
import { SourceUpdateBadges } from "./SourceUpdateBadges";

const retraction = { kind: "retraction", noticeDoi: "10.1016/s0140-6736(10)60175-4", date: "2010-02-06", source: "retraction-watch" };
const correction = { kind: "correction", noticeDoi: "10.1016/s0140-6736(04)15715-2", date: "2004-03-06", source: "publisher" };

describe("retraction and correction notices on a cited source", () => {
  it("says what happened to the work, when, who recorded it, and links the notice", () => {
    render(<SourceUpdateBadges updates={[retraction, correction]} />);
    const retracted = screen.getByRole("link", { name: /该文献已撤稿（2010-02-06），据Retraction Watch记录/ });
    expect(retracted).toHaveTextContent("已撤稿 · 2010-02-06");
    expect(retracted).toHaveAttribute("href", "https://doi.org/10.1016/s0140-6736(10)60175-4");
    expect(retracted.className).toMatch(/bg-danger-soft/);
    const corrected = screen.getByRole("link", { name: /该文献有更正（2004-03-06），据出版方记录/ });
    expect(corrected.className).toMatch(/bg-warn-soft/);
  });

  it("shows nothing for a work with no notices, or a kind it does not know", () => {
    const { container } = render(<SourceUpdateBadges updates={[{ kind: "new_version", noticeDoi: null, date: null, source: null }]} />);
    expect(container).toBeEmptyDOMElement();
    const { container: none } = render(<SourceUpdateBadges updates={[]} />);
    expect(none).toBeEmptyDOMElement();
  });

  it("appears beside the source in the 依据 popover, and the claim's own verdict is unchanged", async () => {
    const claims = parseClaimMatrix(JSON.stringify({ claims: [{
      claimId: "CLM-001", claim: "该研究报告了肠道病变。", claimType: "direct", accessLevel: "full_text",
      sourceTitle: "Wakefield 1998", identifier: "DOI:10.1016/S0140-6736(97)11096-0", supportQuote: "Ileal-lymphoid-nodular hyperplasia",
    }] }));
    const verified = new Map([["CLM-001", {
      claimId: "CLM-001", claimType: "direct", status: "verified",
      sources: [{ artifactPath: null, status: "verified", doi: "10.1016/s0140-6736(97)11096-0", updates: [retraction] }],
    }]]);
    render(
      <MemoryRouter>
        <MarkdownViewer variant="document" claims={claims} reading={{ verified }}>{"x [1]<!-- claim:CLM-001 -->"}</MarkdownViewer>
      </MemoryRouter>,
    );
    await userEvent.click(screen.getByRole("button", { name: /查看这句话的依据/ }));
    expect(await screen.findByRole("link", { name: /该文献已撤稿/ })).toBeInTheDocument();
    expect(screen.getByLabelText("引文已在保存的原文中核对")).toHaveTextContent("✓");
  });
});
