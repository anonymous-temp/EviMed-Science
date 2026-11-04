import { validateRequirement } from "@evimed/domain";

// A deliberately narrow signal: an explicit mathematical operator followed by
// a numeric literal. Numbered lists, identifiers and stage labels alone do not
// trigger it. This does not interpret the measurement, unit or comparator.
const NUMERIC_COMPARISON = /(?<![-=<>])(?:<=|>=|<|>|≤|≥|=)\s*[+−-]?(?:\d+(?:\.\d+)?|\.\d+)/u;

/** Called only after grammar validation has bounded the tree. @param {any} node @returns {boolean} */
function presenceOnly(node) {
  if (node.window != null) return false;
  if (node.op === "present" || node.op === "absent") return true;
  if (node.op === "not") return presenceOnly(node.operand);
  if (node.op === "all" || node.op === "any") return node.operands.every(presenceOnly);
  return false;
}

/**
 * Flag one representation worth reviewing, without deciding source-to-rule
 * equivalence. A categorical concept may itself encode a numeric definition.
 * Mixed numeric, temporal and language rules are outside this warning's scope.
 * @param {{sourceText?: unknown, requirement?: any, applicability?: any}} criterion
 * @returns {Array<{field: string, code: string, message: string}>}
 */
export function criterionFidelityWarnings(criterion) {
  if (typeof criterion?.sourceText !== "string" || !NUMERIC_COMPARISON.test(criterion.sourceText.normalize("NFKC"))) return [];
  const nodes = [criterion.requirement, criterion.applicability].filter(node => node != null);
  if (criterion.requirement == null || nodes.some(node => validateRequirement(node).length || !presenceOnly(node))) return [];
  return [{
    field: "sourceText",
    code: "numeric_threshold_requires_review",
    message: "原文含明确数值比较，规则仅含有/无判断。请复核数值门槛是否完整保留；此提示需要结合原文判断。",
  }];
}
