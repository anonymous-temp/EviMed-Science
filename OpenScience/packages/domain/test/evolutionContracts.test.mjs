import test from 'node:test';
import assert from 'node:assert/strict';
import {runGate} from '../src/contractRegistry.mjs';
test('development contracts validate real JSON structure without a research delivery veto',()=>{
  /** @type {[string,string,any][]} */
  const fixtures = [
    ['evolution-research-card','research-card.json',{id:'missing-tool',track:'E',publicationKind:'skill',goal:'Implement a missing method.',developmentCases:[]}],
    ['evolution-tool-candidate','tool-candidate.json',{id:'missing-tool',track:'E',publicationKind:'isolated-tool',entrypoint:'scripts/tool.py:calculate',files:{'scripts/tool.py':'def calculate(): return 1'}}],
  ];
  for(const [contractKind,file,value] of fixtures){
    const good=runGate({contractKind,files:new Map([[file,JSON.stringify(value)]])});assert.equal(good.ok,true);assert.equal(good.issues.length,0);
    const malformed=runGate({contractKind,files:new Map([[file,'{}']])});assert.equal(malformed.ok,true);assert.ok(malformed.issues.length);assert.ok(malformed.issues.every(issue=>issue.severity==='advisory'));
    const leaked=runGate({contractKind,files:new Map([[file,JSON.stringify({...value,goldAnswers:[42]})]])});assert.ok(leaked.issues.some(issue=>issue.message.includes('Evaluator assets')));
  }
});

test('candidate file references share safe relative artifact rules with inline UTF-8 resources',()=>{
  const base={id:'candidate',track:'E',publicationKind:'skill'};
  const findings=value=>runGate({contractKind:'evolution-tool-candidate',files:new Map([['tool-candidate.json',JSON.stringify({...base,...value})]])}).issues;
  assert.equal(findings({filePaths:{'scripts/tool.py':'deliverables/tool.py'}}).length,0);
  assert.equal(findings({files:{'SKILL.md':'Text'},filePaths:{'scripts/tool.py':'deliverables/tool.py'}}).length,0);
  for(const value of [{filePaths:{'scripts/tool.py':'../tool.py'}},{filePaths:{'../tool.py':'tool.py'}},{filePaths:{'tool.py':'/tmp/tool.py'}},{filePaths:{'tool.py':2}},{files:{'tool.py':'code'},filePaths:{'tool.py':'other.py'}},{files:{'tool.py':'\ud800'}},{}])assert.ok(findings(value).length);
});
