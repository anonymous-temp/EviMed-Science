import { createHash } from "node:crypto";
import { parseFragment } from "parse5";
import { RobotsPolicy } from "./webReadRobots.mjs";
import { HostPacer } from "./webReadLimits.mjs";
import { evidenceHash, evidencePublicExcerpt, evidencePublicationStatus } from "./evidenceCardContent.mjs";

/** Only explicit bibliographic notices count; ordinary comments are not corrections.
 * Undefined means that the record supplied no status, null means verified clear.
 * @param {any} record */
function publicationStatus(record) {
  const types = record.pubTypeList?.pubType ?? [];
  const relations = record.commentCorrectionList?.commentCorrection ?? [];
  const kindOf = (/** @type {string} */ type) => {
    const normalized = type.toLowerCase().replace(/\s+/g, " ").trim();
    if (["retracted publication", "retraction of publication", "retraction in", "retraction of"].includes(normalized)) return "retracted";
    if (["expression of concern", "expression of concern in", "expression of concern for"].includes(normalized)) return "concern";
    if (["published erratum", "erratum in", "erratum for", "corrected and republished in", "corrected and republished from"].includes(normalized)) return "corrected";
    return null;
  };
  const notices = [];
  const kinds = new Set();
  for (const type of types) {
    const kind = typeof type === "string" ? kindOf(type) : null;
    if (kind) { kinds.add(kind); notices.push(type); }
  }
  for (const relation of relations) {
    const kind = typeof relation.type === "string" ? kindOf(relation.type) : null;
    if (kind) {
      kinds.add(kind);
      notices.push([relation.type, relation.reference, relation.note,
        relation.id ? `${relation.source ?? "MED"}:${relation.id}` : null]
        .filter(value=>typeof value === "string" && value.trim()).join(" · ").slice(0,1000));
    }
  }
  const retracted = record.isRetracted === true || String(record.isRetracted).toUpperCase() === "Y";
  if (retracted) { kinds.add("retracted"); notices.push("Europe PMC: isRetracted=Y"); }
  const kind = ["retracted", "concern", "corrected"].find(value=>kinds.has(value));
  if (kind) return evidencePublicationStatus({kind,notices:notices.slice(0,10)});
  if (record.isRetracted === false || String(record.isRetracted).toUpperCase() === "N") return null;
  return undefined;
}

/**
 * What a card keeps of a source the platform has just read: the text, its hash, the receipt of the bytes read, and the public
 * excerpt. The editor's upkeep and the owner's own request to have their sources read (`evidenceSourceVerification.mjs`) store a
 * source exactly this way, so a ✓ means the same thing whichever of them earned it — it is the only writer of these fields.
 * @param {any} source the card's source as it was @param {any} result what the source reader returned
 * @param {string} documentText the text kept (the reader's text, capped) @param {string} checkedAt
 */
export function retainedSource(source, result, documentText, checkedAt) {
  return {
    ...source,
    excerpt: evidencePublicExcerpt(documentText, source.excerpt ?? null),
    documentText,
    sha256: evidenceHash(documentText),
    fetchedSha256: result.receipt?.sha256 ?? evidenceHash(documentText),
    checkedAt,
    // Explicit null clears a previously verified notice; absent metadata does not.
    publicationStatus: evidencePublicationStatus(result.publicationStatus),
    coverage:
      (result.receipt?.truncated || String(result.text ?? "").length > 2000000) ? "excerpt" : result.coverage ??
      (source.coverage === "full-text" && !result.receipt?.truncated
        ? "full-text"
        : (source.coverage ?? "excerpt")),
  };
}

/** Canonical retained scientific text; excludes JATS front matter and references.
 * @param {string} markup @param {boolean} [fullText] */
