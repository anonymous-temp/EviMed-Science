/** The control plane reaches the contained calculation worker only through its private Unix socket. */
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import http from 'node:http';
import path from 'node:path';
const unavailable=()=>Object.assign(new Error('The contained matching worker is unavailable.'),{code:'patient_matching_worker_unavailable'});
/** @param {{socketPath:string,tokenFile:string,timeoutMs?:number}} options */
export function createPatientMatchingWorkerClient({socketPath,tokenFile,timeoutMs=10000}){
  async function token(){
    if(!path.isAbsolute(socketPath??'')||!path.isAbsolute(tokenFile??''))throw unavailable();
    const socket=await fs.lstat(socketPath);if(!socket.isSocket())throw unavailable();
    const handle=await fs.open(tokenFile,constants.O_RDONLY|constants.O_NOFOLLOW);
    try{const stat=await handle.stat();if(!stat.isFile()||stat.size>4096||(stat.mode&0o077)!==0||stat.uid!==process.getuid?.())throw unavailable();const value=(await handle.readFile('utf8')).trim();if(value.length<32||/[\r\n]/.test(value))throw unavailable();return value;}
    finally{await handle.close();}
  }
  /** @param {any} input @param {{signal?:AbortSignal}} [options] */
  const calculate = async (input,{signal}={})=>{
    const key=await token();const body=JSON.stringify({operation:'clinical-score',input});if(Buffer.byteLength(body)>262144)throw unavailable();
    return new Promise((resolve,reject)=>{
      const req=http.request({socketPath,path:'/execute',method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json','content-length':Buffer.byteLength(body)},signal},res=>{
        const chunks=[];let size=0;res.on('data',chunk=>{size+=chunk.length;if(size>1024*1024){res.destroy(unavailable());return;}chunks.push(chunk);});
        res.on('error',reject);res.on('end',()=>{try{const payload=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(res.statusCode!==200)throw unavailable();resolve(payload);}catch{reject(unavailable());}});
      });
      req.setTimeout(Math.max(1000,Math.min(30000,timeoutMs)),()=>req.destroy(unavailable()));req.on('error',reject);req.end(body);
    });
  };
  return calculate;
}
