import { act, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PageShell, type PageWidth } from "./PageShell";

/**
 * A page's one container: the gutter and the column are classes the stylesheet answers to, so those are what a unit test can see.
 * (jsdom resolves no media query; the 358 px body at 390 px is measured in a browser against the gallery build.)
 */
function column(width?: PageWidth) {
  const { container } = render(<PageShell title="记忆" width={width}><p>内容</p></PageShell>);
  const heading = screen.getByRole("heading", { level: 1, name: "记忆" });
  return { box: container.querySelector(".mx-auto") as HTMLElement, heading, container };
}

describe("PageShell", () => {
  it("keeps common secondary actions directly available when the actual content column has room", () => {
    const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1100);
    try {
      render(<MemoryRouter><PageShell title="研究" actionPlan={{
        primary: { id: "run", label: "开始", onSelect: () => {} },
        secondary: [{ id: "report", label: "周报", onSelect: () => {} }, { id: "talk", label: "对话", onSelect: () => {} }],
      }}><p>内容</p></PageShell></MemoryRouter>);
      expect(screen.getByRole("button", { name: "周报" })).toBeVisible();
      expect(screen.getByRole("button", { name: "对话" })).toBeVisible();
    } finally { width.mockRestore(); }
  });

  it("keeps a 16 px gutter on a phone and 24 px from 768 up, on one box that holds the title and the body", () => {
    const { box, heading } = column();
    expect(box).toHaveClass("px-4", "md:px-6");
    expect(box).not.toHaveClass("px-6");
    // One left edge: the header and the body are in the same box.
    expect(box).toContainElement(heading);
    expect(box).toContainElement(screen.getByText("内容"));
  });

  it.each([
    ["read", "max-w-read"],
    ["page", "max-w-page"],
    ["wide", "max-w-wide"],
    ["full", "max-w-none"],
  ] as const)("the %s column is %s", (width, expected) => {
    expect(column(width).box).toHaveClass(expected);
  });

  it("is the list column unless it is told otherwise", () => {
    expect(column().box).toHaveClass("max-w-page");
  });
});

