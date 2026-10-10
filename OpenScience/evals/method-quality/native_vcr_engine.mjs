// A real, isolated R service for native VCR acceptance. No production route,
// model key or patient file is used. The caller supplies the pinned R library.
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createVcrEngineClient } from '../../apps/server/src/vcrEngineClient.mjs';

export async function startNativeVcrEngine(root) {
  if (!process.env.VCR_R_LIBS) throw new Error('VCR_R_LIBS must name the existing pinned R library.');
  const engineRoot=fileURLToPath(new URL('../../../项目代码/vcr-engine/',import.meta.url));
  const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port;await new Promise(resolve=>server.close(resolve));
  const token=randomBytes(32).toString('hex'),receiptKey=randomBytes(32).toString('hex');
  const directory=path.join(root,'engine');await fs.mkdir(directory,{recursive:true});
  await fs.mkdir(path.join(root,'protected'),{recursive:true});
  await fs.writeFile(path.join(directory,'token'),token,{mode:0o600});
  await fs.writeFile(path.join(directory,'receipt-key'),receiptKey,{mode:0o600});
  const child=spawn('python3',['-m','uvicorn','service.app:app','--host','127.0.0.1','--port',String(port),'--log-level','warning'],{
    cwd:engineRoot,env:{PATH:process.env.PATH,HOME:process.env.HOME,LANG:'C.UTF-8',VCR_ENGINE_ROOT:engineRoot,VCR_R_LIBS:process.env.VCR_R_LIBS,
      VCR_ENGINE_TOKEN_FILE:path.join(directory,'token'),VCR_ENGINE_RECEIPT_KEY_FILE:path.join(directory,'receipt-key'),
      VCR_ENGINE_WORK_DIR:path.join(directory,'jobs'),VCR_ENGINE_DATA_ROOT:path.join(root,'protected'),VCR_ENGINE_CORES:'2',VCR_ENGINE_CPU_SECONDS:'600'},stdio:['ignore','pipe','pipe']});
  let log='',failure=null;child.stdout.on('data',x=>log+=x);child.stderr.on('data',x=>log+=x);
  child.on('error',error=>{failure=error.message;});child.on('exit',code=>{failure=`R service exited ${code}`;});
  const baseUrl=`http://127.0.0.1:${port}`,engine=createVcrEngineClient({baseUrl,token,receiptKey,timeoutMs:120000});
  const deadline=Date.now()+60000;
  for (;;) {
    try {if((await engine.health()).ok)break;}catch { /* The local service is starting. */ }
    if(failure || Date.now()>deadline){child.kill('SIGKILL');throw new Error(failure ?? 'R service startup timed out.');}
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  return {config:{vcrEngineUrl:baseUrl,vcrEngineToken:token,vcrEngineReceiptKey:receiptKey,vcrEngineTimeoutMs:120000},
    async close(){child.kill('SIGTERM');await new Promise(resolve=>setTimeout(resolve,300));if(child.exitCode==null)child.kill('SIGKILL');await fs.writeFile(path.join(directory,'service.log'),log);}};
}
