import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

/**
 * What the writing-rule tests that scan the shell's sources share: the files
 * under a directory, and every piece of text a file can render — string and
 * template literals and JSX text, parsed with TypeScript, so a comment or a
 * regular expression that mentions a word cannot trip a scan for it.
 */
export function walk(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path).flatMap((entry) => walk(join(path, entry)));
}

/** The shell's own sources under `root`: `.ts` and `.tsx`, no tests, fixtures or the test helpers. */
export function shellSources(root: string): string[] {
  return walk(root).filter((path) => /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path) && !/__fixtures__|\.fixtures\.ts$|\/test\//.test(path));
}

export function sourceStrings(path: string): { line: number; text: string }[] {
  const kind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : path.endsWith(".mjs") ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, kind);
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
