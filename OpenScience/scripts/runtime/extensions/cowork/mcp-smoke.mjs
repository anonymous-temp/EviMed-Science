/** Isolated upstream protocol smoke only. The unrestricted upstream file-path API is not the hosted gateway contract. */
import assert from 'node:assert/strict';
const {createCoworkServer}=await import('/opt/cowork/vendor/lib/index.js');
const {Client}=await import('/opt/cowork/vendor/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
const {InMemoryTransport}=await import('/opt/cowork/vendor/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js');
const server=createCoworkServer(),client=new Client({name:'evimed-contained-fixture',version:'1.0.0'});
const [left,right]=InMemoryTransport.createLinkedPair();await server.connect(right);await client.connect(left);
try{
  const tools=await client.listTools();assert(tools.tools.some(tool=>tool.name==='doc_read'));assert(tools.tools.some(tool=>tool.name==='doc_write'));
  const result=await client.callTool({name:'doc_read',arguments:{file_path:'/input/public.docx'}});
  assert.equal(Boolean(result.isError),false);assert(JSON.stringify(result.content).includes('公开文档'));
  console.log(JSON.stringify({upstreamMcpHandshake:true,actualDocxRead:true,hostedPathApiExposed:false}));
}finally{await client.close();await server.close();}
