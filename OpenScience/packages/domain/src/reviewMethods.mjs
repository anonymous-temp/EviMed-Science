/**
 * Review-method accounting over the existing search ledger.
 *
 * Findings are advisory. Counts describe declared source relationships, not an
 * independent scientific judgment. Unknown study identities remain unknown;
 * titles never determine study families.
 */
export const REVIEW_METHOD_CHECK_IDS = Object.freeze([
  "review-methods-schema", "review-search-coverage", "review-study-accounting",
]);

/** @typedef {{ check: string, text: string }} ReviewFinding */
/** @typedef {{ issues: ReviewFinding[], metrics: Record<string, any> }} ReviewCoverage */
/** @param {unknown} value @returns {value is Record<string, any>} */
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** @param {unknown} value @returns {value is string} */
function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}
/** @param {unknown} value @returns {boolean} */
function textList(value) {
  return Array.isArray(value) && value.length > 0 && value.every(nonEmpty);
}
/** @param {ReviewFinding[]} issues @param {string} check @param {string} detail */
function note(issues, check, detail) {
  issues.push({ check, text: "Review methods: " + detail });
}

/** Canonicalize identifier formats, never scientific titles.
 * @param {Record<string, any>} source @returns {string | null} */
function documentIdentity(source) {
  if (!nonEmpty(source.identifier)) return null;
  return source.identifier.trim().toLowerCase()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//, "doi:")
    .replace(/^doi:\s*/, "doi:")
    .replace(/^(10\.\d{4,9}\/\S+)$/, "doi:$1")
    .replace(/^https?:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)\/?$/, "pmid:$1")
    .replace(/^pmid\s*:?\s*(\d+)$/, "pmid:$1");
}

/** @param {Record<string, any>} methods @param {ReviewFinding[]} issues */
function checkProtocol(methods, issues) {
  if (!["narrative", "systematic", "scoping", "rapid"].includes(methods.reviewType)) {
    note(issues, "review-methods-schema", "reviewType must name narrative, systematic, scoping, or rapid.");
  }
  if (!record(methods.eligibility)
    || !textList(methods.eligibility.inclusionCriteria)
    || !textList(methods.eligibility.exclusionCriteria)) {
    note(issues, "review-methods-schema", "record non-empty inclusionCriteria and exclusionCriteria under eligibility.");
  }
  const protocol = methods.protocol;
  if (!record(protocol)) {
    note(issues, "review-methods-schema", "record protocol status and deviations; an unregistered review may say unregistered.");
    return;
  }
  if (!["registered", "unregistered", "not_applicable"].includes(protocol.status)) {
    note(issues, "review-methods-schema", "protocol.status must be registered, unregistered, or not_applicable.");
  }
  if (protocol.status === "registered" && !nonEmpty(protocol.identifier)) {
    note(issues, "review-methods-schema", "a registered protocol needs its real identifier or URL.");
  }
  if (protocol.status === "not_applicable" && !nonEmpty(protocol.reason)) {
    note(issues, "review-methods-schema", "protocol.reason must explain a not_applicable status.");
  }
  if (!Array.isArray(protocol.deviations) || !protocol.deviations.every(nonEmpty)) {
    note(issues, "review-methods-schema", "protocol.deviations must be a list of stated deviations, or an empty list.");
  }
}

/** @param {Record<string, any>} methods @param {unknown} queries
 * @param {ReviewFinding[]} issues @returns {Record<string, any>} */
