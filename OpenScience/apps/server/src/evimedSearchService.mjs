import { HttpError } from "./security.mjs";
import { validateEvimedAccountSettings } from "./evimedAccountService.mjs";
import { evimedSessionEncryptionAvailable, openEvimedSearchReference, sealEvimedSearchReference } from "./evimedSessionCredentials.mjs";
import { evimedSearchAction, evimedCollectionStatus, EVIMED_ACTION_PATHS } from "./evimedSearchActions.mjs";

export const EVIMED_SEARCH_CATEGORIES = Object.freeze(["literature", "guidelines", "drugs", "trials"]);
const SEARCH_TYPES = { literature: "paper", guidelines: "guide", drugs: "instruction", trials: "" };
const SEARCH_PATHS = { literature: "FineScreenController/search", guidelines: "archive-api/guide/search", drugs: "drug-api/instructions/pages", trials: "clinical-api/getClinical" };
const DETAIL_PATHS = { literature: "FineScreenController/selectLiteratureDetails", guidelines: "archive-api/guide/guideDetails", drugs: "drug-api/instructions/text" };
const DRUG_SOURCES = new Set(["NMPA", "FDA", "EMA", "PMDA"]);
const FACET_PATHS = {
  literature: {
    timeline: "FineScreenController/chart", articleType: "FineScreenController/leftSidebarMiddle",
    journalPartition: "FineScreenController/leftSidebarJournal", keyWords: "FineScreenController/leftSidebarBottom",
    p: "FineScreenController/leftSidebarP", ic: "FineScreenController/leftSidebarIc", jcrPartition: "FineScreenController/leftSidebarJcr",
  },
  guidelines: { timeline: "archive-api/guide/filter/ysar/get", filters: "archive-api/guide/filter/get", departments: "archive-api/guide/department/" },
  drugs: { source: "drug-api/countrys/list" },
  trials: { clinicalSourceDb: "clinical-api/evimed/source" },
};
const FILTER_FIELDS = {
  literature: ["articleType", "keyWords", "p", "ic", "jcrPartition", "journalPartition", "smallJcr", "bidJcr"],
  guidelines: ["zdzs", "keywords", "sType", "firstLevelDepartment", "secondLevelDepartment"],
  drugs: [],
  trials: ["studyType", "testPhase", "recruitmentStatus", "associatedArticles", "clinicalSourceDb", "minSampleSize", "maxSampleSize"],
};
const ARRAY_FILTERS = ["articleType", "keyWords", "p", "ic", "jcrPartition", "journalPartition", "zdzs", "keywords", "sType", "firstLevelDepartment", "secondLevelDepartment", "studyType", "testPhase", "recruitmentStatus", "associatedArticles"];
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
/** Only generated scalar facts reach private diagnostics. @type {WeakMap<Error,string>} */
const FAILURE_DETAILS = new WeakMap();
const OPERATIONS = new Map(/** @type {Array<[string,string]>} */ ([
  ["FineScreenController/screen", "screen"],
  ...Object.entries(SEARCH_PATHS).map(([category, path]) => [path, `${category}-search`]),
  ...Object.entries(DETAIL_PATHS).map(([category, path]) => [path, `${category}-detail`]),
  ...Object.entries(FACET_PATHS).flatMap(([category, paths]) => Object.entries(paths).map(([key, path]) => [path, `${category}-${key}`])),
  ...Object.entries(EVIMED_ACTION_PATHS).map(([name, path]) => [path, `action-${name}`]),
]));
/** @param {unknown} error */
export const evimedSearchFailureDetail = error => error instanceof Error ? FAILURE_DETAILS.get(error) ?? "" : "";

/** Provider words are inspected only in memory and never retained. @param {Record<string,any>} answer */
function refusalReason(answer) {
  const message = [answer.msg, answer.message].filter(value => typeof value === "string").map(value => value.slice(0, 512)).join(" ");
  if (/登录|认证|凭证|token.{0,12}(?:失效|无效|过期)|invalid token|token expired|unauthorized|unauthenticated|invalid credential/i.test(message)) return "authorization";
  if (/权限|会员|订阅|余额|积分|额度|permission|forbidden|subscription|balance|quota/i.test(message)) return "permission";
  if (/验证码|captcha|challenge/i.test(message)) return "challenge";
  if (/参数|不能为空|请求数据|invalid input|invalid parameter|missing parameter/i.test(message)) return "invalid_input";
  if (/频繁|次数|rate.?limit|too many/i.test(message)) return "rate_limit";
  if (/服务器|系统|服务|繁忙|service|server|busy/i.test(message)) return "service";
  return "other";
}

