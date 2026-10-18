import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { shellSources } from "../../test/sourceStrings";
import { FilterChip } from "./FilterChips";
import { Headline } from "./Headline";
import { Button } from "./Button";
import { List, ListHeader, ListRow } from "./ListRow";
import { Note } from "./Note";
import { SearchInput } from "./SearchInput";
import { SeverityBadge } from "./SeverityBadge";
import { StepRail, type StepRailStep } from "./StepRail";
import { Tabs } from "./Tabs";

/**
 * One look for one job (R19, r19-guards3). The UI walk counts a page's kinds of control by what a control looks like — its height, its
 * size and weight of type, a frame, a ground, a corner — and the data-rich pages of 循证 GEO, the frontier and 虚拟临床研究 spent 11 to 16
 * kinds against a budget of 10 because the same job was drawn two ways: the step rail's open step in a weight and a corner of its own, a
 * list row's title square beside rounded links, a selected chip bolder than the search pill beside it, a figure that opens what it counts
 * in 500 where the sentence is 400, a sort button that changed its height once it drew its arrow. The walk measures a real page; these
 * read the classes of the components, so a regression is a red test here before it is a failed release walk.
 */

const classesOf = (element: Element) => new Set((element.getAttribute("class") ?? "").split(/\s+/).filter(Boolean));

const STEPS: StepRailStep[] = [
  { id: "a", label: "证据", state: "done", href: "/a" },
  { id: "b", label: "问题", state: "active", href: "/b" },
  { id: "c", label: "监测", state: "todo", href: "/c" },
];

describe("the module band", () => {
  it("draws a step of the rail like a tab of the row beneath it, and the open step only by its rule and its colour", () => {
    render(
      <MemoryRouter>
        <StepRail label="进度" steps={STEPS} activeSteps={["b"]} />
        <Tabs label="项目视图" items={[{ value: "x", label: "总览" }]} value="x" onChange={() => {}} />
      </MemoryRouter>,
    );
    const tab = classesOf(screen.getByRole("tab", { name: "总览" }));
    const steps = STEPS.map((step) => classesOf(screen.getByRole("link", { name: new RegExp(`^${step.label}`) })));
    for (const step of steps) {
      // The type of the tab row: 14 px, 500, square (`rounded-none`: every link and button has the control corner unless it says
      // otherwise, and a 2 px rule at the foot of a rounded box curves up at its ends), a 2 px rule at the foot.
      expect(step).toContain("text-ui");
      expect(step).toContain("font-medium");
      expect(step).toContain("border-b-2");
      expect([...step].filter((name) => /^rounded/.test(name))).toEqual(["rounded-none"]);
    }
    expect(tab).toContain("text-ui");
    expect(tab).toContain("font-medium");
    expect([...tab].filter((name) => /^rounded/.test(name))).toEqual(["rounded-none"]);
    const open = steps[1];
    expect(open).toContain("border-accent");
    expect(steps[0]).not.toContain("border-accent");
  });
});

describe("a list row", () => {
  it("has a title with the corner every link has, so it is not a second kind of text control", () => {
    render(<MemoryRouter><List><ListRow title="第一行" onOpen={() => {}} /><ListRow title="第二行" to="/x" /></List></MemoryRouter>);
    expect(classesOf(screen.getByRole("button", { name: "第一行" }))).toContain("rounded");
    expect(classesOf(screen.getByRole("link", { name: "第二行" }))).toContain("rounded");
  });

  it("draws a sort button at one height, sorted or not", () => {
    render(<ListHeader columns={[{ key: "a", label: "被引用", sortable: true }, { key: "b", label: "讲错", sortable: true }]} sort={{ key: "a", descending: true }} onSort={() => {}} />);
    const heights = screen.getAllByRole("button").map((button) => [...classesOf(button)].find((name) => /^h-/.test(name)));
    expect(heights).toEqual(["h-5", "h-5"]);
  });
});

