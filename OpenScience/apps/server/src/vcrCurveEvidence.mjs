/**
 * Source-bound curve inputs. A caller's origin label never attests digitization.
 *
 * A curve record has one of two origins and the reconstruction path accepts
 * both the same way: a person's selection through the authenticated browser API
 * (`human_click`, kept as an optional correction), or the platform's own
 * deterministic digitizer run on a figure the study already holds
 * (`digitizer`, `vcrCurveDigitizer.mjs`). Either way the points are bound to the
 * hash of the figure they came from; what a model states is a calibration, never
 * a coordinate, and a list of points that has neither record is refused.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { canonicalScenarioJson, validateScenario } from '@evimed/domain';
import { HttpError, openScopedFileNoFollow, readStableFileHandle } from './security.mjs';
import { VCR_DIGITIZER_TOOL } from './vcrCurveDigitizer.mjs';

const IMAGE_LIMIT = 10 * 1024 * 1024;
const HUMAN_SELECTION = Object.freeze({ kind: 'human_click', tool: 'EviMed authenticated curve input', toolVersion: '1' });
/** @param {any} value */
const digest = value => createHash('sha256').update(canonicalScenarioJson(value)).digest('hex');
/** @param {string} code @param {string} message */
const refuse = (code, message) => new HttpError(409, code, message);

/** What a reader and a run are shown of a digitization: the calibration as stated, the algorithm, the quality of each curve. @param {any} digitization */
export function digitizationSummary(digitization) {
  return {
    statedBy: 'run',
    algorithm: { name: digitization.algorithm?.name, version: digitization.algorithm?.version },
    imageSha256: digitization.image?.sha256,
    calibration: digitization.calibration,
    anchor: digitization.anchor,
    plotArea: digitization.plotArea,
    warnings: digitization.warnings ?? [],
    curves: (digitization.curves ?? []).map((/** @type {any} */ curve) => ({
      name: curve.name, color: curve.color, points: curve.quality?.points, xCoverage: curve.quality?.xCoverage,
      bridgedColumns: curve.quality?.bridgedColumns, monotonicityRepairs: curve.quality?.monotonicityRepairs, startSurvival: curve.quality?.startSurvival,
    })),
  };
}

