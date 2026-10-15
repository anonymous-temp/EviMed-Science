import { render } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { VcrHomePage } from "./VcrHomePage";
import { VcrStudyPage } from "./VcrStudyPage";

/**
 * What the structure tests of the study pages share (`startsWork`, `inertLookalikes`, `standingText`): the real page on the real
 * routes, and the rules those tests state about what is on a page.
 *
 * It does not mock the network or the store itself: a mock is hoisted per test file, so each file declares
 * `vi.mock("@/lib/productClient", …)` and `vi.mock("@/lib/projects", …)` and feeds `installVcrServer` (the server's own fixtures).
 */

export function Where() {
  const location = useLocation();
  return <p data-testid="where">{`${location.pathname}${location.search}`}</p>;
}

export function drawStudy(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/app/virtual-research" element={<><VcrHomePage /><Where /></>} />
        <Route path="/app/virtual-research/:studyId/:tab?" element={<><VcrStudyPage /><Where /></>} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** The blocks of text a page stands on its own, outside what holds a record: what the rule counts. */
const RECORD = "[role=dialog], [role=alertdialog], table, blockquote, [data-note], [data-empty], [data-step-state], [data-toolbar], [data-page-header], [data-activity], [role=tab], [role=menu], button, a, h1, h2, h3, label, li";

/** Elements with at least `min` Han characters of their own text (not their children's), outside a record container. */
export function standingBlocks(root: ParentNode, min = 24): Array<{ element: Element; text: string }> {
  const found: Array<{ element: Element; text: string }> = [];
  for (const element of root.querySelectorAll("*")) {
    if (element.closest(RECORD)) continue;
    const own = [...element.childNodes].filter((node) => node.nodeType === 3).map((node) => node.textContent ?? "").join("");
    const han = own.match(/\p{Script=Han}/gu)?.length ?? 0;
    if (han >= min) found.push({ element, text: own.trim() });
  }
  return found;
}

/** What looks selected or pressed, and is neither a control nor in one. */
export function inertLookalikes(root: ParentNode): Element[] {
  const SELECTED = "[aria-current]:not([aria-current=false]), [aria-selected=true], [aria-pressed=true], .bg-accent-soft";
  return [...root.querySelectorAll(SELECTED)].filter((element) => {
    // An information band or a note is not a selection, whatever ground it has.
    if (element.closest("[data-activity], [data-note], [data-tag], [data-tab-dot], [data-forced-colors]")) return false;
    if (element.matches("a, button, [role=tab], [role=option], [role=menuitem], [role=menuitemradio], [role=radio], [role=row], summary")) return false;
    if (element.closest("a, button, [role=tab], [role=option], [role=row]")) return false;
    // A row that wraps its own control (a list row: the title is the link) is a row.
    if (element.querySelector("a, button, [role=tab]")) return false;
    return true;
  });
}
