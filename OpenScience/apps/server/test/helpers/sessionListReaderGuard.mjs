import ts from "typescript";

/**
 * Follow session/list response expressions to the canonical reader, through
 * the callers' await/catch/deadline wrappers and local aliases. Symbols keep
 * same-named bindings in different scopes separate. Unknown uses fail closed.
 * This is a test guard for this boundary, not a general JavaScript dataflow tool.
 * @param {string} text @param {string} [filename]
 */
export function inspectSessionListReaders(text, filename = "caller.mjs") {
  const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const host = ts.createCompilerHost({ allowJs: true, noLib: true });
  host.getSourceFile = name => name === filename ? source : undefined;
  const program = ts.createProgram([filename], { allowJs: true, noLib: true, noResolve: true }, host);
  const checker = program.getTypeChecker();
  const nodes = [];
  const collect = node => { nodes.push(node); ts.forEachChild(node, collect); };
  collect(source);
  const calls = nodes.filter(node => ts.isCallExpression(node)
    && node.arguments.some(argument => ts.isStringLiteralLike(argument) && argument.text === "session/list"));
  const issues = [];
  const nameOf = expression => ts.isIdentifier(expression) ? expression.text
    : ts.isPropertyAccessExpression(expression) ? expression.name.text : null;
  const isCanonicalReader = expression => ts.isIdentifier(expression)
    && checker.getSymbolAtLocation(expression)?.declarations?.some(declaration => ts.isImportSpecifier(declaration)
      && (declaration.propertyName ?? declaration.name).text === "sessionListItems"
      && ts.isImportDeclaration(declaration.parent.parent.parent)
      && declaration.parent.parent.parent.moduleSpecifier.text === "./dshRuntimeAdapter.mjs");
  for (const call of calls) {
    const seen = new Set();
    const pending = [call];
    let readers = 0;
    const fail = (node, reason) => issues.push(`${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}: ${reason}`);
    const binding = name => {
      if (ts.isIdentifier(name)) {
        const symbol = checker.getSymbolAtLocation(name);
        if (!symbol) { fail(name, "unresolved response binding"); return; }
        for (const node of nodes) {
          if (node !== name && ts.isIdentifier(node) && checker.getSymbolAtLocation(node) === symbol) pending.push(node);
        }
      } else if (ts.isObjectBindingPattern(name)) {
        for (const element of name.elements) {
          const key = element.propertyName ?? element.name;
          if (ts.isComputedPropertyName(key)) fail(element, "computed response binding; use sessionListItems");
          else if ((ts.isIdentifier(key) || ts.isStringLiteralLike(key)) && key.text === "items") fail(element, "raw response.items binding; use sessionListItems");
          else binding(element.name);
        }
      } else fail(name, "unsupported response binding; use sessionListItems");
    };
    while (pending.length) {
      const node = pending.pop();
      if (seen.has(node)) continue;
      seen.add(node);
      const parent = node.parent;
      if (!parent) { fail(node, "unconsumed session/list response"); continue; }
      if (ts.isAwaitExpression(parent) || ts.isParenthesizedExpression(parent) || ts.isConditionalExpression(parent)) pending.push(parent);
      else if (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) {
        const key = ts.isPropertyAccessExpression(parent) ? parent.name.text
          : ts.isStringLiteralLike(parent.argumentExpression) ? parent.argumentExpression.text : undefined;
        if (key === "items") fail(parent, "raw response.items access; use sessionListItems");
        else if (ts.isElementAccessExpression(parent) && key === undefined) fail(parent, "dynamic response property; use sessionListItems");
        else pending.push(parent);
      } else if (ts.isCallExpression(parent)) {
        const name = nameOf(parent.expression);
        if (isCanonicalReader(parent.expression) && parent.arguments.length === 1 && parent.arguments[0] === node) readers++;
        else if ((name === "catch" && parent.expression === node)
          || (name === "withRuntimeDeadline" && parent.arguments.includes(node))) pending.push(parent);
        else fail(parent, "unsupported response call; use sessionListItems");
      } else if (ts.isArrowFunction(parent) && parent.body === node && ts.isCallExpression(parent.parent)
        && nameOf(parent.parent.expression) === "withRuntimeDeadline") pending.push(parent);
      else if (ts.isVariableDeclaration(parent) && parent.initializer === node) binding(parent.name);
      else fail(parent, "unsupported session/list response use; use sessionListItems");
    }
    if (!readers) fail(call, "session/list response has no sessionListItems reader");
  }
  return { calls: calls.length, issues: [...new Set(issues)] };
}
