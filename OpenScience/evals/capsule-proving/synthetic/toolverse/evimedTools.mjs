/**
 * Our own research tools as chainable nodes. The MCP server publishes input schemas only (no output schema), so the
 * inputs below are a curated subset of the real `inputSchema` properties (checked against `evimedSchema.json`, a
 * snapshot of `server.py` TOOL_DEFINITIONS) and the output fields are curated from what each tool's description says it
 * returns. Only the parameters a task would plausibly fill are listed as inputs.
 * @module capsule-proving/synthetic/toolverse/evimedTools
 */
import { tool } from './toolSpec.mjs';

const S = 'evimed';
export const EVIMED_TOOLS = [
  tool('term_normalize', S, 'Normalize a medical term with the bilingual vocabulary.', ['term:drugName'], ['canonicalName:drugName', 'normalizedQuery:searchQuery']),
  tool('drug_term_normalize', S, 'Normalize a drug name against RxNorm.', ['term:drugName'], ['rxcui:rxcui', 'canonicalName:drugName']),
  tool('literature_search', S, 'Search the biomedical literature.', ['query:searchQuery'], ['topPmid:pmid', 'topDoi:doi', 'topPmcid:pmcid', 'pmids:pmid[]', 'totalCount:count']),
  tool('reference_list', S, 'The reference list of one paper.', ['identifier:pmid|doi|pmcid'], ['firstReferenceDoi:doi', 'referenceCount:count']),
  tool('identifier_resolve', S, 'Link PMIDs, PMCIDs and DOIs to one another.', ['identifiers:pmid[]'], ['resolvedPmcid:pmcid', 'resolvedDoi:doi']),
  tool('open_access_full_text', S, 'Preserve the open-access full text of a paper.', ['identifier:pmcid|pmid|doi'], ['sourceId:sourceId', 'wordCount:count']),
  tool('locate_quote', S, 'Find a quotation in a preserved source.', ['sourceId:sourceId', 'quote:quoteText'], ['matchCount:count']),
  tool('clinical_trial_search', S, 'Search one clinical-trial registry.', ['query:searchQuery', 'recruitmentStatus:recruitmentStatus'], ['topNctId:nctId', 'nctIds:nctId[]', 'totalCount:count']),
  tool('clinical_trial_snapshot', S, 'Read one ClinicalTrials.gov record whole.', ['nctId:nctId'], ['sourceId:sourceId', 'enrollment:quantity']),
  tool('trial_registry_record', S, 'Fetch one registry record as structured fields.', ['registryId:nctId'], ['primaryOutcome:text', 'enrollment:quantity']),
  tool('dailymed_label', S, 'A US drug label from DailyMed.', ['drug:drugName'], ['setid:setid', 'version:count']),
  tool('drug_label_search', S, 'Search drug labels by drug and jurisdiction.', ['drug:drugName', 'jurisdiction:jurisdiction'], ['labelId:labelId', 'sectionText:text']),
  tool('adr_case_query', S, 'Query adverse-event cases for a drug.', ['drug:drugName', 'adverseEvent:adverseEvent', 'dateFrom:dateFrom'], ['caseCount:count']),
  tool('adr_signal_analysis', S, 'Run ADR signal analysis for a drug and event.', ['drug:drugName', 'adverseEvent:adverseEvent'], ['ror:score', 'signalFlag:boolean']),
  tool('guideline_search', S, 'Search clinical-guideline sources.', ['query:searchQuery', 'jurisdiction:jurisdiction'], ['guidelineTitle:guidelineTitle', 'guidelineUrl:url']),
  tool('web_search', S, 'Search the open web.', ['query:searchQuery'], ['topUrl:url']),
  tool('web_read', S, 'Read one public web page.', ['url:url'], ['sourceId:sourceId', 'pageText:text']),
  tool('kb_search', S, 'Search the researcher\'s own knowledge base.', ['query:searchQuery'], ['sourceId:sourceId', 'passage:text']),
  tool('gene_expression_series', S, 'Preserve a GEO series matrix and platform annotation.', ['accession:gseAccession'], ['captureDir:captureDir', 'sampleCount:count']),
  tool('gene_expression_differential', S, 'Differential expression between two groups of one series.', ['captureDir:captureDir', 'outputDir:outputDir', 'groups:groupLabels'], ['resultPath:filePath', 'significantCount:count']),
  tool('biomedical_source_search', S, 'Query one audited public biomedical source.', ['query:searchQuery'], ['topRecordId:pmid']),
];
