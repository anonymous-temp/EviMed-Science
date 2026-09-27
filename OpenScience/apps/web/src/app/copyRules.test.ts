// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * The writing rules a string can be checked for mechanically (spec §5.5,
 * §13.7, §14.1; appendix E #25, #26), over every string the shell can render:
 *
 *  - quotation marks are “” (and ‘’ inside them), never 「」『』, which belong
 *    to vertical and Hong Kong / Taiwan typesetting;
 *  - status text is 正在 + a verb with no ellipsis — “加载中…” is the shape
 *    this replaced;
 *  - interface copy types a half-width space between Chinese and a Latin
 *    letter or a digit (“共 29 条”, “打开 PubMed 检索”), except inside a
 *    formatted date (“9月26日”).
 *
 * Only strings are read — string and template literals and JSX text, parsed
 * with TypeScript — so a comment quoting old copy, a regular expression or an
 * identifier cannot trip it. “失败/错误 as the subject” is a judgement about a
 * sentence, not a pattern, and stays with review.
 *
 * `OUT_OF_SCOPE` are areas other engineers were rewriting when the sweep ran
 * (2026-09-27): 循证 GEO and its charts, the knowledge-base pages, and the
 * settings row that imports from a network drive. Remove an entry once its
 * area has been swept (the memory pages were, the same day).
 */
const SRC = fileURLToPath(new URL("..", import.meta.url));
const OUT_OF_SCOPE = [
  /^components\/geo\//,
  /^components\/data\//,
  /^components\/charts\//,
  /^app\/routes\/Geo/,
  /^app\/routes\/(KnowledgePage|SourcesPage|FilesPage)/,
  /^components\/sources\//,
  /^lib\/sourceClient\.ts$/,
  /^components\/settings\/ConnectorsSection\.tsx$/,
];

function files(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path).flatMap((entry) => files(join(path, entry)));
}

/** Every piece of text a file can render: literals, template parts, JSX text. */
function strings(path: string): { line: number; text: string }[] {
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: { line: number; text: string }[] = [];
  const add = (node: ts.Node, text: string) => found.push({ line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, text });
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isJsxText(node)) add(node, node.text);
    else if (ts.isTemplateExpression(node)) {
      add(node.head, node.head.text);
      for (const span of node.templateSpans) add(span.literal, span.literal.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const CORNER_QUOTES = /[「」『』]/;
const STATUS_ELLIPSIS = /(正在[^"'`\n…]{0,16}|[㐀-鿿]中)(…|\.\.\.)/;
const UNSPACED = /[㐀-鿿][A-Za-z0-9]|[A-Za-z0-9][㐀-鿿]/;
/** A formatted date or ordinal keeps its digits tight: 9月26日, 2026年. */
const DATE_PARTS = /\d+[年月日号]|[年月]\d+/g;

const sources = files(SRC)
  .filter((path) => /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path) && !/__fixtures__|\.fixtures\.ts$|\/test\//.test(path))
  .filter((path) => !OUT_OF_SCOPE.some((pattern) => pattern.test(relative(SRC, path))));

function offenders(rule: (text: string) => boolean): string[] {
  return sources.flatMap((path) =>
    strings(path)
      .filter(({ text }) => rule(text))
      .map(({ line, text }) => `${relative(SRC, path)}:${line}  ${text.trim().slice(0, 60)}`),
  );
}

describe("copy follows the writing rules", () => {
  it("walks the shell it names", () => {
    // Prove the walk walked before trusting what it did not find.
    expect(sources.length).toBeGreaterThan(150);
    const names = sources.map((path) => relative(SRC, path));
    for (const name of ["components/ui/Toaster.tsx", "components/sidebar/ProjectBrowser.tsx", "components/settings/ProjectsSection.tsx", "lib/format.ts"]) {
      expect(names).toContain(name);
    }
  });

  it("quotes with “”, never 「」 or 『』", () => {
    expect(offenders((text) => CORNER_QUOTES.test(text))).toEqual([]);
  });

  it("writes status as 正在 + a verb, without an ellipsis", () => {
    expect(offenders((text) => STATUS_ELLIPSIS.test(text))).toEqual([]);
    // JSX splits “正在读取 {filename}…” into pieces; an ellipsis that is JSX
    // text after an expression is the same status.
    const jsxEllipsis = sources.flatMap((path) => {
      const found: string[] = [];
      const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const visit = (node: ts.Node) => {
        if (ts.isJsxText(node) && /^\s*…/.test(node.text)) found.push(`${relative(SRC, path)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
        ts.forEachChild(node, visit);
      };
      if (path.endsWith(".tsx")) visit(source);
      return found;
    });
    expect(jsxEllipsis).toEqual([]);
  });

  it("types a space between Chinese and Latin letters or digits, except inside a date", () => {
    expect(offenders((text) => UNSPACED.test(text.replace(DATE_PARTS, "")))).toEqual([]);
  });

  it("reads strings, not comments, and would see a string that breaks a rule", () => {
    const probe = join(SRC, "app/copyRules.test.ts");
    const own = strings(probe).map(({ text }) => text);
    expect(own.some((text) => text.includes("正在"))).toBe(true);
    expect(CORNER_QUOTES.test("搜索「阿司匹林」")).toBe(true);
    expect(STATUS_ELLIPSIS.test("加载中…")).toBe(true);
    expect(STATUS_ELLIPSIS.test("正在读取 报告.pdf…")).toBe(true);
    expect(UNSPACED.test("共29条".replace(DATE_PARTS, ""))).toBe(true);
    expect(UNSPACED.test("9月26日".replace(DATE_PARTS, ""))).toBe(false);
  });
});