export function canonicalEvidenceSourceText(markup, fullText = false) {
  const body = fullText
    ? markup.match(/<body(?:\s[^>]*)?>([\s\S]*?)<\/body>/)?.[1]
    : null;
  const tables = fullText
    ? [...markup.matchAll(/<table-wrap(?:\s[^>]*)?>([\s\S]*?)<\/table-wrap>/g)]
        .map((match) => match[1])
        .join(" ")
    : "";
  const scientific = body
    ? `${body.replace(/<table-wrap(?:\s[^>]*)?>[\s\S]*?<\/table-wrap>/g, "")} ${tables}`
    : markup;
  const parts = [];
  const walk = (/** @type {any} */ node) => {
    if (node.nodeName === "#text") parts.push(node.value);
    for (const child of node.childNodes ?? []) walk(child);
  };
  walk(
    parseFragment(
      scientific.replace(/<(?:\/?[A-Za-z][^>]*|![^>]*|\?[^>]*\?)>/g, " "),
    ),
  );
  return parts.join(" ").replace(/\s*</g, " < ").replace(/\s+/g, " ").trim();
}

/** Primary scholarly API text is stable across page chrome updates; all sockets
 * still use the existing pinned transport, robots policy and bounded responses.
 * @param {{readWeb:any,transport:any,userAgent:string,now?:()=>Date}} dependencies */
