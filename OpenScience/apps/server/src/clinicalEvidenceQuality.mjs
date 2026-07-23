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
const academicProcessPattern = /(?:clinical-evidence-synthesis|\bevimed_[a-z_]+\b|EviMed.{0,24}(?:引擎|网关|工具)|证据追溯契约|\.evimed-sources\/|(?:抓取|落盘).{0,16}(?:核验|来源|文件|原文)|白名单抓取|工具调用|(?:全文|页面|文件).{0,12}(?:不可及|无法获取|无法获得|未能获取|未能获得|不可得)|(?:未触及|未读取|未检索).{0,16}(?:完整|全文|文件|页面))/i;
const medicationResponseDiagnosisPattern = /(?:(?:速效救心丸|胃药|抗酸药|硝酸甘油).{0,80}(?:反应|缓解).{0,80}(?:诊断|排除|区分|判断)|(?:诊断|排除|区分|判断).{0,80}(?:速效救心丸|胃药|抗酸药|硝酸甘油).{0,80}(?:反应|缓解))/i;
const emergencyCallClaimPattern = /(?:(?:呼叫|拨打).{0,16}(?:急救|120|999)|(?:急救|120|999).{0,16}(?:呼叫|拨打))/i;
const emergencyCallSupportPattern = /(?:call.{0,16}(?:999|emergency|ambulance)|(?:999|emergency|ambulance).{0,16}call|呼叫|拨打|急救)/i;
const unsupportedSelfCarePattern = /(?:(?:可|可以|建议|不妨|先|服用后).{0,24}(?:胃药|抗酸药).{0,40}(?:等待|观察)|(?:胃药|抗酸药).{0,40}(?:后再|并|然后).{0,20}(?:等待|观察)|(?:可|可以|建议|不妨|先).{0,20}(?:等待|观察).{0,30}(?:症状|变化|缓解))/i;
const exclusiveSafetyPattern = /(?:唯一.{0,24}(?:安全|可靠|正确|一致|策略|方法|途径)|(?:安全|可靠|正确).{0,24}唯一)/i;
const suxiaoPattern = /(?:速效救心丸|Suxiao Jiuxin Wan)/i;
const deepResearchProfile = "academic_deep_research_v1";
const visibleClaimMarkerPattern = /\[claim:(CLM-[0-9]{3,6})\]/g;
const hiddenClaimMarkerPattern = /<!--\s*claim:(CLM-[0-9]{3,6})\s*-->/g;

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
  return normalizedPassage(value).replace(/\s+/g, "").length > 0;
}

function numericTokens(value) {
  return String(value ?? "")
    .replace(/\]\(https?:\/\/[^)\s]+\)/gi, "]")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\[claim:CLM-[0-9]{3,6}\]/g, "")
    .replace(/<!--\s*claim:CLM-[0-9]{3,6}\s*-->/g, "")
    .replace(/\[(?:\d+(?:\s*[-,]\s*\d+)*)\]/g, "")
    .replace(/\b(?=[A-Za-z0-9-]*[0-9])[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*\b/g, "")
    .replace(/[（(]\s*[1-9]\d?\s*[)）]/g, "")
    .replace(/(?<=\d),(?=\d{3}(?:\D|$))/g, "")
    .replace(/%(\s*[–—-]\s*)(?=\d)/g, "$1")
    .match(/[0-9]+(?:\.[0-9]+)?(?:\s*[–—-]\s*[0-9]+(?:\.[0-9]+)?)?/g)
    ?.map((token) => token
      .replace(/\s+/g, "")
      .replace(/[–—]/g, "-")
      .split("-")
      .map((part) => part
        .replace(/^0+(?=\d)/, "")
        .replace(/(\.\d*?)0+$/, "$1")
        .replace(/\.$/, ""))
      .join("-")) ?? [];
}

function reportClaimIds(value) {
  const text = String(value ?? "");
  return [
    ...[...text.matchAll(visibleClaimMarkerPattern)].map((match) => match[1]),
    ...[...text.matchAll(hiddenClaimMarkerPattern)].map((match) => match[1]),
  ];
}

function hasClaimMarker(value) {
  return reportClaimIds(value).length > 0;
}

