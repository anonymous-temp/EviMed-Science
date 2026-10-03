/** Synthetic trusted roots, generated inside Linux so physical NFC/NFD aliases remain distinct. */
import fs from 'node:fs';
const core='/opt/evimed/socket/presets/evimed-universal/skills/core',community='/opt/evimed/socket/presets/evimed-universal/skills/community',personal='/opt/evimed/personal-skills';
for(const[root,name,policy]of[[core,'catalogue-template','user-invocable: false\n'],[core,'alias-control',''],[community,'community-template',''],[personal,'personal-fixture','']]){
 const dir=root+'/'+name;fs.mkdirSync(dir+'/资料',{recursive:true});fs.writeFileSync(dir+'/SKILL.md',`---\nname: ${name}\ndescription: Synthetic native fixture\n${policy}metadata:\n  title: 原始模板\n---\n\nUse the preserved Chinese resource.`);fs.writeFileSync(dir+'/资料/证据.csv','来源,结果\n真实,1\n');
 if(name==='alias-control'){fs.writeFileSync(dir+'/资料/café.csv','same');fs.writeFileSync(dir+'/资料/cafe\u0301.csv','same');}
}
const digest='sha256:'+'a'.repeat(64),legacy={extensionId:'dsh-cite',compatibility:'legacy-citation-v1',enabled:true,configRevision:1,settings:{timeoutMs:4000}},external={extensionId:'cowork-portable',executionClass:'isolated-tool',coordinate:{kind:'github',repository:'Jesse-njx/dsh-cowork',commit:'2ae5cf755c4294a1e988eebf3b12dd062425d84c'},enabled:true,settings:{},connectionRefs:[],artifactDigest:digest,configRevision:1};
for(const mode of['enabled','disabled']){fs.mkdirSync('/fixture/generations/'+mode,{recursive:true});fs.writeFileSync('/fixture/generations/'+mode+'/projection.json',JSON.stringify({schemaVersion:1,generationDigest:digest,personal:{reference:null,digest:null},plugins:[{...legacy,enabled:mode==='enabled',settings:{timeoutMs:mode==='enabled'?4000:5000}},{...external,enabled:mode==='enabled'}]}));}