/** @param {HttpError} error @param {string} path @param {string} reason @param {number|null} [httpStatus] @param {any} [answer] */
function diagnosed(error, path, reason, httpStatus = null, answer = null) {
  const code = typeof answer?.code === "string" || typeof answer?.code === "number" ? String(answer.code).trim() : "";
  FAILURE_DETAILS.set(error, JSON.stringify({
    stage: OPERATIONS.get(path) ?? "unknown", httpStatus,
    businessCode: /^\d{1,6}$/.test(code) ? Number(code) : null,
    success: answer?.success === true ? "true" : answer?.success === false ? "false" : answer && Object.hasOwn(answer, "success") ? "other" : "missing",
    reason,
  }));
  return error;
}
const invalid = () => new HttpError(400, "evimed_search_invalid_input", "The search request is invalid.");
const malformed = () => new HttpError(502, "evimed_search_response_invalid", "The search service returned an invalid response.");
/** @param {unknown} value @returns {value is Record<string, any>} */
const object = value => Boolean(value && typeof value === "object" && !Array.isArray(value));

/** Only explicitly selected text fields leave the upstream boundary. @param {unknown} value @param {number} [limit] */
function text(value, limit = 2000) {
  if (typeof value !== "string" && typeof value !== "number") return "";
  return String(value).slice(0, limit * 4).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/?[A-Za-z][A-Za-z0-9:-]*(?=[\s/>])(?:[^<>"']|"[^"]*"|'[^']*')*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ").replace(/&amp;/gi, "&").replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'").replace(/\s+/g, " ").trim().slice(0, limit);
}

/** @param {unknown[]} values @param {number} [limit] */
const firstText = (values, limit = 2000) => values.map(value => text(value, limit)).find(Boolean) ?? "";

/** No credential-bearing or executable address is exposed as a source link. @param {unknown} value */
function sourceUrl(value) {
  if (typeof value !== "string" || value.length > 4000) return null;
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return null;
    if ([...url.searchParams.keys()].some(key => /token|secret|credential|authorization|api.?key|signature/i.test(key))) return null;
    if (url.hostname === "www.evimed.com" && url.pathname.startsWith("/api-evimed/")) return null;
    return url.href;
  } catch { return null; }
}

/** An upstream must not be able to echo the private header into a selected text field. @param {any} value @param {string} credential @returns {any} */
function withoutCredential(value, credential) {
  if (typeof value === "string") return value.split(credential).join("[redacted]");
  if (Array.isArray(value)) return value.map(item => withoutCredential(item, credential));
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, withoutCredential(item, credential)]));
  return value;
}

/** @param {unknown} value @param {number} [limit] @returns {string[]} */
function strings(value, limit = 12) {
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[;；]/) : [];
  return values.slice(0, limit).map(item => text(object(item) ? item.name ?? item.title : item, 200)).filter(Boolean);
}

/** @param {unknown} value @param {number} minimum @param {number} maximum @param {number} fallback */
function integer(value, minimum, maximum, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) throw invalid();
  return Number(value);
}

/** @param {Record<string, any>} value @param {string[]} allowed */
function fields(value, allowed) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) throw invalid();
}

/** @param {string} category @param {unknown} body */
function searchInput(category, body) {
  if (!EVIMED_SEARCH_CATEGORIES.includes(category)) throw invalid();
  if (!object(body)) throw invalid();
  fields(body, ["query", "page", "pageSize", "filters", "searchRef"]);
  if (typeof body.query !== "string" || !body.query.trim() || body.query.length > 500) throw invalid();
  if (body.searchRef !== undefined && (typeof body.searchRef !== "string" || body.searchRef.length > 10_000)) throw invalid();
  const filters = body.filters ?? {};
  fields(filters, ["language", "startYear", "endYear", "source", "sort", "words", ...FILTER_FIELDS[category]]);
  for (const key of ARRAY_FILTERS) {
    const values = filters[key];
    if (values !== undefined && (!Array.isArray(values) || values.length > 50 || values.some(value => typeof value !== "string" || !value.trim() || value.length > 200))) throw invalid();
  }
  if (filters.words !== undefined && (typeof filters.words !== "string" || filters.words.length > 200)) throw invalid();
  if (filters.clinicalSourceDb !== undefined && (typeof filters.clinicalSourceDb !== "string" || filters.clinicalSourceDb.length > 200)) throw invalid();
  for (const [minimum, maximum, limit, whole] of /** @type {Array<[string,string,number,boolean]>} */ ([["smallJcr", "bidJcr", 1000, false], ["minSampleSize", "maxSampleSize", 99_999_999, true]])) {
    for (const key of [minimum, maximum]) if (filters[key] !== undefined && (typeof filters[key] !== "number" || !Number.isFinite(filters[key]) || filters[key] < 0 || filters[key] > limit || whole && !Number.isInteger(filters[key]))) throw invalid();
    if (filters[minimum] !== undefined && filters[maximum] !== undefined && filters[minimum] > filters[maximum]) throw invalid();
  }
  for (const key of ["sType", "associatedArticles"]) if (filters[key]?.some(value => !/^\d{1,4}$/.test(value))) throw invalid();
  if (filters.associatedArticles?.some(value => !["0", "1"].includes(value))) throw invalid();
  if (filters.language !== undefined && !["", "zh", "en"].includes(filters.language)) throw invalid();
  if (filters.sort !== undefined && !["comprehensive", "relevance", "newest", "oldest", "impact-high", "impact-low"].includes(filters.sort)) throw invalid();
  if (filters.sort?.startsWith("impact-") && (category !== "literature" || filters.language !== "en")) throw invalid();
  if (["drugs", "trials"].includes(category) && ["oldest", "impact-high", "impact-low"].includes(filters.sort)) throw invalid();
  for (const key of ["startYear", "endYear"]) if (filters[key] !== undefined) integer(filters[key], 1800, 2200, 0);
  if (filters.startYear !== undefined && filters.endYear !== undefined && filters.startYear > filters.endYear) throw invalid();
  if (filters.source !== undefined && (typeof filters.source !== "string" || filters.source.length > 16)) throw invalid();
  if (category === "drugs" && filters.source && !DRUG_SOURCES.has(filters.source)) throw invalid();
  if (category === "trials" && filters.source && !["0", "1", "2"].includes(filters.source)) throw invalid();
  if (["literature", "guidelines"].includes(category) && filters.source) throw invalid();
  if (["drugs", "trials"].includes(category) && filters.language) throw invalid();
  if (category === "drugs" && (filters.startYear !== undefined || filters.endYear !== undefined || filters.sort === "newest")) throw invalid();
  return { query: body.query.trim(), page: integer(body.page, 1, 1000, 1), pageSize: integer(body.pageSize, 1, 50, 10), filters };
}

