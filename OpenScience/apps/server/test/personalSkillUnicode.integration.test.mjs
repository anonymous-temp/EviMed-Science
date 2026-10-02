import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import {createHash,randomUUID} from 'node:crypto'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {zipSync} from 'fflate'
import {parsePersonalSkill} from '@evimed/harness-port/personal-skills'
import {ControlPlaneDatabase} from '../src/controlPlaneDatabase.mjs'
import {SkillLibraryService} from '../src/skillLibraryService.mjs'
import {SkillLibraryArtifacts} from '../src/skillLibraryArtifacts.mjs'
import {PluginService} from '../src/pluginService.mjs'
import {decodeSkillArchive} from '../src/skillArchive.mjs'
import {PersonalSkillGenerationService,verifyPersonalSkillGeneration} from '../src/personalSkillGenerationService.mjs'
import {createSkillValidationController} from '../src/skillValidationController.mjs'
import {createGeoTestDatabase} from './helpers/geoTestDatabase.mjs'
const sha=value=>createHash('sha256').update(value).digest('hex')

test('one actual Chinese ZIP/native/private generation/readonly Docker/validator chain preserves canonical resources and depth16',{
  skip:!process.env.OPEN_SCIENCE_TEST_POSTGRES_URL||!process.env.EVIMED_SKILL_VALIDATION_TEST_IMAGE,timeout:60000,
},async()=>{
  const isolated=await createGeoTestDatabase(process.env.OPEN_SCIENCE_TEST_POSTGRES_URL,'unicode')
  const db=new ControlPlaneDatabase({databaseUrl:isolated.url,databasePoolMax:1,databaseConnectionTimeoutMs:1000})
  const base=process.env.EVIMED_SKILL_VALIDATION_TEST_DATA;assert.ok(base&&path.isAbsolute(base));await fs.mkdir(base,{recursive:true})
  const root=await fs.realpath(await fs.mkdtemp(path.join(base,'unicode-chain-')))
  const image=process.env.EVIMED_SKILL_VALIDATION_TEST_IMAGE;assert.match(image,/^sha256:[a-f0-9]{64}$/u)
  const user={id:'unicode_'+randomUUID()},project={userId:user.id,id:'project'}
  const library=path.join(root,'.openscience','skill-library');await fs.mkdir(library,{recursive:true,mode:0o700})
  const artifacts=new SkillLibraryArtifacts({root:library,parseSkill:parsePersonalSkill,decodeArchive:decodeSkillArchive,minFreeBytes:1})
  const skills=new SkillLibraryService(db,{artifacts,projectAccess:async(actor,p)=>{const row=await db.query('SELECT id FROM evimed_control.projects WHERE user_id=$1 AND id=$2',[actor.id,p.id]);assert.equal(row.rowCount,1)}})
  const plugins=new PluginService(db),config={dataDir:root,runtimeContainerBin:'docker',runtimeContainerImage:image}
  const generations=new PersonalSkillGenerationService(db,{config,skillService:skills,pluginService:plugins,resolveUser:async()=>user,identities:async()=>({baseRuntimeImageDigest:image,adapterRevision:'sha256:'+'b'.repeat(64),permissionProfileRevision:'sha256:'+'c'.repeat(64)}),ledgerBusy:async()=>false})
  const controller=createSkillValidationController(config,{availableMemory:async()=>2*1024**3})
  const resource='资料/证据汇总.csv',deep=Array.from({length:15},()=> '资料').join('/')+'/深层证据.csv',csv=Buffer.from('字段,值\n研究证据,1\n')
  const docker=promisify(execFile),reader='evimed-unicode-reader-'+randomUUID()
  try{
    await db.migrate();await db.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Unicode fixture','development')",[user.id]);await db.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,$2,'Unicode',1048576)",[user.id,project.id])
    const zip=Buffer.from(zipSync({'仓库/SKILL.md':Buffer.from('---\nname: unicode-import\ndescription: Unicode resources\n---\nRead the supplied evidence.\n'),['仓库/'+resource]:csv,['仓库/'+deep]:csv,'仓库/引用/cafe\u0301.csv':csv,'仓库/scripts/检查.py':Buffer.from('raise RuntimeError("inert fixture script")\n')}))
    const uploaded=await skills.upload(user,'zip',zip),imported=await skills.import(user,{resourceId:uploaded.resourceId,title:'中文证据方法'})
    assert.deepEqual(imported.payload.resources.map(x=>x.path),[resource,deep,'引用/café.csv','scripts/检查.py'])
    for(const item of imported.payload.resources.filter(x=>x.path.endsWith('.csv')))assert.deepEqual(await skills.resource(user,imported.id,1,item.id),csv)
    await skills.saveProjectSelections(user,project,{expectedRevision:0,skills:[{skillId:imported.id,revision:1}]})
    const candidate=await plugins.withAdmission(project,()=>db.transaction(()=>generations.reconcile(user,project)))
    const selected=await verifyPersonalSkillGeneration(config,project,candidate.reference,image)
    assert.equal((await parsePersonalSkill(selected.mountRoot,{expectedName:imported.payload.nativeName})).instructions,'Read the supplied evidence.')
    assert.deepEqual(await fs.readFile(path.join(selected.mountRoot,imported.payload.nativeName,resource)),csv)
    const code="const fs=require('node:fs');const p='/input/'+process.argv[1]+'/资料/证据汇总.csv';console.log(JSON.stringify({uid:process.getuid(),data:fs.readFileSync(p,'utf8'),mode:fs.statSync(p).mode&4095}));"
    await docker('docker',['create','--pull','never','--name',reader,'--read-only','--network','none','--user','10001:10001','--cap-drop','ALL','--security-opt','no-new-privileges','--memory','256m','--pids-limit','32','--cpus','0.5','--mount',`type=bind,source=${selected.mountRoot},target=/input,readonly`,'--entrypoint','node',image,'-e',code,imported.payload.nativeName],{timeout:10000})
    const read=JSON.parse((await docker('docker',['start','--attach',reader],{timeout:15000,maxBuffer:4096})).stdout)
    assert.deepEqual(read,{uid:10001,data:csv.toString(),mode:0o444})
    const reference={ownerHash:sha(user.id),kind:'packages',contentId:imported.payload.digest.slice(7),expectedName:imported.payload.nativeName}
    const before=await fs.stat(path.join(await artifacts.preparedRoot(user,imported.payload),imported.payload.nativeName,resource))
    assert.equal((await controller.validate(reference)).name,imported.payload.nativeName)
    const after=await fs.stat(path.join(await artifacts.preparedRoot(user,imported.payload),imported.payload.nativeName,resource));assert.equal(after.mode,before.mode);assert.equal(after.ctimeMs,before.ctimeMs)
    // Stored hash-bound manifests refuse noncanonical spelling instead of rewriting it.
    const bad=structuredClone(imported.payload);bad.resources=bad.resources.map(x=>x.path==='引用/café.csv'?{...x,path:'引用/cafe\u0301.csv'}:x)
    await assert.rejects(artifacts.preparedRoot(user,bad))
  }finally{
    await controller.close();await docker('docker',['rm','--force',reader],{timeout:15000}).catch(error=>{if(!/no such/iu.test(String(error.stderr)))throw error});await assert.rejects(docker('docker',['inspect',reader]),/no such/iu)
    await db.close();await isolated.drop();await fs.rm(root,{recursive:true,force:true})
  }
})
