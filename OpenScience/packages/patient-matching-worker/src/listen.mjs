import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
/** Recover only an orphaned socket in the operator's private worker directory. */
export async function listenWorkerSocket(server,socketPath){
  const parent=await fs.lstat(path.dirname(socketPath));
  if(!parent.isDirectory()||(parent.mode&0o077)!==0||parent.uid!==process.getuid?.())throw new Error('matching_worker_socket_directory_invalid');
  const prior=await fs.lstat(socketPath).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  if(prior){
    if(!prior.isSocket())throw new Error('matching_worker_socket_path_invalid');
    const stale=await new Promise((resolve,reject)=>{
      const connection=net.createConnection(socketPath);connection.setTimeout(500);
      connection.once('connect',()=>{connection.destroy();resolve(false);});
      connection.once('timeout',()=>{connection.destroy();reject(new Error('matching_worker_socket_busy'));});
      connection.once('error',error=>{connection.destroy();if(error.code==='ECONNREFUSED'||error.code==='ENOENT')resolve(true);else reject(error);});
    });
    if(!stale)throw new Error('matching_worker_socket_busy');
    const current=await fs.lstat(socketPath).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
    if(current){if(!current.isSocket()||current.ino!==prior.ino||current.dev!==prior.dev)throw new Error('matching_worker_socket_changed');await fs.unlink(socketPath);}
  }
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,()=>{server.off('error',reject);resolve();});});
  await fs.chmod(socketPath,0o600);
}
