import ts from "typescript";

/**
 * What `layoutRules.test.ts` measures, as functions of a source text, so the test can prove the scan sees a violation before it
 * trusts a count of none (R19, plan §3 S3, audit D C3 and C5).
 *
 *  - **A grey sentence written by hand**: a `<p>`, `<span>`, `<div>` or `<li>` whose own text — JSX text, a string literal or a
 *    template in an expression — holds at least 14 Chinese characters, whose classes include the grey text colours
 *    (`text-text-2`, `text-text-3`, `text-muted`), and that has no clickable descendant. Such a sentence has no action and no
 *    number to open: by the plan's rule 4 it is a back-office line or a sentence for `Note`. A small, individually reviewed
 *    registry preserves state and scope information; a role alone does not grant an exception.
 *    Sentences kept in a variable or a
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

/** Each exception names the actual state, its location and behavioral test, not just a styling or ARIA role. */
export const reviewedGreyStatusExceptions = [
  { file: "app/extensions/SkillImport.tsx", id: "ordinary-import-recovery", role: "note", text: "恢复上次确认：。继续时先核查已保存结果；若尚未保存，将按原确认执行导入。", reason: "Identifies the exact unresolved import before a deliberate retry.", test: "app/extensions/SkillImport.test.tsx" },
  { file: "app/extensions/SkillImport.tsx", id: "ordinary-import-unknown", role: "status", text: "继续时使用原确认记录核查；不会创建第二份技能。刷新或返回后，可在当前账户与项目的“待核查的普通导入”继续。上传资源过期或无权读取时，请先人工核查已添加列表。", reason: "Explains an unknown mutation outcome and safe recovery.", test: "app/extensions/SkillImport.test.tsx" },
  { file: "app/extensions/SkillImport.tsx", id: "transfer-scope", role: "note", text: "迁移技能内容、资源和历史版本。账户数据中的角色、连接和启用设置不会导入。", reason: "States what the account transfer excludes before confirmation.", test: "app/extensions/SkillImport.test.tsx" },
  { file: "app/extensions/SkillImport.tsx", id: "transfer-paused", role: "status", text: "迁移已暂停；继续时会核对同一迁移进度。", reason: "Reports an observed paused state and its continuation.", test: "app/extensions/SkillImport.test.tsx" },
  { file: "app/extensions/SkillImport.tsx", id: "transfer-unknown", role: "note", text: "未确认的请求可以使用本页原确认记录继续核查。返回后请读取“未完成的技能迁移”；只有服务器保存的记录才可恢复。尚未收到回执时，不能确认迁移记录已保存。", reason: "Distinguishes an unknown receipt from a durable recovery record.", test: "app/extensions/SkillImport.test.tsx" },
  { file: "app/routes/MemoryOverviewPage.tsx", id: "memory-growth-failed", role: "status", text: "部分来源暂未读到，暂不汇总变化。", reason: "Preserves an independent source failure without inventing totals.", test: "app/routes/MemoryOverviewPage.test.tsx" },
  { file: "components/geo/GeoQuestionWorkbench.tsx", id: "geo-pending-save", role: "status", text: "发现上次尚未确认的保存记录。当前草稿已保留；核查该记录前不能提交新的保存。", reason: "Explains why a new save is held while an earlier intent is checked.", test: "components/geo/GeoQuestionWorkbench.test.tsx" },
  { file: "components/memory/overview/GrowthCard.tsx", id: "memory-growth-partial", role: "status", text: "仅显示已读取的变化，其他来源尚未完整读取。", reason: "Labels partial history while retaining the records actually read.", test: "app/routes/MemoryOverviewPage.test.tsx" },
  { file: "components/memory/overview/GrowthCard.tsx", id: "memory-growth-recent", role: "note", text: "已显示最近 项，更多变化可在地图里查看。", reason: "Labels the limited recent-history preview; the map link is in its header.", test: "app/routes/MemoryOverviewPage.test.tsx" },
] as const;

function literalAttribute(node: ts.JsxElement, name: string): string | null {
  const attribute = attributesOf(node).properties.find(value => ts.isJsxAttribute(value) && value.name.getText() === name);
  return attribute && ts.isJsxAttribute(attribute) && attribute.initializer && ts.isStringLiteral(attribute.initializer) ? attribute.initializer.text : null;
}

function isReviewedStatusOrNote(fileName: string, node: ts.JsxElement, text: string): boolean {
  const path = fileName.replace(/\\/g, "/");
  return reviewedGreyStatusExceptions.some(entry => (path === entry.file || path.endsWith(`/src/${entry.file}`) || path === `src/${entry.file}`)
    && literalAttribute(node, "data-layout-exception") === entry.id && literalAttribute(node, "role") === entry.role && text === entry.text);
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
      if ((own.match(CJK) ?? []).length >= MIN_CHARACTERS && !hasPressableDescendant(node) && !isReviewedStatusOrNote(fileName, node, own)) {
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
