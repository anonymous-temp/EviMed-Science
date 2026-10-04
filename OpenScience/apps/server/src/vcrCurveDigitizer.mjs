import { canonicalJson, validateScenario } from '@evimed/domain';
import { HttpError } from './security.mjs';
import { createIntakeCounters } from './vcrRecordExtract.mjs';
import { runIntakeAttempt } from './vcrIntakeStage.mjs';

/**
 * A published Kaplan-Meier figure, turned into curve points by the deterministic
 * digitizer (`vcr_curve_digitize.py`, in the intake container).
 *
 * The rule this keeps: **a model never supplies a point.** What a run states is
 * a calibration (the value at the first and last tick of each axis, the unit,
 * fraction or percent), which curve (by colour or legend order), and the risk
 * table and totals the paper prints. Every coordinate comes out of the pixels of
 * a figure that is already a study artifact, identified by its hash. This module
 * validates what was stated, runs the digitizer, checks what came back, and
 * hands the control plane a scenario the reconstruction path accepts exactly like
 * a human-click one; recording it as a receipt is `vcrCurveEvidence.mjs`.
 *
 * Hidden knowledge:
 *
 * - **Stated is stated.** The calibration is recorded as stated by the run, from
 *   the figure's axis labels, and says so (`statedBy: "run"`). It is checked for
 *   being possible — a time that starts at or after zero, an axis that runs up,
 *   a survival axis that fits its scale — and the digitizer cross-checks what it
 *   can against the figure (the tick spacing the stated range implies is a round
 *   number, or a warning says it is not).
 * - **A refusal to trace is an answer, not a failure.** Two panels with an axis
 *   each, a colour that is not in the figure, a legend that cannot be found: the
 *   run is told what was found (the candidate boxes, the colours in the plot) and
 *   states the one that settles it. Only a stated calibration that is impossible,
 *   an unreadable image or a dead container is an error.
 * - **The result is re-checked here.** It comes from a container of our own image
 *   and is still validated: shapes, finite numbers, times in order, survival never
 *   rising, the image hash and the calibration echoed unchanged, and the finished
 *   scenario against the engine's own schema.
 */

export const VCR_DIGITIZER_TOOL = 'EviMed curve digitizer';
const RESULT_LIMIT = 1024 * 1024;
const TRACE_REFUSALS = new Set([
  'plot_area_not_found', 'plot_area_ambiguous', 'plot_area_invalid', 'colour_not_found', 'colour_ambiguous', 'colour_required', 'colour_invalid',
  'curve_not_found', 'curve_ambiguous', 'curve_rising', 'legend_not_found', 'curves_invalid',
]);
const refuse = (status, code, message) => new HttpError(status, code, message);

/** @param {unknown} value */
const finite = value => typeof value === 'number' && Number.isFinite(value);
/** @param {unknown} value */
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * The stated calibration, or the refusal naming what is impossible. The
 * digitizer holds the same rules (`check_calibration`); a test holds the two
 * equal, so a call is refused before a container is started and never differently.
 * @param {unknown} calibration
 * @returns {{ x: { min: number, max: number, unit: string }, y: { min: number, max: number, scale: 'fraction'|'percent' } }}
 */
export function checkCalibration(calibration) {
  const bad = message => refuse(400, 'vcr_curve_calibration_invalid', message);
  if (!plain(calibration)) throw bad('calibration is an object with x and y.');
  const x = plain(/** @type {any} */ (calibration).x) ? /** @type {any} */ (calibration).x : {};
  const y = plain(/** @type {any} */ (calibration).y) ? /** @type {any} */ (calibration).y : {};
  for (const [axis, spec] of [['x', x], ['y', y]]) for (const key of ['min', 'max']) if (!finite(spec[key])) throw bad(`${axis}.${key} is a number.`);
  const unit = typeof x.unit === 'string' ? x.unit.trim() : '';
  if (!unit || unit.length > 20) throw bad('x.unit names the time unit (months, years, weeks, days), at most 20 characters.');
  if (!['fraction', 'percent'].includes(y.scale)) throw bad('y.scale is fraction (0 to 1) or percent (0 to 100).');
  if (x.min < 0) throw bad('x.min is not negative: a survival time starts at or after zero.');
  if (x.max <= x.min) throw bad('x.max is greater than x.min.');
  const top = y.scale === 'fraction' ? 1 : 100;
  if (y.min < 0 || y.min > top * 0.95) throw bad(`y.min is between 0 and ${top * 0.95}: survival is not negative.`);
  if (y.max > top * 1.1) throw bad(`y.max is at most ${top * 1.1} on a ${y.scale} axis.`);
  if (y.max <= y.min) throw bad('y.max is greater than y.min.');
  if (y.max - y.min < top * 0.05) throw bad(`the survival axis spans at least 5% of 0 to ${top}.`);
  return { x: { min: x.min, max: x.max, unit }, y: { min: y.min, max: y.max, scale: y.scale } };
}