/** @param {{store:any,studyStore:any,access:any,resolveProject:(study:any)=>Promise<any>,digitizer?:any}} deps */
export function createVcrCurveEvidence({ store, studyStore, access, resolveProject, digitizer = null }) {
  /** Resolve authority with the actual actor, before using the study owner's workspace address.
   * @param {string} studyId @param {string} principal @param {string} ability */
  async function authorized(studyId, principal, ability) {
    await access.require({ actor: principal, studyId, ability, purpose: 'curve_reconstruction' });
    const study = await studyStore.studyById(studyId);
    if (!study) throw new HttpError(404, 'vcr_study_not_found', 'Study not found.');
    return study;
  }
  /** @param {any} study @param {string} artifactId @param {{ withData?: boolean }} [options] */
  async function readImage(study, artifactId, { withData = false } = {}) {
    if (typeof artifactId !== 'string' || !artifactId || artifactId.length > 2048 || path.isAbsolute(artifactId)
      || artifactId.includes('\\') || artifactId.includes('\0') || artifactId.split('/').some(part => part === '..' || !part)
      || /^[a-z]+:/i.test(artifactId) || !/\.(png|jpe?g)$/i.test(artifactId)) throw refuse('vcr_curve_provenance_invalid', 'A scoped PNG or JPEG source image is required.');
    const project = await resolveProject(study);
    const opened = await openScopedFileNoFollow(project.workspaceDir, path.join(project.workspaceDir, artifactId));
    try {
      if (!opened.stat.isFile() || opened.stat.size < 8 || opened.stat.size > IMAGE_LIMIT) throw refuse('vcr_curve_provenance_invalid', 'The source image is outside the supported bound.');
      const bytes = await readStableFileHandle(opened.handle, opened.stat);
      const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
      if (!png && !jpeg) throw refuse('vcr_curve_provenance_invalid', 'The source bytes are not a supported raster image.');
      return { artifactId, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, mime: png ? 'image/png' : 'image/jpeg', ...(withData ? { data: bytes } : {}) };
    } finally { await opened.handle.close(); }
  }
  return {
    /** Optional data entry through the authenticated browser API; never exposed to runtime writes.
     * @param {{studyId:string,principal:string,imageArtifactId:string,points:Record<string,any>}} request */
    async recordSelection({ studyId, principal, imageArtifactId, points }) {
      const study = await authorized(studyId, principal, 'write');
      if (!points || Array.isArray(points) || typeof points !== 'object' || Object.hasOwn(points, 'provenance')) throw refuse('vcr_curve_provenance_invalid', 'Curve input cannot assign its own provenance.');
      const scenario = { ...structuredClone(points), provenance: { ...HUMAN_SELECTION } };
      const issues = validateScenario('evidence.reconstruct_km', scenario);
      if (issues.length) throw new HttpError(400, 'vcr_curve_provenance_invalid', 'Curve points are not a supported reconstruction input.', { issues });
      const image = await readImage(study, imageArtifactId);
      const pointsHash = digest(scenario);
      return store.saveCurveExtraction({ id: `crv_${digest({ studyId, principal, image, pointsHash }).slice(0, 32)}`,
        studyId, userId: study.userId, principal, image, pointsHash, scenario, origin: 'human_click', createdAt: new Date().toISOString() });
    },
    /**
     * Digitize a figure the study already holds and record the result as a curve receipt. The caller states a
     * calibration, which curve, and the published risk table; every coordinate is measured from the pixels. A
     * run reaches this through the gateway; no call can write a receipt of its own.
     * @param {{studyId:string,principal:string,request:Record<string,any>,signal?:AbortSignal}} input
     */
    async recordDigitization({ studyId, principal, request, signal }) {
      const study = await authorized(studyId, principal, 'write');
      if (!request || Array.isArray(request) || typeof request !== 'object') throw refuse('vcr_curve_provenance_invalid', 'A figure and its calibration are required.');
      if (Object.hasOwn(request, 'provenance') || Object.hasOwn(request, 'origin') || Object.hasOwn(request, 'points') || Object.hasOwn(request, 'curve')) {
        throw new HttpError(400, 'vcr_curve_provenance_invalid', 'A digitization is measured, never stated: no origin, provenance or points can be given.');
      }
      if (!digitizer?.available) throw new HttpError(503, 'vcr_curve_digitizer_unavailable', 'This deployment cannot digitize figures.');
      const { imageArtifactId, ...stated } = request;
      const image = await readImage(study, imageArtifactId, { withData: true });
      const done = await digitizer.digitize({ request: { imageArtifactId, ...stated }, image, signal });
      if (done.refused) return { refused: done.refused };
      const { data: _bytes, ...meta } = image;
      const pointsHash = digest(done.scenario);
      const saved = await store.saveCurveExtraction({
        id: `crv_${digest({ studyId, principal, origin: 'digitizer', image: meta, pointsHash }).slice(0, 32)}`,
        studyId, userId: study.userId, principal, image: meta, pointsHash, scenario: done.scenario, origin: 'digitizer',
        digitization: { ...done.digitization, pointsHash }, createdAt: new Date().toISOString(),
      });
      return { id: saved.id, origin: saved.origin, createdAt: saved.createdAt, digitization: digitizationSummary(saved.digitization ?? done.digitization) };
    },
    /** Recheck at enqueue and again immediately before execution. No host paths or commands cross this seam.
     * @param {{studyId:string,principal:string,scenario:Record<string,any>,inputs:any[],receiptId?:string}} request */
    async curveVerifier({ studyId, principal, scenario, inputs = [], receiptId = undefined }) {
      const study = await authorized(studyId, principal, 'run');
      if (!scenario || Array.isArray(scenario) || typeof scenario !== 'object' || !Array.isArray(inputs)) throw refuse('vcr_curve_provenance_invalid', 'A curve request contains an object and input references.');
      const id = receiptId ?? scenario?.provenance?.receiptId;
      if (typeof id !== 'string' || !/^crv_[a-f0-9]{32}$/.test(id)) throw refuse('vcr_curve_provenance_unavailable', 'Verified image and curve-point provenance is unavailable. Continue other supported analyses.');
      const receipt = await store.curveExtraction(studyId, id);
      if (!receipt || receipt.userId !== study.userId) throw refuse('vcr_curve_provenance_unavailable', 'The curve extraction is unavailable for this study.');
      if (!receipt.principal || !['human_click', 'digitizer'].includes(receipt.origin) || digest(receipt.scenario) !== receipt.pointsHash) {
        throw refuse('vcr_curve_provenance_invalid', 'The recorded point extraction changed.');
      }
      // A human selection carries the one provenance the browser API stamps. A digitizer record carries the digitizer's
      // identity and version, and the record of what was measured, bound to the same points and the same figure.
      const recorded = receipt.digitization;
      const attested = receipt.origin === 'human_click'
        ? digest(receipt.scenario.provenance) === digest(HUMAN_SELECTION) && recorded == null
        : recorded?.statedBy === 'run' && typeof recorded.algorithm?.version === 'string' && recorded.pointsHash === receipt.pointsHash
          && recorded.image?.sha256 === receipt.image.sha256
          && digest(receipt.scenario.provenance) === digest({ kind: 'digitizer', tool: VCR_DIGITIZER_TOOL, toolVersion: recorded.algorithm.version });
      if (!attested) throw refuse('vcr_curve_provenance_invalid', 'The recorded point extraction changed.');
      const image = await readImage(study, receipt.image.artifactId).catch(() => { throw refuse('vcr_curve_source_changed', 'The source image can no longer be verified.'); });
      if (image.sha256 !== receipt.image.sha256 || image.bytes !== receipt.image.bytes) throw refuse('vcr_curve_source_changed', 'The curve source image changed after point selection.');
      for (const [key, value] of Object.entries(scenario ?? {})) {
        if (key === 'provenance') {
          for (const [name, field] of Object.entries(value ?? {})) {
            if (name === 'receiptId' ? field !== id : !Object.hasOwn(receipt.scenario.provenance, name) || digest(field) !== digest(receipt.scenario.provenance[name])) throw refuse('vcr_curve_provenance_invalid', 'Caller provenance does not match the recorded extraction.');
          }
        } else if (!Object.hasOwn(receipt.scenario, key) || digest(value) !== digest(receipt.scenario[key])) throw refuse('vcr_curve_provenance_invalid', 'Caller points do not match the recorded extraction.');
      }
      const lineage = { kind: 'evidence', id: `evidence:${id}@1` };
      return { scenario: structuredClone(receipt.scenario), inputs: [...inputs.filter(input => input?.id !== lineage.id), lineage],
        detail: { curveReceiptId: id, curvePrincipal: principal, curveImageHash: image.sha256, curvePointsHash: receipt.pointsHash } };
    },
    /** Identifiers only; source image bytes/paths never enter model context.
     * @param {{studyId:string,principal:string}} request */
    async receipts({ studyId, principal }) {
      await authorized(studyId, principal, 'read');
      // The newest digitizations carry what was measured and what was stated, so a run reports the calibration as the
      // run's own reading of the axis labels; older ones are identifiers only.
      let detailed = 12;
      return (await store.curveExtractions(studyId)).map(row => ({ id: row.id, origin: row.origin, createdAt: row.createdAt,
        ...(row.origin === 'digitizer' && row.digitization && detailed-- > 0 ? { digitization: digitizationSummary(row.digitization) } : {}) }));
    },
  };
}
