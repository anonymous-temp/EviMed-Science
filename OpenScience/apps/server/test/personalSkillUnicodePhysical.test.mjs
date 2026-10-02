import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {canonicalJson,extensionGenerationIdentity,personalSkillName} from '@evimed/domain'
import {verifyPersonalSkillGeneration,personalGenerationRoot} from '../src/personalSkillGenerationService.mjs'
import {createSkillValidationController,skillValidationRoot} from '../src/skillValidationController.mjs'
const options={skip:process.platform!=='linux'&&'Physical NFC/NFD distinct entries require Linux; actual Docker control runs separately.'}
const sha=value=>createHash('sha256').update(value).digest('hex')

test('stored Linux generation rejects an extra same-byte NFD entry instead of deduplicating it',options,async()=>{
  const dataDir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'unicode-physical-')))
  const owner='physical-owner',project={userId:owner,id:'project'},skillId='skill:fixture',nativeName=personalSkillName(owner,skillId,sha),csv=Buffer.from('same bytes')
  const file=`---\nname: ${nativeName}\ndescription: fixture\n---\nbody`,resource={path:'data/café.csv',id:'resource:'+sha(csv),digest:'sha256:'+sha(csv),size:csv.length},resources=[resource],digest='sha256:'+sha(canonicalJson({file,resources}))
  const identity={ownerId:owner,projectId:project.id,baseRuntimeImageDigest:'sha256:'+'a'.repeat(64),adapterRevision:'sha256:'+'b'.repeat(64),permissionProfileRevision:'sha256:'+'c'.repeat(64),selections:[],skills:[{skillId,revision:1,digest}]},scope={userId:owner,accountCreatedAt:'account',projectCreatedAt:'project'},selectionRevision=1
  const reference={ownerHash:sha(owner),projectHash:sha(project.id),generationHash:sha(canonicalJson({identity:extensionGenerationIdentity(identity,{ownerId:owner,projectId:project.id},sha),scope,selectionRevision}))},root=personalGenerationRoot({dataDir},reference)
  const entries=[[`skills/${nativeName}/SKILL.md`,Buffer.from(file)],[`skills/${nativeName}/${resource.path}`,csv]]
  try{
    await fs.mkdir(root,{recursive:true,mode:0o700})
    for(const[relative,bytes]of entries){const target=path.join(root,relative);await fs.mkdir(path.dirname(target),{recursive:true,mode:0o755});await fs.writeFile(target,bytes,{mode:0o444})}
    const manifest={schemaVersion:1,reference,identity,scope,selectionRevision,pins:[{nativeName,ownerHash:reference.ownerHash,contentId:digest.slice(7),skillId,revision:1,digest,resources}],files:entries.map(([path,bytes])=>({path,size:bytes.length,digest:'sha256:'+sha(bytes)}))}
    await fs.writeFile(path.join(root,'manifest.json'),canonicalJson(manifest)+'\n',{mode:0o400})
    await verifyPersonalSkillGeneration({dataDir},project,reference)
    await fs.writeFile(path.join(root,'skills',nativeName,'data','cafe\u0301.csv'),csv,{mode:0o444})
    assert.equal((await fs.readdir(path.join(root,'skills',nativeName,'data'))).length,2)
    await assert.rejects(verifyPersonalSkillGeneration({dataDir},project,reference),{code:'extension_contract_invalid'})
  }finally{await fs.rm(dataDir,{recursive:true,force:true})}
})

test('stored Linux validator rejects raw NFD alias before image lookup or projection publication',options,async()=>{
  const dataDir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'validator-physical-'))),config={dataDir,runtimeContainerBin:'/must-not-execute',runtimeContainerImage:'unused'},reference={ownerHash:'a'.repeat(64),contentId:'b'.repeat(64),kind:'imports',expectedName:null},root=skillValidationRoot(config,reference)
  const controller=createSkillValidationController(config)
  try{await fs.mkdir(path.join(root,'bundle','data'),{recursive:true,mode:0o700});await fs.writeFile(path.join(root,'bundle','SKILL.md'),'---\nname: fixture\ndescription: fixture\n---\nbody',{mode:0o400});for(const name of ['café.csv','cafe\u0301.csv'])await fs.writeFile(path.join(root,'bundle','data',name),'same bytes',{mode:0o400});assert.equal((await fs.readdir(path.join(root,'bundle','data'))).length,2);await assert.rejects(controller.validate(reference),{code:'extension_contract_invalid',status:400});await assert.rejects(fs.stat(path.join(dataDir,'.openscience','skill-validation-state','projections')),{code:'ENOENT'})}
  finally{await controller.close();await fs.rm(dataDir,{recursive:true,force:true})}
})