/** The parameters follow the Vue search page's category-specific filter contracts. @param {string} category @param {ReturnType<typeof searchInput>} input @param {string} screenId */
function upstreamSearch(category, input, screenId) {
  const { query, page, pageSize, filters: f } = input;
  const base = { pageNum: page, pageSize, screenId };
  const years = { startYear: f.startYear === undefined ? "" : String(f.startYear), endYear: f.endYear === undefined ? "" : String(f.endYear) };
  if (category === "literature") return {
    ...base, journalDivisions: [], type: 1, language: f.language === "zh" ? [1] : f.language === "en" ? [2] : [],
    hasPdf: 0, articleType: f.articleType ?? [], keyWords: f.keyWords ?? [], documentStatus: 0, ...years,
    searchDomain: { searchRange: [1, 2, 3, 4], searchWord: f.words ?? "" }, smallJcr: f.smallJcr === undefined ? "" : String(f.smallJcr), bidJcr: f.bidJcr === undefined ? "" : String(f.bidJcr),
    sortBasis: ["newest", "oldest"].includes(f.sort) ? 2 : f.sort?.startsWith("impact-") ? 1 : f.sort === "relevance" ? 5 : 0,
    sortDirection: ["oldest", "impact-low"].includes(f.sort) ? 1 : ["newest", "relevance", "impact-high"].includes(f.sort) ? 2 : null,
    ic: f.ic ?? [], p: f.p ?? [], jcrPartition: f.language === "en" ? f.jcrPartition ?? [] : [], journalPartition: f.journalPartition ?? [], choice: 1,
  };
  if (category === "guidelines") return {
    ...base, zdzs: f.zdzs ?? [], keywords: f.keywords ?? [], ...years, firstLevelDepartment: (f.firstLevelDepartment ?? []).join(), secondLevelDepartment: (f.secondLevelDepartment ?? []).join(), words: f.words ?? "", sType: (f.sType ?? []).map(Number),
    language: f.language || "all", sortBy: ["newest", "oldest"].includes(f.sort) ? 1 : 0, sort: f.sort === "newest" ? 0 : f.sort === "oldest" ? 1 : 2,
  };
  if (category === "drugs") return { words: f.words ?? "", source: f.source ?? "", queryId: screenId, queryStr: query, pageSize, pageNum: page };
  const registry = Number(f.source ?? "0");
  const trial = { id: screenId, pageNum: page, pageSize, type: 0, change: [registry], registrationTimeSort: 2, associatedArticles: registry === 1 ? (f.associatedArticles ?? []).map(Number) : [], searchData: f.words ?? "" };
  if (registry === 2) return { ...trial, language: "", ...years, source: f.clinicalSourceDb ?? "" };
  return { ...trial, startRegistrationTime: years.startYear, endRegistrationTime: years.endYear, minSampleSize: f.minSampleSize === undefined ? "" : String(f.minSampleSize), maxSampleSize: f.maxSampleSize === undefined ? "" : String(f.maxSampleSize), testPhase: f.testPhase ?? [],
    ...(registry === 0 ? { studyType: f.studyType ?? [] } : { recruitmentStatus: f.recruitmentStatus ?? [] }) };
}

/** Facet counts describe the whole query, never one result page. @param {unknown} value */
function facetCount(value) {
  if (value === "" || value === null || value === undefined || typeof value === "boolean") return undefined;
  const count = Number(value);
  return Number.isInteger(count) && count >= 0 && count <= 1_000_000_000 ? count : undefined;
}

