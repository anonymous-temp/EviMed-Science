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
const academicProcessPattern = /(?:clinical-evidence-synthesis|证据追溯契约|(?:抓取|落盘).{0,16}(?:核验|来源|文件|原文)|白名单|本次检索.{0,24}(?:未纳入|无法)|无法通过本次检索|(?:本分析|本文).{0,60}(?:仅基于|未检索|未直接检索|未触及)|工具调用|不可及|无法获取|无法获得|未能获取|未能获得|全文不可得)/i;
const articleTypeTitlePattern = /(?:综述|系统评价|meta\s*分析|meta-analysis|systematic review|review article)/i;
const medicationResponseDiagnosisPattern = /(?:(?:速效救心丸|胃药|抗酸药|硝酸甘油).{0,80}(?:反应|缓解).{0,80}(?:诊断|排除|区分|判断)|(?:诊断|排除|区分|判断).{0,80}(?:速效救心丸|胃药|抗酸药|硝酸甘油).{0,80}(?:反应|缓解))/i;

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
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[‘’“”"'＂＇]/g, "")
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function validSupportingPassage(value) {
  return normalizedPassage(value).replace(/\s+/g, "").length >= 12;
}

function numericTokens(value) {
  return String(value ?? "")
    .replace(/\]\(https?:\/\/[^)\s]+\)/gi, "]")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\[claim:CLM-[0-9]{3,6}\]/g, "")
    .replace(/\b(?=[A-Za-z0-9-]*[0-9])[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*\b/g, "")
    .replace(/^[（(]\s*[1-9]\s*[)）]/, "")
    .replace(/((?:包括|分为|以及|与|和|、)|[：:；;，,]|\s)[（(]\s*[1-9]\s*[)）]/g, "$1")
    .match(/[0-9]+(?:\s*[–—-]\s*[0-9]+)?/g)
    ?.map((token) => token
      .replace(/\s+/g, "")
      .replace(/[–—]/g, "-")
      .split("-")
      .map((part) => part.replace(/^0+(?=\d)/, ""))
      .join("-")) ?? [];
}

