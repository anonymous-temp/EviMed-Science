/** Reuse only the verified fixed global/seed SDK layout of a complete immutable runtime. */
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {verifiedKernelPins} from './platform/deploy/runtime-dsh/profile-kernel-pins.mjs';
import {securityYamlPin,verifyYamlInstallation} from './platform/deploy/runtime-dsh/runtime-yaml-security.mjs';
const pins=JSON.parse(fs.readFileSync('/fixture/platform/deps-version.json')),global='/usr/local/lib/node_modules',seed='/opt/evimed/dsh-home-seed/profiles/evimed-runtime/node_modules';
const installed=JSON.parse(fs.readFileSync('/opt/evimed/runtime-deps-version.json'));if(installed.dsh.version!==pins.dsh.version||installed.dsh.publishedBefore!==pins.dsh.publishedBefore||installed.$runtimeSecurity['js-yaml'].integrity!==pins.$runtimeSecurity['js-yaml'].integrity)throw Error('runtime_fixture_pin_differs');
const packages=verifiedKernelPins(global+'/@deepseek-ai/dsh/package.json',pins.dsh.version,pins.dsh.cordis),namespace=Object.keys(packages).filter(name=>/^@deepseek-ai\/dsh(?:-|$)/.test(name)).length;if(namespace!==273)throw Error('runtime_fixture_namespace_differs');
const pin=securityYamlPin('/fixture/platform/deps-version.json');
// Whole official package bytes were verified by the immutable runtime's dedicated security build step.
// Recheck every current consumer resolution/version without altering either installed closure.
const official='/opt/evimed/runtime-security/js-yaml';const globalYaml=verifyYamlInstallation(global,official,pin),profileYaml=verifyYamlInstallation(seed,official,pin);
fs.mkdirSync('/opt/sdk',{recursive:true});fs.symlinkSync(global,'/opt/sdk/node_modules');const scope='/fixture/platform/node_modules/@deepseek-ai';fs.mkdirSync(scope,{recursive:true});
for(const source of [global+'/@deepseek-ai/dsh/node_modules/@deepseek-ai',global+'/@deepseek-ai']){if(!fs.existsSync(source))continue;for(const name of fs.readdirSync(source)){const directory=source+'/'+name;try{const p=JSON.parse(fs.readFileSync(directory+'/package.json'));if(packages[p.name]!==p.version)throw Error('runtime_fixture_namespace_identity');if(!fs.existsSync(scope+'/'+name))fs.symlinkSync(fs.realpathSync(directory),scope+'/'+name);}catch(error){if(error.code!=='ENOENT')throw error;}}}
const citation=fs.realpathSync(seed+'/dsh-cite'),cite=JSON.parse(fs.readFileSync(citation+'/package.json'));if(cite.version!==pins.dsh.citeVersion)throw Error('runtime_fixture_citation_identity');fs.symlinkSync(citation,'/fixture/platform/node_modules/dsh-cite');
// Replace only disposable fixture copies of the port and parser entry; original global/seed SDK bytes stay unchanged.
fs.copyFileSync('/fixture/validate-personal-skill.mjs','/opt/evimed/socket/scripts/validate-personal-skill.mjs');
fs.rmSync('/opt/evimed/socket/node_modules/@evimed/harness-port',{recursive:true,force:true});fs.symlinkSync('/fixture/platform/node_modules/@evimed/harness-port','/opt/evimed/socket/node_modules/@evimed/harness-port');
fs.writeFileSync('/fixture/sdk-installation.json',JSON.stringify({kernel:pins.dsh.version,cutoff:pins.dsh.publishedBefore,namespace,node:process.version,layout:{global,seed},globalYaml,profileYaml,fixtureSHA:createHash('sha256').update(fs.readFileSync('/fixture/fixture.mjs')).digest('hex'),qualification:'unverified'})+'\n');
