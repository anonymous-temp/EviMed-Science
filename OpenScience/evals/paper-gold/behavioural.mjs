/**
 * Behavioural checks for a built tool: inputs the evaluator derives itself, at evaluation time, from
 * the hidden reference cases.
 *
 * Why this exists. The defence against a builder that hard-codes answers used to be a static scan that
 * looked for assignment targets named `expected_value`, `gold_answer` and the like. A name cannot decide
 * this: a lookup table keyed by the input tuple passed it, and an honest net-benefit implementation
 * with an intermediate called `expected_value_treat` was refused. Whether code computes or recites is a
 * property of what it does on inputs it has not seen, so that is what is tested here:
 *
 *  - metamorphic relations: a transformed input whose correct output is known from the output on the
 *    original input, with no reference number needed (rescale a unit and a cost scales with it, reorder
 *    the states and nothing changes, rename a strategy and its result moves with the name, swap two arms
 *    and a difference changes sign or a ratio inverts, duplicate a dataset and an estimate stays put);
 *  - fresh cases: the hidden input perturbed into a new valid input, scored against an executable
 *    reference implementation the candidate never saw.
 *
 * A table of memorised answers has no entry for any of these. A real implementation passes all of them.
 *
 * The derived inputs are drawn from a generator seeded by the frozen definition (hidden from the
 * builder), the candidate's own bytes and the purpose of the evaluation. So a repair round never meets
 * the inputs of the round before it, and the sudden-perfect review draws inputs the ordinary evaluation
 * did not use. Nothing here is returned to the builder but a pass or a fail.
 *
 * Everything in this file is pure and deterministic; running candidates and references is the caller's.
 */
import { createHash } from "node:crypto";

/** How many fresh cases each hidden case contributes when an executable reference exists. */
export const BEHAVIOUR_LIMITS = Object.freeze({ freshPerCase: 3, freshAttempts: 12, relativeTolerance: 1e-6, absoluteTolerance: 1e-9 });

export const RELATION_KINDS = Object.freeze(["scale", "permute", "relabel", "swap", "duplicate"]);
const OUTPUT_TRANSFORMS = Object.freeze(["invariant", "negate", "reciprocal", "complement"]);

/** @param {string} seed */
export function seededRandom(seed) {
  let counter = 0;
  const next = () => (createHash("sha256").update(`${seed}:${counter++}`).digest().readUIntBE(0, 6) + 0.5) / 2 ** 48;
  const api = {
    next,
    /** @param {number} low @param {number} high */
    between: (low, high) => low + (high - low) * next(),
    /** @param {number} low @param {number} high inclusive */
    integer: (low, high) => low + Math.floor(next() * (high - low + 1)),
    /** A permutation of 0..n-1 that is not the identity whenever one exists. @param {number} n */
    permutation(n) {
      const order = Array.from({ length: n }, (_, index) => index);
      for (let index = n - 1; index > 0; index--) { const other = api.integer(0, index); [order[index], order[other]] = [order[other], order[index]]; }
      if (n > 1 && order.every((value, index) => value === index)) [order[0], order[1]] = [order[1], order[0]];
      return order;
    },
  };
  return api;
}

const isNumber = value => typeof value === "number" && Number.isFinite(value);
const significant = (value, digits = 6) => Number(Number(value).toPrecision(digits));
const clone = value => structuredClone(value);

/** Concrete paths of `pattern` in `value`; `*` stands for every key of an object or index of an array.
 * @param {any} value @param {string} pattern @returns {string[][]} */
export function expandPath(value, pattern) {
  let paths = [[]];
  for (const segment of pattern === "" ? [] : pattern.split(".")) {
    const next = [];
    for (const prefix of paths) {
      const node = prefix.reduce((current, key) => current?.[key], value);
      if (node === null || typeof node !== "object") continue;
      if (segment === "*") for (const key of Array.isArray(node) ? node.keys() : Object.keys(node)) next.push([...prefix, String(key)]);
      else if (Object.hasOwn(node, segment)) next.push([...prefix, segment]);
    }
    paths = next;
  }
  return paths;
}
const read = (value, path) => path.reduce((current, key) => current?.[key], value);
function write(value, path, replacement) {
  const parent = path.slice(0, -1).reduce((current, key) => current[key], value);
  parent[path.at(-1)] = replacement;
}
/** Every numeric leaf under a node, as [path, number]. @param {any} node @param {string[]} [prefix] @returns {[string[], number][]} */
export function numericLeaves(node, prefix = []) {
  if (isNumber(node)) return [[prefix, node]];
  if (node === null || typeof node !== "object") return [];
  return Object.entries(node).flatMap(([key, child]) => numericLeaves(child, [...prefix, key]));
}

