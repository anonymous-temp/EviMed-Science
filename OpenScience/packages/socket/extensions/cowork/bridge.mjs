import {defineTool,registerTool} from '@evimed/harness-port';

/** @param {Record<string,any>} args @param {string} operation */
function request(args,operation){
  const keys=operation==='doc_read'?['resourceId','options']:['targetId','format','spec'];
  if(!args||typeof args!=='object'||Array.isArray(args)||Object.getPrototypeOf(args)!==Object.prototype
    ||Reflect.ownKeys(args).some(key=>typeof key!=='string'||!keys.includes(key))
    ||Object.values(Object.getOwnPropertyDescriptors(args)).some(field=>!Object.hasOwn(field,'value')||!field.enumerable))throw new Error('extension_contract_invalid');
  const id=operation==='doc_read'?args.resourceId:args.targetId;
  if(typeof id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(id))throw new Error('extension_contract_invalid');
  return{operation,...args};
}
/** Platform-only injection: gateway independently authorizes the actual calling agent and opaque resources. No vendor module or secret lives here.
 * @param {(input:{request:Record<string,any>,call:any})=>Promise<any>} callGateway */
export function coworkToolSpecs(callGateway){
  return[
    {name:'doc_read',description:'Inspect a permitted document resource using bounded pages, cells or rows.',timeoutMs:15000,concurrencySafe:true,
      parameters:{resourceId:{type:'string',required:true},options:{type:'object'}},execute:async(args,call)=>callGateway({request:request(args,'doc_read'),call})},
    {name:'doc_write',description:'Create a new permitted XLSX or inert notebook document; does not execute notebook code or generate DOCX/PDF.',timeoutMs:15000,concurrencySafe:false,
      parameters:{targetId:{type:'string',required:true},format:{type:'string',required:true,enum:['xlsx','ipynb']},spec:{type:'object',required:true}},execute:async(args,call)=>callGateway({request:request(args,'doc_write'),call})},
  ];
}
/** @param {any} ctx @param {(input:{request:Record<string,any>,call:any})=>Promise<any>} callGateway */
export async function registerCoworkTools(ctx,callGateway){
  const disposers=[];for(const spec of coworkToolSpecs(callGateway))disposers.push(registerTool(ctx,await defineTool(spec)));
  return()=>{for(const dispose of disposers.reverse())dispose();};
}
