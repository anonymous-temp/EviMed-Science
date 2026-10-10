// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * The file viewers speak the reader's language.
 *
 * A viewer is where a researcher meets a file the agent made — a table, a model, a
 * genome track — and `copyRules.test.ts` reads how Chinese is written, not whether it
 * is there: a table preview told every reader with a long CSV "Showing the first 200
 * rows", a 3D model "12,345 triangles" and "File problem", and a genome track "Drag to
 * pan · scroll to zoom", for as long as nobody looked (audit, 2026-10-10).
 *
 * This reads what a viewer can put on the screen — JSX text and the expressions inside
 * it, the words of a label, a title or an `aria-label`, and what is passed to
 * `setNotice` / `setError` / `toast` — and fails on any that is English with no Chinese
 * in it. A class list, a comment and an identifier are not read. `PENDING` is the
 * viewers whose figures still carry the English axis and legend words of their field
 * (energy, k-point, spin): remove a file the moment it has none left, and it is
 * reported if it already has none.
 */
const SRC = fileURLToPath(new URL("..", import.meta.url));
const VIEWERS = join(SRC, "components/inspector");

const PENDING = new Set(["AnomalyMapView.tsx", "BandView.tsx", "DosView.tsx", "FitsView.tsx", "PhaseView.tsx"]);

/** English that is a command or a unit and not a sentence: it is what the reader types or reads in the field. */
const NOT_A_SENTENCE = [/^pip freeze\b/];

const PROPS = new Set(["label", "title", "placeholder", "aria-label", "alt", "description", "summary", "message", "emptyText", "hint"]);
const SAYS = /^(set(Notice|Error|Message)|toast\.(error|success))$/;
const CJK = /[㐀-鿿]/;

/** Every piece of text a viewer's source can put on the screen. */
function visibleStrings(path: string, text: string): { line: number; text: string }[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: { line: number; text: string }[] = [];
  const add = (node: ts.Node, value: string) => found.push({ line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, text: value });

  /**
   * The literals an expression shows as they are: the expression itself, a branch of a condition, what follows `&&` or stands
   * either side of `||` and `??`, the pieces of a template. A comparison's operand, an argument and a callback's body are code.
   */
  const literals = (node: ts.Node | undefined) => {
    if (!node) return;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) add(node, node.text);
    else if (ts.isTemplateExpression(node)) {
      add(node.head, node.head.text);
      for (const span of node.templateSpans) add(span.literal, span.literal.text);
    } else if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) literals(node.expression);
    else if (ts.isJsxExpression(node)) literals(node.expression);
    else if (ts.isConditionalExpression(node)) {
      literals(node.whenTrue);
      literals(node.whenFalse);
    } else if (ts.isBinaryExpression(node)) {
      const operator = node.operatorToken.kind;
      if (operator === ts.SyntaxKind.AmpersandAmpersandToken) literals(node.right);
      else if (operator === ts.SyntaxKind.BarBarToken || operator === ts.SyntaxKind.QuestionQuestionToken) {
        literals(node.left);
        literals(node.right);
      }
    }
  };

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (ts.isJsxText(node)) {
      if (node.text.trim()) add(node, node.text.trim());
    } else if (ts.isJsxExpression(node) && !ts.isJsxAttribute(node.parent)) {
      literals(node.expression);
    } else if (ts.isJsxAttribute(node) && PROPS.has(node.name.getText(source))) {
      literals(node.initializer);
    } else if (ts.isCallExpression(node) && SAYS.test(node.expression.getText(source))) {
      literals(node.arguments[0]);
    } else if (ts.isPropertyAssignment(node) && ["label", "title"].includes(node.name.getText(source))) {
      literals(node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** The strings among them that are English and nothing else — a word of three lowercase letters; STL and BED are names, not English. */
function english(path: string, text: string): string[] {
  return visibleStrings(path, text)
    .filter(({ text: value }) => !CJK.test(value) && /[a-z]{3,}/.test(value) && !NOT_A_SENTENCE.some((pattern) => pattern.test(value.trim())))
    .map(({ line, text: value }) => `${line}  ${value.slice(0, 60)}`);
}

const viewers = readdirSync(VIEWERS).filter((name) => name.endsWith(".tsx") && !/\.test\.tsx$/.test(name));
const englishIn = (name: string) => english(name, readFileSync(join(VIEWERS, name), "utf8"));

describe("the file viewers speak Chinese", () => {
  it("walked the viewers it names", () => {
    // Prove the walk walked before trusting what it did not find.
    expect(viewers.length).toBeGreaterThan(15);
    for (const name of ["TablePreview.tsx", "MeshView.tsx", "GenomeView.tsx", "ProvenancePanel.tsx", "FilePreviewInspector.tsx"]) expect(viewers).toContain(name);
    expect(viewers.flatMap((name) => visibleStrings(name, readFileSync(join(VIEWERS, name), "utf8"))).length).toBeGreaterThan(300);
  });

  it("prints no English sentence in a viewer that is not waiting for its field's words", () => {
    const offenders = viewers.filter((name) => !PENDING.has(name)).flatMap((name) => englishIn(name).map((entry) => `${name}:${entry}`));
    expect(offenders).toEqual([]);
  });

  it("lists only viewers that still have English in them", () => {
    expect([...PENDING].filter((name) => !viewers.includes(name) || englishIn(name).length === 0)).toEqual([]);
  });

  it("would see the English of a table note, a badge, a notice and a label, and nothing else", () => {
    const probe = [
      'export function A({ rows, tris, filename }: P) {',
      '  const [, setNotice] = useState("");',
      '  setNotice("This file has no visible geometry");',
      '  return (<div className="flex items-center text-caption" aria-label={`${filename} model viewer`}>',
      '    <span>{tris.toLocaleString()} triangles</span>',
      '    <p>Showing the first {rows} rows</p>',
      '    {rows > 60 && ` · showing 60 of ${rows} rows`}',
      '    <b title="Open file">拖动平移</b>',
      '  </div>);',
      '}',
    ].join("\n");
    expect(english("probe.tsx", probe).map((entry) => entry.replace(/^\d+ {2}/, ""))).toEqual([
      "This file has no visible geometry",
      " model viewer",
      "triangles",
      "Showing the first",
      "rows",
      " · showing 60 of ",
      " rows",
      "Open file",
    ]);
    const quiet = [
      '// Showing the first rows',
      'export function B({ n }: P) {',
      '  return <div className="flex items-center gap-2 text-caption text-muted" title="共 3 行">只显示前 {n} 行 <code>pip freeze</code> · STL</div>;',
      '}',
    ].join("\n");
    expect(english("quiet.tsx", quiet)).toEqual([]);
  });
});
