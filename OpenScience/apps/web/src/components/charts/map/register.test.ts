// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SVGRenderer } from "echarts/renderers";
import { echarts } from "../echartsBase";
import "./register";

/**
 * With the modular build, `labelLayout` is the option of a feature, and an option whose feature is not registered is not an error: it
 * does nothing. The relation graph named `hideOverlap` and drew every label over the next one for as long as it existed (the owner's
 * screenshot, 2026-10-14). This draws three marks whose labels stand on one spot, through the registrations the map page makes, and
 * counts the labels that came out.
 */
describe("the relation graph's label layout", () => {
  it("hides the labels that would cover one another, so only the first of three on one spot is drawn", () => {
    echarts.use([SVGRenderer]);
    const chart = echarts.init(null, null, { renderer: "svg", ssr: true, width: 600, height: 300 });
    const name = (text: string, x: number, y: number) => ({
      name: text, x, y, symbolSize: 10, label: { show: true, position: "right", formatter: text },
    });
    chart.setOption({
      animation: false,
      series: [{
        type: "graph", layout: "none", labelLayout: { hideOverlap: true },
        // The picture is fitted to its marks, so two invisible anchors far apart keep the three real ones close together, as they are on the page.
        data: [name("甲乙丙丁戊", 100, 100), name("己庚辛壬癸", 102, 102), name("子丑寅卯辰", 104, 101),
          { name: "anchor:0", x: 0, y: 0, symbolSize: 0, label: { show: false } }, { name: "anchor:1", x: 1800, y: 900, symbolSize: 0, label: { show: false } }],
      }],
    });
    const svg = chart.renderToSVGString();
    chart.dispose();
    const drawn = ["甲乙丙丁戊", "己庚辛壬癸", "子丑寅卯辰"].filter((text) => svg.includes(text));
    expect(drawn).toHaveLength(1);
  });

  it("registers the feature by name, because the library's own registration does not survive a production bundle", () => {
    // `echarts/core` installs the label layout as a side effect of being imported, and a production build (Rollup, tree-shaken) drops
    // it: the same graph option hid its overlapped labels on the development server and drew them all over each other on the live
    // page, which a test run in this environment cannot tell apart (the previous test passes without this line). So the registration
    // is read where it is made. Measured 2026-10-14 on a production build of this page, with and without the line.
    const source = readFileSync(fileURLToPath(new URL("./register.ts", import.meta.url)), "utf8");
    expect(source).toMatch(/import \{[^}]*\bLabelLayout\b[^}]*\} from "echarts\/features"/u);
    expect(source).toMatch(/echarts\.use\(\[[^\]]*\bLabelLayout\b/u);
  });
});
