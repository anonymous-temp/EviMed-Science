const claimFields = Object.freeze([
  "claimId",
  "claim",
  "sourceUrl",
  "sourceTitle",
  "artifactPath",
  "identifier",
  "accessLevel",
  "supportQuote",
  "applicability",
  "uncertainty",
]);
const accessLevels = new Set(["full_text", "official_page", "abstract", "structured_record"]);
const claimIdPattern = /^CLM-[0-9]{3,6}$/;
const operationalFailurePattern = /(?:Transport error|Runtime configuration bootstrap|网页访问失败|工具调用失败|public[_ -]source[_ -]gateway.*(?:failed|error))/i;
const articleTypeTitlePattern = /(?:综述|系统评价|meta\s*分析|meta-analysis|systematic review|review article)/i;

function nonEmpty(value, minimum = 1) {
  return typeof value === "string" && value.trim().length >= minimum;
}

function sourceDomain(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) return null;
    return url.hostname.toLowerCase();
  } catch {
    return null;
  }
}

function normalizedPassage(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function validSourceArtifactPath(value) {
  return typeof value === "string"
    && value.startsWith(".evimed-sources/")
    && !value.includes("\\")
    && !value.split("/").some((part) => part === "" || part === "." || part === "..");
}

export function validateClinicalEvidencePackage({ reportText, matrix, runReceipt, sourceArtifacts = {} } = {}) {
  const issues = [];
  const claimIds = [];
  const sourceDomains = new Set();
  const claims = matrix && typeof matrix === "object" && !Array.isArray(matrix) && Array.isArray(matrix.claims)
    ? matrix.claims
    : [];
  const successfulArtifacts = new Set(
    Array.isArray(runReceipt?.successfulSourceArtifacts)
      ? runReceipt.successfulSourceArtifacts.filter((value) => typeof value === "string")
      : [],
  );
  const artifactText = sourceArtifacts instanceof Map
    ? sourceArtifacts
    : new Map(Object.entries(sourceArtifacts && typeof sourceArtifacts === "object" ? sourceArtifacts : {}));

  if (!nonEmpty(reportText, 1200)) issues.push("clinical-evidence-report.md must contain at least 1200 characters of academic analysis.");
  const title = typeof reportText === "string" ? reportText.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? "" : "";
  if (!title || title.length > 80) issues.push("The academic title must be present and no longer than 80 characters.");
  if (articleTypeTitlePattern.test(title)) issues.push("The academic title must not contain an article-type label.");
  for (const section of [/(?:^|\n)##\s+(?:摘要|Abstract)/i, /(?:^|\n)##\s+.*(?:临床|证据|Evidence|Clinical)/i, /(?:^|\n)##\s+.*(?:局限|Limitations?)/i, /(?:^|\n)##\s+.*(?:结论|处置|Conclusion|Practical)/i]) {
    if (!section.test(reportText ?? "")) issues.push(`The academic report is missing a required section matching ${section}.`);
  }
  if (operationalFailurePattern.test(reportText ?? "")) {
    issues.push("The academic report contains operational failure prose that belongs only in the run receipt.");
  }
  if (/https:\/\/www\.evimed\.com\/api-evimed\//i.test(reportText ?? "")) {
    issues.push("EviMed API endpoints cannot be used as public evidence citations.");
  }

  if (claims.length < 4) issues.push("The evidence matrix must contain at least four material claims.");
  const seen = new Set();
  for (const [index, value] of claims.entries()) {
    const label = `claims[${index}]`;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      issues.push(`${label} must be an object.`);
      continue;
    }
    for (const field of claimFields) {
      if (!nonEmpty(value[field])) issues.push(`${label}.${field} must be a non-empty string.`);
    }
    if (!claimIdPattern.test(value.claimId ?? "")) issues.push(`${label}.claimId must match CLM-NNN.`);
    if (seen.has(value.claimId)) issues.push(`${label}.claimId is duplicated.`);
    else if (typeof value.claimId === "string") {
      seen.add(value.claimId);
      claimIds.push(value.claimId);
    }
    if (!accessLevels.has(value.accessLevel)) {
      issues.push(`${label}.accessLevel must identify verified content access, not bibliographic metadata.`);
    }
    if (!nonEmpty(value.supportQuote, 20)) issues.push(`${label}.supportQuote must contain a direct supporting passage.`);
    if (!validSourceArtifactPath(value.artifactPath)) {
      issues.push(`${label}.artifactPath must be a safe .evimed-sources workspace path.`);
    } else if (!successfulArtifacts.has(value.artifactPath)) {
      issues.push(`${label}.artifactPath is not listed as a successful source artifact for this run.`);
    } else {
      const preserved = normalizedPassage(artifactText.get(value.artifactPath));
      const quote = normalizedPassage(value.supportQuote);
      if (!preserved || !quote || !preserved.includes(quote)) {
        issues.push(`${label}.supportQuote was not found in its preserved source artifact.`);
      }
    }
    const domain = sourceDomain(value.sourceUrl);
    if (!domain) issues.push(`${label}.sourceUrl must be a valid credential-free HTTPS URL.`);
    else {
      sourceDomains.add(domain);
      if (domain === "www.evimed.com" && value.sourceUrl.includes("/api-evimed/")) {
        issues.push(`${label}.sourceUrl is an internal API route, not a public evidence citation.`);
      }
    }
  }
  if (sourceDomains.size < 2) issues.push("Material claims must use at least two authoritative source domains.");

  const reportClaims = [...String(reportText ?? "").matchAll(/\[claim:(CLM-[0-9]{3,6})\]/g)].map((match) => match[1]);
  const reportSet = new Set(reportClaims);
  for (const claimId of reportSet) {
    if (!seen.has(claimId)) issues.push(`Report claim reference ${claimId} does not resolve to the evidence matrix.`);
  }
  for (const claimId of seen) {
    if (!reportSet.has(claimId)) issues.push(`Evidence matrix claim ${claimId} is not cited by the report.`);
  }

  if (!runReceipt || typeof runReceipt !== "object" || Array.isArray(runReceipt)) {
    issues.push("clinical-evidence-run.json must be an object.");
  } else {
    if (runReceipt.status !== "succeeded") issues.push("The clinical evidence run receipt is not succeeded.");
    if (!Array.isArray(runReceipt.successfulSourceArtifacts) || runReceipt.successfulSourceArtifacts.length < 2) {
      issues.push("The run receipt must name at least two successful source artifacts.");
    } else if (runReceipt.successfulSourceArtifacts.some((value) => !validSourceArtifactPath(value))) {
      issues.push("Every successful source artifact must be a safe .evimed-sources workspace path.");
    }
    const checks = runReceipt.qualityChecks;
    if (!checks || typeof checks !== "object" || Array.isArray(checks) || Object.values(checks).length < 3 || Object.values(checks).some((value) => value !== true)) {
      issues.push("All declared run-receipt quality checks must pass.");
    }
  }

  return Object.freeze({
    valid: issues.length === 0,
    issues: Object.freeze(issues),
    claimIds: Object.freeze(claimIds),
    sourceDomains: Object.freeze([...sourceDomains].sort()),
  });
}