export function createEvidenceSourceReader({
  readWeb,
  transport,
  userAgent,
  now = () => new Date(),
}) {
  const robots = new RobotsPolicy({ transport, userAgent });
  const pacer = new HostPacer({ intervalMs: 1000 });
  return async (
    /** @type {string} */ rawUrl,
    /** @type {any} */ options = {},
  ) => {
    options.signal?.throwIfAborted();
    const url = new URL(rawUrl);
    const pmid =
      url.hostname === "pubmed.ncbi.nlm.nih.gov"
        ? url.pathname.match(/^\/(\d+)\/?$/)?.[1]
        : null;
    const pmcid = ["pmc.ncbi.nlm.nih.gov", "europepmc.org"].includes(
      url.hostname,
    )
      ? url.pathname.match(/\b(PMC\d+)\b/i)?.[1]?.toUpperCase()
      : null;
    const doi = ["doi.org", "www.doi.org", "dx.doi.org"].includes(url.hostname)
      ? decodeURIComponent(url.pathname).match(/^\/(10\.\d{4,9}\/[^\s"\\]+)$/i)?.[1]?.toLowerCase()
      : null;
    const nct = ["clinicaltrials.gov", "www.clinicaltrials.gov"].includes(url.hostname)
      ? url.pathname.match(/^\/study\/(NCT\d{8})\/?$/i)?.[1]?.toUpperCase()
      : null;
    if (!pmid && !pmcid && !doi && !nct) return readWeb(rawUrl, options);
    const registryFields = "NCTId,BriefTitle,OfficialTitle,OverallStatus,LastUpdatePostDate,DescriptionModule,ConditionsModule,DesignModule,ArmsInterventionsModule,OutcomesModule,EligibilityModule,ParticipantFlowModule,BaselineCharacteristicsModule,OutcomeMeasuresModule,AdverseEventsModule";
    const target = nct
      ? new URL(`https://clinicaltrials.gov/api/v2/studies/${nct}?fields=${registryFields}`)
      : doi
      ? new URL(`https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(`DOI:"${doi}"`)}&format=json&resultType=core`)
      : pmid
      ? new URL(
          `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=EXT_ID%3A${pmid}+AND+SRC%3AMED&format=json&resultType=core`,
        )
      : new URL(
          `https://www.ebi.ac.uk/europepmc/webservices/rest/${pmcid}/fullTextXML`,
        );
    // NLM explicitly authorizes this open API for automated study extraction:
    // https://www.nlm.nih.gov/pubs/techbull/ja25/ja25_clinical_trials_screen-scraping.html
    // This exception is only our constructed exact study endpoint and fixed fields,
    // never caller URLs, redirects, pages or arbitrary ClinicalTrials API requests.
    const verdict = nct
      ? {allowed:true,crawlDelayMs:1000}
      : await robots.check(target, { signal: options.signal });
    if (!verdict.allowed)
      throw Object.assign(
        new Error("The scholarly API refuses automated reading."),
        { code: "web_read_robots_disallowed" },
      );
    await pacer.acquire(target.hostname, {
      crawlDelayMs: verdict.crawlDelayMs,
      signal: options.signal,
    });
    const response = await transport({
      url: target,
      headers: {
        "user-agent": userAgent,
        accept: pmid || doi || nct ? "application/json" : "application/xml",
      },
      signal: options.signal,
      maxBytes: 16 * 1024 * 1024,
    });
    if (response.status < 200 || response.status >= 300)
      throw Object.assign(
        new Error("The primary scholarly record is unavailable."),
        { code: "evidence_source_unavailable" },
      );
    let markup = response.body.toString("utf8"),
      title = "",
      coverage = "full-text";
    let status;
    if (nct) {
      const study = JSON.parse(markup);
      const protocol = study?.protocolSection;
      if (protocol?.identificationModule?.nctId !== nct)
        throw Object.assign(new Error("The registry returned another trial identity."), {code:"evidence_source_identity_mismatch"});
      title = protocol.identificationModule.officialTitle ?? protocol.identificationModule.briefTitle ?? nct;
      // Keep the selected scientific modules only, never registry contact records.
      const selected = {
        identificationModule: {nctId:nct,briefTitle:protocol.identificationModule.briefTitle,officialTitle:protocol.identificationModule.officialTitle},
        statusModule: {overallStatus:protocol.statusModule?.overallStatus,lastUpdatePostDateStruct:protocol.statusModule?.lastUpdatePostDateStruct},
        ...Object.fromEntries(["descriptionModule","conditionsModule","designModule","armsInterventionsModule","outcomesModule","eligibilityModule"].filter(key=>protocol[key]!=null).map(key=>[key,protocol[key]])),
        resultsSection: Object.fromEntries(["participantFlowModule","baselineCharacteristicsModule","outcomeMeasuresModule","adverseEventsModule"].filter(key=>study.resultsSection?.[key]!=null).map(key=>[key,study.resultsSection[key]])),
      };
      if (!protocol.descriptionModule?.briefSummary && !protocol.descriptionModule?.detailedDescription && !Object.keys(selected.resultsSection).length)
        throw Object.assign(new Error("No scientific registry description or posted results."), {code:"evidence_source_empty"});
      markup = `ClinicalTrials.gov trial registry record; registered protocol and any posted results, not a journal publication. ${JSON.stringify(selected)}`;
      coverage = "excerpt";
    } else if (pmid || doi) {
      const records = JSON.parse(markup)?.resultList?.result ?? [];
      const result = records.find(
        (r) => doi ? typeof r.doi === "string" && r.doi.trim().toLowerCase() === doi : String(r.id) === pmid && r.source === "MED",
      );
      if (doi && !result) {
        if (!records.length) return readWeb(rawUrl, options);
        throw Object.assign(new Error("The scholarly API returned another DOI identity."), {code:"evidence_source_identity_mismatch"});
      }
      status = result ? publicationStatus(result) : undefined;
      if (typeof result?.abstractText !== "string" && !status)
        throw Object.assign(
          new Error("The primary record contains no abstract."),
          { code: "evidence_abstract_unavailable" },
        );
      markup = result.abstractText ?? "";
      title = result.title ?? "";
      coverage = markup ? "abstract" : "excerpt";
    }
    const text = canonicalEvidenceSourceText(markup, Boolean(pmcid));
    if (!text && !status)
      throw Object.assign(new Error("No primary source text."), {
        code: "evidence_source_empty",
      });
    return {
      text,
      coverage,
      ...(status !== undefined ? {publicationStatus:status} : {}),
      receipt: {
        url: rawUrl,
        finalUrl: target.href,
        title,
        fetchedAt: now().toISOString(),
        sha256: createHash("sha256").update(response.body).digest("hex"),
        truncated: false,
      },
    };
  };
}
