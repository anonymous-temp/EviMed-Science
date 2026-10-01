/** Operator-owned adaptation, applied only to a disposable source copy inside Docker. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
const root=process.argv[2],pinsFile=process.argv[3],admittedFile=process.argv[4];
const pins=JSON.parse(await fs.readFile(pinsFile,'utf8'));
if(pins.sourceCommit!=='2ae5cf755c4294a1e988eebf3b12dd062425d84c'||JSON.stringify(pins.overrides)!==JSON.stringify({'exceljs@4.4.0>unzipper':'0.12.3'}))throw new Error('overlay_pin_differs');
const admitted=await fs.readFile(admittedFile);
if(createHash('sha256').update(admitted).digest('hex')!==pins.admittedLockSha256)throw new Error('overlay_admitted_lock_differs');
const lock=await fs.readFile(path.join(root,'pnpm-lock.yaml'));
if(createHash('sha256').update(lock).digest('hex')!==pins.upstreamLockSha256)throw new Error('overlay_upstream_lock_differs');
const workspaceFile=path.join(root,'pnpm-workspace.yaml'),workspace=await fs.readFile(workspaceFile,'utf8');
if(/^overrides:/m.test(workspace))throw new Error('overlay_already_present');
await fs.writeFile(path.join(root,'upstream-pnpm-lock.yaml'),lock,{flag:'wx'});
await fs.chmod(workspaceFile,0o600);
await fs.chmod(path.join(root,'pnpm-lock.yaml'),0o600);
await fs.writeFile(path.join(root,'pnpm-lock.yaml'),admitted);
await fs.writeFile(workspaceFile,workspace+'overrides:\n  "exceljs@4.4.0>unzipper": "0.12.3"\n');
