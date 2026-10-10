// Exact source grounding for public-corpus probes; never reads reference labels.
export const PUBLIC_RELATION_TYPES = Object.freeze(['ACTIVATOR','AGONIST','AGONIST-ACTIVATOR','AGONIST-INHIBITOR','ANTAGONIST','DIRECT-REGULATOR','INDIRECT-DOWNREGULATOR','INDIRECT-UPREGULATOR','INHIBITOR','PART-OF','PRODUCT-OF','SUBSTRATE','SUBSTRATE_PRODUCT-OF']);
export function publicExtractionPrompt(example) {
  const input = {id: example.id, documentId: example.documentId, text: example.text};
  return `Extract every CHEMICAL and GENE mention and chemical-to-gene relation stated in this public abstract. Return ONLY compact JSON, no markdown or commentary: {"entities":[["e1","CHEMICAL","exact source surface",1]],"relations":[["INHIBITOR","e1","e2","exact supporting source quotation"]]}. Each entity tuple is [id,type,exact surface,occurrence]. occurrence is the 1-based occurrence of that exact surface in the entire text, including unannotated occurrences. Include repeated mentions separately. Count occurrences case-sensitively for each exact surface independently: aspirin and Aspirin have separate counts; never use the entity serial number as its occurrence. Copy complete named mention surfaces including modifiers; do not count character offsets. GENE includes proteins. Each relation tuple is [type,chemical mention id,gene mention id,verbatim evidence]. Attach to the actual mentions in the sentence expressing the relation, not another occurrence of their name in the title or a different sentence. Explicit abbreviation/expansion pairs in that statement may both be linked. Do not propagate relations to all coreferent mentions or infer individual members of an unnamed subset. Do not infer subtype pharmacology from prior knowledge: record only what this text attributes to the named compound and target. Co-occurrence, disease association or a phenotype alone is not a chemical-protein relation. A list explicitly tied to a target supports its named members. Relation types: ${PUBLIC_RELATION_TYPES.join(', ')}. Distinguish direct action on activity (INHIBITOR/ACTIVATOR), receptor action (AGONIST/ANTAGONIST), and indirect changes to expression/amount (INDIRECT-DOWNREGULATOR/INDIRECT-UPREGULATOR). SUBSTRATE is acted on by the protein, PRODUCT-OF is produced by it, PART-OF is a component. DIRECT-REGULATOR is direct action with unspecified direction. Quote only the short sentence or clause establishing the relationship; do not invent a quotation or relation. Keep output compact to avoid truncation.\n${JSON.stringify(input)}`;
}
export function groundPublicExtraction(example, raw) {
  const parsed = JSON.parse(raw.replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,''));
  if (!Array.isArray(parsed.entities) || !Array.isArray(parsed.relations)) throw new Error('extraction_arrays_missing');
  const entities=[], relations=[], issues=[], ids=new Set(), spans=new Set();
  for (const row of parsed.entities) {
    if (!Array.isArray(row) || row.length!==4 || typeof row[0]!=='string' || !['CHEMICAL','GENE'].includes(row[1]) || typeof row[2]!=='string' || !row[2] || !Number.isSafeInteger(row[3]) || row[3]<1 || row[3]>example.text.length || ids.has(row[0])) {issues.push({kind:'entity_invalid',row});continue;}
    let start=-1;
    for(let n=0;n<row[3];n++){start=example.text.indexOf(row[2],start+1);if(start<0)break;}
    const span=JSON.stringify([row[1],start,start+row[2].length]);
    if(start<0 || spans.has(span)){issues.push({kind:start<0?'surface_unresolved':'duplicate_span',row});continue;}
    ids.add(row[0]);spans.add(span);
    entities.push({id:row[0],documentId:example.documentId,type:row[1],start,end:start+row[2].length});
  }
  const byId=new Map(entities.map(row=>[row.id,row]));
  const links=new Set();
  for(const row of parsed.relations){
    if(!Array.isArray(row)||![3,4,5].includes(row.length)||!PUBLIC_RELATION_TYPES.includes(row[0])||byId.get(row[1])?.type!=='CHEMICAL'||byId.get(row[2])?.type!=='GENE'){issues.push({kind:'relation_unresolved',row});continue;}
    // Historical three-field archives remain readable. New output carries a
    // checked quotation; this grounds bytes, not the clinical interpretation.
    if(row.length>=4 && (typeof row[3]!=='string'||!row[3]||!example.text.includes(row[3]))){issues.push({kind:'relation_quote_unresolved',row});continue;}
    if(row.length>=4 && !relationQuoteBinding(example.text, byId.get(row[1]), byId.get(row[2]), row[3], row[4])) {issues.push({kind:'relation_quote_endpoint_mismatch',row});continue;}
    const key=JSON.stringify(row.slice(0,3));
    if(links.has(key)){issues.push({kind:'duplicate_relation',row});continue;}
    links.add(key);
    relations.push({type:row[0],arg1:row[1],arg2:row[2],...(row.length>=4?{quote:row[3],quoteLocator:relationQuoteBinding(example.text,byId.get(row[1]),byId.get(row[2]),row[3],row[4])}:{})});
  }
  return {entities,relations,groundingIssues:issues};
}

