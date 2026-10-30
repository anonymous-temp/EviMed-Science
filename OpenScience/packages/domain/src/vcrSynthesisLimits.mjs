/**
 * What an empirical synthesis (`population.synthpop`) can finish inside a job's CPU budget, and the sentence that says so before the
 * job is queued (2026-10-31).
 *
 * The scenario advertised `m` from 1 and a table of any size; the engine refuses fewer than five copies, and a full-feature synthesis
 * of a 12,000-stay intensive-care table (PhysioNet 2012) ran out of CPU budget with no table and no partial result. The synthesis
 * is synthpop's sequential CART: each variable is modelled on the variables before it, once per copy, and the copies are made one
 * after another inside one R process whose budget is the job's `cpuSecondsLimit`. Nothing about the table's size is limited by
 * the engine itself; the budget is the limit, and the budget is known before the job is queued.
 *
 * Hidden knowledge:
 *
 * - **The cost is measured, not guessed.** `VCR_SYNTHPOP_COST` is a fit of the CPU seconds the engine's own job runner used on
 *   synthetic tables of the shape intensive-care baselines have (continuous, count and 0/1 columns), across rows, columns and
 *   copies, on the engine's R and package lock (`项目代码/vcr-engine/scripts/measure-synthpop-cost.R` runs the measurement and lists the
 *   seconds it found); its basis is written beside the numbers. It is an estimate for numeric, count and
 *   binary columns; a text column with many levels costs more and is not in it, so the estimate is the cost of the table at its
 *   cheapest and a table it refuses is one the engine could not have finished either.
 * - **The budget is the engine's, not the job's.** The R side stops at 90 % of the smaller of the job's `cpuSecondsLimit` and the
 *   engine's own ceiling (`VCR_ENGINE_CPU_LIMIT`, 3600 s by default) and a job that stops there is failed with no table: the copies
 *   already made are discarded. So the whole job is refused up front rather than most of it run and lost.
 * - **The host that measured is not the host that runs.** The estimate is multiplied by a margin before it is held against the
 *   budget, so a job is refused only when it would not finish with that much to spare.
 * - **No row is dropped on the caller's behalf.** The engine has no sampling parameter and the queue does not subsample: the sentence
 *   names the three things a person can change (the number of columns, the rows, the copies) and the budget they can raise, and
 *   what it asks for of each.
 *
 * @module @evimed/domain/vcrSynthesisLimits
 */

/** @template T @param {T} value @returns {Readonly<T>} */
const frozen = (value) => Object.freeze(value)

/** How many synthetic copies a synthesis makes: inference on synthetic data needs several, and the engine refuses fewer and more. */
export const VCR_SYNTHPOP_COPIES = frozen({ min: 5, max: 50 })

/** The engine's own ceiling on any job's CPU limit (`VCR_ENGINE_MAX_CPU_SECONDS`), and the share of the limit R stops at. */
export const VCR_ENGINE_CPU_CEILING_SECONDS = 3600
export const VCR_ENGINE_CPU_STOP_SHARE = 0.9

/**
 * CPU seconds ≈ `fixedSeconds` + copies/5 × ( `perRowColumnSquared`·n·p² + `perRowColumn`·n·p + `perRowPairwise`·S·n·k·min(1.6n, k)
 * + `perRowRowColumn`·n²·p ), with n the table's rows (before the holdout is taken: the holdout only makes it cheaper), p the columns
 * the synthesis learns from (the subject key is not one), k = p(p+1)/2 the parameters of the quality score's all-pairs logistic model
 * and S the saturation factor below. The terms are the costs that grow: each copy models every variable on the ones before it
 * (n·p²), each copy is scored by a logistic regression on every pair of variables, fitted once and five more times for its
 * cross-validated AUC (n·k·min(1.6n, k): the work of a least-squares fit is the rows times the columns times the smaller of the two),
 * and by nearest-neighbour distances from every held-out row to every training row over every column (n²·p).
 */
export const VCR_SYNTHPOP_COST = frozen({
  basis: 'Weighted least squares on relative error over 17 synthetic tables of continuous, count and 0/1 columns: 500 to 12,000 rows, '
    + '10 to 50 columns, 5 and 10 copies, one core of the engine host class, R 4.3.3 with synthpop 1.9-3 (the engine lock), measured through '
    + 'the engine\'s own job runner (2026-10-31). Leave-one-out, the predicted over the measured seconds lies between 0.75 and 1.18; '
    + 'the margin below is the reciprocal of the lowest (0.75, rounded up).',
  fixedSeconds: 4.837,
  perRowColumnSquared: 4.971e-6,
  perRowColumn: 2.518e-4,
  perRowPairwise: 1.471e-7,
  perRowRowColumn: 1.686e-7,
  /** Held against the budget: the estimate is multiplied by this before it is compared. */
  margin: 1.35,
})

