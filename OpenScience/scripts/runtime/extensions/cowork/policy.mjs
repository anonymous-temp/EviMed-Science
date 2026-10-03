import {inflateRawSync,crc32} from 'node:zlib';
export const LIMITS=Object.freeze({inputBytes:8*1024*1024,outputBytes:8*1024*1024,decompressedBytes:32*1024*1024,zipEntries:512,windowBytes:64*1024,rows:100,cells:1000});
export class CoworkPolicyError extends Error {constructor(){super('The isolated document operation was refused.');this.code='cowork_input_refused';}}
const refuse=()=>{throw new CoworkPolicyError();};
function object(value,keys,required=keys){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype
    ||Reflect.ownKeys(value).some(key=>typeof key!=='string'||!keys.includes(key))
    ||Object.values(Object.getOwnPropertyDescriptors(value)).some(field=>!Object.hasOwn(field,'value')||!field.enumerable)
    ||required.some(key=>!Object.hasOwn(value,key)))refuse();return value;
}
function list(value,max){if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype||value.length>max||Reflect.ownKeys(value).length!==value.length+1
  ||Object.entries(Object.getOwnPropertyDescriptors(value)).some(([key,field])=>key!=='length'&&(!/^\d+$/.test(key)||!Object.hasOwn(field,'value')||!field.enumerable)))refuse();return value;}
