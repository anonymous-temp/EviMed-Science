import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  EXTENSION_SAAS_CASE_IDS, EXTENSION_SUPPORTED_DSH_VERSION, EXTENSION_QUALIFICATION_STATES, EXTENSION_EVIDENCE_STATES,
  canonicalExtensionCoordinate, validateExtensionInstallRequest, validateSkillWriteRequest, personalSkillName,
  extensionGenerationIdentity, extensionProofDigest, qualifyExtensionProof, extensionQualificationStateOf, extensionEvidenceState,
} from '../src/extensions.mjs'

/** @param {string} value */
const hash = value => createHash('sha256').update(value).digest('hex')
/** @param {string} value */
const digest = value => `sha256:${hash(value)}`
/** @returns {import('../src/extensions.mjs').ExtensionProofIdentity} */
const identity = () => ({packageIntegrity:digest('package'),sourceCommit:'a'.repeat(40),adapterRevision:digest('adapter'),
  dshVersion:EXTENSION_SUPPORTED_DSH_VERSION,runtimeImageDigest:digest('image'),executionClass:'isolated-tool',
  permissionProfileRevision:digest('permission'),suiteRevision:digest('suite')})
const proof = () => ({schemaVersion:1,identity:identity(),cases:EXTENSION_SAAS_CASE_IDS.map(caseId=>({caseId,status:'pass',
  observationDigests:[digest('observation-'+caseId)],artifactDigests:[digest('artifact-'+caseId)]}))})
/** @param {any} value @returns {any} */
function trusted(value) {
  return {...value,receiptDigest:extensionProofDigest(value,hash)}
}
/** @param {any} receipt */
const authority = receipt => ({sha256Hex:hash,trustedReceiptDigests:new Set([receipt.receiptDigest]),
  trustedSurfaces:{client:false,browser:false,externalActions:false,descriptorDigest:digest('descriptor')}})
const install = () => ({coordinate:{kind:'npm',name:'@example/tool',version:'1.0.0'},scope:'project',projectId:'p1',idempotencyKey:'install-one'})

