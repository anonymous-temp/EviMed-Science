/** @typedef {{schemaVersion:1,classification:'private'|'unclassified'|'ordinary',reasons:string[]}} MemorySourcePrivacy */

/**
 * Resolve ORIGINAL trusted source metadata before any genericization. Text is never a privacy classifier.
 * Producers may attest ordinary source scope; client/imported assertions require validation before reaching this API.
 * Unknown scope is retained for owner use and withheld at egress. A derived body cannot downgrade its source lineage.
 * @param {unknown} source
 * @returns {MemorySourcePrivacy}
 */
export function sourcePrivacyOf(source) {
  const seen=new WeakSet();
  /** @param {any} item @param {number} depth @returns {MemorySourcePrivacy} */
  const visit=(item,depth)=>{
    if(!item||typeof item!=='object'||depth>16||seen.has(item))return {schemaVersion:1,classification:'unclassified',reasons:['source-unclassified']};
    seen.add(item);
    const payload=item.payload&&typeof item.payload==='object'?item.payload:null;
    const privacy=item.sourcePrivacy??payload?.sourcePrivacy;
    const person=item.nativeType==='people'||[item.kind,item.factKind,payload?.factKind,item.subjectType,item.sourceType].some(kind=>['person','patient','personal-context'].includes(kind));
    const declared=privacy?.schemaVersion===1&&['private','unclassified','ordinary'].includes(privacy.classification)?privacy.classification:'unclassified';
    const own={schemaVersion:/** @type {const} */(1),classification:/** @type {MemorySourcePrivacy['classification']} */(person?'private':declared),reasons:person?['person-context']:Array.isArray(privacy?.reasons)?privacy.reasons.filter((/** @type {unknown} */ value)=>typeof value==='string').slice(0,32):[declared==='ordinary'?'ordinary-source':'source-unclassified']};
    const children=[...(Array.isArray(item.originalSources)?item.originalSources:[]),...(Array.isArray(item.sources)?item.sources:[])].map(child=>visit(child,depth+1));
    const proofs=children.length&&!privacy&&!person?children:[own,...children];
    return {schemaVersion:1,classification:proofs.some(proof=>proof.classification==='private')?'private':proofs.some(proof=>proof.classification==='unclassified')?'unclassified':'ordinary',reasons:[...new Set(proofs.flatMap(proof=>proof.reasons))].slice(0,32)};
  };
  return visit(source,0);
}

/**
 * Egress permission is separate from factual confirmation and owner recall. Only an exact per-share digest choice permits a
 * private share; it never authorizes external API disclosure, frontier publication, distillation or global promotion.
 * @param {unknown} original
 * @param {{purpose?:'external-api'|'share'|'frontier'|'method'|'global-method',contentDigest?:string|null,consentDigest?:string|null}} [options]
 */
export function sourceAllowsEgress(original,{purpose='external-api',contentDigest=null,consentDigest=null}={}) {
  if(!['external-api','share','frontier','method','global-method'].includes(purpose))return false;
  if(sourcePrivacyOf(original).classification==='ordinary')return true;
  return purpose==='share'&&typeof contentDigest==='string'&&/^[a-f0-9]{64}$/.test(contentDigest)&&contentDigest===consentDigest;
}

/** People and unclassified native context remain available to their owner, privately. `sensitive` is independent recall suppression.
 * @param {unknown} record */
export function privateByDefault(record) {
  if(!record||typeof record!=='object')return false;
  const item=/** @type {any} */(record),payload=item.payload;
  if(item.nativeType||item.sourcePrivacy||payload?.sourcePrivacy||item.originalSources||item.sources)return !sourceAllowsEgress(item);
  return item.kind==='person'||item.factKind==='person'||payload?.factKind==='person';
}