function searchCoverage(methods, queries, issues) {
  const rows = methods.searchCoverage;
  const queryRows = Array.isArray(queries) ? queries : [];
  const metrics = { searchDomains: 0, searchedDomains: 0, unavailableDomains: 0, notApplicableDomains: 0, searchCoverageComplete: false };
  if (!Array.isArray(rows) || rows.length === 0) {
    note(issues, "review-search-coverage", "searchCoverage must identify the domains the question requires; no fixed database quota applies.");
    return metrics;
  }
  let complete = true;
  const domains = new Set();
  for (const [index, row] of rows.entries()) {
    const label = "searchCoverage[" + index + "]";
    if (!record(row) || !nonEmpty(row.domain)) {
      note(issues, "review-search-coverage", label + " needs a non-empty domain and a search status.");
      complete = false;
      continue;
    }
    const key = row.domain.trim().toLowerCase();
    if (domains.has(key)) {
      note(issues, "review-search-coverage", label + " repeats the same domain; combine its query references.");
      complete = false;
      continue;
    }
    domains.add(key);
    metrics.searchDomains += 1;
    if (!Array.isArray(row.queryIndexes)) {
      note(issues, "review-search-coverage", label + ".queryIndexes must reference zero-based entries of queries, or be empty when unavailable.");
      complete = false;
      continue;
    }
    const indexes = row.queryIndexes;
    const invalid = indexes.some((value) => !Number.isInteger(value) || value < 0 || value >= queryRows.length
      || !record(queryRows[value]) || !nonEmpty(queryRows[value].database) || !nonEmpty(queryRows[value].query));
    if (invalid) {
      note(issues, "review-search-coverage", label + " references an absent or incomplete recorded query.");
      complete = false;
    }
    if (row.status === "searched") {
      if (!indexes.length || invalid) {
        if (!indexes.length) note(issues, "review-search-coverage", label + " says searched but names no recorded query.");
        complete = false;
      } else {
        metrics.searchedDomains += 1;
      }
    } else if (row.status === "unavailable") {
      metrics.unavailableDomains += 1;
      complete = false;
      note(issues, "review-search-coverage", label + " is unavailable"
        + (nonEmpty(row.reason) ? ": " + row.reason.trim() : "; record its reason")
        + ". This does not establish absence of evidence.");
    } else if (row.status === "not_applicable") {
      metrics.notApplicableDomains += 1;
      if (!nonEmpty(row.reason)) {
        note(issues, "review-search-coverage", label + " needs a reason for not_applicable.");
        complete = false;
      }
    } else {
      note(issues, "review-search-coverage", label + ".status must be searched, unavailable, or not_applicable.");
      complete = false;
    }
  }
  metrics.searchCoverageComplete = complete;
  return metrics;
}

/** @param {Record<string, any>} methods @param {unknown} sourceRecords
 * @param {ReviewFinding[]} issues @returns {Record<string, any>} */
