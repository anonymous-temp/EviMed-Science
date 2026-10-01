import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { createEvidenceSourceReader } from "../src/evidenceSourceReader.mjs";
import {
  evidenceStructuredContent,
  evidenceHash,
  evidencePublicExcerpt,
} from "../src/evidenceCardContent.mjs";

test("primary abstract reader retains stable scholarly text, raw byte hash and honest coverage", async () => {
  const raw = Buffer.from(
    JSON.stringify({
      resultList: {
        result: [
          {
            id: "12345",
            source: "MED",
            title: "A randomized trial",
            abstractText:
              "<h4>Background</h4><p>A primary trial.</p><h4>Results</h4><p>Benefit was observed.</p>",
          },
        ],
      },
    }),
  );
  const visited = [];
  const reader = createEvidenceSourceReader({
    userAgent: "EviMedBot",
    readWeb: async () => {
      throw new Error("Page chrome must not define scholarly source identity.");
    },
    transport: async ({ url }) => {
      visited.push(url.href);
      return {
        status: 200,
        headers: { "content-type": "text/plain" },
        body:
          url.pathname === "/robots.txt"
            ? Buffer.from("User-agent: *\nAllow: /\n")
            : raw,
      };
    },
  });
  const result = await reader("https://pubmed.ncbi.nlm.nih.gov/12345/");
  assert.equal(
    result.text,
    "Background A primary trial. Results Benefit was observed.",
  );
  assert.equal(result.coverage, "abstract");
  assert.equal(
    result.receipt.sha256,
    createHash("sha256").update(raw).digest("hex"),
  );
  assert.equal(visited.length, 2);
  assert.match(result.receipt.finalUrl, /europepmc\/webservices/);
});
test("non-scholarly primary pages use the existing web reader", async () => {
  const reader = createEvidenceSourceReader({
    userAgent: "EviMedBot",
    readWeb: async (url) => ({ text: "Official notice", url }),
    transport: async () => {
      throw new Error("Not a scholarly API request");
    },
  });
  assert.equal(
    (await reader("https://www.fda.gov/drugs/notice")).text,
    "Official notice",
  );
});
test("risk and rate comparison units must match their measure", () => {
  const comparison = {
    title: "Outcome",
    outcome: "Events",
    timeframe: "Annualized",
    denominator: 100,
    control: { label: "Control", events: 3.09 },
    intervention: { label: "Treatment", events: 2.13 },
    sourceIndexes: [1],
    measure: "rate",
    denominatorUnit: "person-years",
  };
  assert.ok(evidenceStructuredContent({ comparisons: [comparison] }, 1));
  assert.throws(
    () =>
      evidenceStructuredContent(
        { comparisons: [{ ...comparison, denominatorUnit: "people" }] },
        1,
      ),
    { code: "evidence_invalid" },
  );
  assert.throws(
    () =>
      evidenceStructuredContent(
        { comparisons: [{ ...comparison, measure: "risk" }] },
        1,
      ),
    { code: "evidence_invalid" },
  );
});

test("scientific hashes survive JSONB key ordering and nested malformed content is a 400", () => {
  assert.equal(
    evidenceHash({ question: "Q", population: "Adults", answer: "A" }),
    evidenceHash({ answer: "A", question: "Q", population: "Adults" }),
  );
  for (const key of ["sections", "tables", "comparisons"])
    assert.throws(() => evidenceStructuredContent({ [key]: [null] }, 1), {
      code: "evidence_invalid",
    });
});

test("public quote anchors remain bounded for Chinese sources without spaces", () => {
  const paragraph =
    "临床研究报告了患者人群与随访结果，需要结合适用范围理解结论。".repeat(1000);
  const anchor = evidencePublicExcerpt(paragraph);
  assert.ok(anchor.length <= 300);
  assert.ok(anchor.length < paragraph.length);
  const words = [
    ...new Intl.Segmenter("zh", { granularity: "word" }).segment(anchor),
  ].filter((segment) => segment.isWordLike);
  assert.ok(words.length <= 25);
  assert.ok(paragraph.includes(anchor));
  const short = "需要结合适用范围理解结论。";
  assert.equal(evidencePublicExcerpt(paragraph, short), short);
  const english = Array.from(
    { length: 100 },
    (_, index) => `word${index}`,
  ).join(" ");
  assert.equal(evidencePublicExcerpt(english).split(/\s+/).length, 25);
});

