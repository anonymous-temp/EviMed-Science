/** Preserve numerical comparisons only after the control plane replayed delivered code. */
import {createHash} from 'node:crypto';
import {prospectiveNumericQuoteMatches} from './evolutionProspectiveScore.mjs';
/** @param {{unit:any,gold:any,score:any}} input */
export function comparisonFromVerifiedUnit({unit,gold,score}){
 const proof=score.verificationProof;
 if(score.codeVerified!==true||proof?.kind!=='isolated-independent-replay'||proof.replicates<2||proof.sourceHash!==gold.sourceHash||!Array.isArray(proof.outputHashes)||proof.outputHashes.length<2||!proof.proofHash)return null;
 const source=(gold.preservedEvidence??[]).find(row=>typeof row.text==='string'&&row.text.trim()&&(row.sourceHash??row.sha256)===gold.sourceHash&&createHash('sha256').update(row.text).digest('hex')===gold.sourceHash);
 if(!source)return null;
 const items=[];
 for(const [key,ref]of Object.entries(gold.numeric??{})){
   const value=unit.numeric?.[key];if(!Number.isFinite(value)||!Number.isFinite(ref.value)||typeof ref.quote!=='string'||!source.text.includes(ref.quote)||!prospectiveNumericQuoteMatches(ref.quote,ref.value,source.text))continue;
   items.push({key,published:{value:ref.value,printed:ref.printed,quote:ref.quote,unit:ref.unit??null,absoluteTolerance:ref.absoluteTolerance,relativeTolerance:ref.relativeTolerance,toleranceReason:ref.toleranceReason},recalculated:{value,unit:ref.unit??null},verificationProofHash:proof.proofHash});
 }
 return items.length?{title:gold.title??source.title??'',source:{id:source.id,url:source.url??gold.sourceUrl??null,title:source.title??gold.title??'',sha256:gold.sourceHash,documentText:source.text},items}:null;
}
