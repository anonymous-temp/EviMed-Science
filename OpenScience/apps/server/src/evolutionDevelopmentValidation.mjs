/** Deterministic public development examples are inspected before hidden evaluation.
 * No hidden values, model calls or candidate-written test verdicts participate.
 * `expectedSubset` on a case compares only the fields its expectation names: an expectation computed by a
 * reference implementation lists the numeric outputs, and a tool may return more than those. @param {any} dependencies */
export function createEvolutionDevelopmentValidation({controller}) {
  return {
    /**
     * @param {any} candidate
     * @param {{contract?:any,signal?:AbortSignal}} [options]
     */
    async validate(candidate,{contract,signal}={}) {
    if(!contract?.cases?.length)return {ok:true,status:'verified',issues:[],executions:[]};
    if(contract.cases.some(testCase=>!testCase?.id || !testCase.input || [testCase.absoluteTolerance??1e-8,testCase.relativeTolerance??0].some(value=>typeof value!=='number'||!Number.isFinite(value)||value<0)))return {ok:false,status:'waiting_resource',issues:[{code:'public_development_contract_invalid'}],executions:[]};
    const entry=/^(scripts\/[A-Za-z0-9_-]+\.py):([A-Za-z_][A-Za-z0-9_]*)$/.exec(candidate.entrypoint??'');
    if(!entry || !Object.hasOwn(candidate.files??{},entry[1]))return {ok:false,status:'repair',issues:[{code:'public_development_callable_missing'}],executions:[]};
    const code=`import runpy,json,sys,math\nnamespace=runpy.run_path(${JSON.stringify(`/candidate/${entry[1]}`)},run_name='public_development')\nfunction=namespace[${JSON.stringify(entry[2])}]\ncases=json.load(sys.stdin)\nresults=[]\ndef contains_number(value):\n if isinstance(value,dict): return any(contains_number(item) for item in value.values())\n if isinstance(value,list): return any(contains_number(item) for item in value)\n return isinstance(value,(int,float)) and not isinstance(value,bool)\ndef same(actual,expected,absolute,relative,subset=False):\n if isinstance(expected,dict): return isinstance(actual,dict) and (set(expected)<=set(actual) if subset else set(actual)==set(expected)) and all(same(actual[key],value,absolute,relative,subset) for key,value in expected.items())\n if isinstance(expected,list): return isinstance(actual,list) and len(actual)==len(expected) and all(same(a,b,absolute,relative,subset) for a,b in zip(actual,expected))\n if isinstance(expected,(int,float)) and not isinstance(expected,bool): return isinstance(actual,(int,float)) and not isinstance(actual,bool) and math.isfinite(actual) and abs(actual-expected)<=absolute+abs(expected)*relative\n return type(actual) is type(expected) and actual==expected\nfor case in cases:\n passed=False\n try:\n  output=function(**case['input'])\n  if case.get('expectedRefusal') is True:\n   passed=isinstance(output,dict) and (output.get('status') in ('refused','unsupported','invalid','invalid_input') or output.get('supported') is False or output.get('ok') is False) and set(output).issubset({'status','supported','ok','reason','message','code','error','refusalConditions'}) and not contains_number(output)\n  else: passed=same(output,case['expected'],float(case.get('absoluteTolerance',1e-8)),float(case.get('relativeTolerance',0)),case.get('expectedSubset') is True)\n except (ValueError,TypeError) as error:\n  passed=case.get('expectedRefusal') is True and bool(str(error).strip())\n except Exception:\n  passed=False\n results.append({'caseId':case['id'],'executed':True,'passed':passed})\nprint(json.dumps({'executions':results}))\n`;
    let result;
    try {result=await controller.execVerify({files:candidate.files,dependencyIds:candidate.dependencies??[],code,input:contract.cases},{signal});}
    catch {return {ok:false,status:'waiting_resource',issues:[{code:'public_development_execution_unavailable'}],executions:[]};}
    if(result?.joined!==true || result?.executionStarted!==true)return {ok:false,status:'waiting_resource',issues:[{code:'public_development_execution_unavailable'}],executions:[]};
    let executions;
    try{executions=JSON.parse(String(result.output??result.stdout??'').trim().split('\n').at(-1)).executions;}catch{executions=[];}
    if(result.ok!==true || !Array.isArray(executions) || executions.length!==contract.cases.length || executions.some((row,index)=>row.caseId!==contract.cases[index].id || row.executed!==true || typeof row.passed!=='boolean'))return {ok:false,status:'repair',issues:[{code:'public_development_execution_failed'}],executions:[]};
    const issues=executions.filter(row=>!row.passed).map(row=>({code:'public_development_case_failed',caseId:row.caseId}));
    return {ok:!issues.length,status:issues.length?'repair':'verified',issues,executions};
  }};
}
