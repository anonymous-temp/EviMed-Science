import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import test from 'node:test';import{createRequire}from'node:module';
import{securityPackagePins,patchYamlInstallation,verifyYamlInstallation}from'../../../deploy/runtime-dsh/runtime-yaml-security.mjs';
const policy=new URL('../../../deps-version.json',import.meta.url),pin=securityPackagePins(policy).find(p=>p.name==='zod');
const require=createRequire(new URL('../../../packages/harness-port/package.json',import.meta.url)),installed=path.dirname(require.resolve('zod/package.json'));
const put=(dir,value)=>{fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify(value));};
test('workspace and cowork use the authoritative security version',()=>{
 const workspace=JSON.parse(fs.readFileSync(new URL('../../../package.json',import.meta.url)));assert.equal(workspace.pnpm.overrides['zod@>=4 <5'],pin.version);
 const lock=fs.readFileSync(new URL('../../../scripts/runtime/extensions/cowork/overlay/pnpm-lock.yaml',import.meta.url),'utf8');assert.ok(lock.includes(`  zod@${pin.version}:`));assert.equal(lock.includes('zod@4.4.3'),false);
});
test('whole official Zod package replaces every physical copy and verifies native consumer resolution including v3 compatibility',t=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'runtime-zod-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const official=path.join(root,'official'),modules=path.join(root,'node_modules');fs.cpSync(installed,official,{recursive:true});
 for(const suffix of ['zod','nested/node_modules/zod']){const target=path.join(modules,suffix);fs.cpSync(official,target,{recursive:true});const p=JSON.parse(fs.readFileSync(path.join(target,'package.json')));p.version='4.4.3';put(target,p);}
 const peer=path.join(modules,'peer-consumer');put(peer,{name:'peer-consumer',version:'1.0.0',peerDependencies:{zod:'^4.0.0'}});
 const consumer=path.join(modules,'@deepseek-ai/fixture-consumer');put(consumer,{name:'@deepseek-ai/fixture-consumer',version:'0.2.1-rc.2',dependencies:{zod:'^4.0.0'}});const before=fs.readFileSync(path.join(consumer,'package.json'));
 const result=patchYamlInstallation(modules,official,pin);assert.equal(result.copies,2);assert.equal(result.consumers,2);assert.deepEqual(fs.readFileSync(path.join(consumer,'package.json')),before);assert.deepEqual(patchYamlInstallation(modules,official,pin),result);
 const used=createRequire(path.join(consumer,'package.json'));assert.equal(used('zod').string().parse('works'),'works');assert.equal(used('zod/v4').string().parse('v4'),'v4');assert.ok(used('zod/v4/core').$ZodString);assert.equal(used('zod/v3').string().parse('compatibility'),'compatibility');
 fs.appendFileSync(path.join(modules,'zod/index.cjs'),'\n// tamper');assert.throws(()=>verifyYamlInstallation(modules,official,pin),/full bytes mismatch/);
});
test('physical Zod3 is refused without replacing it or namespace consumers',t=>{const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'zod-major-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const modules=path.join(root,'node_modules');put(path.join(modules,'zod'),{name:'zod',version:'3.25.76'});const before=fs.readFileSync(path.join(modules,'zod/package.json'));assert.throws(()=>patchYamlInstallation(modules,installed,pin),/unsupported/);assert.deepEqual(fs.readFileSync(path.join(modules,'zod/package.json')),before);});
for(const jitless of [true,false])test(`constrained collections bound issues before child parsing (jitless=${jitless})`,()=>{
 const z=require('zod/v4');z.config({jitless});try{for(const kind of ['array','set','map']){let children=0;const child=z.string().refine(()=>{children++;return false;});const schema=kind==='array'?z.array(child).max(1):kind==='set'?z.set(child).max(1):z.map(child,child).max(1);const value=kind==='array'?Array(1000).fill('bad'):kind==='set'?new Set(Array.from({length:1000},(_,i)=>String(i))):new Map(Array.from({length:1000},(_,i)=>[String(i),'bad']));const result=schema.safeParse(value);assert.equal(result.success,false);assert.equal(result.error.issues.length,1);assert.equal(result.error.issues[0].code,'too_big');assert.equal(children,0);}
 for(const [schema,value] of [[z.array(z.string()).length(1),['a','b']],[z.set(z.string()).size(1),new Set(['a','b'])],[z.map(z.string(),z.string()).size(1),new Map([['a','b'],['c','d']])]]){const r=schema.safeParse(value);assert.equal(r.error.issues.length,1);assert.equal(r.error.issues[0].code,'too_big');}
 assert.equal(z.array(z.string()).max(2).safeParse(['valid']).success,true);assert.equal(z.array(z.string()).max(2).safeParse([1]).success,false);assert.equal(z.set(z.string()).max(1).safeParse([]).success,false);assert.equal(z.map(z.string(),z.string()).max(1).safeParse({}).success,false);
 assert.deepEqual(z.object({items:z.array(z.string()).max(1)}).safeParse({items:[1,2]}).error.issues[0].path,['items']);
 let overwritten=false;const transformed=z.array(z.string()).overwrite(value=>{overwritten=true;return value.slice(0,1);}).max(1).parse(['a','b']);assert.equal(overwritten,true);assert.deepEqual(transformed,['a']);
 }finally{z.config({jitless:false});}
});

test('deleting either owned package policy cannot silently remove runtime protection',t=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'security-policy-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const policyValue=JSON.parse(fs.readFileSync(policy));for(const name of ['zod','js-yaml']){const copy=structuredClone(policyValue);delete copy.$runtimeSecurity[name];const file=path.join(root,name+'.json');fs.writeFileSync(file,JSON.stringify(copy));assert.throws(()=>securityPackagePins(file),/single-source/);}});
test('required peers must resolve into the verified closure; only absent optional providers may be skipped',t=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'zod-peers-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const modules=path.join(root,'node_modules');fs.mkdirSync(path.join(modules,'private/node_modules'),{recursive:true});fs.cpSync(installed,path.join(modules,'private/node_modules/zod'),{recursive:true});
 const optional=path.join(modules,'optional');put(optional,{name:'optional',version:'1.0.0',optionalDependencies:{zod:'^4'}});assert.equal(verifyYamlInstallation(modules,installed,pin).consumers,1);
 const peer=path.join(modules,'peer');put(peer,{name:'peer',version:'1.0.0',peerDependencies:{zod:'^4'}});assert.throws(()=>verifyYamlInstallation(modules,installed,pin),{code:'MODULE_NOT_FOUND'});
 put(peer,{name:'peer',version:'1.0.0',peerDependencies:{zod:'^4'},peerDependenciesMeta:{zod:{optional:true}}});assert.equal(verifyYamlInstallation(modules,installed,pin).consumers,2);
});
