import ts from "typescript";

/**
 * What `layoutRules.test.ts` measures, as functions of a source text, so the test can prove the scan sees a violation before it
 * trusts a count of none (R19, plan §3 S3, audit D C3 and C5).
 *
 *  - **A grey sentence written by hand**: a `<p>`, `<span>`, `<div>` or `<li>` whose own text — JSX text, a string literal or a
 *    template in an expression — holds at least 14 Chinese characters, whose classes include the grey text colours
 *    (`text-text-2`, `text-text-3`, `text-muted`), and that has no clickable descendant. Such a sentence has no action and no
 *    number to open: by the plan's rule 4 it is a back-office line or a sentence for `Note`. Sentences kept in a variable or a
 *    copy table are not seen, so the count is a floor.
 *  - **A hand-written divided list**: a `<ul>` or `<ol>` whose classes hold `divide-y`, outside `components/ui/`. `List` and
 *    `ListRow` own the row's hover, mark and selected state, which a hand-written list does not have.
 */

/** The page and tab components: where the rules are held (the primitives and the chrome are the sanctioned makers). */
const PAGE_DIRECTORIES = /^(app\/|components\/(geo|vcr|memory|sources|frontier|inbox|autopilot|capsule|settings|skills)\/)/;

/** Whether a path (relative to `src`) is a page or a tab component. */
export function isPageFile(relative: string): boolean {
  return PAGE_DIRECTORIES.test(relative);
}

const GREY = /(?<![\w-])text-(?:text-2|text-3|muted)(?![\w-])/;
const DIVIDED = /(?<![\w-])divide-y(?![\w-])/;
const CJK = /[㐀-鿿]/g;
const MIN_CHARACTERS = 14;
const SENTENCE_TAGS = new Set(["p", "span", "div", "li"]);
const LIST_TAGS = new Set(["ul", "ol"]);

/** An element a person can press, by its name or by what it is given to do. */
const CLICKABLE_TAG = /^(?:a|button|input|select|textarea|summary|label)$|(?:Button|Link|Chip|Chips|Menu|Switch|Select|Input|Toggle|Tabs|Action|Actions)$/;
const CLICKABLE_ATTRIBUTE = new Set(["onClick", "onOpen", "onSelect", "href", "to"]);

function parse(fileName: string, text: string): ts.SourceFile {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

function tagName(node: ts.JsxElement | ts.JsxSelfClosingElement): string {
  return (ts.isJsxElement(node) ? node.openingElement : node).tagName.getText();
}

function attributesOf(node: ts.JsxElement | ts.JsxSelfClosingElement): ts.JsxAttributes {
  return (ts.isJsxElement(node) ? node.openingElement : node).attributes;
}

function classText(node: ts.JsxElement | ts.JsxSelfClosingElement): string {
  for (const attribute of attributesOf(node).properties) {
    if (ts.isJsxAttribute(attribute) && attribute.name.getText() === "className") return attribute.initializer?.getText() ?? "";
  }
  return "";
}

function pressable(node: ts.JsxElement | ts.JsxSelfClosingElement): boolean {
  if (CLICKABLE_TAG.test(tagName(node))) return true;
  return attributesOf(node).properties.some((attribute) => ts.isJsxAttribute(attribute) && CLICKABLE_ATTRIBUTE.has(attribute.name.getText()));
}

function hasPressableDescendant(node: ts.Node): boolean {
  let found = false;
  const visit = (child: ts.Node) => {
    if (found) return;
    if ((ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child)) && pressable(child)) {
      found = true;
      return;
    }
    ts.forEachChild(child, visit);
  };
  ts.forEachChild(node, visit);
  return found;
}

/** The text an element holds itself: its JSX text and the literals written in its expression children. */
function ownText(node: ts.JsxElement): string {
  const parts: string[] = [];
  for (const child of node.children) {
    if (ts.isJsxText(child)) parts.push(child.text);
    else if (ts.isJsxExpression(child) && child.expression) {
      const expression = child.expression;
      if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) parts.push(expression.text);
      else if (ts.isTemplateExpression(expression)) {
        parts.push(expression.head.text);
        for (const span of expression.templateSpans) parts.push(span.literal.text);
      }
    }
  }
  return parts.join("").replace(/\s+/g, " ").trim();
}

export interface Occurrence {
  line: number;
  text: string;
}

/** The grey sentences in a source file that have no action, by line. */
export function scanGreySentences(fileName: string, text: string): Occurrence[] {
  const source = parse(fileName, text);
  const found: Occurrence[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node) && SENTENCE_TAGS.has(tagName(node)) && GREY.test(classText(node))) {
      const own = ownText(node);
      if ((own.match(CJK) ?? []).length >= MIN_CHARACTERS && !hasPressableDescendant(node)) {
        found.push({ line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, text: own.slice(0, 40) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** The hand-written divided lists in a source file, by line. */
export function scanHandwrittenLists(fileName: string, text: string): Occurrence[] {
  const source = parse(fileName, text);
  const found: Occurrence[] = [];
  const visit = (node: ts.Node) => {
    if ((ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) && LIST_TAGS.has(tagName(node)) && DIVIDED.test(classText(node))) {
      found.push({ line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, text: tagName(node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}
