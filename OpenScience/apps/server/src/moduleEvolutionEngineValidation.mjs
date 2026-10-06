/** Engine changes execute only in the existing disposable, networkless verification container.
 * Candidate-written tests are provisional development evidence, never independent confirmations.
 * @param {{controller:any,allowedPaths:string[]}} deps */
export function createModuleEvolutionEngineValidation({controller,allowedPaths}){
 async function run(candidate,mode,signal){
  const files=candidate.files??{},names=Object.keys(files),tests=names.filter(name=>/^tests\/[^/]+\.test\.mjs$/.test(name));
  const changed=names.filter(name=>!name.startsWith('tests/'));
  if(!changed.length||changed.some(name=>!allowedPaths.includes(name)))return {ok:false,status:'repair',issues:[{code:'module_engine_path_not_declared'}],executions:[]};
  if(mode==='development'&&!tests.length)return {ok:false,status:'repair',issues:[{code:'module_engine_development_tests_missing'}],executions:[]};
  const code=`import json,subprocess,pathlib\nmode=${JSON.stringify(mode)}\nfiles=${JSON.stringify(changed)}\ntests=${JSON.stringify(tests)}\nresults=[]\nfor name in files:\n result=subprocess.run(['node','--check','/candidate/'+name],capture_output=True,text=True,timeout=20)\n results.append({'path':name,'executed':True,'passed':result.returncode==0,'output':result.stderr[-2000:]})\nif mode=='development' and all(row['passed'] for row in results):\n for name in tests:\n  text=pathlib.Path('/candidate',name).read_text()\n  if 'assert' not in text or not any(pathlib.PurePosixPath(path).name in text for path in files):\n   results.append({'path':name,'executed':False,'passed':False,'output':'A test must assert behavior of the changed module.'});continue\n  result=subprocess.run(['node','--test','--test-reporter=tap','/candidate/'+name],capture_output=True,text=True,timeout=40)\n  results.append({'path':name,'executed':True,'passed':result.returncode==0 and '# pass 0' not in result.stdout and '# pass ' in result.stdout,'output':(result.stdout+result.stderr)[-3000:]})\nprint(json.dumps({'executions':results}))`;
  let result;try{result=await controller.execVerify({files,dependencyIds:[],code},{signal});}catch{return {ok:false,status:'waiting_resource',issues:[{code:'module_engine_node_verification_unavailable'}],executions:[]};}
  if(!result.joined||!result.executionStarted)return {ok:false,status:'waiting_resource',issues:[{code:'module_engine_execution_not_observed'}],executions:[]};
  let executions;try{executions=JSON.parse(String(result.output??result.stdout??'').trim().split('\n').at(-1)).executions;}catch{executions=[];}
  const ok=result.ok===true&&executions.length===changed.length+(mode==='development'?tests.length:0)&&executions.every(row=>row.executed&&row.passed);
  return {ok,status:ok?'verified':'repair',issues:ok?[]:[{code:`module_engine_${mode}_failed`}],executions,independent:false,scope:'provisional-engine-review'};
 }
 return {verify:(candidate,options=/** @type {any} */({}))=>run(candidate,'static',options.signal),validate:(candidate,options=/** @type {any} */({}))=>run(candidate,'development',options.signal)};
}
