import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {canonicalJson} from '@evimed/domain';
import {HttpError,assertNoSymlinkPath,writeFileExclusiveNoFollow} from './security.mjs';
const sha=value=>createHash('sha256').update(value).digest('hex');
const refused=()=>new HttpError(400,'extension_contract_invalid','Dependency is not an exact admitted artifact.');
/** Acquisition is a fixed disposable preparer, never the control-plane process or a research runtime.
 * URLs and complete wheel closure come from deployment-owned exact-digest entries only.
 * @param {any} config @param {{tools:any,imageId:()=>Promise<string>}} dependencies */
export function createEvolutionDependencyPreparer(config,{tools,imageId}){
  const admitted=new Map((config.evolutionDependencyAllowlist??[]).map(item=>[item.id,Object.freeze({...item})]));
  const root=path.join(config.dataDir,'.openscience','evolution-dependencies');
  async function entries(requests){
    if(!Array.isArray(requests)||requests.length>16)throw refused();
    return requests.map(request=>{
      const item=admitted.get(request.id),url=item?new URL(item.url):null;
      if(!item||Object.keys(request).sort().join(',')!=='digest,id,version'||request.digest!==item.digest||request.version!==item.version||!/^sha256:[a-f0-9]{64}$/.test(item.digest)||!url||url.protocol!=='https:'||url.username||url.password||url.hash||url.search||(url.port&&url.port!=='443')||!/^[-A-Za-z0-9_.]+\.(?:whl|zip|tar\.gz)$/.test(item.filename))throw refused();
      return item;
    }).sort((a,b)=>a.id.localeCompare(b.id));
  }
  async function selectedImage(requests){
    const selected=await entries(requests);if(!selected.length)return imageId();
    const identity=sha(canonicalJson({base:await imageId(),selected})),target=path.join(root,'images',identity+'.json');
    await assertNoSymlinkPath(config.dataDir,target,{allowMissingTail:true});const saved=JSON.parse(await fs.readFile(target,'utf8'));
    if(saved.identity!==identity||!/^sha256:[a-f0-9]{64}$/.test(saved.imageId))throw refused();return saved.imageId;
  }
  async function acquire(selected,base,identity,signal){
      // The executor's own physical reservation also holds acquisition: no customer mounts, secrets or sockets.
      const bytes=Buffer.from(canonicalJson(selected));
      const program=`import urllib.request,http.client,socket,ipaddress,json,sys,hashlib,base64\nitems=json.load(sys.stdin)\nclass NoRedirect(urllib.request.HTTPRedirectHandler):\n def redirect_request(self,*args,**kwargs): return None\nclass PublicHTTPS(http.client.HTTPSConnection):\n def connect(self):\n  if self.port!=443: raise ValueError('dependency_port_denied')\n  answers=socket.getaddrinfo(self.host,self.port,type=socket.SOCK_STREAM)\n  addresses=[answer[4][0] for answer in answers]\n  if not addresses or any(not ipaddress.ip_address(address).is_global for address in addresses): raise ValueError('dependency_address_denied')\n  pinned=addresses[0]\n  self._create_connection=lambda address,timeout,source_address=None: socket.create_connection((pinned,self.port),timeout,source_address)\n  super().connect()\nclass PublicHandler(urllib.request.HTTPSHandler):\n def https_open(self,request): return self.do_open(PublicHTTPS,request,context=self._context,check_hostname=self._check_hostname)\nopener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect,PublicHandler)\nresult=[]\nfor item in items:\n response=opener.open(item['url'],timeout=15)\n data=response.read(8*1024*1024+1)\n assert len(data)<=8*1024*1024 and 'sha256:'+hashlib.sha256(data).hexdigest()==item['digest']\n result.append({'filename':item['filename'],'content':base64.b64encode(data).decode()})\nprint(json.dumps(result))`;
      const fetched=await tools.run({imageId:base,artifactDigest:'sha256:'+identity},{jobId:randomUUID(),evolution:true},{network:'bridge',mounts:['--tmpfs','/workspace:ro,noexec,nosuid,nodev,size=1m','--tmpfs','/runtime:ro,noexec,nosuid,nodev,size=1m'],entrypoint:['--entrypoint','python3'],command:['-c',program]},bytes,signal??null,null,false);
      const artifacts=JSON.parse(fetched);if(!Array.isArray(artifacts)||artifacts.length!==selected.length)throw refused();
      const staging=path.join(root,'builds',identity);await fs.mkdir(staging,{recursive:true,mode:0o700});await assertNoSymlinkPath(config.dataDir,staging);
      for(let index=0;index<artifacts.length;index++){
        const item=artifacts[index],expected=selected[index],content=Buffer.from(item.content,'base64');
        if(item.filename!==expected.filename||content.length>8*1024*1024||'sha256:'+sha(content)!==expected.digest)throw refused();
        await writeFileExclusiveNoFollow(config.dataDir,path.join(staging,item.filename),content,{mode:0o444}).catch(error=>{if(error.code!=='EEXIST')throw error;});
      }
      // Freeze exact wheel bytes; installation takes place only in the disposable verification container.
      await writeFileExclusiveNoFollow(config.dataDir,path.join(root,'images',identity+'.json'),canonicalJson({identity,imageId:base,artifacts:selected.map(item=>({filename:item.filename,digest:item.digest}))})+'\n',{mode:0o444}).catch(error=>{if(error.code!=='EEXIST')throw error;});
      return{imageId:base,dependencies:selected.map(({id,version,digest})=>({id,version,digest}))};
  }
  /** Acquisitions in flight by identity: concurrent callers after an image change join one download instead of repeating it. */
  const acquiring=new Map();
  return{
    selectedImage,
    async executionFiles(requests){
      const selected=await entries(requests);if(!selected.length)return{};
      const identity=sha(canonicalJson({base:await imageId(),selected})),files={};
      await selectedImage(requests);
      for(const item of selected){const target=path.join(root,'builds',identity,item.filename);await assertNoSymlinkPath(config.dataDir,target);const stat=await fs.lstat(target);
        if(!stat.isFile()||stat.nlink!==1||stat.size>8*1024*1024)throw refused();const bytes=await fs.readFile(target);if('sha256:'+sha(bytes)!==item.digest)throw refused();files[item.filename]=bytes;}
      return files;
    },
    async prepare(requests,{signal=undefined}={}){
      if(config.evolutionEnabled!==true)throw refused();await tools.reconcileEvolutionAttempts?.();const selected=await entries(requests),base=await imageId();
      if(!selected.length)return{imageId:base,dependencies:[]};
      const identity=sha(canonicalJson({base,selected}));
      try{return{imageId:await selectedImage(requests),dependencies:selected.map(({id,version,digest})=>({id,version,digest}))};}catch(error){if(error.code!=='ENOENT')throw error;}
      if(!acquiring.has(identity))acquiring.set(identity,acquire(selected,base,identity,signal).finally(()=>acquiring.delete(identity)));
      return acquiring.get(identity);
    },
  };
}