describe("PageShell slots", () => {
  const steps = {
    label: "进度",
    steps: [{ id: "a", label: "证据", state: "done" as const }, { id: "b", label: "问题", state: "active" as const }],
    activeSteps: ["b"],
  };
  const tabs = { label: "项目视图", items: [{ value: "overview", label: "总览" }, { value: "plan", label: "方案" }], value: "overview", onChange: () => {}, panelId: "tab-panel" };
  const toolbar = { filters: [{ kind: "toggle" as const, label: "只看待处理", pressed: false, onChange: () => {} }] };

  const full = (
    <MemoryRouter>
      <PageShell
        title="信尔美" meta="第 3 周" scope={{ label: "范围", groups: [{ choices: [{ id: "p", label: "项目 P" }] }], value: "p", onChange: () => {} }}
        actions={<button type="button">周报</button>}
        steps={steps}
        activity={{ label: "复测" }}
        tabs={tabs}
        toolbar={toolbar}
        headline={{ parts: ["18 条严重讲错"] }}
      >
        <p>正文</p>
      </PageShell>
    </MemoryRouter>
  );

  const before = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

  it("renders header, steps, activity, tabs, toolbar, headline and body in one fixed order", () => {
    const { container } = render(full);
    const order = ["[data-page-header]", "[data-step-rail]", "[data-activity]", "[role=tablist]", "[data-toolbar]", "[data-headline]", "[data-page-body]"]
      .map((selector) => container.querySelector(selector) as Element);
    order.forEach((element, index) => expect(element, `slot ${index}`).not.toBeNull());
    for (let index = 1; index < order.length; index += 1) expect(before(order[index - 1], order[index]), `slot ${index} follows slot ${index - 1}`).toBe(true);
  });

  it("puts steps, activity, tabs and toolbar in one sticky band that covers the gutters, and the header and the headline outside it", () => {
    const { container } = render(full);
    const band = container.querySelector("[data-page-chrome]") as HTMLElement;
    expect(band).toHaveClass("sticky", "top-0", "z-sticky", "-mx-4", "px-4", "md:-mx-6", "md:px-6", "bg-bg");
    for (const inside of ["[data-step-rail]", "[data-activity]", "[role=tablist]", "[data-toolbar]"]) expect(band.querySelector(inside), inside).not.toBeNull();
    expect(band.querySelector("[data-page-header], [data-headline], [data-page-body]")).toBeNull();
  });

  it("omits an empty toolbar row while retaining tab navigation (DS22.4)", () => {
    const { container, rerender } = render(<PageShell title="页" tabs={tabs} toolbar={toolbar}><p>正文</p></PageShell>);
    expect(container.querySelector("[data-toolbar]")?.parentElement).toHaveClass("min-h-11");
    rerender(<PageShell title="页" tabs={{ ...tabs, value: "plan" }} toolbar={null}><p>正文</p></PageShell>);
    expect(container.querySelector("[data-toolbar]")).toBeNull();
    const reserved = container.querySelector("[data-page-chrome] > [aria-hidden='true']");
    expect(reserved).toBeNull();
    rerender(<PageShell title="页" tabs={{ ...tabs, value: "plan" }}><p>正文</p></PageShell>);
    expect(container.querySelector("[data-page-chrome] > [aria-hidden='true']")).toBeNull();
  });

  it("is a page with no band at all when it fills no band slot, and renders as it did", () => {
    const { container } = render(<PageShell title="记忆"><p>内容</p></PageShell>);
    expect(container.querySelector("[data-page-chrome]")).toBeNull();
    expect(container.querySelector("[data-page-body]")).toHaveClass("mt-6");
  });

  it("makes the body the tab panel, labelled by the open tab", () => {
    const { container } = render(<PageShell title="页" tabs={tabs}><p>正文</p></PageShell>);
    const body = container.querySelector("[data-page-body]") as HTMLElement;
    expect(body).toHaveAttribute("role", "tabpanel");
    expect(body).toHaveAttribute("id", "tab-panel");
    expect(body).toHaveAttribute("aria-labelledby", "tab-panel-tab-overview");
    expect(screen.getByRole("tab", { name: "总览" })).toHaveAttribute("id", "tab-panel-tab-overview");
  });

  it("draws the scope after the title, in the header", () => {
    const { container } = render(full);
    const header = container.querySelector("[data-page-header]") as HTMLElement;
    const heading = screen.getByRole("heading", { level: 1, name: "信尔美" });
    const scope = screen.getByRole("button", { name: "范围：项目 P" });
    expect(header).toContainElement(scope);
    expect(before(heading, scope)).toBe(true);
  });

  it("lets the title take the room the actions leave, and never shrinks the actions", () => {
    const { container } = render(<PageShell title="一个很长很长很长很长很长的标题" actions={<button type="button">问这条证据</button>}><p>x</p></PageShell>);
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading).toHaveClass("min-w-0", "line-clamp-2");
    expect(screen.getByRole("button", { name: "问这条证据" }).parentElement).toHaveClass("shrink-0");
    expect(container.querySelector("[data-page-header]")).toHaveClass("flex-wrap");
  });

  it("sets a reader's title in the document rung", () => {
    render(<PageShell title="一张证据卡" titleVariant="document" width="read"><p>x</p></PageShell>);
    expect(screen.getByRole("heading", { level: 1 })).toHaveClass("text-doc-title");
  });

  it("publishes the band's height for what sticks below it, makes it the scroll padding, and takes it back with the band", () => {
    const { container, rerender, unmount } = render(<PageShell title="页" tabs={tabs}><p>x</p></PageShell>);
    const scroller = container.querySelector("[data-page-scroll]") as HTMLElement;
    expect(scroller).toHaveClass("overflow-y-auto", "scroll-pt-[var(--page-chrome-h,0px)]");
    expect(scroller.style.getPropertyValue("--page-chrome-h")).toBe("0px");
    rerender(<PageShell title="页"><p>x</p></PageShell>);
    expect(scroller.style.getPropertyValue("--page-chrome-h")).toBe("");
    unmount();
  });

  describe("the hairline under the band", () => {
    let callback: IntersectionObserverCallback | null = null;
    afterEach(() => { vi.unstubAllGlobals(); callback = null; });
    const stub = () => {
      vi.stubGlobal("IntersectionObserver", class {
        constructor(cb: IntersectionObserverCallback) { callback = cb; }
        observe() {}
        disconnect() {}
        unobserve() {}
      });
    };
    // Held at the top of the scroll container: the band is no longer wholly inside the root shrunk by a pixel.
    const scrollPast = (container: HTMLElement) => {
      act(() => {
        callback?.([{ intersectionRatio: 0.97, boundingClientRect: { top: 0 }, rootBounds: { top: 1 } } as unknown as IntersectionObserverEntry], {} as IntersectionObserver);
      });
      return container.querySelector("[data-page-chrome]") as HTMLElement;
    };

    it("is drawn once the header has scrolled away, when the band's last row has none of its own", () => {
      stub();
      const { container } = render(<PageShell title="页" tabs={tabs} toolbar={toolbar}><p>x</p></PageShell>);
      const band = container.querySelector("[data-page-chrome]") as HTMLElement;
      expect(band).not.toHaveAttribute("data-stuck");
      expect(band.className).toContain("after:opacity-0");
      expect(scrollPast(container)).toHaveAttribute("data-stuck");
    });

    it("is left to the tab row when that is the band's last row", () => {
      stub();
      const { container } = render(<PageShell title="页" tabs={tabs}><p>x</p></PageShell>);
      expect(scrollPast(container).className).not.toContain("after:opacity-0");
    });
  });

  it("warns, in development, that a page has one row of views: tabs and a toolbar's views are both set", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    render(<PageShell title="页" tabs={tabs} toolbar={{ views: { label: "视图", items: [{ value: "a", label: "A" }], value: "a", onChange: () => {} } }}><p>x</p></PageShell>);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("one view-switch row"));
    warn.mockRestore();
  });
});

