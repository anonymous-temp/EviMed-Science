/** Verify the Linux Docker client before allocating any benchmark resource. */
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';

export function dockerClientArchitecture(bytes) {
  if(!Buffer.isBuffer(bytes)||bytes.length<64||!bytes.subarray(0,4).equals(Buffer.from([0x7f,0x45,0x4c,0x46]))
    ||bytes[4]!==2||bytes[5]!==1||bytes[6]!==1||![0,3].includes(bytes[7]))
    throw new Error('Benchmark Docker client must be a Linux-compatible little-endian ELF64 executable');
  if(![2,3].includes(bytes.readUInt16LE(16)))throw new Error('Benchmark Docker client ELF is not executable');
  const architecture=new Map([[183,'arm64'],[62,'amd64']]).get(bytes.readUInt16LE(18));
  if(!architecture)throw new Error('Benchmark Docker client architecture is unsupported');
  return architecture;
}
export async function readDockerClient(file,expectedArchitecture) {
  const handle=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const before=await handle.stat();
    if(!before.isFile()||before.size>64*1024*1024||!(before.mode&0o111))throw new Error('Benchmark Docker client must be a bounded executable regular file');
    const bytes=await handle.readFile(),after=await handle.stat();
    if(before.size!==after.size||before.mtimeMs!==after.mtimeMs||bytes.length!==before.size)
      throw new Error('Benchmark Docker client changed while reading');
    const architecture=dockerClientArchitecture(bytes);
    if(architecture!==expectedArchitecture)throw new Error('Benchmark Docker client architecture differs from the control-plane image');
    return {bytes,architecture,format:'ELF64',sha256:createHash('sha256').update(bytes).digest('hex')};
  }finally{await handle.close();}
}