test('coordinates preserve exact publisher identity and refuse ranges, URLs and path escapes',()=>{
  const credentialUrl = new URL('https://github.com/a/b')
  credentialUrl.username = 'fixture-user'
  credentialUrl.password = 'fixture-password'
  assert.equal(canonicalExtensionCoordinate({kind:'npm',name:'@example/tool',version:'1.0.0-rc.2'}),'npm:@example/tool@1.0.0-rc.2')
  assert.equal(canonicalExtensionCoordinate({kind:'github',repository:'Example/Tool',commit:'a'.repeat(40),subdirectory:'packages/mcp'}),`github:example/tool@${'a'.repeat(40)}#packages/mcp`)
  for(const coordinate of [{kind:'npm',name:'tool',version:'latest'},{kind:'npm',name:'tool',version:'^1.0.0'},
    {kind:'npm',name:'../tool',version:'1.0.0'},{kind:'github',repository:credentialUrl.href,commit:'a'.repeat(40)},
    {kind:'github',repository:'a/b',commit:'main'},{kind:'github',repository:'a/b',commit:'a'.repeat(40),subdirectory:'../secrets'}]) {
    assert.throws(()=>canonicalExtensionCoordinate(coordinate),{code:'extension_contract_invalid'})
  }
})
test('installation and imported records cannot assert identity, secrets or qualified proof',()=>{
  assert.equal(validateExtensionInstallRequest(install()).projectId,'p1')
  for(const key of ['ownerId','userId','role','qualified','proof','trustedReceiptDigests','hostPath','env','cmd','apiKey','credentials']) {
    assert.throws(()=>validateExtensionInstallRequest({...install(),[key]:'forged'}),{code:'extension_contract_invalid'})
  }
  assert.throws(()=>validateExtensionInstallRequest({...install(),scope:'library'}))
  assert.throws(()=>validateExtensionInstallRequest({...install(),coordinate:{...install().coordinate,token:'secret'}}))
})
test('personal skill edits are explicit CAS content and native names do not collide with titles or owners',()=>{
  assert.deepEqual(validateSkillWriteRequest({expectedRevision:0,title:'Research style',description:'Style',instructions:'Keep evidence.'}),
    {expectedRevision:0,title:'Research style',description:'Style',instructions:'Keep evidence.'})
  assert.throws(()=>validateSkillWriteRequest({expectedRevision:0,title:'Style',instructions:'body',ownerId:'other'}))
  assert.throws(()=>validateSkillWriteRequest({expectedRevision:-1,title:'Style',description:'',instructions:'body'}))
  const a=personalSkillName('owner-a','skill-one',hash)
  assert.match(a,/^personal-[a-f0-9]+-[a-f0-9]+$/)
  assert.notEqual(a,personalSkillName('owner-b','skill-one',hash))
  assert.notEqual(a,personalSkillName('owner-a','skill-two',hash))
  assert.notEqual(a,'vcr-protocol')
})
function generation() {
  return {ownerId:'owner-a',projectId:'p1',baseRuntimeImageDigest:digest('image'),adapterRevision:digest('adapter'),
    permissionProfileRevision:digest('permission'),selections:[{extensionId:'tool',artifactDigest:digest('package'),configRevision:1,
      configDigest:digest('config'),connectionRefs:['connection-one']}],skills:[{skillId:'skill-one',revision:1,digest:digest('skill')}]}
}
test('immutable generation identity is canonical, scoped and changes with every mounted revision',()=>{
  const a=generation(),scope={ownerId:'owner-a',projectId:'p1'}
  const id=extensionGenerationIdentity(a,scope,hash)
  assert.equal(id,extensionGenerationIdentity({...a,selections:a.selections.map(v=>({...v,connectionRefs:[...v.connectionRefs]}))},scope,hash))
  assert.notEqual(id,extensionGenerationIdentity({...a,skills:[{...a.skills[0],revision:2}]},scope,hash))
  assert.notEqual(id,extensionGenerationIdentity({...a,projectId:'p2'},{...scope,projectId:'p2'},hash))
  assert.throws(()=>extensionGenerationIdentity(a,{...scope,ownerId:'owner-b'},hash))
  assert.throws(()=>extensionGenerationIdentity({...a,selections:[a.selections[0],a.selections[0]]},scope,hash))
  assert.throws(()=>extensionGenerationIdentity({...a,selections:[{...a.selections[0],settings:{apiKey:'secret'}}]},scope,hash))
})
test('only externally trusted receipts with all22 observed cases qualify',()=>{
  const receipt=trusted(proof())
  assert.equal(qualifyExtensionProof(receipt,identity(),authority(receipt)).qualified,true)
  assert.throws(()=>qualifyExtensionProof(receipt,identity(),{...authority(receipt),trustedReceiptDigests:new Set()}),{code:'extension_proof_untrusted'})
  assert.throws(()=>qualifyExtensionProof({...receipt,trusted:true},identity(),authority(receipt)),{code:'extension_contract_invalid'})
})
test('proof receipt binds outcomes, observations and artifact digests, not only identity',()=>{
  const receipt=trusted(proof())
  for(const patch of [{status:'unknown'},{observationDigests:[digest('tampered')]},{artifactDigests:[digest('tampered')]}]) {
    const changed={...receipt,cases:receipt.cases.map((/** @type {any} */ row,/** @type {number} */ i)=>i?row:{...row,...patch})}
    assert.throws(()=>qualifyExtensionProof(changed,identity(),authority(receipt)),{code:'extension_proof_untrusted'})
  }
})
test('receipt cannot be reused across artifact, adapter, kernel, image, class, permission or suite changes',()=>{
  const receipt=trusted(proof())
  for(const [key,value]of Object.entries({...identity(),packageIntegrity:digest('new-package'),sourceCommit:'b'.repeat(40),adapterRevision:digest('new-adapter'),
    dshVersion:'0.2.0',runtimeImageDigest:digest('new-image'),executionClass:'managed-native',permissionProfileRevision:digest('new-permission'),suiteRevision:digest('new-suite')})) {
    assert.throws(()=>qualifyExtensionProof(receipt,{...identity(),[key]:value},authority(receipt)),error=>['extension_proof_stale','extension_contract_invalid'].includes(/** @type {any} */(error).code))
  }
})
test('missing, duplicate, out-of-matrix, unknown, skipped and unavailable cases never qualify',()=>{
  const value=proof()
  for(const cases of [value.cases.slice(1),[...value.cases,value.cases[0]],value.cases.map((r,i)=>i?r:{...r,caseId:'SAAS-99'}),
    ...['unknown','skipped','unavailable','fail'].map(status=>value.cases.map((r,i)=>i?r:{...r,status}))]) {
    const receipt=trusted({...value,cases})
    assert.throws(()=>qualifyExtensionProof(receipt,identity(),authority(receipt)),{code:'extension_proof_incomplete'})
  }
})
test('not-applicable needs a genuinely unreachable trusted surface and its retained observation',()=>{
  const value=proof(),na={...value.cases[8],status:'not-applicable',reason:'No client entry or action surface',observationDigests:[digest('descriptor')]}
  const receipt=trusted({...value,cases:value.cases.map((r,i)=>i===8?na:r)})
  assert.equal(qualifyExtensionProof(receipt,identity(),authority(receipt)).qualified,true)
  for(const surfaces of [{...authority(receipt).trustedSurfaces,client:true},{...authority(receipt).trustedSurfaces,descriptorDigest:digest('wrong')}]) {
    assert.throws(()=>qualifyExtensionProof(receipt,identity(),{...authority(receipt),trustedSurfaces:surfaces}),{code:'extension_proof_incomplete'})
  }
  const forbidden=trusted({...value,cases:value.cases.map((r,i)=>i===0?{...na,caseId:r.caseId}:r)})
  assert.throws(()=>qualifyExtensionProof(forbidden,identity(),authority(forbidden)),{code:'extension_proof_incomplete'})
})
test('contract data never evaluates proof getters or accepts hidden authoritative fields',()=>{
  let reads=0
  const candidate=proof()
  Object.defineProperty(candidate.cases[0],'status',{enumerable:true,get(){reads++;return 'pass'}})
  assert.throws(()=>extensionProofDigest(candidate,hash),{code:'extension_contract_invalid'})
  assert.equal(reads,0)
  const request=install()
  Object.defineProperty(request,'scope',{value:'project',enumerable:false})
  assert.throws(()=>validateExtensionInstallRequest(request),{code:'extension_contract_invalid'})
})
test('observations, bounds and hash implementations must remain explicit',()=>{
  const absent=proof();absent.cases[0].observationDigests=[];const receipt=trusted(absent)
  assert.throws(()=>qualifyExtensionProof(receipt,identity(),authority(receipt)),{code:'extension_proof_incomplete'})
  assert.throws(()=>personalSkillName('a','b',()=> 'invalid'),{code:'extension_contract_invalid'})
  assert.throws(()=>validateSkillWriteRequest({expectedRevision:0,title:'中'.repeat(81),description:'',instructions:'body'}))
  assert.throws(()=>extensionGenerationIdentity({...generation(),skills:[{...generation().skills[0],revision:0}]},{ownerId:'owner-a',projectId:'p1'},hash))
  assert.throws(()=>canonicalExtensionCoordinate({kind:'url',name:'http://127.0.0.1'}))
})
test('registry artifacts without a Git commit keep that fact null while integrity stays mandatory',()=>{
  const value=proof();value.identity.sourceCommit=null
  const receipt=trusted(value)
  assert.equal(qualifyExtensionProof(receipt,value.identity,authority(receipt)).identity.sourceCommit,null)
  assert.throws(()=>extensionProofDigest({...value,identity:{...value.identity,packageIntegrity:null}},hash),{code:'extension_contract_invalid'})
})
for(const field of /** @type {const} */ (['selections','skills'])) {
  for(const attack of ['sparse','accessor','custom-prototype']) {
    test(`${field} rejects ${attack} before generation identity evaluation`,()=>{
      const scope={ownerId:'owner-a',projectId:'p1'},base=generation(),entry=base[field][0]
      let reads=0
      const list=attack==='sparse'?Array(1):[entry]
      if(attack==='accessor')Object.defineProperty(list,'0',{enumerable:true,get(){reads++;return entry}})
      if(attack==='custom-prototype')Object.setPrototypeOf(list,Object.create(Array.prototype))
      assert.throws(()=>extensionGenerationIdentity({...base,[field]:list},scope,hash),{code:'extension_contract_invalid'})
      assert.equal(reads,0,'Generation validation must never evaluate an indexed getter')
    })
  }
}