/**
 * How much more the all-pairs logistic fit costs when it has nearly as many parameters as rows (`r` = parameters over the rows of
 * the real and synthetic tables stacked): the fit stops converging and runs to its iteration limit. Measured: ×1 up to r = 0.3 and
 * ×2.3 to ×3.3 from r = 0.5 to 1.6 (a 500-row table of 40 and 50 columns, a 1,000-row table of 40); taken as ×4 from r = 0.6.
 * @param {number} r
 */
function saturation(r) {
  return 1 + 3 * Math.min(1, Math.max(0, (r - 0.3) / 0.3))
}

/**
 * The CPU seconds a synthesis of this table is expected to use on the engine's host.
 * @param {{ rows: number, columns: number, copies?: number }} table
 * @returns {number}
 */
export function vcrSynthpopEstimateSeconds({ rows, columns, copies = VCR_SYNTHPOP_COPIES.min }) {
  const cost = VCR_SYNTHPOP_COST
  const n = Math.max(1, rows)
  const p = Math.max(1, columns)
  const k = p * (p + 1) / 2
  const perCopy = cost.perRowColumnSquared * n * p * p + cost.perRowColumn * n * p
    + cost.perRowPairwise * saturation(k / (1.6 * n)) * n * k * Math.min(1.6 * n, k) + cost.perRowRowColumn * n * n * p
  return cost.fixedSeconds + (copies / VCR_SYNTHPOP_COPIES.min) * perCopy
}

/**
 * The seconds a job can use before R stops it.
 * @param {number} cpuSecondsLimit the job's own limit
 */
export function vcrSynthpopBudgetSeconds(cpuSecondsLimit) {
  return VCR_ENGINE_CPU_STOP_SHARE * Math.min(Math.max(1, cpuSecondsLimit), VCR_ENGINE_CPU_CEILING_SECONDS)
}

/**
 * The largest value of one dimension, up to `high`, at which the synthesis fits the budget with the margin, the others held — found on
 * the model itself, so the sentence and the check can never disagree. The cost is not monotone in the rows (a table with few rows
 * and many columns is costlier than one with more of them: its scoring model saturates), so the binary search is only the first guess
 * and the answer is walked down until it is one the model accepts.
 * @param {(value: number) => number} cost @param {number} budget @param {number} high @returns {number}
 */
function largestThatFits(cost, budget, high) {
  const fits = (/** @type {number} */ value) => cost(value) * VCR_SYNTHPOP_COST.margin <= budget
  let low = 0
  let top = Math.max(1, Math.floor(high))
  while (low < top) {
    const middle = Math.ceil((low + top) / 2)
    if (fits(middle)) low = middle
    else top = middle - 1
  }
  for (let steps = 0; low > 0 && !fits(low) && steps < 400; steps += 1) low = Math.floor(low * 0.97)
  return low > 0 && fits(low) ? low : 0
}

/**
 * Whether a synthesis can finish in the job's budget, and — when it cannot — what to change.
 * @param {{ rows: number, columns: number, copies?: number, cpuSecondsLimit: number, cpuSecondsCeiling?: number }} input
 *   `cpuSecondsCeiling` is the most the platform lets a job ask for (the queue's own ceiling), when it is above the job's limit
 * @returns {{ ok: true } | { ok: false, estimateSeconds: number, budgetSeconds: number, columns: number, rows: number, copies: number,
 *   fits: { columns: number, rows: number, copies: number | null }, raiseTo: number | null, message: string }}
 */