/** @param {unknown} value @param {string} [mode] @returns {Array<{value:string,label:string,count?:number,parent?:string}>} */
function facetOptions(value, mode = "name") {
  const rows = Array.isArray(value) ? value.slice(0, 150) : object(value) ? Object.entries(value).slice(0, 150).map(([name, count]) => ({ name, value: count })) : [];
  const seen = new Set();
  return rows.flatMap(row => {
    const label = text(object(row) ? row.name ?? row.label ?? row.title ?? row.value ?? row.id : row, 200);
    const optionValue = text(object(row) ? mode === "type" ? row.value ?? row.id ?? label : mode === "identity" ? row.name ?? row.id ?? row.value ?? label : label : row, 200);
    if (!label || !optionValue || seen.has(optionValue)) return [];
    seen.add(optionValue);
    const count = object(row) ? facetCount(row.count ?? row.cnt ?? row.num ?? (mode === "name" || mode === "identity" && row.name !== undefined ? row.value : undefined)) : undefined;
    return [{ value: optionValue, label, ...(count === undefined ? {} : { count }) }];
  });
}

/** @param {unknown} data @returns {Array<{year:number,count:number}>} */
function timelineRows(data) {
  if (!object(data) || !Array.isArray(data.name) || !Array.isArray(data.value) || data.name.length !== data.value.length) throw malformed();
  const years = new Map();
  for (let index = 0; index < Math.min(data.name.length, 401); index++) {
    const year = Number(data.name[index]); const count = facetCount(data.value[index]);
    if (Number.isInteger(year) && year >= 1800 && year <= 2200 && count !== undefined) years.set(year, count);
  }
  if (data.name.length && !years.size) throw malformed();
  return [...years].sort(([a], [b]) => a - b).map(([year, count]) => ({ year, count }));
}

/** @param {unknown} value */
function departmentOptions(value) {
  const data = object(value) ? value : {};
  /** @type {Map<string,string>} */
  const parents = new Map();
  for (const row of Array.isArray(data.department) ? data.department.slice(0, 150) : []) {
    if (!object(row)) continue;
    for (const [parent, children] of Object.entries(row)) if (Array.isArray(children)) {
      for (const child of children.slice(0, 150)) { const name = text(child, 200); if (name) parents.set(name, text(parent, 200)); }
    }
  }
  const raw = data.administrativeTwo ?? data.administrative ?? [...parents.keys()];
  return facetOptions(raw, "identity").map(option => ({ ...option, ...(parents.has(option.value) ? { parent: parents.get(option.value) } : {}) }));
}

/** These uncounted options are the Vue registry contract's enums. @param {string} registry */
function trialFacetGroups(registry) {
  const options = values => values.map(value => ({ value, label: value }));
  if (registry === "0") return [
    { key: "studyType", label: "研究类型", options: options(["干预性研究", "预防性研究", "诊断试验", "病因学/相关因素研究", "预后研究", "治疗研究", "基础科学研究", "卫生服务研究", "流行病学研究", "观察性研究", "筛查"]) },
    { key: "testPhase", label: "试验阶段", options: options(["探索性研究/预试验/0", "I期临床试验/1", "II期临床试验/2", "II-III期临床试验/2-3", "III期临床试验/3", "IV期临床试验/4", "上市后药物/4", "治疗新技术临床试验", "诊断试验新技术临床试验", "回顾性研究", "其他/N/A"]) },
  ];
  if (registry === "1") return [
    { key: "associatedArticles", label: "关联文章", options: [{ value: "1", label: "有" }, { value: "0", label: "无" }] },
    { key: "recruitmentStatus", label: "招募状态", options: options(["Not yet recruiting/尚未招募", "Recruiting/招募中", "Enrolling by invitation/通过邀请注册", "Active, not recruiting/活跃，但未招募", "Suspended/暂停", "Terminated/终止", "Unknown status/未知状态", "Withdrawn/撤回", "Completed/完成"]) },
    { key: "testPhase", label: "试验阶段", options: options(["Early Phase 1/早期1期临床试验", "Phase 1/1期临床试验", "Phase 2/2期临床试验", "Phase 3/3期临床试验", "Phase 4/4期临床试验", "Not Applicable/不适用"]) },
  ];
  return [];
}

/** @param {Record<string, any>} item @param {string} category @param {number} index */
function listItem(item, category, index) {
  const id = firstText([item.id, item.registerNo, item.pdfName, item.pdf_name, item.fileName, item.file_name,
    item.literatureId, item.literature_id, item.paperId, item.paper_id, item.articleId, item.article_id,
    item.documentId, item.document_id, item.docId, item.doc_id, item.guideId, item.guide_id, item.archiveId, item.archive_id], 512) || `${category}-${index + 1}`;
  const title = category === "drugs" ? firstText([item.simpleGenericNames, item.genericNames, item.commonName, item.name], 500)
    : firstText([item.title, item.name, item.publicTitle, item.scientificTitle, item.Title], 500);
  const source = firstText([item.source, item.journal, item.cc, item.registerNo, item.Journal], 200);
  const subtitle = category === "drugs" ? firstText([item.tradeNames, item.enterpriseName, item.country], 500)
    : category === "trials" ? firstText([item.registerNo, item.primarySponsor], 500) : firstText([item.journal, item.zdz], 500);
  const summary = firstText([item.summary, item.abstract, item.hs, item.nrjs, item.indication, item.condition, item.Conditions], 3000);
  return { id, title, subtitle, summary, source,
    publishedAt: firstText([item.year, item.fbdate, item.ysar, item.registerDate, item.revisionDate, item.modifyDate, item.approveDate, item.Year].filter(value => value !== 0 && value !== "0"), 100),
    authors: strings(item.authorAndStatus ?? item.author ?? item.authors),
    url: [item.url, item.pdfUrl, item.registerUrl, item.link, item.sourceUrl, item.fullTextUrl].map(sourceUrl).find(Boolean) ?? null,
    doi: text(item.doi, 256) || null,
    tags: strings(category === "trials" ? [item.studyType, item.studyPhase, item.recruitmentStatus] : category === "drugs" ? [item.source] : item.typeShow ?? [item.wxlx]),
  };
}