function bibliographyEntryCount(value) {
  return [...String(value ?? "").matchAll(/^@[A-Za-z]+\s*\{/gm)].length;
}

function numberedReferenceCount(reportText) {
  const references = reportSection(reportText, "参考文献|参考来源|References?");
  return references.split("\n").filter((line) => /^\s*\d+\.\s+\S/.test(line)).length;
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function reportSection(reportText, headingPattern) {
  const match = String(reportText ?? "").match(
    new RegExp(`(?:^|\\n)##\\s+[^\\n]*(?:${headingPattern})[^\\n]*\\n([\\s\\S]*?)(?=\\n##\\s+|$)`, "i"),
  );
  return match?.[1] ?? "";
}

function withoutReportSections(reportText, headingPattern) {
  return String(reportText ?? "").replace(
    new RegExp(`(?:^|\\n)##\\s+[^\\n]*(?:${headingPattern})[^\\n]*\\n[\\s\\S]*?(?=\\n##\\s+|$)`, "gi"),
    "\n",
  );
}

function standardCitationNumbers(value) {
  const numbers = new Set();
  for (const match of String(value ?? "").matchAll(/\[(\d+(?:\s*[-,]\s*\d+)*)\]/g)) {
    for (const part of match[1].split(",")) {
      const range = part.trim().match(/^(\d+)\s*-\s*(\d+)$/);
      if (range) {
        const start = Number(range[1]);
        const end = Number(range[2]);
        if (end >= start && end - start <= 100) {
          for (let number = start; number <= end; number += 1) numbers.add(number);
        }
      } else {
        numbers.add(Number(part.trim()));
      }
    }
  }
  return numbers;
}

function validSourceArtifactPath(value) {
  return typeof value === "string"
    && value.startsWith(".evimed-sources/")
    && !value.includes("\\")
    && !value.split("/").some((part) => part === "" || part === "." || part === "..");
}

function sourceArtifactIdentity(value) {
  if (!validSourceArtifactPath(value)) return null;
  const parts = value.split("/");
  const fileName = parts.at(-1)?.toLowerCase();
  if (["fulltext.md", "fulltext.xml", "page.md", "page.html"].includes(fileName)) {
    return parts.slice(0, -1).join("/");
  }
  return value;
}

export function validateClinicalEvidencePackage({
  reportText,
  matrix,
  runReceipt,
  sourceArtifacts = {},
  executedSearchQueries = null,
  searchLogText = "",
  referencesText = "",
  citationLedgerText = "",
  citationAuditText = "",
} = {}) {
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
  const distinctSuccessfulSources = new Set(
    [...successfulArtifacts].map(sourceArtifactIdentity).filter(Boolean),
  );
  const artifactText = sourceArtifacts instanceof Map
    ? sourceArtifacts
    : new Map(Object.entries(sourceArtifacts && typeof sourceArtifacts === "object" ? sourceArtifacts : {}));
  const deepResearch = runReceipt?.reportProfile === deepResearchProfile;
  const reportReferenceCount = numberedReferenceCount(reportText);

  if (!nonEmpty(reportText)) issues.push("clinical-evidence-report.md must contain academic analysis.");
  const title = typeof reportText === "string" ? reportText.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? "" : "";
  if (!title) issues.push("The academic title must be present.");
  for (const section of [/(?:^|\n)##\s+(?:摘要|Abstract)/i, /(?:^|\n)##\s+.*(?:临床|证据|Evidence|Clinical)/i, /(?:^|\n)##\s+.*(?:局限|Limitations?)/i, /(?:^|\n)##\s+.*(?:结论|处置|Conclusion|Practical)/i]) {
    if (!section.test(reportText ?? "")) issues.push(`The academic report is missing a required section matching ${section}.`);
  }
  if (deepResearch) {
    for (const section of [
      /(?:^|\n)##\s+.*(?:检索|方法|Methods?)/i,
      /(?:^|\n)##\s+.*(?:结果|Results?)/i,
      /(?:^|\n)##\s+.*(?:讨论|Discussion)/i,
    ]) {
      if (!section.test(reportText ?? "")) {
        issues.push(`The deep-research report is missing a required academic section matching ${section}.`);
      }
    }
    const practicalHeading = String(reportText ?? "").search(/(?:^|\n)##\s+[^\n]*(?:安全优先的实际处置|实际处置|实用回答|Practical)[^\n]*$/im);
    const referencesHeading = String(reportText ?? "").search(/(?:^|\n)##\s+[^\n]*(?:参考文献|参考来源|References?)[^\n]*$/im);
    if (practicalHeading < 0) {
      issues.push("The deep-research report must contain a dedicated safety-first practical-answer section.");
    }
    if (referencesHeading < 0 || (practicalHeading >= 0 && referencesHeading < practicalHeading)) {
      issues.push("The numbered reference list must follow the safety-first practical-answer section.");
    }
    if (visibleClaimMarkerPattern.test(reportText ?? "")) {
      issues.push("Deep-research reports must hide internal claim IDs in HTML comments and show standard numbered citations to readers.");
    }
    visibleClaimMarkerPattern.lastIndex = 0;
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
  if (exclusiveSafetyPattern.test(reportText ?? "")) {
    issues.push("The report must not turn a bounded recommendation into an unsupported exclusive safety claim.");
  }

  if (!claims.length) issues.push("The evidence matrix must contain the report's material claims.");
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
    if (
      deepResearch
      && (
        !Number.isInteger(value.referenceNumber)
        || value.referenceNumber < 1
        || value.referenceNumber > reportReferenceCount
      )
    ) {
      issues.push(`${label}.referenceNumber must resolve to a numbered report reference.`);
    }
    if (!validSupportingPassage(value.supportQuote)) issues.push(`${label}.supportQuote must contain a direct supporting passage.`);
    if (emergencyCallClaimPattern.test(value.claim ?? "")
      && !emergencyCallSupportPattern.test(value.supportQuote ?? "")) {
      issues.push(`${label}.emergency-call action is not present in its direct support.`);
    }
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
  const reportClaims = reportClaimIds(reportText);
  const reportSet = new Set(reportClaims);
  for (const claimId of reportSet) {
    if (!seen.has(claimId)) issues.push(`Report claim reference ${claimId} does not resolve to the evidence matrix.`);
  }
  for (const claimId of seen) {
    if (!reportSet.has(claimId)) issues.push(`Evidence matrix claim ${claimId} is not cited by the report.`);
  }

  const claimsById = new Map(claims.map((claim) => [claim?.claimId, claim]));
  const reportForNumericAudit = withoutReportSections(
    withoutReportSections(reportText, "参考文献|参考来源|References?"),
    "检索|方法|Methods?",
  );
  for (const [lineIndex, rawLine] of reportForNumericAudit.split("\n").entries()) {
    if (/^\s*#{1,6}\s+/.test(rawLine)) continue;
    const line = rawLine
      .replace(/^\s*[0-9]+\.\s*/, "")
      .replace(/^\s*\|\s*[0-9]+\s*\|/, "| |");
    const reportNumbers = new Set(numericTokens(line).filter((token) => {
      if (token === "120") return false;
      const single = token.match(/^\d+$/) ? Number(token) : null;
      return single == null || single < 1900 || single > 2099;
    }));
    if (!reportNumbers.size) continue;
    const referencedIds = reportClaimIds(rawLine);
    if (!referencedIds.length) {
      issues.push(
        `Report line ${lineIndex + 1} numeric facts ${[...reportNumbers].join(", ")} have no evidence-matrix claim reference.`,
      );
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
    const unsupportedNumbers = [...reportNumbers].filter((token) => !supportedNumbers.has(token));
    if (unsupportedNumbers.length) {
      issues.push(
        `Report line ${lineIndex + 1} numeric facts ${unsupportedNumbers.join(", ")} are not present in the cited claim evidence.`,
      );
    }
  }

  const practical = reportSection(reportText, "实际处置|实用|怎么办|Practical");
  const numberedItems = practical.split(/\n(?=\s*[0-9]+\.\s+)/).filter((item) => /^\s*[0-9]+\.\s+/.test(item));
  if (numberedItems.some((item) => !hasClaimMarker(item))) {
    issues.push("Every numbered practical-action item must cite at least one evidence-matrix claim.");
  }
  const practicalActionLines = practical
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^(?:(?:\*\*)?第[一二三四五六七八九十]+步|(?:\*\*)?[0-9]+[.、]|[-*+]\s+)/.test(line));
  if (practicalActionLines.some((line) => !hasClaimMarker(line))) {
    issues.push("Every practical-action step or bullet must cite at least one evidence-matrix claim.");
  }
  if (unsupportedSelfCarePattern.test(practical)) {
    issues.push("The practical answer must not add unsupported advice about antacids or waiting for symptom changes.");
  }
  if (nonEmpty(runReceipt?.question) && !suxiaoPattern.test(runReceipt.question) && suxiaoPattern.test(reportText ?? "")) {
    issues.push("A medicine-free question must not introduce Suxiao Jiuxin Wan into the report.");
  }
  if (/速效救心丸/.test(reportText ?? "")
    && !/(?:速效救心丸.{0,120}(?:不应|不能|不得).{0,50}(?:延误|替代).{0,30}(?:呼救|急救|就医|评估)|(?:不应|不能|不得).{0,50}(?:因|以|让)?.{0,30}速效救心丸.{0,60}(?:延误|替代).{0,30}(?:呼救|急救|就医|评估))/s.test(practical)) {
    issues.push("The practical answer must explicitly state that Suxiao Jiuxin Wan must not delay emergency care.");
  }

  if (deepResearch) {
    const searchLog = parseJsonObject(searchLogText);
    const queries = Array.isArray(searchLog?.queries) ? searchLog.queries : [];
    const sourceRecords = Array.isArray(searchLog?.sourceRecords) ? searchLog.sourceRecords : [];
    const normalizedQueryEntries = queries.map((entry) => ({
      database: typeof entry?.database === "string" ? entry.database.trim().toLowerCase() : "",
      query: typeof entry?.query === "string" ? entry.query.trim().toLowerCase() : "",
    }));
    const normalizedQueries = new Set(
      normalizedQueryEntries.map((entry) => entry.query).filter(Boolean),
    );
    const searchedDatabases = new Set(
      normalizedQueryEntries.map((entry) => entry.database).filter(Boolean),
    );
    const documentedSearches = new Set(
      normalizedQueryEntries
        .filter((entry) => entry.database && entry.query)
        .map((entry) => `${entry.database}\u0000${entry.query}`),
    );
    const includedRecords = sourceRecords.filter((entry) => entry?.included === true);
    const inspectedRecords = includedRecords.filter((entry) => (
      ["full_text", "abstract", "official_page", "structured_record"].includes(entry?.accessLevel)
      && entry.accessLevel !== "bibliographic_only"
    ));
    const screening = searchLog?.screening;

    if (searchLog?.schemaVersion !== 1) {
      issues.push("clinical-evidence-search.json must use schemaVersion 1.");
    }
    if (!queries.length || documentedSearches.size !== queries.length) {
      issues.push("The search log must contain completed, non-empty, non-duplicate search queries.");
    }
    if (Array.isArray(executedSearchQueries)) {
      const executed = new Set(
        executedSearchQueries
          .map((value) => typeof value === "string" ? value.trim().toLowerCase() : "")
          .filter(Boolean),
      );
      const undocumented = [...normalizedQueries].filter((query) => !executed.has(query));
      const unlogged = [...executed].filter((query) => !normalizedQueries.has(query));
      if (undocumented.length || unlogged.length) {
        issues.push("The search log must exactly match successful evidence-search calls from the same run.");
      }
    }
    if (searchedDatabases.size < 2) {
      issues.push("Deep research must search at least two distinct evidence databases or source classes.");
    }
    if (
      !screening
      || !Number.isInteger(screening.recordsIdentified)
      || screening.recordsIdentified < 1
      || !Number.isInteger(screening.recordsAfterDeduplication)
      || screening.recordsAfterDeduplication < 1
      || screening.recordsAfterDeduplication > screening.recordsIdentified
      || !Number.isInteger(screening.sourcesIncluded)
      || screening.sourcesIncluded < 1
      || screening.sourcesIncluded > screening.recordsAfterDeduplication
      || screening.sourcesIncluded !== includedRecords.length
    ) {
      issues.push("The search log must preserve a coherent, internally consistent screening flow.");
    }
    if (inspectedRecords.length !== includedRecords.length) {
      issues.push("Every included source record must have an inspected evidence access level.");
    }
    const stats = runReceipt?.stats;
    if (
      !stats
      || !Number.isInteger(stats.totalSearches)
      || stats.totalSearches !== queries.length
      || !Number.isInteger(stats.recordsIdentified)
      || stats.recordsIdentified !== screening?.recordsIdentified
      || !Number.isInteger(stats.recordsAfterDeduplication)
      || stats.recordsAfterDeduplication !== screening?.recordsAfterDeduplication
      || !Number.isInteger(stats.sourcesIncluded)
      || stats.sourcesIncluded !== screening?.sourcesIncluded
      || !Number.isInteger(stats.distinctPreservedSources)
      || stats.distinctPreservedSources !== distinctSuccessfulSources.size
    ) {
      issues.push("The run-receipt statistics must exactly match the search log and distinct preserved-source count.");
    }
    const largestReferenceNumber = claims.reduce(
      (maximum, claim) => Number.isInteger(claim?.referenceNumber)
        ? Math.max(maximum, claim.referenceNumber)
        : maximum,
      0,
    );
    if (reportReferenceCount < largestReferenceNumber) {
      issues.push("The numbered reference list must resolve every evidence-matrix reference.");
    }
    if (bibliographyEntryCount(referencesText) < reportReferenceCount) {
      issues.push("references.bib must contain a bibliography entry for every numbered report reference.");
    }
    const ledgerLines = String(citationLedgerText).trim().split(/\r?\n/).filter(Boolean);
    if (
      ledgerLines.length < claims.length + 1
      || !/(?:claimId|claim_id).*(?:referenceNumber|reference_number).*(?:supportQuote|support_quote)/i.test(ledgerLines[0] ?? "")
    ) {
      issues.push("citation-ledger.csv must contain a traceability header and one row per evidence-matrix claim.");
    }
    if (
      !nonEmpty(citationAuditText)
      || !/(?:unresolved|未解析)/i.test(citationAuditText)
      || !/(?:duplicate|重复)/i.test(citationAuditText)
      || !/(?:retract|撤稿|更正|correction)/i.test(citationAuditText)
      || !/(?:metadata|元数据)/i.test(citationAuditText)
      || !/(?:claim mismatch|claim-source|claims?.{0,60}(?:verified|checked|audited)|主张不匹配|引文不匹配|主张.{0,20}(?:核对|验证|审计)|逐条.{0,20}(?:核对|验证|审计))/i.test(citationAuditText)
    ) {
      issues.push("citation-audit.md must document unresolved, duplicate, correction/retraction, metadata-only, and claim-mismatch checks.");
    }
    for (const [index, claim] of claims.entries()) {
      const marker = `<!-- claim:${claim?.claimId} -->`;
      const claimLine = String(reportText).split("\n").find((line) => line.includes(marker)) ?? "";
      if (!standardCitationNumbers(claimLine).has(claim?.referenceNumber)) {
        issues.push(`claims[${index}] is not paired with its standard numbered in-text citation.`);
      }
    }
  }

  if (!runReceipt || typeof runReceipt !== "object" || Array.isArray(runReceipt)) {
    issues.push("clinical-evidence-run.json must be an object.");
  } else {
    if (runReceipt.status !== "succeeded") issues.push("The clinical evidence run receipt is not succeeded.");
    if (!Array.isArray(runReceipt.successfulSourceArtifacts)) {
      issues.push("The run receipt must name the distinct successful source artifacts.");
    } else {
      if (runReceipt.successfulSourceArtifacts.some((value) => !validSourceArtifactPath(value))) {
        issues.push("Every successful source artifact must be a safe .evimed-sources workspace path.");
      }
      if (!distinctSuccessfulSources.size) {
        issues.push("The run receipt must name the distinct successful source artifacts.");
      }
    }
    if (deepResearch && successfulArtifacts.size !== distinctSuccessfulSources.size) {
      issues.push("Deep-research source counts must use one canonical text artifact per distinct document; companion XML and Markdown files cannot be counted twice.");
    }
    const checks = runReceipt.qualityChecks;
    if (!checks || typeof checks !== "object" || Array.isArray(checks) || !Object.values(checks).length || Object.values(checks).some((value) => value !== true)) {
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
