import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {test} from 'node:test';
import {listenWorkerSocket} from '../src/listen.mjs';
test('crashed sockets recover while a live worker and non-socket file remain protected',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'matching-socket-'));const socket=path.join(dir,'worker.sock');
 const child=spawn(process.execPath,['-e','require("net").createServer().listen(process.argv[1],()=>process.stdout.write("ready"))',socket],{stdio:['ignore','pipe','pipe']});
 try{
  await once(child.stdout,'data');child.kill('SIGKILL');await once(child,'close');assert.equal((await fs.lstat(socket)).isSocket(),true);
  const server=net.createServer();await listenWorkerSocket(server,socket);
  try{await assert.rejects(listenWorkerSocket(net.createServer(),socket),/matching_worker_socket_busy/);}finally{await new Promise(resolve=>server.close(resolve));}
  await fs.writeFile(socket,'keep');await assert.rejects(listenWorkerSocket(net.createServer(),socket),/matching_worker_socket_path_invalid/);assert.equal(await fs.readFile(socket,'utf8'),'keep');
 }finally{if(child.exitCode===null)child.kill('SIGKILL');await fs.rm(dir,{recursive:true,force:true});}
});