it("reserves a separate dock viewport so scrolling content never passes behind conversation controls", () => {
  const { container } = render(<PageShell title="研究" dock={<button>打开对话</button>}><button>查看结果</button></PageShell>);
  const scroll = container.querySelector('[data-page-scroll]')!;
  const dock = container.querySelector('[data-page-dock]')!;
  expect(scroll.contains(screen.getByRole('button', { name: '查看结果' }))).toBe(true);
  expect(scroll.contains(dock)).toBe(false);
  expect(scroll.parentElement).toBe(dock.parentElement);
  expect(scroll.nextElementSibling).toBe(dock);
  expect(dock.contains(screen.getByRole('button', { name: '打开对话' }))).toBe(true);
});

it("reattaches chrome observers when adding or removing the dock changes the viewport geometry", () => {
  const intersections: { root: Element | Document | null | undefined; disconnect: ReturnType<typeof vi.fn>; observe: ReturnType<typeof vi.fn> }[] = [];
  const sizes: { disconnect: ReturnType<typeof vi.fn>; observe: ReturnType<typeof vi.fn> }[] = [];
  vi.stubGlobal('IntersectionObserver', class {
    disconnect = vi.fn(); observe = vi.fn();
    constructor(_callback: unknown, options: IntersectionObserverInit) { intersections.push({ root: options.root, disconnect: this.disconnect, observe: this.observe }); }
  });
  vi.stubGlobal('ResizeObserver', class {
    disconnect = vi.fn(); observe = vi.fn();
    constructor() { sizes.push(this); }
  });
  try {
    const tabs = { label: '结果', value: 'one', items: [{ value: 'one', label: '结果' }], onChange: () => {} };
    const view = (dock?: React.ReactNode) => <PageShell title="页" tabs={tabs} dock={dock}>结果</PageShell>;
    const { container, rerender } = render(view(<button>对话</button>));
    for (const dock of [undefined, <button key="dock">对话</button>]) {
      const previous = intersections.at(-1)!;
      const oldSize = sizes.at(-1)!;
      rerender(view(dock));
      expect(previous.disconnect).toHaveBeenCalledOnce();
      expect(oldSize.disconnect).toHaveBeenCalledOnce();
      const scroll = container.querySelector('[data-page-scroll]');
      const band = container.querySelector('[data-page-chrome]');
      expect(intersections.at(-1)!.root).toBe(scroll);
      expect(intersections.at(-1)!.observe).toHaveBeenCalledWith(band);
      expect(sizes.at(-1)!.observe).toHaveBeenCalledWith(band);
      expect((scroll as HTMLElement).style.getPropertyValue('--page-chrome-h')).toBe('0px');
    }
  } finally { vi.unstubAllGlobals(); }
});


it("preserves child drafts, DOM identity and scroll position while the dock toggles", () => {
  const view = (dock?: React.ReactNode) => <PageShell title="研究" dock={dock}><input aria-label="草稿" defaultValue="原稿" /></PageShell>;
  const { container, rerender } = render(view(<button>对话</button>));
  const input = screen.getByRole('textbox', { name: '草稿' }) as HTMLInputElement;
  input.value = '未发送的修改';
  const scroll = container.querySelector('[data-page-scroll]') as HTMLElement;
  scroll.scrollTop = 120;
  for (const dock of [undefined, <button key="dock">对话</button>]) {
    rerender(view(dock));
    expect(screen.getByRole('textbox', { name: '草稿' })).toBe(input);
    expect(input.value).toBe('未发送的修改');
    expect(container.querySelector('[data-page-scroll]')).toBe(scroll);
    expect(scroll.scrollTop).toBe(120);
  }
});

it("keeps a module's single project context in measured sticky chrome", () => {
  const { container } = render(<PageShell title="AI 表现" contextBar={<button>选择整个项目</button>}><p>结果</p></PageShell>);
  const band = container.querySelector('[data-page-chrome]');
  expect(band).toHaveClass('sticky', 'top-0');
  expect(band).toContainElement(screen.getByRole('button', { name: '选择整个项目' }));
  expect(band).not.toContainElement(screen.getByRole('heading', { name: 'AI 表现' }));
  expect(container.querySelectorAll('[data-page-context]')).toHaveLength(1);
});
