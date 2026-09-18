import { describe, expect, it } from "vitest";
import { findQuoteRange, highlightQuote, quoteNeedle } from "./quoteHighlight";

function root(html: string): HTMLElement {
  const element = document.createElement("div");
  element.innerHTML = html;
  document.body.appendChild(element);
  return element;
}

describe("finding a quotation in a rendered source", () => {
  it("finds it across inline formatting, ignoring whitespace runs and case", () => {
    const element = root("<p>Aspirin <strong>resulted in a significantly</strong>\n   higher risk of major hemorrhage.</p>");
    const range = findQuoteRange(element, "resulted in a significantly higher RISK of major hemorrhage");
    expect(range?.toString().replace(/\s+/g, " ")).toBe("resulted in a significantly higher risk of major hemorrhage");
  });

  it("locates an elided quotation by its first part", () => {
    expect(quoteNeedle("the effect was modest … in the subgroup")).toBe("the effect was modest");
    const element = root("<p>Overall, the effect was modest. Later, in the subgroup, it vanished.</p>");
    expect(findQuoteRange(element, "the effect was modest … in the subgroup")?.toString()).toBe("the effect was modest");
  });

  it("finds nothing when the words are not there, and says so", () => {
    const element = root("<p>median of 4.7 years of follow-up</p>");
    expect(findQuoteRange(element, "median of 5.2 years")).toBeNull();
    expect(highlightQuote(element, "median of 5.2 years")).toBe(false);
    expect(highlightQuote(element, "median of 4.7 years")).toBe(true);
  });
});
