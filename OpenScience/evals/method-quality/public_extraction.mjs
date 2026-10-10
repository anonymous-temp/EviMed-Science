// Exact source grounding for public-corpus probes; never reads reference labels.
export const PUBLIC_RELATION_TYPES = Object.freeze(['ACTIVATOR','AGONIST','AGONIST-ACTIVATOR','AGONIST-INHIBITOR','ANTAGONIST','DIRECT-REGULATOR','INDIRECT-DOWNREGULATOR','INDIRECT-UPREGULATOR','INHIBITOR','PART-OF','PRODUCT-OF','SUBSTRATE','SUBSTRATE_PRODUCT-OF']);
export function publicExtractionPrompt(example) {
  return `Extract every CHEMICAL and GENE mention and chemical-to-gene relation supported by this public abstract. Return ONLY compact JSON, no markdown or commentary: {"entities":[["e1","CHEMICAL","exact source surface",1]],"relations":[["INHIBITOR","e1","e2"]]}. Each entity tuple is [id,type,exact surface,occurrence]. occurrence is the 1-based occurrence of that exact surface in the entire text, including unannotated occurrences. Include repeated mentions separately. Copy exact surfaces; do not count character offsets. GENE includes proteins. Relation arguments must be listed chemical and gene mention ids, respectively. Relation types: ${PUBLIC_RELATION_TYPES.join(', ')}. Do not invent a relation. Keep output compact to avoid truncation.\n${JSON.stringify(example)}`;
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
  for(const row of parsed.relations){
    if(!Array.isArray(row)||row.length!==3||!PUBLIC_RELATION_TYPES.includes(row[0])||byId.get(row[1])?.type!=='CHEMICAL'||byId.get(row[2])?.type!=='GENE'){issues.push({kind:'relation_unresolved',row});continue;}
    relations.push({type:row[0],arg1:row[1],arg2:row[2]});
  }
  return {entities,relations,groundingIssues:issues};
}