export function vcrSynthpopFeasibility({ rows, columns, copies = VCR_SYNTHPOP_COPIES.min, cpuSecondsLimit, cpuSecondsCeiling }) {
  const budget = vcrSynthpopBudgetSeconds(cpuSecondsLimit)
  const estimate = vcrSynthpopEstimateSeconds({ rows, columns, copies })
  if (estimate * VCR_SYNTHPOP_COST.margin <= budget) return { ok: true }
  const fitsColumns = largestThatFits((value) => vcrSynthpopEstimateSeconds({ rows, columns: value, copies }), budget, columns)
  const fitsRows = largestThatFits((value) => vcrSynthpopEstimateSeconds({ rows: value, columns, copies }), budget, rows)
  const fitsCopies = copies > VCR_SYNTHPOP_COPIES.min
    ? largestThatFits((value) => vcrSynthpopEstimateSeconds({ rows, columns, copies: value }), budget, copies) : 0
  const ceiling = Math.min(cpuSecondsCeiling ?? cpuSecondsLimit, VCR_ENGINE_CPU_CEILING_SECONDS)
  const needed = Math.ceil(estimate * VCR_SYNTHPOP_COST.margin / VCR_ENGINE_CPU_STOP_SHARE)
  const raiseTo = ceiling > cpuSecondsLimit && needed <= ceiling ? needed : null
  /** @type {string[]} */
  const ways = []
  if (fitsColumns >= 1) ways.push(`列数减到 ${fitsColumns} 以内（现在 ${columns} 列；只保留这项分析要用的变量，在字段映射里去掉其余的列再冻结新快照）`)
  if (fitsRows >= 100) ways.push(`行数减到 ${fitsRows} 以内（现在 ${rows} 行；用行数更少的快照，例如单个中心或一段时间）`)
  if (fitsCopies >= VCR_SYNTHPOP_COPIES.min && fitsCopies < copies) ways.push(`份数 m 减到 ${fitsCopies}（最少 ${VCR_SYNTHPOP_COPIES.min}）`)
  if (raiseTo !== null) ways.push(`把计算上限 cpuSecondsLimit 提到 ${raiseTo} 秒（平台允许到 ${ceiling} 秒）`)
  else if (needed <= VCR_ENGINE_CPU_CEILING_SECONDS) ways.push(`平台单次计算的上限现在是 ${Math.round(ceiling)} 秒，这张表需要约 ${needed} 秒；由管理员把上限调到这个数（引擎自己的上限是 ${VCR_ENGINE_CPU_CEILING_SECONDS} 秒）后可以不改表直接算`)
  const beyondEngine = needed > VCR_ENGINE_CPU_CEILING_SECONDS
  const message = `这份表合成不完：${rows} 行 × ${columns} 列 × ${copies} 份，预计要 ${Math.round(estimate)} 秒 CPU（留出余量后按 ${Math.round(estimate * VCR_SYNTHPOP_COST.margin)} 秒算），`
    + `而这项计算的预算是 ${Math.round(budget)} 秒（上限 ${Math.round(cpuSecondsLimit)} 秒的 90%，到点会整体失败、不留任何一份合成表）。没有排队，也没有替你抽样或删列。`
    + (ways.length ? `可以改其中一项：${ways.join('；')}。` : '换一张列和行都更少的表。')
    + (beyondEngine ? `这张表按现在的大小，引擎自己的最大预算（${VCR_ENGINE_CPU_CEILING_SECONDS} 秒）也合成不完，提高上限没有用。` : '')
  return { ok: false, estimateSeconds: estimate, budgetSeconds: budget, columns, rows, copies,
    fits: { columns: fitsColumns, rows: fitsRows, copies: fitsCopies >= VCR_SYNTHPOP_COPIES.min ? fitsCopies : null }, raiseTo, message }
}

/**
 * The sentences the method's help carries about what it can finish, with the sizes worked out from the model itself.
 * @returns {string[]}
 */
export function vcrSynthpopHelpNotes() {
  const budget = vcrSynthpopBudgetSeconds(600)
  /** @param {number} rows */
  const widest = (rows) => largestThatFits((columns) => vcrSynthpopEstimateSeconds({ rows, columns, copies: VCR_SYNTHPOP_COPIES.min }), budget, 400)
  return [
    `m is the number of synthetic copies, ${VCR_SYNTHPOP_COPIES.min} to ${VCR_SYNTHPOP_COPIES.max}: fewer than ${VCR_SYNTHPOP_COPIES.min} cannot support inference on synthetic data and the engine refuses them. Every copy costs the same again.`,
    `Size limit. The copies and their quality scores are made in one R process whose CPU budget is the job's cpuSecondsLimit (the platform's default is 600 s, of which ${Math.round(VCR_ENGINE_CPU_STOP_SHARE * 100)}% can be used); a job that reaches it fails with no table and no copy kept. The cost grows with the square of the columns for the copies, with the fourth power for the quality score (a logistic model of every pair of columns) and with the square of the rows for its nearest-neighbour check, so a wide table is the expensive one, not a long one. The queue estimates the CPU seconds from the table it will read (rows × columns × m, the subject key not counted) and refuses before queueing a synthesis estimated, with a ${VCR_SYNTHPOP_COST.margin}× margin, to exceed the budget.`,
    `At the default budget and ${VCR_SYNTHPOP_COPIES.min} copies the model allows about ${widest(1000)} columns at 1,000 rows, ${widest(4000)} at 4,000 and ${widest(12000)} at 12,000. The estimate is for numeric, count and 0/1 columns; a text column with many levels costs more.`,
    'A refusal names what to change: fewer columns (keep only the variables the analysis needs when the field map is built, then freeze a new snapshot), fewer rows (a smaller snapshot), fewer copies down to the minimum, or the job\'s cpuSecondsLimit where the platform allows more. The engine does not sample rows and does not drop columns, and neither does the queue.',
  ]
}