/** @param {unknown} value @param {number} [depth] */
function contentText(value, depth = 0) {
  if (depth > 8) return "";
  if (Array.isArray(value)) return value.slice(0, 50).map(item => contentText(item, depth + 1)).filter(Boolean).join("\n").slice(0, 12_000);
  if (object(value)) {
    if (["img", "image"].includes(String(value.tag ?? value.type))) return "";
    if (Array.isArray(value.rows)) return contentText([value.headers ?? [], ...value.rows], depth + 1);
    if (Object.hasOwn(value, "header") && Object.hasOwn(value, "value")) return contentText([value.header, value.value], depth + 1);
    const own = ["content_zh", "content_na", "content", "content_en", "text", "value", "name"]
      .map(key => contentText(value[key], depth + 1)).find(Boolean) ?? "";
    const children = contentText(value.elements ?? value.contents ?? [], depth + 1);
    return [own, children].filter(Boolean).join("\n").slice(0, 12_000);
  }
  if (typeof value === "string" && value.trim().startsWith("[")) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed) && parsed.some(item => typeof item !== "number")) return contentText(parsed, depth + 1);
    } catch { /* Bracketed clinical prose is text, not a failed document. */ }
  }
  return text(value, 12_000);
}

const LABEL_SECTIONS = [
  ["warningsMarks", "警告"], ["boxedWarning", "警示语"], ["component", "成份"], ["description", "性状"], ["form", "规格"],
  ["vaccineRecipients", "接种对象"], ["pharmacologyAndIndication", "作用与用途"], ["radionuclideHalflife", "放射性核素半衰期"],
  ["radioactivityAndTime", "放射性活度和标示时间"], ["immunizationProgramesAndDose", "免疫程序和剂量"],
  ["indication", "适应症"], ["dosage", "用法用量"], ["contraindications", "禁忌"], ["precautions", "注意事项"],
  ["radiationAbsorbedDose", "内辐射吸收剂量"], ["introduction", "使用说明"],
  ["adverseReactions", "不良反应"], ["drugInteractions", "药物相互作用"], ["useInPregLact", "孕妇及哺乳期用药"],
  ["useInChildren", "儿童用药"], ["useInElderly", "老年用药"], ["pharmacokinetics", "药代动力学"],
  ["overdosage", "药物过量"], ["clinicalTrial", "临床试验"], ["storage", "贮藏"], ["period", "有效期"],
  ["toxicological", "药理毒理"], ["poison", "毒理研究"], ["pharmacological", "药理作用"], ["mechanismAction", "作用机制"],
  ["pack", "包装"], ["standard", "执行标准"], ["approveCode", "批准文号"], ["companyName", "生产企业"],
  ["marketingAuthorisationHolder", "上市许可持有人"], ["agentCorpName", "境内联系机构"],
];

/** @param {string} category @param {Record<string, any>} data @param {Record<string, any>} parameters */
function detailItem(category, data, parameters) {
  const info = category === "drugs" ? data.info ?? data.drugInfo ?? (object(data.list) ? data.list : data) : data;
  const item = listItem(object(info) ? info : {}, category, 0);
  /** @type {Array<{title:string,text:string}>} */
  const sections = [];
  const add = (title, value) => { const body = contentText(value); if (body && sections.length < 50) sections.push({ title, text: body }); };
  if (category === "literature") {
    for (const [key, title] of [["abstract", "摘要"], ["summary", "概要"], ["objective", "目的"], ["method", "方法"], ["result", "结果"], ["conclusion", "结论"]]) add(title, data[key]);
  } else if (category === "guidelines") {
    for (const [key, title] of [["hs", "摘要"], ["abstract", "摘要"], ["nrjs", "内容简介"], ["summary", "概要"], ["content", "正文"], ["fullText", "全文"]]) add(title, data[key]);
  } else {
    if (object(data.list)) for (const [key, title] of LABEL_SECTIONS) add(title, data.list[key]);
    const list = data.list ?? data.details ?? data.drugDetails;
    if (Array.isArray(list)) for (const row of list.slice(0, 30)) if (object(row)) add(firstText([row.title_zh, row.title_na, row.title_en, row.title, row.name, row.label], 200) || "说明书", row.elements ?? row.contents ?? row.content ?? row.text ?? row.value);
    if (!sections.length) add("说明书", data.html ?? data.content);
  }
  const metadata = [
    ["期刊", data.journal], ["发布机构", data.zdz], ["发布日期", data.fbdate ?? data.ysar ?? data.year],
    ["生产企业", info.enterpriseName ?? info.companyName], ["批准文号", info.approvalNumber ?? info.approvalNo ?? info.approveCode],
    ["修订日期", info.modifyDate], ["规格", info.specifications ?? info.form],
  ].map(([label, value]) => ({ label: String(label), value: contentText(value).slice(0, 1000) })).filter(row => row.value);
  return { title: item.title || text(parameters.name, 500), subtitle: item.subtitle, source: item.source || text(parameters.source, 200),
    url: sourceUrl(data.url ?? data.pdfUrl) ?? item.url, doi: item.doi, sections, metadata };
}