function studyAccounting(methods, sourceRecords, issues) {
  const rows = Array.isArray(sourceRecords) ? sourceRecords : [];
  const included = rows.filter((row) => record(row) && row.included === true);
  const sources = new Map();
  const documents = new Map();
  let complete = true;
  let metadataOnlyIncluded = 0;
  for (const [index, row] of included.entries()) {
    if (!Number.isInteger(row.referenceNumber) || row.referenceNumber < 1 || sources.has(row.referenceNumber)) {
      note(issues, "review-study-accounting", "included sourceRecords entry " + index + " has a missing or repeated referenceNumber.");
      complete = false;
      continue;
    }
    sources.set(row.referenceNumber, row);
    const identity = documentIdentity(row);
    if (identity && documents.has(identity)) {
      note(issues, "review-study-accounting", "references " + documents.get(identity) + " and " + row.referenceNumber
        + " identify the same document; reconcile the source ledger before counting studies.");
      complete = false;
    } else if (identity) {
      documents.set(identity, row.referenceNumber);
    }
    if (!["full_text", "official_page", "abstract", "structured_record"].includes(row.accessLevel)) {
      metadataOnlyIncluded += 1;
      note(issues, "review-study-accounting", "reference " + row.referenceNumber
        + " has no usable beyond-metadata access level; do not describe it as a full-text study.");
    }
  }
  const groups = methods.studyGroups;
  const metrics = {
    includedReports: sources.size, primaryReports: 0, knownPrimaryStudies: 0,
    independentPrimaryStudies: /** @type {number | null} */ (null),
    unassignedPrimaryReports: 0, ungroupedReports: sources.size, metadataOnlyIncluded,
    studyAccountingComplete: false, studyIdentityBasis: "declared_source_groups",
  };
  if (!Array.isArray(sourceRecords)) {
    note(issues, "review-study-accounting", "sourceRecords must be an array before study counts can be calculated.");
    complete = false;
  }
  if (!Array.isArray(groups)) {
    note(issues, "review-study-accounting", "studyGroups must assign included reference numbers to explicit study identities or unknown identities.");
    return metrics;
  }
  const assigned = new Set();
  const primaryReferences = new Set();
  const unknownPrimary = new Set();
  const primaryStudies = new Set();
  const studyKinds = new Map();
  for (const [index, group] of groups.entries()) {
    const label = "studyGroups[" + index + "]";
    if (!record(group) || !Array.isArray(group.referenceNumbers) || group.referenceNumbers.length === 0
      || !["primary", "review", "guideline", "registry", "other"].includes(group.evidenceType)) {
      note(issues, "review-study-accounting", label + " needs an evidenceType and non-empty referenceNumbers.");
      complete = false;
      continue;
    }
    const id = nonEmpty(group.studyId) ? group.studyId.trim().toLowerCase() : null;
    if (group.studyId != null && !nonEmpty(group.studyId)) {
      note(issues, "review-study-accounting", label + ".studyId must be a non-empty string or null for unknown identity.");
      complete = false;
    }
    if (id && studyKinds.has(id) && studyKinds.get(id) !== group.evidenceType) {
      note(issues, "review-study-accounting", label + " assigns incompatible evidence types to studyId " + id + ".");
      complete = false;
    }
    if (id) studyKinds.set(id, group.evidenceType);
    const local = new Set();
    let usableReferences = 0;
    for (const number of group.referenceNumbers) {
      if (!Number.isInteger(number) || !sources.has(number)) {
        note(issues, "review-study-accounting", label + " contains a reference that is not an included integer referenceNumber.");
        complete = false;
        continue;
      }
      if (local.has(number) || assigned.has(number)) {
        note(issues, "review-study-accounting", label + " assigns reference " + number + " more than once.");
        complete = false;
        continue;
      }
      local.add(number);
      assigned.add(number);
      usableReferences += 1;
      if (group.evidenceType === "primary") {
        primaryReferences.add(number);
        if (!id) unknownPrimary.add(number);
      }
    }
    if (group.evidenceType === "primary" && id && usableReferences) primaryStudies.add(id);
  }
  const missing = [...sources.keys()].filter((number) => !assigned.has(number));
  if (missing.length) {
    note(issues, "review-study-accounting", "included references " + missing.join(", ") + " are not assigned to a study group.");
    complete = false;
  }
  if (unknownPrimary.size) {
    note(issues, "review-study-accounting", unknownPrimary.size + " primary report(s) have unknown study identity; independent study count remains unavailable.");
    complete = false;
  }
  return {
    ...metrics, primaryReports: primaryReferences.size, knownPrimaryStudies: primaryStudies.size,
    independentPrimaryStudies: complete ? primaryStudies.size : null,
    unassignedPrimaryReports: unknownPrimary.size, ungroupedReports: missing.length,
    studyAccountingComplete: complete,
  };
}

/** Optional extension: older ledgers keep their existing behavior.
 * @param {unknown} searchLog @returns {ReviewCoverage} */
export function reviewMethodsFindings(searchLog) {
  const issues = /** @type {ReviewFinding[]} */ ([]);
  if (!record(searchLog) || !Object.hasOwn(searchLog, "reviewMethods")) {
    return { issues, metrics: { present: false } };
  }
  const methods = searchLog.reviewMethods;
  if (!record(methods) || methods.schemaVersion !== 1) {
    note(issues, "review-methods-schema", "reviewMethods must be an object with schemaVersion 1; leave the existing source and query ledgers intact while repairing it.");
    return { issues, metrics: { present: true, schemaValid: false } };
  }
  checkProtocol(methods, issues);
  const coverage = searchCoverage(methods, searchLog.queries, issues);
  const accounting = studyAccounting(methods, searchLog.sourceRecords, issues);
  return {
    issues,
    metrics: {
      present: true, schemaValid: !issues.some((item) => item.check === "review-methods-schema"),
      reviewType: typeof methods.reviewType === "string" ? methods.reviewType : null,
      ...coverage, ...accounting,
    },
  };
}