test('personal resources share NFC Unicode paths, UTF8/depth bounds and portable collision keys', async () => {
  const {canonicalPersonalSkillResourcePath:canonical}=await import('../src/extensions.mjs')
  assert.deepEqual(canonical('资料/证据汇总.csv'),{path:'资料/证据汇总.csv',key:'资料/证据汇总.csv'})
  assert.equal(canonical('数据/cafe\u0301.csv').path,'数据/café.csv')
  assert.equal(canonical('Straße.csv').key,canonical('STRASSE.csv').key)
  assert.equal(canonical('Σ.csv').key,canonical('ς.csv').key)
  assert.equal(canonical(Array.from({length:16},()=> '资料').join('/')).path.split('/').length,16)
  assert.throws(()=>canonical(Array.from({length:17},()=> '资料').join('/')))
  assert.throws(()=>canonical('数'.repeat(34)))
  for(const value of ['../证据','/证据','资料\\证据','资料/\u0001数据','资料/.密钥','资料/.git/config','node_modules/数据','credentials.json','secrets.json','id_ecdsa.pub','证据.pem','证据.key','ＮＯＤＥ_ＭＯＤＵＬＥＳ/数据','se\u0301crets.json','资料/💉.csv'])assert.throws(()=>canonical(value),value)
  const prefixes=new Map();canonical('资料/Report.csv',prefixes);assert.throws(()=>canonical('资料/report.csv',prefixes))
  const aliases=new Map();canonical('引用/Σ/a.csv',aliases);assert.throws(()=>canonical('引用/ς/b.csv',aliases))
})

