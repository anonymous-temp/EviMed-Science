import {verifyCodeSkill} from './codeSkillVerification.mjs';

/** Executed only in the disposable controller container. AST checks inspect executable constructs;
 * scientific claims and skill prose do not participate in this decision.
 *
 * What is not here: a rule for hard-coded answers. The one that was (`candidate_expected_value_embedded`)
 * looked at the names of assignment targets, and a name cannot decide whether code computes or recites:
 * a lookup table of answers passed it and an honest `expected_value_treat` was refused. That question is
 * answered where the answers are, by behaviour: `evolutionCandidateEvaluator.mjs` runs the candidate on
 * inputs it derives from the hidden cases (`evals/paper-gold/behavioural.mjs`), and reports a hidden value
 * found as a literal in the source as a notice. */
export const EVOLUTION_STATIC_CHECK = String.raw`
import ast,json,pathlib
issues=[]
denied={'requests','httpx','urllib','socket','aiohttp','ftplib','smtplib','subprocess','ctypes','importlib','multiprocessing','pickle','marshal','pty','pdb','bdb','runpy','pytest','unittest.mock','posix','_socket'}
def issue(code,path):
    item={'code':code,'path':path,'message':code}
    if item not in issues: issues.append(item)
for file in pathlib.Path('/candidate').rglob('*.py'):
    name=str(file.relative_to('/candidate'))
    try: tree=ast.parse(file.read_text(encoding="utf-8-sig"),filename=name)
    except SyntaxError: issue('candidate_syntax_invalid',name); continue
    aliases={}
    allowed_negative_handlers=set()
    if name.startswith('tests/'):
        for function in tree.body:
            if not isinstance(function,ast.FunctionDef): continue
            body=function.body
            if body and isinstance(body[0],ast.Expr) and isinstance(body[0].value,ast.Constant) and isinstance(body[0].value.value,str): body=body[1:]
            if len(body)!=2: continue
            attempt,fallthrough=body
            if not isinstance(attempt,ast.Try) or attempt.orelse or attempt.finalbody or len(attempt.handlers)!=1 or len(attempt.body)!=1: continue
            handler=attempt.handlers[0]
            if not isinstance(handler.type,ast.Name) or handler.type.id not in {'ValueError','TypeError'}: continue
            if not isinstance(attempt.body[0],ast.Expr) or not isinstance(attempt.body[0].value,ast.Call): continue
            if len(handler.body)!=1 or not isinstance(handler.body[0],ast.Return) or not isinstance(handler.body[0].value,ast.Constant) or handler.body[0].value.value is not True: continue
            if not isinstance(fallthrough,ast.Return) or not isinstance(fallthrough.value,ast.Constant) or fallthrough.value.value is not False: continue
            if any(isinstance(n,ast.Assert) and isinstance(n.test,ast.Call) and isinstance(n.test.func,ast.Name) and n.test.func.id==function.name for n in ast.walk(tree)):
                allowed_negative_handlers.add(id(handler))
    for node in ast.walk(tree):
        if isinstance(node,(ast.Import,ast.ImportFrom)):
            modules=[a.name for a in node.names] if isinstance(node,ast.Import) else [node.module or '']
            for module in modules:
                if module.split('.')[0] in denied: issue('candidate_network_import_denied',name)
            for a in node.names: aliases[a.asname or a.name]=(node.module+'.'+a.name if isinstance(node,ast.ImportFrom) and node.module else a.name)
        if isinstance(node,ast.Name) and node.id in {'__import__','eval','exec','compile','getattr','setattr','delattr','globals','locals','vars','breakpoint'}: issue('candidate_control_override',name)
        if isinstance(node,ast.Call):
            fn=ast.unparse(node.func)
            first,*rest=fn.split('.')
            fn='.'.join([aliases.get(first,first),*rest])
            if fn in {'exit','quit','sys.exit','os._exit','__import__','eval','exec','compile','setattr','delattr','getattr','globals','locals','vars'} or fn.startswith(('os.system','os.popen','os.exec','os.spawn','builtins.','unittest.mock.','mock.patch','pytest.skip','pytest.xfail')):
                issue('candidate_control_override',name)
        if isinstance(node,ast.Attribute) and node.attr in {'__globals__','__builtins__','__subclasses__','__code__','__dict__','__getattribute__'}: issue('candidate_control_override',name)
        if isinstance(node,ast.Assert) and isinstance(node.test,ast.Compare):
            operands=[node.test.left,*node.test.comparators]
            if len(operands)==2 and ast.dump(operands[0])==ast.dump(operands[1]) and any(isinstance(op,(ast.Eq,ast.LtE,ast.GtE)) for op in node.test.ops): issue('candidate_constant_assert',name)
        if isinstance(node,ast.Assert) and isinstance(node.test,ast.Constant) and bool(node.test.value): issue('candidate_constant_assert',name)
        if isinstance(node,(ast.Assign,ast.AnnAssign)):
            targets=node.targets if isinstance(node,ast.Assign) else [node.target]
            for target in targets:
                value=ast.unparse(target)
                if any(x in value for x in ['__eq__','__builtins__','assertEqual','assert_allclose','pytest','unittest']): issue('candidate_test_override',name)
        if isinstance(node,(ast.FunctionDef,ast.AsyncFunctionDef)) and node.name=='__eq__':
            if any(isinstance(n,ast.Return) and isinstance(n.value,ast.Constant) and n.value.value is True for n in ast.walk(node)): issue('candidate_constant_equality',name)
        if name.startswith('tests/') and isinstance(node,ast.ExceptHandler) and (node.type is None or any(isinstance(n,ast.Name) and n.id in {'AssertionError','Exception','BaseException'} for n in ast.walk(node.type))): issue('candidate_exception_swallowed',name)
        if isinstance(node,ast.ExceptHandler) and id(node) not in allowed_negative_handlers and all(isinstance(n,ast.Pass) or isinstance(n,ast.Return) and (n.value is None or isinstance(n.value,ast.Constant)) for n in node.body): issue('candidate_exception_swallowed',name)
print(json.dumps({'issues':issues}))
`;
/** @param {{execute:(body:any,options?:any)=>Promise<any>,prepareDependencies?:(requests:any[],options?:any)=>Promise<any>}} dependencies */
export function createEvolutionVerification({execute,prepareDependencies}){
  return{async verify(candidate,{signal=undefined}={}){
    if(!candidate?.files||!Object.keys(candidate.files).length)return{ok:false,issues:[{code:'candidate_files_missing',message:'Candidate files are required.'}],executions:[]};
    if(candidate.dependencies?.length){
      if(!prepareDependencies)return{ok:false,issues:[{code:'candidate_dependencies_unavailable',message:'Dependency preparation is unavailable.'}],executions:[]};
      await prepareDependencies(candidate.dependencies,{signal});
    }
    const staticResult=await execute({files:candidate.files,dependencyIds:candidate.dependencies??[],code:EVOLUTION_STATIC_CHECK},{signal});
    if(staticResult?.ok!==true)return{ok:false,issues:[{code:'candidate_static_check_unavailable',message:'Static inspection did not complete successfully.'}],executions:[]};
    let checked;try{checked=JSON.parse(String(staticResult.output??staticResult.stdout??'').trim().split('\n').at(-1));}catch{return{ok:false,issues:[{code:'candidate_static_check_unavailable',message:'Static inspection did not return a verdict.'}],executions:[]};}
    if(checked.issues?.length)return{ok:false,issues:checked.issues,executions:[]};
    return verifyCodeSkill({files:candidate.files,project:{},signal,runFiles:async(group,stem)=>{
      const code=`import runpy,unittest,inspect,sys\nrunpy.run_path(${JSON.stringify('/candidate/')}+${JSON.stringify(group.script)},run_name='__main__')\nnamespace=runpy.run_path(${JSON.stringify('/candidate/')}+${JSON.stringify(group.test)},run_name='verification_tests')\nsuite=unittest.TestSuite()\ncount=0\nfor name,value in namespace.items():\n if inspect.isclass(value) and issubclass(value,unittest.TestCase) and value is not unittest.TestCase: suite.addTests(unittest.defaultTestLoader.loadTestsFromTestCase(value))\n elif name.startswith('test_') and inspect.isfunction(value): value();count+=1\ncount+=suite.countTestCases()\nif count:\n result=unittest.TextTestRunner(stream=sys.stdout).run(suite)\n assert result.wasSuccessful()\nprint('code-skill-verified:'+${JSON.stringify(stem)})\n`;
      return execute({files:candidate.files,dependencyIds:candidate.dependencies??[],code},{signal});
    },runKernel:async(_project,code,currentSignal)=>execute({files:candidate.files,dependencyIds:candidate.dependencies??[],code},{signal:currentSignal})});
  }};
}
