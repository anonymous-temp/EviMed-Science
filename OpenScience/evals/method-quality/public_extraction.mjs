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
    if(!Array.isArray(row)||![3,4].includes(row.length)||!PUBLIC_RELATION_TYPES.includes(row[0])||byId.get(row[1])?.type!=='CHEMICAL'||byId.get(row[2])?.type!=='GENE'){issues.push({kind:'relation_unresolved',row});continue;}
    // Historical three-field archives remain readable. New output carries a
    // checked quotation; this grounds bytes, not the clinical interpretation.
    if(row.length===4 && (typeof row[3]!=='string'||!row[3]||!example.text.includes(row[3]))){issues.push({kind:'relation_quote_unresolved',row});continue;}
    const key=JSON.stringify(row.slice(0,3));
    if(links.has(key)){issues.push({kind:'duplicate_relation',row});continue;}
    links.add(key);
    relations.push({type:row[0],arg1:row[1],arg2:row[2],...(row.length===4?{quote:row[3]}:{})});
  }
  return {entities,relations,groundingIssues:issues};
}