export class EvimedSearchService {
  /** @param {any} config @param {any} store @param {{fetchImpl?:typeof fetch}} [options] */
  constructor(config, store, { fetchImpl = globalThis.fetch } = {}) { this.config = config; this.store = store; this.fetch = fetchImpl; }

  get enabled() {
    if (!this.config.evimedAuthEnabled || !this.config.evimedAccountApiBaseUrl || !evimedSessionEncryptionAvailable(this.config)) return false;
    try { validateEvimedAccountSettings(this.config); return true; } catch { return false; }
  }

  /** @param {any} req @param {any} res */
  async session(req, res) {
    const session = await this.store.evimedSearchSession(req, res);
    if (!this.enabled || !session.available) throw new HttpError(503, "evimed_search_unavailable", "Account search is unavailable on this deployment.");
    if (!session.credential) throw new HttpError(403, "evimed_search_login_required", "Sign in again to authorize account search.");
    return session;
  }

  /** A logout or revocation while the upstream was working must also stop delivery. @param {any} req @param {any} res @param {any} expected */
  async confirmSession(req, res, expected) {
    const current = await this.store.evimedSearchSession(req, res);
    if (current.binding !== expected.binding || current.userId !== expected.userId || current.credential !== expected.credential) {
      throw new HttpError(403, "evimed_search_credential_expired", "The account search authorization changed. Sign in again.");
    }
  }

  /** Only these owned paths are reachable; callers never supply a URL. @param {any} req @param {any} session @param {string} path @param {Record<string, any>} parameters @param {boolean|"PUT"} [get] @param {boolean} [detail] @param {number} [deadline] @param {boolean} [action] */
  async call(req, session, path, parameters, get = false, detail = false, deadline = Date.now() + 30_000, action = false) {
    const settings = validateEvimedAccountSettings(this.config);
    const url = new URL(path, settings.baseUrl);
    if (get === true) for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, String(value));
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw diagnosed(new HttpError(504, "evimed_search_timeout", "The search service timed out."), path, "timeout");
    const signal = AbortSignal.timeout(remaining);
    let response;
    try {
      response = await this.fetch(url, { method: get === true ? "GET" : get === "PUT" ? "PUT" : "POST", headers: {
        accept: "application/json", client: "pc", token: session.credential, ...(get !== true ? { "content-type": "application/json" } : {}),
      }, ...(get !== true ? { body: JSON.stringify(parameters) } : {}), redirect: "error", signal });
    } catch (error) {
      if (signal.aborted || error?.name === "TimeoutError" || error?.name === "AbortError") throw diagnosed(new HttpError(504, "evimed_search_timeout", "The search service timed out."), path, "timeout");
      throw diagnosed(new HttpError(503, "evimed_search_upstream_unavailable", "The search service is unreachable."), path, "network");
    }
    const expired = async (answer = null) => { await this.store.clearEvimedSearchCredential(req); throw diagnosed(new HttpError(403, "evimed_search_credential_expired", "The account search authorization expired. Sign in again."), path, "authorization", response.status, answer); };
    if ([401, 403].includes(response.status)) return expired();
    if (action && response.status === 402) throw new HttpError(402, "evimed_search_balance_insufficient", "The download allowance is insufficient.");
    if (response.status === 429) throw diagnosed(new HttpError(429, "evimed_search_rate_limited", "The search service rate limit was reached."), path, "rate_limit", response.status);
    if (!response.ok) throw diagnosed(new HttpError(503, "evimed_search_upstream_unavailable", "The search service is unavailable."), path, "http", response.status);
    let answer;
    try {
      const chunks = []; let length = 0;
      for await (const chunk of response.body ?? []) { length += chunk.length; if (length > MAX_RESPONSE_BYTES) throw malformed(); chunks.push(Buffer.from(chunk)); }
      answer = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch (error) {
      if (signal.aborted || error?.name === "TimeoutError" || error?.name === "AbortError") throw diagnosed(new HttpError(504, "evimed_search_timeout", "The search service timed out."), path, "timeout", response.status);
      throw diagnosed(malformed(), path, "response_shape", response.status);
    }
    if (!object(answer)) throw diagnosed(malformed(), path, "response_shape", response.status);
    if (["401", "403"].includes(String(answer.code))) return expired(answer);
    if (action && String(answer.code) === "402") throw new HttpError(402, "evimed_search_balance_insufficient", "The download allowance is insufficient.");
    if (action && !["0", "200"].includes(String(answer.code)) && /实名|身份|完善.{0,8}(?:资料|信息)|profile/i.test(String(answer.msg ?? answer.message ?? ""))) throw new HttpError(409, "evimed_search_profile_required", "Complete the EviMed account profile before downloading.");
    if (String(answer.code) === "429") throw diagnosed(new HttpError(429, "evimed_search_rate_limited", "The search service rate limit was reached."), path, "rate_limit", response.status, answer);
    const accepted = detail ? answer.code === undefined || ["0", "200"].includes(String(answer.code)) : String(answer.code) === "200";
    if (!accepted || answer.success === false) throw diagnosed(new HttpError(503, "evimed_search_upstream_unavailable", "The search service refused the request."), path, refusalReason(answer), response.status, answer);
    return answer.data;
  }