/** @param {number} actual @param {number} expected */
export function behaviourallyEqual(actual, expected) {
  return isNumber(actual) && isNumber(expected) && Math.abs(actual - expected) <= BEHAVIOUR_LIMITS.absoluteTolerance + BEHAVIOUR_LIMITS.relativeTolerance * Math.abs(expected);
}

/** A relation is data from a closed vocabulary; anything else is refused before it can be applied. @param {any} relation */
export function relationIssues(relation) {
  const issues = [];
  const patterns = value => Array.isArray(value) && value.length > 0 && value.every(item => typeof item === "string");
  const outputs = (value, allowed) => value && typeof value === "object" && Object.keys(value).length > 0 && Object.values(value).every(allowed);
  if (!relation || !RELATION_KINDS.includes(relation.kind)) return ["relation_kind_unknown"];
  if (relation.kind === "scale" && !(patterns(relation.inputs) && outputs(relation.outputs, isNumber))) issues.push("relation_scale_invalid");
  if (relation.kind === "duplicate" && !(patterns(relation.arrays) && outputs(relation.outputs, isNumber))) issues.push("relation_duplicate_invalid");
  if (relation.kind === "permute" && !(Array.isArray(relation.arrays) && relation.arrays.length > 0 && relation.arrays.every(item => typeof item?.path === "string" && Array.isArray(item.axes) && item.axes.every(axis => axis === 0 || axis === 1)))) issues.push("relation_permute_invalid");
  if (relation.kind === "relabel" && !(typeof relation.input === "string" && typeof relation.output === "string")) issues.push("relation_relabel_invalid");
  if (relation.kind === "swap" && !(Array.isArray(relation.pairs) && relation.pairs.length > 0 && relation.pairs.every(pair => Array.isArray(pair) && pair.length === 2 && pair.every(item => typeof item === "string")) && outputs(relation.outputs, value => OUTPUT_TRANSFORMS.includes(value)))) issues.push("relation_swap_invalid");
  return issues;
}

/**
 * Apply one relation to one hidden input.
 * @param {any} relation @param {any} input @param {ReturnType<typeof seededRandom>} random
 * @returns {{input:any, check:(base:any, output:any)=>boolean}|null} null when the relation does not apply to this input
 */