test('explicit scholarly notices distinguish status clear, unknown, concern and ordinary comments', async()=>{
  const read = async metadata => {
    const reader=createEvidenceSourceReader({userAgent:'EviMedTest',readWeb:async()=>{throw new Error('Unexpected web fallback');},transport:async({url})=>({status:200,headers:{},body:Buffer.from(url.pathname==='/robots.txt'?'User-agent: *\nAllow: /\n':JSON.stringify({resultList:{result:[{id:'12345',source:'MED',abstractText:'Synthetic abstract',...metadata}]}}))})});
    return reader('https://pubmed.ncbi.nlm.nih.gov/12345/');
  };
  assert.equal((await read({isRetracted:'N'})).publicationStatus,null);
  assert.equal((await read({})).publicationStatus,undefined);
  assert.equal((await read({isRetracted:'N',commentCorrectionList:{commentCorrection:[{type:'Comment in'}]}})).publicationStatus,null);
  assert.equal((await read({commentCorrectionList:{commentCorrection:[{type:'Expression of concern in',reference:'Synthetic official notice'}]}})).publicationStatus.kind,'concern');
});

function officialReader(payload, { robotsText = "User-agent: *\nAllow: /\n", status = 200, fallback = async () => { throw new Error("Unexpected browser fallback"); } } = {}) {
  const requests = [];
  return { requests, reader: createEvidenceSourceReader({ userAgent: "EviMedBot", readWeb: fallback, transport: async request => {
    requests.push(request);
    return {status: request.url.pathname === "/robots.txt" ? 200 : status, headers: {}, body: Buffer.from(request.url.pathname === "/robots.txt" ? robotsText : JSON.stringify(payload))};
  } }) };
}
test("DOI lookup binds exact official DOI, abstract coverage and publisher notice", async () => {
  const payload = {resultList:{result:[{doi:"10.1001/OTHER",abstractText:"Wrong source"}, {doi:"10.1001/JAMACARDIO.2026.4215",title:"Official trial report",abstractText:"<p>Retained primary abstract.</p>",isRetracted:"Y"}]}};
  const {reader,requests} = officialReader(payload);
  const signal = new AbortController().signal;
  const result = await reader("https://doi.org/10.1001/jamacardio.2026.4215", {signal});
  assert.equal(result.text,"Retained primary abstract."); assert.equal(result.coverage,"abstract"); assert.equal(result.publicationStatus.kind,"retracted");
  assert.equal(requests[1].url.searchParams.get("query"),'DOI:"10.1001/jamacardio.2026.4215"');
  assert.equal(requests[1].signal,signal); assert.equal(requests[1].maxBytes,16*1024*1024);
  assert.equal(result.receipt.url,"https://doi.org/10.1001/jamacardio.2026.4215");
  assert.equal(result.receipt.sha256,createHash("sha256").update(JSON.stringify(payload)).digest("hex"));
  assert.equal(result.receipt.truncated,false);
});
test("DOI mismatches cannot become evidence; an unindexed DOI retains normal page fallback", async () => {
  const wrong = officialReader({resultList:{result:[{doi:"10.1001/other",abstractText:"Wrong"}]}});
  await assert.rejects(wrong.reader("https://doi.org/10.1001/jamacardio.2026.4215"),{code:"evidence_source_identity_mismatch"});
  const calls=[]; const absent=officialReader({resultList:{result:[]}}, {fallback:async(url,options)=>{calls.push({url,options});return {text:"Actual official page"};}});
  const signal=new AbortController().signal; assert.equal((await absent.reader("https://doi.org/10.1001/jamacardio.2026.4215",{signal})).text,"Actual official page");
  assert.equal(calls[0].options.signal,signal);
});
test("ClinicalTrials official study identity and selected scientific modules are registry excerpts, never paper full text", async () => {
  const study={protocolSection:{identificationModule:{nctId:"NCT06575348",briefTitle:"Registered study",organization:{fullName:"Unused organization"}},statusModule:{overallStatus:"RECRUITING"},descriptionModule:{briefSummary:"Registered protocol, not efficacy results."},designModule:{enrollmentInfo:{count:100,type:"ESTIMATED"}},contactsLocationsModule:{centralContacts:[{email:"private-contact@example.test"}]}},resultsSection:{outcomeMeasuresModule:{outcomeMeasures:[{title:"Observed outcome",counts:[{value:"10"}]}]},moreInfoModule:{pointOfContact:{email:"private-result@example.test"}}}};
  const {reader,requests}=officialReader(study); const result=await reader("https://clinicaltrials.gov/study/NCT06575348");
  assert.equal(result.coverage,"excerpt"); assert.equal(result.publicationStatus,undefined);
  assert.match(result.text,/trial registry record/); assert.match(result.text,/not a journal publication/); assert.match(result.text,/ESTIMATED/); assert.match(result.text,/Observed outcome/);
  assert.doesNotMatch(result.text,/private-contact|private-result|contactsLocationsModule|moreInfoModule/);
  assert.equal(result.receipt.title,"Registered study"); assert.match(result.receipt.finalUrl,/api\/v2\/studies\/NCT06575348\?/);
  assert.equal(requests.length,1); assert.match(requests[0].url.searchParams.get("fields"),/OutcomeMeasuresModule/);
  assert.equal(result.receipt.sha256,createHash("sha256").update(JSON.stringify(study)).digest("hex"));
});
test("official API sources preserve robots refusals, unavailable records, cancellation and identity checks", async () => {
  const denied=officialReader({}, {robotsText:"User-agent: *\nDisallow: /europepmc/\n"});
  await assert.rejects(denied.reader("https://doi.org/10.1001/jamacardio.2026.4215"),{code:"web_read_robots_disallowed"}); assert.equal(denied.requests.length,1);
  await assert.rejects(officialReader({}, {status:403}).reader("https://clinicaltrials.gov/study/NCT06575348"),{code:"evidence_source_unavailable"});
  await assert.rejects(officialReader({protocolSection:{identificationModule:{nctId:"NCT00000000"},descriptionModule:{briefSummary:"Wrong trial"}}}).reader("https://clinicaltrials.gov/study/NCT06575348"),{code:"evidence_source_identity_mismatch"});
  await assert.rejects(officialReader({protocolSection:{identificationModule:{nctId:"NCT06575348"}}}).reader("https://clinicaltrials.gov/study/NCT06575348"),{code:"evidence_source_empty"});
  const controller=new AbortController(); controller.abort();
  await assert.rejects(officialReader({}).reader("https://doi.org/10.1001/jamacardio.2026.4215",{signal:controller.signal}),{name:"AbortError"});
});