  /** @param {any} req @param {any} res @param {string} category @param {unknown} body */
  async search(req, res, category, body) {
    const input = searchInput(category, body);
    const session = await this.session(req, res);
    const deadline = Date.now() + 30_000;
    const screen = await this.call(req, session, "FineScreenController/screen", {
      generalOrFineScreen: input.query, queryStr: input.query, screenId: null, screenMap: null, excludeSynonyms: null,
      translateStatus: 1, type: 1, retain: false, searchRange: 0, searchType: SEARCH_TYPES[category],
    }, false, false, deadline);
    const screenId = object(screen) ? text(screen.screenId, 512) : "";
    if (!screenId) throw malformed();
    await this.confirmSession(req, res, session);
    if (category === "guidelines" && input.filters.secondLevelDepartment?.length && !input.filters.firstLevelDepartment?.length) {
      const data = await this.call(req, session, FACET_PATHS.guidelines.departments, {}, true, false, deadline);
      input.filters.firstLevelDepartment = [...new Set(departmentOptions(data).filter(option => input.filters.secondLevelDepartment.includes(option.value)).map(option => option.parent).filter(Boolean))];
    }
    const result = await this.call(req, session, SEARCH_PATHS[category], upstreamSearch(category, input, screenId), category === "drugs", false, deadline);
    if (!object(result)) throw malformed();
    const rows = result.list ?? result.records;
    if (!Array.isArray(rows)) throw malformed();
    const items = rows.slice(0, input.pageSize).filter(object).map((row, index) => {
      const item = listItem(row, category, index);
      /** @type {Record<string,string>} */
      let parameters = { id: firstText([row.id, row.literatureId, row.literature_id, row.paperId, row.paper_id, row.articleId, row.article_id,
        row.documentId, row.document_id, row.docId, row.doc_id, row.guideId, row.guide_id, row.archiveId, row.archive_id], 512), screenId };
      if (category === "guidelines") parameters.name = firstText([row.name, row.title], 500);
      if (category === "drugs") parameters = { screenId, source: firstText([row.source, input.filters.source], 16).toLowerCase(), pdfName: firstText([row.pdfName, row.pdf_name, row.fileName, row.file_name, row.name, row.id], 512) };
      const canRead = category !== "trials" && (category === "drugs" ? parameters.pdfName && DRUG_SOURCES.has(parameters.source.toUpperCase()) : parameters.id || category === "guidelines" && parameters.name);
      const detailRef = canRead ? sealEvimedSearchReference(this.config, session, category, parameters) : null;
      const actionRef = canRead ? sealEvimedSearchReference(this.config, session, category, { ...parameters, screenId, name: parameters.name || item.title, title: item.title }) : null;
      return { ...item, detailRef, actionRef, collected: evimedCollectionStatus(row) };
    });
    const count = Number(result.total ?? result.totalCount ?? items.length);
    if (!Number.isFinite(count) || count < 0 || count > 1_000_000_000) throw malformed();
    await this.confirmSession(req, res, session);
    return withoutCredential({ category, query: input.query, page: input.page, pageSize: input.pageSize, total: Math.floor(count), items }, session.credential);
  }

