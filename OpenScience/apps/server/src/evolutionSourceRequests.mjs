/** Public pull-only manifest: the plugin owns admission and never receives a push. */
export const AI_DISCOVERY_SOURCE_REQUESTS = Object.freeze([
 {id:'arxiv-agent-self-improvement',name:'arXiv agent self-improvement, memory and evaluation',homepage:'https://arxiv.org/',lane:'ai',source_type:'preprint',access:'atom',egress:'direct',authority:2,safety_feed:false,owner_entity:'arXiv',launch_tier:'P0',language:'en',region:'US',poll_floor_s:21600,poll_ceiling_s:129600,category:'ai-discovery',config:{url:'https://export.arxiv.org/api/query?search_query=%28cat:cs.AI+OR+cat:cs.CL+OR+cat:cs.LG%29+AND+%28abs:self-improvement+OR+abs:agent+OR+abs:memory+OR+abs:evaluation+OR+abs:tool-learning%29&sortBy=submittedDate&sortOrder=descending&max_results=100',max_pages:1,allowed_hosts:['arxiv.org','export.arxiv.org'],discovery_only:true}}
]);
/** @param {any} service */
export async function evolutionSourceRequestManifest(service){const requested=service?(await service.list('source-request')).filter(r=>r.payload.public===true&&r.payload.status==='requested').map(r=>r.payload.source):[];return {schemaVersion:1,sources:[...AI_DISCOVERY_SOURCE_REQUESTS,...requested].slice(0,25)};}