/** A quotation instance must contain both exact mentions. No inferred coreference. */
export function relationQuoteBinding(text, chemical, gene, quote, occurrence) {
  if (!chemical || !gene || typeof quote !== 'string' || !quote) return null;
  // Without an explicitly verified coreference annotation, separate sentence
  // mentions cannot form a certified endpoint pair. Do not guess an ID repair.
  const left=chemical.start<=gene.start?chemical:gene;
  const right=left===chemical?gene:chemical;
  // Case and script do not determine sentence boundaries. A period followed
  // by whitespace is deliberately conservative: an ambiguous abbreviation
  // remains unresolved rather than supplying an unverified coreference link.
  // Decimal points without intervening whitespace are not separators.
  if (/[.!?]["'”’)\]]*\s|[。！？｡．…]|[\r\n]/u.test(text.slice(left.end,right.start))) return null;
  const starts=[];
  for (let start=text.indexOf(quote);start>=0;start=text.indexOf(quote,start+1)) starts.push(start);
  if (occurrence != null && (!Number.isSafeInteger(occurrence) || occurrence<1 || occurrence>starts.length)) return null;
  const candidates=occurrence == null ? starts : [starts[occurrence-1]];
  const matches=candidates.filter(start=>[chemical,gene].every(entity=>entity.start>=start && entity.end<=start+quote.length));
  if(matches.length!==1) return null;
  return {start:matches[0],end:matches[0]+quote.length,offsetUnit:'utf16'};
}
/** First pass extracts mentions only. The model never chooses its final IDs. */
export function publicEntityPrompt(example) {
  return `Extract every CHEMICAL and GENE (including proteins) mention in this public biomedical abstract. Return ONLY compact JSON: {"entities":[["temporary-id","GENE","exact source surface",1]],"relations":[]}. Each tuple is [temporary-id,type,exact surface,case-sensitive 1-based occurrence of that surface in the complete text]. Include every repeated mention separately, complete protein names and explicit abbreviations. A protein inside a drug-class phrase is still a GENE mention: do not replace it with the whole chemical-class phrase. Do not relabel drugs as genes. Do not infer absent mentions. Occurrences count each exact surface independently, including the title. No relation extraction in this pass.\n${JSON.stringify({id:example.id,documentId:example.documentId,text:example.text})}`;
}
export function freezePublicEntities(example, raw) {
  const parsed=JSON.parse(raw.replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,''));
  const grounded=groundPublicExtraction(example,JSON.stringify({entities:parsed.entities,relations:[]}));
  const entities=grounded.entities.sort((a,b)=>a.start-b.start || a.end-b.end || a.type.localeCompare(b.type)).map((entity,index)=>Object.freeze({...entity,id:`e${index+1}`}));
  return {entities:Object.freeze(entities),groundingIssues:grounded.groundingIssues};
}
/** Second pass can select frozen mention IDs, but cannot redefine mentions. */
export function publicRelationPrompt(example, entities) {
  const mentions=entities.map(entity=>({...entity,surface:example.text.slice(entity.start,entity.end)}));
  return `Extract chemical-to-gene relations explicitly stated in this abstract using ONLY these fixed mention IDs. Return ONLY compact JSON: {"relations":[["INHIBITOR","chemical-id","gene-id","exact supporting quotation",1]]}. Each relation is [type,CHEMICAL id,GENE id,verbatim quotation,case-sensitive 1-based quotation occurrence in the entire text]. Both selected mention spans MUST lie inside that same quotation instance. Include enough exact source context for both endpoints; never use a different occurrence in the title or another sentence. Do not redefine IDs or entities. If a cross-sentence relation depends on inferred coreference, omit it; this evaluator has no verified coreference annotation and cannot certify it. Explicit full-name/abbreviation pairs present in the quotation may each be linked. Include all members of an explicit target-linked compound list; do not infer unnamed subset members. Distinguish INHIBITOR/ACTIVATOR (direct activity), ANTAGONIST/AGONIST (receptors), INDIRECT-DOWNREGULATOR/INDIRECT-UPREGULATOR (expression or amount), SUBSTRATE (acted on by protein), PRODUCT-OF (produced by protein), PART-OF (component), DIRECT-REGULATOR (direct unspecified direction). Do not infer subtype pharmacology or a direct relation from downstream phenotype or co-occurrence. Negated statements do not establish a positive relation. Types: ${PUBLIC_RELATION_TYPES.join(', ')}.\n${JSON.stringify({id:example.id,documentId:example.documentId,text:example.text,mentions})}`;
}
export function groundPublicRelations(example, frozen, raw) {
  const parsed=JSON.parse(raw.replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,''));
  if(!Array.isArray(parsed.relations)) throw new Error('extraction_arrays_missing');
  if(parsed.entities != null) throw new Error('frozen_entities_redefinition');
  const entities=frozen.entities;
  const tuples=entities.map(entity=>{
    const surface=example.text.slice(entity.start,entity.end);
    let occurrence=0;
    for(let start=example.text.indexOf(surface);start>=0 && start<=entity.start;start=example.text.indexOf(surface,start+1)) occurrence++;
    return [entity.id,entity.type,surface,occurrence];
  });
  const malformed=parsed.relations.filter(row=>!Array.isArray(row)||row.length!==5);
  const result=groundPublicExtraction(example,JSON.stringify({entities:tuples,relations:parsed.relations.filter(row=>Array.isArray(row)&&row.length===5)}));
  return {...result,groundingIssues:[...frozen.groundingIssues,...result.groundingIssues,...malformed.map(row=>({kind:'relation_instance_required',row}))]};
}

/** Shared two-pass evaluation workflow; callers archive both native turns. */
export async function extractPublicTwoPass(example, native, onFrozen = async () => {}) {
  const entityPrompt=publicEntityPrompt(example);
  const entityResult=await native({prompt:entityPrompt,filename:example.id+'-entities'});
  if(entityResult.code!==0) throw new Error('native_entity_prediction_failed');
  const frozen=freezePublicEntities(example,entityResult.text);
  await onFrozen(frozen);
  const relationPrompt=publicRelationPrompt(example,frozen.entities);
  const relationResult=await native({prompt:relationPrompt,filename:example.id+'-relations'});
  if(relationResult.code!==0) throw new Error('native_relation_prediction_failed');
  return {prediction:groundPublicRelations(example,frozen,relationResult.text),entityPrompt,relationPrompt,entityResult,relationResult};
}