export function applyRelation(relation, input, random) {
  if (relationIssues(relation).length) return null;
  const transformed = clone(input);
  /** @param {Record<string, number>} outputs @param {number} factor */
  const powerCheck = (outputs, factor) => (base, output) => {
    let checked = 0;
    for (const [pattern, power] of Object.entries(outputs)) for (const path of expandPath(base, pattern)) {
      for (const [leaf, value] of numericLeaves(read(base, path), path)) { checked++; if (!behaviourallyEqual(read(output, leaf), value * factor ** power)) return false; }
    }
    return checked > 0;
  };
  if (relation.kind === "scale") {
    const factor = relation.factor === "integer" ? random.integer(2, 7) : significant(random.next() < 0.5 ? random.between(1.7, 4.3) : 1 / random.between(1.7, 4.3), 4);
    let scaled = 0;
    for (const pattern of relation.inputs) for (const path of expandPath(transformed, pattern)) for (const [leaf, value] of numericLeaves(read(transformed, path), path)) { write(transformed, leaf, value * factor); if (value !== 0) scaled++; }
    return scaled ? { input: transformed, check: powerCheck(relation.outputs, factor) } : null;
  }
  if (relation.kind === "duplicate") {
    let duplicated = 0;
    for (const pattern of relation.arrays) for (const path of expandPath(transformed, pattern)) { const rows = read(transformed, path); if (Array.isArray(rows) && rows.length) { write(transformed, path, [...rows, ...clone(rows)]); duplicated++; } }
    return duplicated ? { input: transformed, check: powerCheck(relation.outputs, 2) } : null;
  }
  if (relation.kind === "permute") {
    let order = null, permuted = 0;
    for (const item of relation.arrays) for (const path of expandPath(transformed, item.path)) {
      const rows = read(transformed, path);
      if (!Array.isArray(rows) || rows.length < 2) continue;
      order ??= random.permutation(rows.length);
      if (order.length !== rows.length) return null;
      let next = item.axes.includes(0) ? order.map(index => rows[index]) : rows;
      if (item.axes.includes(1)) { if (next.some(row => !Array.isArray(row) || row.length !== order.length)) return null; next = next.map(row => order.map(index => row[index])); }
      write(transformed, path, next); permuted++;
    }
    return permuted ? { input: transformed, check: (base, output) => { const leaves = numericLeaves(base); return leaves.length > 0 && leaves.every(([leaf, value]) => behaviourallyEqual(read(output, leaf), value)); } } : null;
  }
  if (relation.kind === "relabel") {
    const [path] = expandPath(transformed, relation.input);
    const labelled = path && read(transformed, path);
    if (!labelled || typeof labelled !== "object" || Array.isArray(labelled) || !Object.keys(labelled).length) return null;
    const names = Object.fromEntries(Object.keys(labelled).map(key => [key, `label_${createHash("sha256").update(`${random.next()}:${key}`).digest("hex").slice(0, 10)}`]));
    write(transformed, path, Object.fromEntries(Object.entries(labelled).map(([key, value]) => [names[key], value])));
    return { input: transformed, check: (base, output) => {
      const before = read(base, relation.output === "" ? [] : relation.output.split(".")), after = read(output, relation.output === "" ? [] : relation.output.split("."));
      if (!before || !after || typeof before !== "object" || typeof after !== "object") return false;
      return Object.keys(names).every(key => { const leaves = numericLeaves(before[key]); return leaves.length > 0 && leaves.every(([leaf, value]) => behaviourallyEqual(read(after[names[key]], leaf), value)); })
        && Object.keys(after).length === Object.keys(before).length;
    } };
  }
  // swap
  for (const [left, right] of relation.pairs) {
    const [a] = expandPath(transformed, left), [b] = expandPath(transformed, right);
    if (!a || !b) return null;
    const held = read(transformed, a); write(transformed, a, read(transformed, b)); write(transformed, b, held);
  }
  if (JSON.stringify(transformed) === JSON.stringify(input)) return null;
  return { input: transformed, check: (base, output) => {
    let checked = 0;
    for (const [pattern, transform] of Object.entries(relation.outputs)) for (const path of expandPath(base, pattern)) for (const [leaf, value] of numericLeaves(read(base, path), path)) {
      const expected = transform === "negate" ? -value : transform === "reciprocal" ? 1 / value : transform === "complement" ? 1 - value : value;
      checked++; if (!behaviourallyEqual(read(output, leaf), expected)) return false;
    }
    return checked > 0;
  } };
}

/**
 * A new input for a method the evaluator knows nothing about: every numeric leaf moved, its type kept
 * (an integer stays an integer, a proportion stays a proportion). Whether the result is a valid input
 * is not decided here: the reference implementation is run on it, and an input the reference refuses
 * is discarded.
 * @param {any} input @param {ReturnType<typeof seededRandom>} random
 */
export function genericFreshInput(input, random) {
  const fresh = clone(input);
  for (const [path, value] of numericLeaves(fresh)) {
    let next = value;
    if (Number.isInteger(value)) { if (Math.abs(value) >= 2) { next = Math.max(1, Math.round(Math.abs(value) * random.between(0.6, 1.6))) * Math.sign(value); if (next === value) next = value + Math.sign(value); } }
    else if (value > 0 && value < 1) next = significant(1 / (1 + Math.exp(-(Math.log(value / (1 - value)) + random.between(-0.8, 0.8)))));
    else next = significant(value * random.between(0.6, 1.6));
    write(fresh, path, next);
  }
  return fresh;
}

/* ------------------------------------------------------------------ the three families shipped today */