/** @param {unknown} area */
function checkPlotArea(area) {
  if (area == null) return null;
  const bad = () => refuse(400, 'vcr_request_invalid', 'plotArea is left, top, right and bottom in pixels (right > left, bottom > top, at least 40 pixels each way).');
  if (!plain(area)) throw bad();
  const box = /** @type {Record<string, any>} */ (area);
  const keys = ['left', 'top', 'right', 'bottom'];
  if (Object.keys(box).some(key => !keys.includes(key)) || keys.some(key => !finite(box[key]))) throw bad();
  if (!(box.left >= 0 && box.top >= 0 && box.right - box.left >= 40 && box.bottom - box.top >= 40)) throw bad();
  return { left: box.left, top: box.top, right: box.right, bottom: box.bottom };
}

/**
 * One arm as the run states it: which curve, and the numbers the paper prints.
 * @param {unknown} arm @param {number} index
 */
function checkArm(arm, index) {
  const bad = message => refuse(400, 'vcr_request_invalid', `arms[${index}]: ${message}`);
  if (!plain(arm)) throw bad('an arm is an object.');
  const value = /** @type {Record<string, any>} */ (arm);
  const extra = Object.keys(value).filter(key => !['name', 'curve', 'riskTable', 'totalEvents', 'reportedMedian'].includes(key));
  if (extra.length) throw bad(`${extra.join(', ')} is not a field of an arm (curve points are never stated: they are measured).`);
  const curve = value.curve ?? {};
  if (!plain(curve) || Object.keys(curve).some(key => !['color', 'legendOrder'].includes(key))) throw bad('curve names the curve by color (#rrggbb) or legendOrder (1 is the first swatch from the top).');
  if (curve.color != null && !/^#?[0-9a-fA-F]{6}$/.test(String(curve.color))) throw bad('curve.color is a six-digit hex such as #d62728.');
  if (curve.legendOrder != null && (!Number.isInteger(curve.legendOrder) || curve.legendOrder < 1 || curve.legendOrder > 8)) throw bad('curve.legendOrder is a whole number from 1 to 8.');
  if (curve.color != null && curve.legendOrder != null) throw bad('name the curve by color or by legendOrder, not both.');
  const name = value.name == null ? '' : String(value.name).trim();
  if (name.length > 60) throw bad('name is at most 60 characters.');
  if (!Array.isArray(value.riskTable) || value.riskTable.length < 2 || value.riskTable.length > 200) {
    throw bad('riskTable is the published numbers at risk, [{time, atRisk}] with at least two rows: without them censoring is not identified and no reconstruction is run.');
  }
  return {
    name: name || (index === 0 ? 'control' : 'treatment'),
    selector: { ...(curve.color != null ? { color: String(curve.color).startsWith('#') ? String(curve.color) : `#${curve.color}` } : {}), ...(curve.legendOrder != null ? { legendOrder: curve.legendOrder } : {}) },
    riskTable: value.riskTable, totalEvents: value.totalEvents, reportedMedian: value.reportedMedian,
  };
}

/**
 * What the run may state, checked.
 * @param {Record<string, any>} request
 */
export function checkDigitizeRequest(request) {
  const allowed = ['imageArtifactId', 'imageSha256', 'calibration', 'plotArea', 'arms', 'reportedLogHazardRatio'];
  const extra = Object.keys(request ?? {}).filter(key => !allowed.includes(key));
  if (extra.length) throw refuse(400, 'vcr_request_invalid', `${extra.join(', ')} is not a field of curve_digitize.`);
  if (request.imageSha256 != null && !/^[a-f0-9]{64}$/.test(String(request.imageSha256))) throw refuse(400, 'vcr_request_invalid', 'imageSha256 is the figure\'s sha256, 64 lowercase hex characters.');
  if (!Array.isArray(request.arms) || request.arms.length < 1 || request.arms.length > 2) throw refuse(400, 'vcr_request_invalid', 'arms lists one or two arms (the first is the control, the second the treatment).');
  const calibration = checkCalibration(request.calibration);
  const arms = request.arms.map(checkArm);
  const named = arms.map(arm => JSON.stringify(arm.selector));
  if (arms.length === 2 && named[0] === named[1] && named[0] !== '{}') throw refuse(400, 'vcr_request_invalid', 'the two arms name the same curve.');
  if (arms.length === 2 && named.includes('{}')) throw refuse(400, 'vcr_request_invalid', 'with two arms, every arm names its curve by color or legendOrder.');
  if (request.reportedLogHazardRatio != null && (!finite(request.reportedLogHazardRatio) || arms.length < 2)) {
    throw refuse(400, 'vcr_request_invalid', 'reportedLogHazardRatio is a number and is checked against two reconstructed arms.');
  }
  return { calibration, plotArea: checkPlotArea(request.plotArea), arms };
}

/**
 * The answer of the container, validated.
 * @param {any} result @param {{ calibration: any, sha256: string, arms: number }} expected
 */
export function checkDigitization(result, expected) {
  const broken = () => refuse(502, 'vcr_intake_failed', 'The digitizer returned a result that does not hold together.');
  if (!plain(result) || result.protocol !== 1 || !['digitized', 'refused'].includes(result.outcome)) throw broken();
  if (result.outcome === 'refused') return result;
  if (!plain(result.algorithm) || typeof result.algorithm.name !== 'string' || !/^\d+\.\d+\.\d+$/.test(String(result.algorithm.version))) throw broken();
  if (result.image?.sha256 !== expected.sha256) throw broken();
  if (canonicalJson(result.calibration) !== canonicalJson(expected.calibration)) throw broken();
  if (!Array.isArray(result.curves) || result.curves.length !== expected.arms) throw broken();
  for (const curve of result.curves) {
    const points = curve?.points;
    if (!Array.isArray(points) || points.length < 3 || points.length > 2000) throw broken();
    let time = -Infinity;
    let survival = Infinity;
    for (const point of points) {
      if (!plain(point) || !finite(point.time) || !finite(point.surv) || point.time < time || point.surv > survival || point.surv <= 0 || point.surv > 1 || point.time < 0) throw broken();
      time = point.time;
      survival = point.surv;
    }
    if (!plain(curve.quality) || !plain(curve.quality.monotonicityRepairs) || !plain(curve.quality.pixelSupport)) throw broken();
  }
  return result;
}

/**
 * @param {{ config: any, controller?: { runVcrIntake?: Function } | null, counters?: Record<string, number>, report?: (code: string) => void }} deps
 */
export function createVcrCurveDigitizer({ config, controller = null, counters = createIntakeCounters(), report = () => {} }) {
  return {
    counters,
    get available() { return typeof controller?.runVcrIntake === 'function'; },
    /**
     * Digitize one figure the study already holds.
     * @param {{ request: Record<string, any>, image: { sha256: string, bytes: number, mime: string, data: Buffer }, signal?: AbortSignal }} input
     * @returns {Promise<{ refused: any } | { digitization: any, scenario: Record<string, any> }>}
     */
    async digitize({ request, image, signal }) {
      const stated = checkDigitizeRequest(request);
      if (!this.available) throw refuse(503, 'vcr_curve_digitizer_unavailable', 'This deployment cannot digitize figures.');
      if (request.imageSha256 != null && request.imageSha256 !== image.sha256) throw refuse(409, 'vcr_curve_source_changed', 'The figure is not the one the call names by hash.');
      let result;
      try {
        result = await runIntakeAttempt({
          config, controller: /** @type {any} */ (controller), kind: 'digitize', name: image.mime === 'image/png' ? 'figure.png' : 'figure.jpg',
          source: { bytes: image.data }, signal,
          request: { calibration: stated.calibration, plotArea: stated.plotArea, curves: stated.arms.map(arm => ({ name: arm.name, ...arm.selector })),
            limits: { maxPixels: Number(config.vcrDigitizeMaxPixels) || 24_000_000 } },
        }, async attempt => {
          const file = await attempt.read('result.json', RESULT_LIMIT);
          let parsed = null;
          try { parsed = file ? JSON.parse(file.toString('utf8')) : null; } catch { parsed = null; }
          return checkDigitization(parsed, { calibration: stated.calibration, sha256: image.sha256, arms: stated.arms.length });
        });
      } catch (error) {
        const code = /** @type {any} */ (error)?.code;
        if (error instanceof HttpError && typeof code === 'string' && code.startsWith('runtime_controller_')) {
          report(code);
          counters.unavailable += 1;
          throw refuse(503, 'vcr_curve_digitizer_unavailable', 'This deployment cannot digitize figures.');
        }
        counters.digitizeFailed += 1;
        throw error;
      }
      if (result.outcome === 'refused') {
        if (result.reason === 'calibration_invalid') throw refuse(400, 'vcr_curve_calibration_invalid', String(result.message ?? 'The stated calibration is impossible.').slice(0, 300));
        if (['image_unreadable', 'image_too_large'].includes(result.reason)) throw refuse(400, 'vcr_curve_provenance_invalid', String(result.message ?? 'The figure cannot be read.').slice(0, 300));
        if (['deadline', 'memory'].includes(result.reason)) { counters.timedOut += 1; throw refuse(504, 'vcr_intake_timeout', 'The digitization took too long and was stopped.'); }
        if (!TRACE_REFUSALS.has(result.reason)) { counters.digitizeFailed += 1; throw refuse(502, 'vcr_intake_failed', 'The digitization did not finish.'); }
        counters.digitizeRefused += 1;
        return { refused: {
          reason: String(result.reason), message: String(result.message ?? '').slice(0, 300),
          ...(Array.isArray(result.detail?.candidates) ? { candidates: result.detail.candidates.slice(0, 4).map((/** @type {any} */ box) => ({
            left: Math.round(Number(box.left)), top: Math.round(Number(box.top)), right: Math.round(Number(box.right)), bottom: Math.round(Number(box.bottom)) })) } : {}),
          ...(Array.isArray(result.detail?.palette) ? { palette: result.detail.palette.slice(0, 8).map(String) } : {}),
        } };
      }
      const provenance = { kind: 'digitizer', tool: VCR_DIGITIZER_TOOL, toolVersion: String(result.algorithm.version) };
      const armScenario = (/** @type {any} */ arm, /** @type {any} */ curve) => ({
        curve: curve.points.map((/** @type {any} */ point) => ({ time: point.time, surv: point.surv })), riskTable: arm.riskTable,
        ...(arm.totalEvents != null ? { totalEvents: arm.totalEvents } : {}), ...(arm.reportedMedian != null ? { reportedMedian: arm.reportedMedian } : {}),
      });
      const scenario = {
        ...armScenario(stated.arms[0], result.curves[0]),
        ...(stated.arms[1] ? { treatmentArm: armScenario(stated.arms[1], result.curves[1]) } : {}),
        ...(request.reportedLogHazardRatio != null ? { reportedLogHazardRatio: request.reportedLogHazardRatio } : {}),
        provenance,
      };
      const issues = validateScenario('evidence.reconstruct_km', scenario);
      if (issues.length) {
        counters.digitizeRefused += 1;
        throw Object.assign(refuse(400, 'vcr_request_invalid', `The digitized curve with the stated risk table is not a reconstruction input: ${issues.slice(0, 3).map(issue => `${issue.field ?? ''} ${issue.code}`.trim()).join('; ')}.`), { issues });
      }
      counters.digitized += 1;
      return {
        scenario,
        digitization: {
          statedBy: 'run',
          algorithm: { name: String(result.algorithm.name), version: String(result.algorithm.version), libraries: result.algorithm.libraries ?? {} },
          image: { sha256: image.sha256, bytes: image.bytes, mime: image.mime, width: Number(result.image.width), height: Number(result.image.height) },
          // As stated by the run from the figure's axis labels: never a measurement, and shown as what it is.
          calibration: result.calibration,
          plotArea: result.plotArea, anchor: result.anchor, ticks: result.ticks ?? null, resolution: result.resolution,
          parameters: result.parameters, palette: result.palette ?? [],
          curves: result.curves.map((/** @type {any} */ curve, /** @type {number} */ index) => ({
            name: stated.arms[index].name, selector: stated.arms[index].selector, color: String(curve.color), colorSource: String(curve.colorSource), quality: curve.quality,
          })),
          warnings: Array.isArray(result.warnings) ? result.warnings.slice(0, 12).map((/** @type {any} */ item) => String(item).slice(0, 300)) : [],
        },
      };
    },
  };
}
