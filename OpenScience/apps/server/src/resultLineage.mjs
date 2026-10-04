/**
 * The supported numerical chain, read and written (plan 2026-10-02 §11.3 N06).
 *
 * `describe` answers the inspection questions the result view asks of a
 * version: from a printed number, which calculation, with which inputs and what
 * produced it; from a calculation, which printed values depend on it and what
 * would move in them if it were replaced by its successor. `render` is the
 * platform writing the numbers of a report itself — the study renderer's
 * mechanism (`@evimed/domain`'s `numberBinding.mjs`) over a result's machine
 * values — so the printed number IS the machine value, formatted by a recorded
 * rule, and the version it produces carries the binding of every number.
 *
 * Hidden knowledge:
 *
 * - **No second ledger.** Bindings and snapshots are fields of the existing
 *   immutable result version; the reverse lookup ("which versions print this
 *   calculation's values") is a containment query on the same documents the
 *   rest of the result workbench reads.
 * - **Re-running a calculation never touches its dependents.** A successor
 *   calculation is a new version; the versions bound to the original stay as
 *   they were, and `describe` says which of their values the successor would
 *   move — and which it would not, because the printed rounding still holds.
 *   A report is updated by rendering its template again against the successor
 *   into a new file, so the old bytes are never overwritten.
 * - **A render never withholds a report.** An unresolved reference reads
 *   「未计算」 and is named; the template, the output and every other value of
 *   the call survive it. Only a request that cannot be an operation at all (an
 *   output path that already holds a file, a template that cannot be read) is
 *   refused, by name, before anything is written.
 * - **The runtime names workspace files, never an authority.** It supplies
 *   paths and which calculations to read; the control plane reads the bytes,
 *   hashes them, renders, writes and captures.
 */
import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { NUMBER_BINDING_VERSION, RESULT_LINEAGE_LIMITS, SNAPSHOT_UNKNOWNS, changeImpact, flattenMachineValues, renderSnapshot, renderWithBindings, valueBindingRecord } from "@evimed/domain";
import { normalizeResultPath } from "@evimed/domain/result-provenance";
import { captureSkillResults } from "./skillExecution.mjs";
import { stableBytes } from "./resultDeliveryCapture.mjs";
import { HttpError, assertProjectCapacity, resolveScopedPath, withProjectStorageMutation, writeFileExclusiveNoFollow } from "./security.mjs";

const sha = (/** @type {Buffer | string} */ bytes) => createHash("sha256").update(bytes).digest("hex");
const ALIAS = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const VERSION_ID = /^rv_[a-f0-9]{64}$/;
const JOB_ID = /^replay_[a-f0-9]{64}$/;
const MAX_TEMPLATE_BYTES = 512 * 1024;
const MAX_RESULTS_BYTES = 8 * 1024 * 1024;

/** @param {unknown} value @returns {value is Record<string, any>} */
const record = (value) => value != null && typeof value === "object" && !Array.isArray(value);

/** A version as the lineage view lists it: what it is, and how many values of one calculation it prints.
 * @param {any} version @param {string | null} calculationId */
function summary(version, calculationId) {
  const mine = calculationId ? version.bindings.items.filter((/** @type {any} */ item) => item.calculation.versionId === calculationId) : version.bindings.items;
  return { versionId: version.versionId, path: version.path, capturedAt: version.capturedAt, digest: version.digest,
    runId: version.producer.runId ?? version.producer.sessionId ?? null, boundValues: mine.length, keys: [...new Set(mine.map((/** @type {any} */ item) => item.calculation.key))].slice(0, 20) };
}

export class ResultLineageService {
  /**
   * @param {{ results: any, replays?: any, config?: any, mirror?: (project: any, full: string, bytes: Buffer) => Promise<any>,
   *   transformationsFor?: ((project: any, digests: string[]) => Promise<any[]>) | null, runtimeImageId?: (() => Promise<string | null>) | null }} dependencies
   */
  constructor({ results, replays = null, config = {}, mirror = async () => {}, transformationsFor = null, runtimeImageId = null }) {
    this.results = results; this.replays = replays; this.config = config; this.mirror = mirror; this.transformationsFor = transformationsFor;
    this.runtimeImageId = runtimeImageId;
  }