function opaque(value){if(typeof value!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(value))refuse();return value;}
function integer(value,min,max){if(!Number.isSafeInteger(value)||value<min||value>max)refuse();return value;}
function plainValue(value){if(value!==null&&!['string','number','boolean'].includes(typeof value))refuse();if(typeof value==='number'&&!Number.isFinite(value))refuse();if(typeof value==='string'&&Buffer.byteLength(value)>8192)refuse();}
export function validateRequest(value){
  const request=object(value,['operation','resourceId','options','targetId','format','spec'],['operation']);
  if(request.operation==='doc_read'){
    object(request,['operation','resourceId','options'],['operation','resourceId']);opaque(request.resourceId);
    const options=object(request.options??{},['page','pages','sheets','rowOffset','rows','cell','cells'],[]);
    for(const [key,item]of Object.entries(options)){
      if(key==='sheets'){list(item,1);if(item.some(name=>typeof name!=='string'||name.length>31))refuse();}
      else integer(item,['cell'].includes(key)?0:1,['pages'].includes(key)?5:['rows','cells'].includes(key)?100:100000);
    }
    return {...request,options};
  }
  if(request.operation!=='doc_write')refuse();object(request,['operation','targetId','format','spec']);opaque(request.targetId);
  if(!['xlsx','ipynb'].includes(request.format))refuse();
  const spec=request.spec;
  if(request.format==='xlsx'){
    object(spec,['kind','sheets']);if(spec.kind!=='create')refuse();list(spec.sheets,4);let count=0;
    for(const sheet of spec.sheets){object(sheet,['name','cells']);if(typeof sheet.name!=='string'||!sheet.name||sheet.name.length>31||['\\','/','*','?',':','[',']'].some(char=>sheet.name.includes(char)))refuse();list(sheet.cells,LIMITS.cells);count+=sheet.cells.length;
      for(const cell of sheet.cells){object(cell,['ref','value']);if(typeof cell.ref!=='string'||!/^[A-Z]{1,3}[1-9][0-9]{0,6}$/.test(cell.ref))refuse();
        const [,column,row]=/^([A-Z]+)(\d+)$/.exec(cell.ref);let n=0;for(const c of column)n=n*26+c.charCodeAt(0)-64;if(n>16384||Number(row)>1048576)refuse();plainValue(cell.value);}}
    if(count>LIMITS.cells)refuse();
  }else{object(spec,['kind','cells']);if(spec.kind!=='create')refuse();list(spec.cells,100);
    for(const cell of spec.cells){object(cell,['type','source']);if(!['markdown','code','raw'].includes(cell.type)||typeof cell.source!=='string'||Buffer.byteLength(cell.source)>8192)refuse();}}
  if(Buffer.byteLength(JSON.stringify(request))>65536)refuse();return request;
}
export function validateResource(value){
  const resource=object(value,['file','format','bytes','sha256','dataClass']);
  if(typeof resource.file!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(resource.file)||!['xlsx','ipynb','docx','pdf'].includes(resource.format)
    ||!resource.file.endsWith('.'+resource.format)||!['public','aggregate'].includes(resource.dataClass)||typeof resource.sha256!=='string'||!/^[a-f0-9]{64}$/.test(resource.sha256))refuse();
  integer(resource.bytes,1,LIMITS.inputBytes);return resource;
}
/** Archive preflight only, not a competing document parser. Raw directory names are checked before any codec normalizes them. */
export function inspectZip(bytes){
  if(bytes.length>LIMITS.inputBytes||bytes.length<22)refuse();let end=-1;
  for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(bytes.readUInt32LE(i)===0x06054b50&&i+22+bytes.readUInt16LE(i+20)===bytes.length){end=i;break;}
  if(end<0||bytes.readUInt16LE(end+4)||bytes.readUInt16LE(end+6)||bytes.readUInt16LE(end+8)!==bytes.readUInt16LE(end+10))refuse();
  const count=bytes.readUInt16LE(end+10),offset=bytes.readUInt32LE(end+16),length=bytes.readUInt32LE(end+12);
  if(!count||count>LIMITS.zipEntries||offset+length!==end)refuse();const entries=[];let cursor=offset,total=0;
  function extras(start,size){let next=start;while(next<start+size){if(next+4>start+size)refuse();const kind=bytes.readUInt16LE(next),n=bytes.readUInt16LE(next+2);if([1,0x7075].includes(kind)||next+4+n>start+size)refuse();next+=4+n;}}
  for(let i=0;i<count;i++){
    if(cursor+46>end||bytes.readUInt32LE(cursor)!==0x02014b50)refuse();
    const nameBytes=bytes.readUInt16LE(cursor+28),extra=bytes.readUInt16LE(cursor+30),comment=bytes.readUInt16LE(cursor+32),size=bytes.readUInt32LE(cursor+24);
    const flags=bytes.readUInt16LE(cursor+8),method=bytes.readUInt16LE(cursor+10),crc=bytes.readUInt32LE(cursor+16),compressed=bytes.readUInt32LE(cursor+20),local=bytes.readUInt32LE(cursor+42);
    // This bounded subset supports stored/deflated entries with concrete local sizes;
    // encryption, streaming data descriptors and alternate path extra records are refused.
    if(cursor+46+nameBytes+extra+comment>end||(flags&~0x800)||![0,8].includes(method)||bytes.readUInt16LE(cursor+34))refuse();
    const rawName=bytes.subarray(cursor+46,cursor+46+nameBytes);let name;try{name=new TextDecoder('utf-8',{fatal:true}).decode(rawName);}catch{refuse();}
    if(!name||name.includes('\\')||name.startsWith('/')||name.includes('\0')||name.split('/').some(part=>part==='..'||part==='.')||/vbaProject\.bin|externalLinks\//i.test(name))refuse();
    extras(cursor+46+nameBytes,extra);
    if(local+30>offset||bytes.readUInt32LE(local)!==0x04034b50||bytes.readUInt16LE(local+6)!==flags||bytes.readUInt16LE(local+8)!==method
      ||bytes.readUInt32LE(local+14)!==crc||bytes.readUInt32LE(local+18)!==compressed||bytes.readUInt32LE(local+22)!==size||bytes.readUInt16LE(local+26)!==nameBytes)refuse();
    const localExtra=bytes.readUInt16LE(local+28),start=local+30+nameBytes+localExtra,finish=start+compressed;
    if(finish>offset||!bytes.subarray(local+30,local+30+nameBytes).equals(rawName))refuse();extras(local+30+nameBytes,localExtra);
    total+=size;if(total>LIMITS.decompressedBytes)refuse();
    const packed=bytes.subarray(start,finish);let data;try{data=method===0?packed:inflateRawSync(packed,{maxOutputLength:Math.max(1,size)});}catch{refuse();}
    if(data.length!==size||crc32(data)!==crc)refuse();
    entries.push({name,bytes:size,compressed,method,offset:local,start,finish});cursor+=46+nameBytes+extra+comment;
  }
  if(cursor!==offset+length||new Set(entries.map(entry=>entry.name)).size!==entries.length)refuse();
  let boundary=0;for(const entry of [...entries].sort((a,b)=>a.offset-b.offset)){if(entry.offset!==boundary)refuse();boundary=entry.finish;}if(boundary!==offset)refuse();
  return entries;
}
export function guardDocument(bytes,format){
  if(bytes.length>LIMITS.inputBytes||!['xlsx','docx','pdf','ipynb'].includes(format))refuse();
  const zipSignature=bytes.length>=4&&[0x04034b50,0x06054b50,0x08074b50].includes(bytes.readUInt32LE(0));
  if(zipSignature!==['xlsx','docx'].includes(format))refuse();
  if(format==='pdf'&&bytes.subarray(0,5).toString()!=='%PDF-')refuse();
  if(format==='ipynb'){let value;try{value=JSON.parse(bytes.toString('utf8'));}catch{refuse();}if(value?.nbformat!==4||!Array.isArray(value.cells))refuse();}
  if(zipSignature)for(const entry of inspectZip(bytes))if(entry.name.endsWith('.rels')){
    const offset=entry.offset;if(offset+30>bytes.length||bytes.readUInt32LE(offset)!==0x04034b50)refuse();
    const start=offset+30+bytes.readUInt16LE(offset+26)+bytes.readUInt16LE(offset+28);if(start+entry.compressed>bytes.length)refuse();
    const compressed=bytes.subarray(start,start+entry.compressed),data=entry.method===0?compressed:entry.method===8?inflateRawSync(compressed,{maxOutputLength:LIMITS.decompressedBytes}):null;
    if(!data)refuse();const xml=data.toString('utf8').replace(/&#(?:x([0-9a-f]+)|(\d+));/gi,(_,hex,dec)=>String.fromCodePoint(hex?parseInt(hex,16):Number(dec)));
    if(/<!DOCTYPE|<!ENTITY|TargetMode\s*=\s*['"]External['"]/i.test(xml))refuse();
  }
  if(format==='pdf'&&/\/(?:JavaScript|JS|Launch|OpenAction|RichMedia)\b/.test(bytes.toString('latin1')))refuse();
}