describe("a toolbar row", () => {
  it("has one filled pill: the selected chip and the search box are the same size, weight, shape and ground", () => {
    render(<><FilterChip pressed>全部</FilterChip><SearchInput label="搜索行动" size="sm" /></>);
    const chip = classesOf(screen.getByRole("button", { name: "全部" }));
    const search = classesOf(screen.getByRole("searchbox", { name: "搜索行动" }));
    for (const shared of ["h-sm", "rounded-full", "bg-surface-2", "text-compact"]) {
      expect(chip).toContain(shared);
      expect(search).toContain(shared);
    }
    for (const set of [chip, search]) {
      expect(set).not.toContain("font-medium");
      expect(set).not.toContain("border");
    }
  });

  it("keeps the header's search the 36 px rectangle", () => {
    render(<SearchInput label="搜索工具" />);
    const box = classesOf(screen.getByRole("searchbox", { name: "搜索工具" }));
    expect(box).toContain("h-control");
    expect(box).toContain("rounded");
    expect(box).not.toContain("rounded-full");
  });
});

describe("a figure that opens what it counts", () => {
  it("has the weight of the sentence it stands in, in a note and in a headline alike", () => {
    render(
      <MemoryRouter>
        <Note result={[{ n: 6, onOpen: () => {} }, " 个群还没有行动"]} />
        <Headline parts={[{ n: 2, onOpen: () => {} }, " 个问题"]} />
      </MemoryRouter>,
    );
    for (const name of ["6", "2"]) expect(classesOf(screen.getByRole("button", { name }))).not.toContain("font-medium");
  });

  it("is told apart in a held-up note by the ground, not by amber text", () => {
    render(<Note tone="warn" result={[{ n: 1 }, " 篇稿件没有看过"]} />);
    const note = classesOf(document.querySelector("[data-note]") as Element);
    expect(note).toContain("bg-warn-soft");
    expect(note).not.toContain("text-warn-strong");
  });
});

describe("the corner of a link and a button", () => {
  it("is the control corner unless the element sets one of its own — in the stylesheet, as the bare element", () => {
    const css = readFileSync(resolve(__dirname, "../../index.css"), "utf8");
    // The bare element (specificity 0,0,1): a `rounded-*` utility is more specific, so only an element with none gets the corner.
    expect(css).toMatch(/\n(?:a,\s*button|button,\s*a)\s*\{\s*border-radius:\s*var\(--radius-control\);\s*\}/);
    expect(css).toContain("--radius-control: 8px;");
  });
});

describe("the small type pairs", () => {
  // A page may hold four size × weight pairs. The owner's data put a 13 / 500 text button beside a 13 / 400 chip, and a 12 / 600 grade
  // beside the 12 / 400 tag, on 循证 GEO's home, 记忆, 信源 and 额度 — one pair more each than the fixture's pages had.
  it("sets a small button in the weight of the chip beside it, and the larger ones as they were", () => {
    render(<><Button size="sm" variant="text">继续</Button><Button>新建项目</Button><FilterChip>最近活动</FilterChip></>);
    expect(classesOf(screen.getByRole("button", { name: "继续" }))).toContain("font-normal");
    expect(classesOf(screen.getByRole("button", { name: "继续" }))).not.toContain("font-medium");
    expect(classesOf(screen.getByRole("button", { name: "新建项目" }))).toContain("font-medium");
    expect(classesOf(screen.getByRole("button", { name: "最近活动" }))).not.toContain("font-medium");
    expect(classesOf(screen.getByRole("button", { name: "最近活动" }))).not.toContain("font-semibold");
  });

  it("sets a severity grade in the weight of a tag: the ground says how bad, not the stroke", () => {
    render(<SeverityBadge level="S3" />);
    const grade = classesOf(document.querySelector("[data-severity]") as Element);
    expect(grade).toContain("text-meta");
    expect(grade).toContain("font-normal");
    expect(grade).not.toContain("font-semibold");
  });
});

describe("the one blue of text", () => {
  // `accent-strong` was a fourth blue next to the link colour on the same page; text on a pale blue ground is the accent (5.67:1).
  // The hot list's three ranks are the one place that needs three tones, and says so (`rankTone`).
  const SRC = resolve(__dirname, "../..");
  it("is not written as `text-accent-strong` anywhere in the shell", () => {
    const found = shellSources(SRC)
      .filter((path) => readFileSync(path, "utf8").includes("text-accent-strong"))
      .map((path) => relative(SRC, path).split("\\").join("/"));
    expect(found).toEqual(["components/frontier/frontierText.ts"]);
  });
});