  /**
   * What the result view shows of a version's numerical chain beyond the version itself.
   * `calculations`: the calculations a report's numbers are bound to. `dependents`: the versions whose numbers are
   * bound to this calculation. `changes`: for each calculation that has a successor, which bound values the successor
   * would move, which it would leave printing the same words, and which versions it would not touch at all.
   * @param {string} userId @param {string} projectId @param {string} versionId
   */
  async describe(userId, projectId, versionId) {
    const version = await this.results.get(userId, projectId, versionId);
    const isCalculation = version.machineValues.length > 0;
    const dependents = isCalculation
      ? (await this.results.query(userId, projectId, { bindingSources: [versionId] }, { limit: 50 })).items.filter((/** @type {any} */ item) => item.versionId !== versionId)
      : [];
    /** @type {any[]} */
    const calculations = [];
    if (isCalculation) calculations.push(version);
    else {
      for (const id of [...new Set(version.bindings.items.map((/** @type {any} */ item) => item.calculation.versionId))].slice(0, RESULT_LINEAGE_LIMITS.calculations)) {
        try { calculations.push(await this.results.get(userId, projectId, /** @type {string} */ (id))); }
        catch (error) { if (![403, 404].includes(/** @type {any} */ (error)?.status)) throw error; }
      }
    }
    /** @type {any[]} */
    const changes = [];
    for (const calculation of calculations) {
      const successors = (await this.results.query(userId, projectId, { supersedesVersionId: calculation.versionId }, { limit: 3 })).items;
      for (const successor of successors) {
        // A successor that is a revised report or table is not a recalculation: nothing it holds is a machine value.
        if (!successor.machineValues.length) continue;
        const impact = changeImpact({ before: calculation, after: successor, dependents: calculation.versionId === versionId ? dependents : [version] });
        changes.push({ calculationVersionId: calculation.versionId, successorVersionId: successor.versionId, successorCapturedAt: successor.capturedAt,
          successorPath: successor.path, successorRunId: successor.producer.runId ?? successor.producer.sessionId ?? null, ...impact });
      }
    }
    return {
      versionId,
      role: isCalculation ? (version.bindings.items.length ? "both" : "calculation") : version.bindings.items.length || version.bindings.counts.unbound ? "report" : "none",
      calculations: calculations.map((calculation) => ({ versionId: calculation.versionId, path: calculation.path, digest: calculation.digest, capturedAt: calculation.capturedAt,
        runId: calculation.producer.runId ?? calculation.producer.sessionId ?? null, method: calculation.snapshot?.method?.id ?? null, producer: calculation.snapshot?.kind ?? null })),
      dependents: dependents.map((/** @type {any} */ item) => summary(item, versionId)),
      changes,
    };
  }

  /**
   * A calculation's machine values, by one of the three names a render may give it: a finished calculation job
   * (`jobId`), an existing result version (`versionId`), or a results file with the execution record of an admitted
   * skill script beside it (`resultsPath`, `receiptPath`).
   * @param {string} userId @param {any} project @param {string} alias @param {any} source @param {any} producer
   */
  async calculation(userId, project, alias, source, producer) {
    if (!ALIAS.test(alias) || !record(source)) throw new HttpError(400, "result_render_invalid", "A calculation is named by an alias and one source.");
    /** @type {any} */
    let version = null;
    if (typeof source.jobId === "string") {
      if (!JOB_ID.test(source.jobId) || !this.replays) throw new HttpError(409, "result_render_calculation_unavailable", `Calculation ${alias} is not a job this deployment can read.`);
      const job = await this.replays.status(userId, project.id, source.jobId);
      if (!job.outputVersionId || job.state !== "succeeded") throw new HttpError(409, "result_render_calculation_unavailable", `Calculation ${alias} has not finished with a result.`);
      version = await this.results.get(userId, project.id, job.outputVersionId);
    } else if (typeof source.versionId === "string") {
      if (!VERSION_ID.test(source.versionId)) throw new HttpError(400, "result_render_invalid", "Invalid result version.");
      version = await this.results.get(userId, project.id, source.versionId);
    } else if (typeof source.resultsPath === "string") {
      version = await this.resultsFile(userId, project, source, producer);
    } else throw new HttpError(400, "result_render_invalid", "A calculation is a job, a result version or a results file.");
    const values = (version.machineValues ?? []).filter((/** @type {any} */ value) => Number.isFinite(value?.value) && typeof value.key === "string")
      .map((/** @type {any} */ value) => ({ key: value.key, value: value.value, unit: typeof value.unit === "string" ? value.unit : null }));
    if (!values.length) throw new HttpError(409, "result_render_calculation_unavailable", `Calculation ${alias} holds no machine values.`);
    return { versionId: version.versionId, digest: version.digest, path: version.path, alias, values };
  }