/** Cohort state-transition flow rewards, exactly as the public development contract states it. @param {any} input */
function cohortFlowReference(input) {
  const specification = input.specification, result = {};
  for (const [name, strategy] of Object.entries(specification.strategies)) {
    let occupancy = specification.initial, cost = 0, qaly = 0;
    occupancy.forEach((mass, state) => { cost += specification.costWeights[0] * mass * strategy.costRewards[state][state]; qaly += specification.utilityWeights[0] * mass * strategy.utilityRewards[state][state]; });
    strategy.transitionMatrices.forEach((matrix, cycle) => {
      const next = occupancy.map(() => 0);
      occupancy.forEach((mass, origin) => matrix[origin].forEach((probability, destination) => {
        const flow = mass * probability;
        next[destination] += flow;
        cost += specification.costWeights[cycle + 1] * flow * strategy.costRewards[origin][destination];
        qaly += specification.utilityWeights[cycle + 1] * flow * strategy.utilityRewards[origin][destination];
      }));
      occupancy = next;
    });
    result[`${name}.cost`] = cost; result[`${name}.qaly`] = qaly;
  }
  return result;
}
/** @param {any} input @param {ReturnType<typeof seededRandom>} random */
function cohortFresh(input, random) {
  const fresh = clone(input), specification = fresh.specification;
  specification.initial = specification.initial.map(mass => significant(mass * random.between(0.4, 2.5) + random.between(0, 0.2)));
  const jitter = (matrix, low, high) => matrix.map(row => row.map(value => significant(value * random.between(low, high))));
  for (const strategy of Object.values(specification.strategies)) {
    strategy.costRewards = jitter(strategy.costRewards, 0.5, 1.5);
    strategy.utilityRewards = jitter(strategy.utilityRewards, 0.5, 1.5);
    // A convex mix with a random stochastic row is again a stochastic row.
    strategy.transitionMatrices = strategy.transitionMatrices.map(matrix => matrix.map(row => {
      const other = row.map(() => random.next()), total = other.reduce((sum, value) => sum + value, 0), weight = random.between(0.05, 0.3);
      const mixed = row.map((value, index) => (1 - weight) * value + weight * other[index] / total), sum = mixed.reduce((a, b) => a + b, 0);
      return mixed.map(value => value / sum);
    }));
  }
  specification.costWeights = specification.costWeights.map(weight => significant(weight * random.between(0.7, 1.3)));
  specification.utilityWeights = specification.utilityWeights.map(weight => significant(weight * random.between(0.7, 1.3)));
  return fresh;
}
const COHORT_STATE_ARRAYS = [
  { path: "specification.initial", axes: [0] },
  { path: "specification.strategies.*.transitionMatrices.*", axes: [0, 1] },
  { path: "specification.strategies.*.costRewards", axes: [0, 1] },
  { path: "specification.strategies.*.utilityRewards", axes: [0, 1] },
];

/** @param {any} input */
function diagnosticPosteriorReference(input) {
  const specification = input.specification, result = {};
  const odds = Object.hasOwn(specification, "priorOdds") ? specification.priorOdds : specification.priorProbability / (1 - specification.priorProbability);
  for (const [label, ratio] of Object.entries(specification.likelihoodRatios)) {
    const posterior = odds * ratio;
    result[`results.${label}.posteriorOdds`] = posterior; result[`results.${label}.posteriorProbability`] = posterior / (1 + posterior);
  }
  return result;
}
/** @param {any} input @param {ReturnType<typeof seededRandom>} random */
function diagnosticPosteriorFresh(input, random) {
  const fresh = clone(input), specification = fresh.specification;
  if (Object.hasOwn(specification, "priorOdds")) specification.priorOdds = significant(random.between(0.02, 3), 4);
  else specification.priorProbability = significant(random.between(0.01, 0.7), 4);
  for (const label of Object.keys(specification.likelihoodRatios)) specification.likelihoodRatios[label] = significant(specification.likelihoodRatios[label] * random.between(0.4, 2.5), 4);
  return fresh;
}

/** @param {any} input */
function decisionNetBenefitReference(input) {
  const { n, truePositive, falsePositive, eventCount, threshold } = input.specification;
  const odds = threshold / (1 - threshold), prevalence = eventCount / n;
  const netBenefit = (truePositive - odds * falsePositive) / n, treatAll = prevalence - (1 - prevalence) * odds;
  return { netBenefit, treatAll, treatNone: 0, netReductionPer100: 100 * (netBenefit - treatAll) / odds };
}
/** @param {any} input @param {ReturnType<typeof seededRandom>} random */
function decisionNetBenefitFresh(input, random) {
  const fresh = clone(input), n = random.integer(60, 6000), eventCount = random.integer(1, n - 1);
  Object.assign(fresh.specification, { n, eventCount, truePositive: random.integer(0, eventCount), falsePositive: random.integer(0, n - eventCount), threshold: significant(random.between(0.03, 0.6), 3) });
  return fresh;
}

/**
 * What the evaluator knows about each method family that has shipped. A family's relations are facts of
 * its mathematics (a cost is linear in the cost rewards; a posterior odds is linear in the likelihood
 * ratio; a net benefit depends on counts only through their ratios), and its reference is the public
 * formula of its development contract, written by the evaluator and never shown to a builder.
 */