test('the kernel version the extension contracts are written for is the pin, written once in deps-version.json',()=>{
  const pin=JSON.parse(readFileSync(new URL('../../../deps-version.json',import.meta.url),'utf8')).dsh.version
  assert.equal(EXTENSION_SUPPORTED_DSH_VERSION,pin,'moving the pin must move this constant with it (and revalidate the extension contracts)')
  // The identity check reads the constant, so a receipt measured on another kernel is not an identity at all.
  assert.throws(()=>qualifyExtensionProof(trusted(proof()),{...identity(),dshVersion:'0.0.0-unsupported.1'},authority(trusted(proof()))),{code:'extension_contract_invalid'})
})
test('a record is a label: every way of reading it maps to one of four states and one word the centre shows',()=>{
  const receipt=trusted(proof())
  /** @param {unknown} value @param {unknown} current @param {any} [trustedAuthority] */
  const read=(value,current,trustedAuthority=authority(receipt))=>{try{qualifyExtensionProof(value,current,trustedAuthority);return 'qualified'}catch(error){return extensionQualificationStateOf(error)}}
  assert.equal(read(receipt,identity()),'qualified')
  assert.equal(read(receipt,{...identity(),runtimeImageDigest:digest('moved-image')}),'stale','a genuine record for an earlier identity')
  assert.equal(read(trusted({...proof(),cases:proof().cases.slice(1)}),identity(),authority(trusted({...proof(),cases:proof().cases.slice(1)}))),'incomplete','a genuine record with unmet cases')
  assert.equal(read(receipt,identity(),{...authority(receipt),trustedReceiptDigests:new Set()}),'unqualified','a record nobody trusts')
  assert.equal(read({...receipt,forged:true},identity()),'unqualified','a malformed record')
  assert.equal(extensionQualificationStateOf(new Error('unreadable')),'unqualified')
  assert.equal(extensionQualificationStateOf(undefined),'unqualified')
  assert.equal(extensionQualificationStateOf(null),'unqualified')
  // One vocabulary: each state has exactly one word on the centre's ladder, and the words are the ladder's own.
  assert.deepEqual([...EXTENSION_QUALIFICATION_STATES],['qualified','unqualified','stale','incomplete'])
  const words=EXTENSION_QUALIFICATION_STATES.map(extensionEvidenceState)
  assert.deepEqual(words,['saas-qualified','source-assessed','qualification-stale','qualification-incomplete'])
  assert.equal(new Set(words).size,4)
  for(const word of words)assert.ok(EXTENSION_EVIDENCE_STATES.includes(word),word)
  assert.equal(extensionEvidenceState('anything-else'),'source-assessed','an unknown state is shown as the unverified one, never as qualified')
})
