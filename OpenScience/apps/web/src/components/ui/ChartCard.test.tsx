import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ChartCard } from "./ChartCard";
import { Section } from "./Section";

describe("a chart card's heading takes the level of where it stands", () => {
  afterEach(cleanup);

  it("is an h2 at the page's level, an h3 in a section, an h4 in a sub-section, and an explicit level wins", () => {
    // The 虚拟临床研究 推演 and 试验设计 tabs put their charts right under the page's title, and every card said h3 (axe heading-order).
    render(<>
      <h1>研究</h1>
      <ChartCard title="功效随真实效应的变化">图</ChartCard>
      <Section title="可比性"><ChartCard title="与本研究人群的可比性">图</ChartCard>
        <Section title="细节" level="sub"><ChartCard title="权重">图</ChartCard></Section>
      </Section>
      <ChartCard title="指定为三级" level={3}>图</ChartCard>
    </>);
    expect(screen.getByRole("heading", { name: "功效随真实效应的变化" }).tagName).toBe("H2");
    expect(screen.getByRole("heading", { name: "与本研究人群的可比性" }).tagName).toBe("H3");
    expect(screen.getByRole("heading", { name: "权重" }).tagName).toBe("H4");
    expect(screen.getByRole("heading", { name: "指定为三级" }).tagName).toBe("H3");
  });
});