test("only the constructed official ClinicalTrials single-study API has explicit API authorization", async () => {
  const calls=[];
  const {reader,requests}=officialReader({protocolSection:{identificationModule:{nctId:"NCT06575348"},descriptionModule:{briefSummary:"Registered study"}}}, {robotsText:"User-agent: *\nDisallow: /api/\n",fallback:async(url)=>{calls.push(url);return {text:"Existing protected webpage reader"};}});
  await reader("https://clinicaltrials.gov/study/NCT06575348?fields=ContactsLocationsModule&redirect=https://other.example");
  assert.equal(requests.length,1);
  assert.equal(requests[0].url.origin,"https://clinicaltrials.gov");
  assert.equal(requests[0].url.pathname,"/api/v2/studies/NCT06575348");
  assert.ok(!requests[0].url.searchParams.has("redirect"));
  assert.doesNotMatch(requests[0].url.searchParams.get("fields"),/ContactsLocations/);
  for (const url of ["https://clinicaltrials.gov/api/v2/studies/NCT06575348", "https://clinicaltrials.gov/study/NCT06575348/other", "https://other.example/study/NCT06575348", "https://clinicaltrials.gov/api/int/studies"]) {
    assert.equal((await reader(url)).text,"Existing protected webpage reader");
  }
  assert.equal(calls.length,4); assert.equal(requests.length,1);
  await assert.rejects(officialReader({}, {status:302}).reader("https://clinicaltrials.gov/study/NCT06575348"),{code:"evidence_source_unavailable"});
});
