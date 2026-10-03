/** Trusted fixture bootstrap; pinned public package data only, dependency lifecycle scripts disabled. */
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {installKernel} from './platform/scripts/ops/kernel-install.mjs';
// Fixed public acquisition mirror; dependency identities and the DSH cutoff remain unchanged.
process.env.npm_config_registry='https://registry.npmmirror.com';
process.env.npm_config_fetch_retries='1';process.env.npm_config_fetch_timeout='30000';
const pins=JSON.parse(fs.readFileSync('/fixture/platform/deps-version.json'));
const modules=await installKernel(pins);fs.mkdirSync('/opt/sdk',{recursive:true});fs.renameSync(modules,'/opt/sdk/node_modules');
const cli='/opt/sdk/node_modules/@deepseek-ai/dsh/package.json',scope='/fixture/platform/node_modules/@deepseek-ai';
fs.mkdirSync(scope,{recursive:true});
const {verifiedKernelPins}=await import('./platform/deploy/runtime-dsh/profile-kernel-pins.mjs');
const packages=verifiedKernelPins(cli,pins.dsh.version,pins.dsh.cordis);
for(const source of ['/opt/sdk/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai','/opt/sdk/node_modules/@deepseek-ai']){if(!fs.existsSync(source))continue;for(const name of fs.readdirSync(source)){
 try{const value=JSON.parse(fs.readFileSync(source+'/'+name+'/package.json'));if(packages[value.name]!==value.version)throw Error('fixture_namespace_identity');if(!fs.existsSync(scope+'/'+name))fs.symlinkSync(fs.realpathSync(source+'/'+name),scope+'/'+name);}catch(error){if(error.code!=='ENOENT')throw error;}
}}
const count=Object.keys(packages).filter(name=>/^@deepseek-ai\/dsh(?:-|$)/.test(name)).length;if(count!==273)throw Error('fixture_kernel_closure_differs');
// Citation provider peers resolve only through this verified SDK, never a second npm-selected kernel.
execFileSync('npm',['install','--prefix','/opt/citation','--ignore-scripts','--no-audit','--no-fund','--legacy-peer-deps','dsh-cite@'+pins.dsh.citeVersion],{stdio:'inherit'});
fs.symlinkSync('/opt/citation/node_modules/dsh-cite','/fixture/platform/node_modules/dsh-cite');
fs.symlinkSync(scope,'/opt/citation/node_modules/@deepseek-ai');
fs.writeFileSync('/fixture/sdk-installation.json',JSON.stringify({kernel:pins.dsh.version,cutoff:pins.dsh.publishedBefore,namespace:count,cordis:packages['@deepseek-ai/cordis'],security:pins.$runtimeSecurity,qualification:'unverified'})+'\n');

// Match the serving entry's canonical image-owned resolver anchor; this is a fixture-only SDK scope.
fs.mkdirSync('/opt/evimed/dsh-home-seed/profiles/evimed-runtime',{recursive:true});fs.symlinkSync('/fixture/platform/node_modules','/opt/evimed/dsh-home-seed/profiles/evimed-runtime/node_modules');