  /**
   * A results file as a calculation: captured with the producer snapshot an admitted skill script's execution record
   * gives it (when one accounts for these exact bytes), and its numbers flattened to machine values.
   * @param {string} userId @param {any} project @param {any} source @param {any} producer
   */
  async resultsFile(userId, project, source, producer) {
    const resultsPath = normalizeResultPath(source.resultsPath);
    const readBytes = (/** @type {string} */ relativePath, /** @type {number} */ limit) => stableBytes(project, relativePath, limit);
    let bytes;
    try { bytes = await readBytes(resultsPath, MAX_RESULTS_BYTES); }
    catch { throw new HttpError(409, "result_render_calculation_unavailable", "The results file cannot be read."); }
    /** @type {any} */
    let parsed;
    try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { throw new HttpError(409, "result_render_calculation_unavailable", "The results file is not JSON."); }
    const flat = flattenMachineValues(parsed);
    // The same bytes already preserved as a calculation are that calculation: a second copy would be a second identity for one result.
    const existing = (await this.results.query(userId, project.id, { path: resultsPath, digest: sha(bytes), hasMachineValues: true }, { limit: 1 })).items[0];
    if (existing) return existing;
    const origin = { sessionId: producer.sessionId, runId: producer.runId ?? null, parentSessionId: producer.parentSessionId ?? null, branchId: producer.branchId ?? null };
    if (typeof source.receiptPath === "string") {
      const captured = await captureSkillResults({ results: this.results, project, userId, receiptPath: normalizeResultPath(source.receiptPath), resultsPath, readBytes, producer: origin,
        transformationsFor: this.transformationsFor ? (digests) => /** @type {any} */ (this.transformationsFor)(project, digests) : null, runtimeImageId: this.runtimeImageId });
      if (captured.status === "captured") return captured.version;
    }
    // No execution record accounts for these bytes: they are a results file the run named, and how it was made was not observed.
    return this.results.captureFile({ userId, project, relativePath: resultsPath, machineValues: flat.values,
      snapshot: { kind: "unobserved", origin: "unknown", unknown: [...SNAPSHOT_UNKNOWNS] },
      producer: { kind: "workspace", ...origin, eventId: `results:${sha(bytes)}` } });
  }