  /** Facets load independently so a slow distribution cannot delay readable results. @param {any} req @param {any} res @param {string} category @param {unknown} body */
  async facets(req, res, category, body) {
    const input = searchInput(category, body);
    const session = await this.session(req, res);
    const deadline = Date.now() + 30_000;
    /** @type {{timeline:Array<{year:number,count:number}>,groups:Array<{key:string,label:string,options:Array<{value:string,label:string,count?:number,parent?:string}>}>,unavailable:string[]}} */
    const output = { timeline: [], groups: [], unavailable: [] };
    if (["literature", "guidelines"].includes(category)) output.groups.push({ key: "language", label: "语言", options: [{ value: "zh", label: "中文" }, { value: "en", label: "英文" }] });
    if (category === "trials") output.groups.push({ key: "source", label: "数据来源", options: [{ value: "0", label: "ChiCTR" }, { value: "1", label: "ClinicalTrials.gov" }, { value: "2", label: "CENTRAL" }] }, ...trialFacetGroups(input.filters.source ?? "0"));
    let screenId = "";
    if (category !== "trials") {
      const screen = await this.call(req, session, "FineScreenController/screen", {
        generalOrFineScreen: input.query, queryStr: input.query, screenId: null, screenMap: null, excludeSynonyms: null,
        translateStatus: 1, type: 1, retain: false, searchRange: 0, searchType: SEARCH_TYPES[category],
      }, false, false, deadline);
      screenId = object(screen) ? text(screen.screenId, 512) : "";
      if (!screenId) throw malformed();
      await this.confirmSession(req, res, session);
    }
    const params = upstreamSearch(category, input, screenId);
    const paths = Object.entries(FACET_PATHS[category]).filter(([key]) => !(key === "jcrPartition" && input.filters.language !== "en") && !(category === "trials" && input.filters.source !== "2"));
    const answers = await Promise.allSettled(paths.map(async ([key, path]) => {
      const get = ["departments", "source", "clinicalSourceDb"].includes(key);
      const parameters = key === "source" ? { queryId: screenId, queryStr: input.query } : get ? {} : params;
      const data = await this.call(req, session, path, parameters, get, false, deadline);
      if (key === "timeline") return { timeline: timelineRows(data), groups: [] };
      const group = (name, label, values, mode = "name") => ({ key: name, label, options: facetOptions(values, mode) });
      if (category === "literature") {
        const sourceKeys = { articleType: ["middle", "研究类型"], journalPartition: ["journal", "核心期刊"], keyWords: ["bottom", "关键词"], p: ["p", "研究对象（P）"], ic: ["ic", "干预 / 对照（I/C）"], jcrPartition: ["jcr", "期刊分区（JCR）"] };
        if (!object(data) || !Object.hasOwn(data, sourceKeys[key][0])) throw malformed();
        return { groups: [group(key, sourceKeys[key][1], data[sourceKeys[key][0]], key === "articleType" ? "type" : "name")] };
      }
      if (key === "filters") {
        if (!object(data)) throw malformed();
        const types = data.sType ?? data.types ?? data.type ?? data.articleType;
        return { groups: [group("sType", "类型", facetOptions(types, "type").length ? types : [{ name: "指南", value: "0" }, { name: "共识", value: "1" }], "type"), group("zdzs", "制定者", data.zdzs, "identity"), group("keywords", "关键词", data.keywords, "identity")] };
      }
      if (key === "departments") {
        if (!object(data)) throw malformed();
        return { groups: [{ key: "secondLevelDepartment", label: "科室", options: departmentOptions(data) }] };
      }
      if (key === "source") {
        if (!Array.isArray(data)) throw malformed();
        const names = { NMPA: "中国 NMPA", FDA: "美国 FDA", EMA: "欧盟 EMA", PMDA: "日本 PMDA" };
        return { groups: [{ key: "source", label: "说明书来源", options: [...new Set(data.map(value => text(value, 16).toUpperCase()))].filter(value => DRUG_SOURCES.has(value)).map(value => ({ value, label: names[value] })) }] };
      }
      if (!Array.isArray(data) && !object(data)) throw malformed();
      return { groups: [group("clinicalSourceDb", "来源", data, "identity")] };
    }));
    for (let index = 0; index < answers.length; index++) {
      const answer = answers[index];
      if (answer.status === "rejected") {
        if (answer.reason?.status === 401 || answer.reason?.status === 403) throw answer.reason;
        const key = paths[index][0];
        output.unavailable.push(...(key === "filters" ? ["sType", "zdzs", "keywords"] : key === "departments" ? ["secondLevelDepartment"] : [key]));
      } else {
        if (answer.value.timeline) output.timeline = answer.value.timeline;
        output.groups.push(...answer.value.groups);
      }
    }
    await this.confirmSession(req, res, session);
    return withoutCredential(output, session.credential);
  }

  /** @param {any} req @param {any} res @param {string} category @param {unknown} body */
  async detail(req, res, category, body) {
    if (!EVIMED_SEARCH_CATEGORIES.includes(category)) throw invalid();
    if (!object(body)) throw invalid();
    fields(body, ["detailRef"]);
    if (typeof body.detailRef !== "string" || !body.detailRef || body.detailRef.length > 10_000) throw invalid();
    const session = await this.session(req, res);
    if (category === "trials") throw new HttpError(404, "evimed_search_detail_unavailable", "The trial is available through its registry link.");
    const parameters = openEvimedSearchReference(this.config, session, category, body.detailRef);
    if (!parameters) throw new HttpError(403, "evimed_search_reference_invalid", "The search detail reference is invalid or expired.");
    const detailParameters = category === "drugs" ? { source: parameters.source, pdfName: parameters.pdfName } : parameters;
    const answer = await this.call(req, session, DETAIL_PATHS[category], detailParameters, true, true);
    if (!object(answer)) throw malformed();
    await this.confirmSession(req, res, session);
    const item = detailItem(category, answer, parameters);
    const info = category === "drugs" ? answer.info ?? answer.drugInfo ?? answer.list ?? answer : answer;
    return withoutCredential({ ...item, id: parameters.id || parameters.pdfName || parameters.name,
      actionRef: sealEvimedSearchReference(this.config, session, category, { ...parameters, title: item.title, name: parameters.name || item.title }),
      collected: evimedCollectionStatus(info) }, session.credential);
  }

  /** @param {any} req @param {any} res @param {string} category @param {string} operation @param {unknown} body */
  async action(req, res, category, operation, body) { return evimedSearchAction(this, req, res, category, operation, body); }
}
