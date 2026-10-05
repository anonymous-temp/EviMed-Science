#!/usr/bin/env node
// Operator-only primary identity enrichment; never sends reference numbers to metadata services.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
const [root,methodId]=process.argv.slice(2);
if(!root||!/^[A-Za-z0-9_-]{1,100}$/.test(methodId??''))throw new Error('Supply protected evaluation directory and method ID.');
const directory=path.join(root,'paper-gold/candidate-cases');const definition=JSON.parse(await fs.readFile(path.join(directory,`${methodId}.json`),'utf8'));const identities=[];
for(const publicationId of [...new Set(definition.cases.filter(x=>x.kind==='published').map(x=>x.publicationId))]){
 const aliases=[publicationId],titles=[];
 if(/^10\.\d{4,9}\//i.test(publicationId)){
  const crossref=await fetch(`https://api.crossref.org/works/${encodeURIComponent(publicationId)}`,{signal:AbortSignal.timeout(30000)});if(!crossref.ok)throw new Error('Primary Crossref identity unavailable.');
  const record=(await crossref.json()).message;titles.push(...(record.title??[]));
  for(const rows of Object.values(record.relation??{}))for(const row of rows)if(row['id-type']==='doi'&&/^10\.\d{4,9}\//i.test(row.id??''))aliases.push(row.id);
  const url=new URL('https://www.ebi.ac.uk/europepmc/webservices/rest/search');url.search=new URLSearchParams({query:`DOI:"${publicationId}"`,format:'json',pageSize:'10'}).toString();
  const response=await fetch(url,{signal:AbortSignal.timeout(30000)});if(!response.ok)throw new Error('Primary bibliographic alias query unavailable.');
  for(const paper of (await response.json()).resultList?.result??[]){if(String(paper.doi??'').toLowerCase()!==publicationId.toLowerCase())continue;if(paper.id&&paper.source==='MED')aliases.push(`PMID:${paper.id}`);if(paper.pmcid)aliases.push(paper.pmcid);if(paper.title)titles.push(paper.title);}
 }
 if(!titles.length)throw new Error('Published target title unresolved; refuse an incomplete blind-exclusion identity set.');
 identities.push({publicationId,aliases:[...new Set(aliases)],titles:[...new Set(titles)]});
}
const referenceHash=createHash('sha256').update(JSON.stringify(definition)).digest('hex');const result={schemaVersion:1,methodId,referenceHash,identities};const bytes=JSON.stringify(result);const file=path.join(directory,`${methodId}.identities.json`);
try{await fs.writeFile(file,bytes,{mode:0o600,flag:'wx'});}catch(e){if(e.code!=='EEXIST'||await fs.readFile(file,'utf8')!==bytes)throw e;}
console.log(JSON.stringify({methodId,referenceHash,identityHash:createHash('sha256').update(bytes).digest('hex'),publishedReferences:identities.length,complete:true}));
