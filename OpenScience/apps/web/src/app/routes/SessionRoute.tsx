import { PageTitle } from "@/components/layout/PageTitle";

/**
 * The conversation surface is the kernel's own application, and nothing else.
 *
 * It used to be the kernel's application plus a shell-owned run panel on the
 * right, and the shell's navigation on the left, inside which the kernel drew
 * its own left column and its own right pane. Four columns, three of which
 * listed the same work under three names — 任务, 会话, 运行 (2026-09-15 walk,
 * A1/A6). The panel is gone rather than moved: the same rows are under each
 * project in the sidebar, and a second copy beside them was the surplus.
 *
 * This route is now a placeholder, and that is the point: the frame it used to
 * mount lives in the shell (`SessionFrameHost`), above the router, so that
 * navigating to any other page hides it instead of tearing its document,
 * websocket and binding down (2026-09-20 plan, WP1). Everything this route
 * once decided — which conversation to open, the opening cover, the errors —
 * is decided there from the address, so there is nothing left to render but
 * the browser tab's name.
 *
 * The design spec chose the opposite arrangement (§18.1 option C: keep a
 * self-built session page, do not embed the kernel's client) and the
 * implementation went the other way on 2026-09-09 without the shell being
 * re-cut around it. This file is that re-cut; the spec records the reversal.
 */
export function SessionRoute() {
  return <PageTitle page="对话" />;
}