function reportSection(reportText, headingPattern) {
  const match = String(reportText ?? "").match(
    new RegExp(`(?:^|\\n)##\\s+[^\\n]*(?:${headingPattern})[^\\n]*\\n([\\s\\S]*?)(?=\\n##\\s+|$)`, "i"),
  );
  return match?.[1] ?? "";
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
  if (!title || title.length > 40) issues.push("The academic title must be present and no longer than 40 characters.");
  if (articleTypeTitlePattern.test(title)) issues.push("The academic title must not contain an article-type label.");
  for (const section of [/(?:^|\n)##\s+(?:摘要|Abstract)/i, /(?:^|\n)##\s+.*(?:临床|证据|Evidence|Clinical)/i, /(?:^|\n)##\s+.*(?:局限|Limitations?)/i, /(?:^|\n)##\s+.*(?:结论|处置|Conclusion|Practical)/i]) {
    if (!section.test(reportText ?? "")) issues.push(`The academic report is missing a required section matching ${section}.`);
  }
  if (operationalFailurePattern.test(reportText ?? "")) {
    issues.push("The academic report contains operational failure prose that belongs only in the run receipt.");
  }
  if (academicProcessPattern.test(reportText ?? "")) {
    issues.push("The academic report contains runtime or retrieval-process prose instead of scientific analysis.");
  }
  if (/\[claim:CLM-[0-9]{3,6}[^\]]+\]/.test(reportText ?? "")) {
    issues.push("Each claim marker must contain exactly one claim ID.");
  }
  if (/https:\/\/www\.evimed\.com\/api-evimed\//i.test(reportText ?? "")) {
    issues.push("EviMed API endpoints cannot be used as public evidence citations.");
  }
  const medicationResponseText = String(reportText ?? "").replace(/不良反应/g, "药品安全信息");
  if (medicationResponseDiagnosisPattern.test(medicationResponseText)) {
    issues.push("Medication response must not be presented as a way to diagnose or exclude the cause of chest symptoms.");
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
    if (!validSupportingPassage(value.supportQuote)) issues.push(`${label}.supportQuote must contain a direct supporting passage.`);
    const directSupportNumbers = new Set(numericTokens([
      value.supportQuote,
      value.sourceTitle,
      value.identifier,
    ].join(" ")));
    for (const token of new Set(numericTokens(value.claim))) {
      if (!directSupportNumbers.has(token)) {
        issues.push(`${label}.claim numeric fact ${token} is not present in its direct support.`);
      }
    }
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

  const claimsById = new Map(claims.map((claim) => [claim?.claimId, claim]));
  const reportBeforeReferences = String(reportText ?? "").split(/\n##\s+(?:参考来源|References?)[^\n]*\n/i)[0];
  for (const rawLine of reportBeforeReferences.split("\n")) {
    if (/^\s*#{1,6}\s+/.test(rawLine)) continue;
    const line = rawLine.replace(/^\s*[0-9]+\.\s*/, "");
    const reportNumbers = new Set(numericTokens(line).filter((token) => token !== "120"));
    if (!reportNumbers.size) continue;
    const referencedIds = [...rawLine.matchAll(/\[claim:(CLM-[0-9]{3,6})\]/g)].map((match) => match[1]);
    if (!referencedIds.length) {
      for (const token of reportNumbers) {
        issues.push(`Report numeric fact ${token} has no evidence-matrix claim reference.`);
      }
      continue;
    }
    const supportedNumbers = new Set(referencedIds.flatMap((claimId) => {
      const claim = claimsById.get(claimId);
      return numericTokens([
        claim?.claim,
        claim?.supportQuote,
        claim?.sourceTitle,
        claim?.identifier,
      ].join(" "));
    }));
    for (const token of reportNumbers) {
      if (!supportedNumbers.has(token)) {
        issues.push(`Report numeric fact ${token} is not present in the cited claim evidence.`);
      }
    }
  }

  const practical = reportSection(reportText, "实际处置|实用|怎么办|Practical");
  const numberedItems = practical.split(/\n(?=\s*[0-9]+\.\s+)/).filter((item) => /^\s*[0-9]+\.\s+/.test(item));
  if (numberedItems.some((item) => !/\[claim:CLM-[0-9]{3,6}\]/.test(item))) {
    issues.push("Every numbered practical-action item must cite at least one evidence-matrix claim.");
  }
  const practicalActionLines = practical
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^(?:(?:\*\*)?第[一二三四五六七八九十]+步|(?:\*\*)?[0-9]+[.、]|[-*+]\s+)/.test(line));
  if (practicalActionLines.some((line) => !/\[claim:CLM-[0-9]{3,6}\]/.test(line))) {
    issues.push("Every practical-action step or bullet must cite at least one evidence-matrix claim.");
  }
  if (/速效救心丸/.test(reportText ?? "")
    && !/(?:速效救心丸.{0,120}(?:不应|不能|不得).{0,50}(?:延误|替代).{0,30}(?:呼救|急救|就医|评估)|(?:不应|不能|不得).{0,50}(?:因|以|让)?.{0,30}速效救心丸.{0,60}(?:延误|替代).{0,30}(?:呼救|急救|就医|评估))/s.test(practical)) {
    issues.push("The practical answer must explicitly state that Suxiao Jiuxin Wan must not delay emergency care.");
  }

  const limitations = reportSection(reportText, "局限|Limitations?");
  const limitationDimensions = [
    /偏倚|方法学质量|risk of bias/i,
    /间接性|外推|人群偏移|indirectness/i,
    /不精确|样本量|imprecision/i,
    /适用性|管辖权|医疗体系|applicability/i,
    /时效|证据年龄|未更新|outdated/i,
  ];
  if (limitationDimensions.filter((pattern) => pattern.test(limitations)).length < 2) {
    issues.push("Scientific limitations must address at least two evidence-quality or applicability dimensions.");
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