export const BEHAVIOUR_FAMILIES = Object.freeze({
  "cohort-state-transition": {
    reference: cohortFlowReference, fresh: cohortFresh,
    relations: [
      { kind: "scale", inputs: ["specification.initial"], outputs: { "*.cost": 1, "*.qaly": 1 } },
      { kind: "scale", inputs: ["specification.strategies.*.costRewards"], outputs: { "*.cost": 1, "*.qaly": 0 } },
      { kind: "scale", inputs: ["specification.utilityWeights"], outputs: { "*.cost": 0, "*.qaly": 1 } },
      { kind: "permute", arrays: COHORT_STATE_ARRAYS },
      { kind: "relabel", input: "specification.strategies", output: "" },
    ],
  },
  "diagnostic-posterior": {
    reference: diagnosticPosteriorReference, fresh: diagnosticPosteriorFresh,
    relations: [
      { kind: "scale", inputs: ["specification.likelihoodRatios"], outputs: { "results.*.posteriorOdds": 1 } },
      { kind: "relabel", input: "specification.likelihoodRatios", output: "results" },
    ],
  },
  "decision-net-benefit": {
    reference: decisionNetBenefitReference, fresh: decisionNetBenefitFresh,
    relations: [
      { kind: "scale", factor: "integer", inputs: ["specification.n", "specification.truePositive", "specification.falsePositive", "specification.eventCount"], outputs: { netBenefit: 0, treatAll: 0, netReductionPer100: 0 } },
    ],
  },
});

/**
 * What can be tested for one method.
 * @param {{methodId:string, methodFamily?:string|null, definition?:any}} request
 * @returns {{relations:any[], fresh:Function, reference:null|{kind:'evaluator',implementationId:string,run:(input:any)=>Record<string,number>}|{kind:'code',implementationId:string,code:string}}}
 */
export function behaviourPlan({ methodId, methodFamily = null, definition = {} }) {
  const family = BEHAVIOUR_FAMILIES[methodFamily ?? ""] ?? BEHAVIOUR_FAMILIES[definition.methodFamily ?? ""] ?? BEHAVIOUR_FAMILIES[methodId];
  // Relations an operator froze with the cases join the family's own; an invalid one is dropped, not applied.
  const declared = (Array.isArray(definition.relations) ? definition.relations : []).filter(relation => relationIssues(relation).length === 0);
  const frozen = definition.referenceImplementation;
  const reference = family ? { kind: /** @type {const} */ ("evaluator"), implementationId: `evaluator-reference:${methodFamily ?? definition.methodFamily ?? methodId}`, run: family.reference }
    : frozen && frozen.language === "python" && typeof frozen.code === "string" && frozen.code.length > 0 && typeof frozen.implementationId === "string"
      ? { kind: /** @type {const} */ ("code"), implementationId: frozen.implementationId, code: frozen.code } : null;
  return { relations: [...(family?.relations ?? []), ...declared], fresh: family?.fresh ?? genericFreshInput, reference };
}

/**
 * The derived inputs for one hidden case: one per applicable relation, plus candidates for fresh cases.
 * @param {ReturnType<typeof behaviourPlan>} plan @param {any} input @param {string} seed
 */
export function deriveBehaviouralInputs(plan, input, seed) {
  const relations = [];
  plan.relations.forEach((relation, index) => {
    const applied = applyRelation(relation, input, seededRandom(`${seed}:relation:${index}`));
    if (applied) relations.push({ id: `relation-${index}-${relation.kind}`, ...applied });
  });
  const fresh = [];
  if (plan.reference) for (let attempt = 0; attempt < BEHAVIOUR_LIMITS.freshAttempts; attempt++) {
    const candidate = plan.fresh(input, seededRandom(`${seed}:fresh:${attempt}`));
    if (JSON.stringify(candidate) !== JSON.stringify(input)) fresh.push({ id: `fresh-${attempt}`, input: candidate });
  }
  return { relations, fresh };
}

/**
 * Compare a candidate's output on a fresh input with the reference's, over every number the reference produced.
 * @param {any} output @param {Record<string, number>} reference @param {(key:string)=>string} [outputPath]
 */
export function freshCaseAgrees(output, reference, outputPath = key => key) {
  const entries = Object.entries(reference ?? {});
  return entries.length > 0 && entries.every(([key, expected]) => behaviourallyEqual(read(output, outputPath(key).split(".")), expected));
}

/** Whether two reference outputs differ anywhere: a fresh input that changes nothing tests nothing.
 * @param {Record<string, number>} left @param {Record<string, number>} right */
export function referenceOutputsDiffer(left, right) {
  return Object.keys({ ...left, ...right }).some(key => !behaviourallyEqual(left?.[key], right?.[key]));
}