  /**
   * Render a report template into a new file with every `{{n:<alias>.<key>|<format>}}` written by the platform from the
   * named calculations' machine values, and capture it with the binding of each number it prints.
   *
   * @param {string} userId @param {any} project
   * @param {{ templatePath: string, outputPath: string, calculations: Record<string, any> }} request
   * @param {{ sessionId: string, callId: string, runId?: string | null, parentSessionId?: string | null, branchId?: string | null }} producer
   * @param {() => Promise<void>} [revalidate]
   */
  async render(userId, project, request, producer, revalidate = async () => {}) {
    const calculationNames = record(request?.calculations) ? Object.entries(request.calculations) : [];
    if (!record(request) || !calculationNames.length || calculationNames.length > RESULT_LINEAGE_LIMITS.calculations) {
      throw new HttpError(400, "result_render_invalid", `Name one to ${RESULT_LINEAGE_LIMITS.calculations} calculations.`);
    }
    let templatePath;
    let outputPath;
    try { templatePath = normalizeResultPath(request.templatePath); outputPath = normalizeResultPath(request.outputPath); }
    catch { throw new HttpError(400, "result_render_invalid", "The template and the output are workspace-relative paths."); }
    if (templatePath === outputPath) throw new HttpError(400, "result_render_invalid", "The output is a new file: it cannot be the template.");
    const full = resolveScopedPath(project.workspaceDir, outputPath);
    let templateBytes;
    try { templateBytes = await stableBytes(project, templatePath, MAX_TEMPLATE_BYTES); }
    catch { throw new HttpError(409, "result_render_template_unavailable", "The template cannot be read."); }
    let template;
    try { template = new TextDecoder("utf-8", { fatal: true }).decode(templateBytes); }
    catch { throw new HttpError(409, "result_render_template_unavailable", "The template is not text."); }
    // An existing file is never overwritten: a rendered report is a new file, so the old bytes stay.
    const present = await lstat(full).then(() => true, (/** @type {any} */ error) => { if (error?.code === "ENOENT") return false; throw error; });
    if (present) throw new HttpError(409, "result_render_output_exists", "The output file already exists; render into a new file.");

    const calculations = [];
    for (const [alias, source] of calculationNames) calculations.push(await this.calculation(userId, project, alias, source, producer));
    await revalidate();

    const rendered = renderWithBindings({ template, path: outputPath, calculations });
    const bytes = Buffer.from(rendered.text, "utf8");
    await withProjectStorageMutation(project, async () => {
      await assertProjectCapacity(project, full, bytes.length, this.config);
      try { await writeFileExclusiveNoFollow(project.workspaceDir, full, bytes); }
      catch (error) {
        if (/** @type {any} */ (error)?.code === "EEXIST") throw new HttpError(409, "result_render_output_exists", "The output file already exists; render into a new file.");
        throw error;
      }
    });

    const templateVersion = await this.templateVersion(userId, project, templatePath, templateBytes, producer);
    const inputs = [
      ...(templateVersion ? [{ kind: "artifact", id: templateVersion.artifactId, versionId: templateVersion.versionId, digest: templateVersion.digest, path: templatePath, availability: "captured" }] : []),
      ...calculations.map((calculation) => ({ kind: "artifact", id: calculation.versionId, versionId: calculation.versionId, digest: calculation.digest, path: calculation.path, availability: "captured" })),
    ];
    const bindings = valueBindingRecord({ ...rendered, calculations });
    const version = await this.results.captureFile({ userId, project, relativePath: outputPath, expectedDigest: sha(bytes), inputs,
      snapshot: renderSnapshot({ inputs, version: NUMBER_BINDING_VERSION }), bindings,
      producer: { kind: "tool", sessionId: producer.sessionId, runId: producer.runId ?? null, callId: producer.callId, eventId: `render:${producer.callId}`,
        parentSessionId: producer.parentSessionId ?? null, branchId: producer.branchId ?? null } });
    // The runtime sees the file the platform wrote. Done after the capture so a failure here leaves the version it describes.
    await this.mirror(project, full, bytes);
    return {
      id: version.versionId, state: "rendered", outputPath, versionId: version.versionId, digest: version.digest, status: version.bindings.status,
      counts: version.bindings.counts,
      // Named so the run can say what it did not get, never so it can be refused: the report is written either way.
      unresolved: rendered.unresolved.slice(0, 20), unparsed: rendered.unparsed.slice(0, 5).map((text) => text.slice(0, 80)),
      unbound: version.bindings.unbound.slice(0, 20).map((/** @type {any} */ item) => ({ printed: item.printed, reason: item.reason })),
    };
  }

  /**
   * The version of the template the report was rendered from: the one the run's own write was captured as when its bytes
   * are the ones read now, otherwise a new capture of exactly these bytes.
   * @param {string} userId @param {any} project @param {string} templatePath @param {Buffer} bytes @param {any} producer
   */
  async templateVersion(userId, project, templatePath, bytes, producer) {
    const digest = sha(bytes);
    try {
      const existing = await this.results.query(userId, project.id, { path: templatePath, digest }, { limit: 1 });
      if (existing.items[0]) return existing.items[0];
      // Not a version of the run's own write (a shell command may have made the file): preserved as the bytes the render read.
      return await this.results.captureFile({ userId, project, relativePath: templatePath, expectedDigest: digest,
        snapshot: { kind: "unobserved", origin: "unknown", unknown: [...SNAPSHOT_UNKNOWNS] },
        producer: { kind: "workspace", sessionId: producer.sessionId, runId: producer.runId ?? null, eventId: `template:${digest}`,
          parentSessionId: producer.parentSessionId ?? null, branchId: producer.branchId ?? null } });
    } catch { return null; }
  }
}
