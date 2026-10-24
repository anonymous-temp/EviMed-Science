export const SIZES=Object.freeze({small:24,medium:64,large:256});
export const SUBSTRATES=Object.freeze(['knowledge','memory','combined']);
export function contextOf(c,index=0) {return c.evaluation??{size:['small','medium','large'][index%3],substrate:SUBSTRATES[Math.floor(index/3)%3],language:/[\u4e00-\u9fff]/.test(c.prompt)?'zh':'en',format:c.stratum==='medical'?'original-abstract':['office','table','code','malicious-original'][index%4]};}
export function evaluationCells(b){return b.cases.map((c,i)=>({caseId:c.id,...contextOf(c,i)}));}
export const contextId=c=>`${c.size}-${c.substrate}`;
