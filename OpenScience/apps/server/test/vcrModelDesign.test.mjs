import assert from 'node:assert/strict';
import test from 'node:test';
import { vcrModelDesignBinding } from '../src/vcrModelDesign.mjs';
import { vcrBuildStages } from '../src/vcrOrchestrator.mjs';
import { prepareVcrSubjectPopulation, resolveJobSubject } from '../src/vcrSubjects.mjs';
const result={id:'res_fit',version:2,executionId:'exe_fit',conclusion:'limited',diagnostics:{fitted:true,modelScope:'population_baseline',sourceCondition:'control',armSelection:{column:'arm',value:'C'},timeUnit:'months',model:{medianParameterQuantileBasis:'R_delta_method',baselineParameterScenarios:{p10:{median:4,controlDistribution:{kind:'weibull',shape:2,scale:4.8}},p50:{median:6,controlDistribution:{kind:'weibull',shape:2,scale:7.2}},p90:{median:9,controlDistribution:{kind:'weibull',shape:2,scale:10.8}}}}}};
const base={design:{kind:'two_arm_fixed',nTreat:50,nControl:50},endpoint:{type:'time_to_event'},timeUnit:'months',truth:{hazardRatio:0.7,controlMedian:999}};
test('saved fit quantiles bind exact R distributions, preserve separate effect, and refuse unsupported curve adapters',()=>{
  const bound=vcrModelDesignBinding(result,base,'p10');assert.deepEqual(bound.scenario.truth.controlDistribution,result.diagnostics.model.baselineParameterScenarios.p10.controlDistribution);
  assert.equal(bound.scenario.truth.controlMedian,undefined);assert.equal(bound.scenario.truth.hazardRatio,0.7);assert.equal(bound.provenance.assurance,false);assert.match(bound.provenance.uncertainty,/shape fixed/);
  const unsupported=structuredClone(result);unsupported.diagnostics.model.baselineParameterScenarios.p10.controlDistribution.kind='lognormal';assert.throws(()=>vcrModelDesignBinding(unsupported,base,'p10'),{code:'vcr_model_not_applicable'});
});
test('fixed published predictions bind residual-aware SD or binary benchmark, without manufacturing a survival curve or parameter uncertainty',()=>{
  const predicted={id:'res_pred',version:1,executionId:'exe_pred',diagnostics:{modelScope:'published_prognostic_equation',absoluteRiskAvailable:true,endpoint:{type:'continuous',horizon:12,timeUnit:'months'},populationVarianceIncludesResidual:true},measures:[{name:'predicted_population_mean',value:7},{name:'predicted_outcome_sd',value:2}]};
  const configuration={design:{kind:'single_arm'},endpoint:{type:'continuous',horizon:12,timeUnit:'months'},truth:{effect:1}};
  const bound=vcrModelDesignBinding(predicted,configuration);assert.deepEqual(bound.scenario.truth,{effect:1,sd:2,benchmark:7});assert.deepEqual(bound.scenario.endpoint,{type:'continuous'});
  assert.throws(()=>vcrModelDesignBinding({...predicted,diagnostics:{...predicted.diagnostics,populationVarianceIncludesResidual:false}},configuration),{code:'vcr_model_not_applicable'});
  assert.throws(()=>vcrModelDesignBinding(predicted,configuration,'p10'),{code:'vcr_model_not_applicable'});
  const cox={...predicted,diagnostics:{...predicted.diagnostics,endpoint:{type:'time_to_event',horizon:12,timeUnit:'months'}}};
  assert.throws(()=>vcrModelDesignBinding(cox,{...configuration,endpoint:cox.diagnostics.endpoint}),{code:'vcr_model_not_applicable'});
});
test('orchestrated saved-model design binds only actually used assumption cards and exposes all three baseline scenarios in a grid',()=>{
  const context={study:{id:'std',dataTier:'T0'},definition:{endpointType:'time_to_event'},assumptions:[{id:'a',key:'control_median',version:1,pointValue:999,unit:'months'}],modelResult:result};
  const configuration={...base,modelResultId:result.id,modelResultVersion:2,modelParameterQuantile:'p50'};
  const planned=vcrBuildStages({kind:'trial_scenario',row:{id:'scn',design:'two_arm_fixed',endpointType:'time_to_event',configuration}},context);assert.equal(planned.ok,true,JSON.stringify(planned));
  for(const stage of planned.stages){assert.equal(stage.scenario.truth.controlMedian,undefined);assert.equal(stage.detail.modelDesign.resultId,result.id);assert.equal(stage.bound.length,0);}
  const grid=vcrBuildStages({kind:'design_grid',row:{dimensions:{base:{...configuration,modelParameterQuantile:'all'},designs:[{kind:'two_arm_fixed',nTreat:50,nControl:50}]},truthScenarios:[]}},context);
  assert.equal(grid.ok,true,JSON.stringify(grid));assert.deepEqual(grid.stages[0].scenario.truths.map(truth=>truth.controlDistribution.scale),[4.8,7.2,10.8]);assert.equal(grid.stages[0].detail.modelDesign.scenarios.length,3);
});
test('ordinary prediction subjects resolve patient/comparator ownership and selected real cohort rules are never replaced by a whole snapshot',async()=>{
  const rules=[{name:'Adults',rule:{op:'compare',column:'age',comparator:'gte',value:18}}];
  const population={id:'pop1',version:3,kind:'real',snapshotId:'snp1',definition:{rules}};
  const patient={id:'pts',version:2,populationId:'pop1',scenario:{endpoint:{type:'binary'}}};
  const comparator={id:'cmp',version:1,route:'model_comparator',configuration:{populationId:'pop1',endpoint:{type:'binary'}}};
  const store={patientSets:async()=>[patient],comparatorDesigns:async()=>[comparator],populations:async()=>[population]};
  for(const id of ['pts','cmp']){
    const subject=await resolveJobSubject({store,study:{id:'std'},kind:'apply_prognostic_model',subjectId:id});assert.equal(subject.detail.subjectId,id);
    const selected=await prepareVcrSubjectPopulation({store,study:{id:'std'},kind:'apply_prognostic_model',subject,scenario:{endpoint:{type:'binary'},inputId:'snp1:1'},inputs:[]});
    assert.deepEqual(selected.scenario.cohortRules,rules);assert.deepEqual(selected.inputs,[{kind:'snapshot',id:'snp1'}]);assert.equal(selected.detail.populationVersion,3);
    await assert.rejects(prepareVcrSubjectPopulation({store,study:{id:'std'},kind:'apply_prognostic_model',subject,scenario:{endpoint:{type:'binary'},inputId:'newest:1'},inputs:[]}),{code:'vcr_model_not_applicable'});
  }
  await assert.rejects(resolveJobSubject({store,study:{id:'std'},kind:'apply_prognostic_model',subjectId:'foreign'}),{code:'vcr_simulate_subject_unknown'});
});
test('published prognostic planning preserves the selected generated table, real cohort rules, endpoint and applicability scope',()=>{
  const equation={model:{family:'logistic',intercept:-3,terms:[{column:'age',coefficient:0.02,unit:'years',transform:'identity',center:0,scale:1}]},endpoint:{type:'binary',horizon:12,timeUnit:'months'},sourceCondition:'control'};
  const model={id:'mdl',userId:'owner',version:'1.0.0',name:'Published risk',endpointType:'binary',applicability:{endpoints:['binary'],requiredFields:['age']},card:{interfaceShape:'baseline_to_outcome',executionSpec:{method:'model.prognostic_apply',scenario:equation}}};
  const generated={id:'popgen',version:4,kind:'scenario',resultId:'resgen',definition:{population:{variables:[{name:'age',family:'normal',mean:50,sd:5}]}}};
  const row={id:'pts',version:1,populationId:generated.id,modelId:model.id,modelVersion:model.version,scenario:{endpoint:{type:'binary'},inputUnits:{age:'years'}}};
  const context={study:{id:'std',dataTier:'T2'},definition:{endpointType:'binary'},assumptions:[],models:[model],populations:[generated]};
  const plan=vcrBuildStages({kind:'patient_set',row},context);assert.equal(plan.ok,true,JSON.stringify(plan));assert.equal(plan.stages[0].jobKind,'apply_prognostic_model');
  assert.equal(plan.stages[0].scenario.inputId,'resgen:population');assert.equal(plan.stages[0].scenario.idColumn,'__generated_patient_id');assert.equal(plan.stages[0].snapshot,false);assert.equal(plan.stages[0].detail.populationVersion,4);
  const wrong=vcrBuildStages({kind:'patient_set',row:{...row,scenario:{...row.scenario,endpoint:{type:'continuous'}}}},context);assert.equal(wrong.ok,false);
  for (const changed of [{endpoint:{type:'binary',horizon:6,timeUnit:'months'}},{endpoint:{type:'binary',horizon:12,timeUnit:'years'}},{sourceCondition:'natural_history'},{model:{...equation.model,intercept:4}}]) {
    const conflict=vcrBuildStages({kind:'patient_set',row:{...row,scenario:{...row.scenario,...changed}}},context);assert.equal(conflict.ok,false,JSON.stringify(changed));
  }
  const uncovered=vcrBuildStages({kind:'patient_set',row},{...context,models:[{...model,applicability:{...model.applicability,requiredFields:['unavailable']}}]});assert.equal(uncovered.ok,false);
  const rules=[{name:'adult',rule:{op:'compare',column:'age',comparator:'gte',value:18}}];
  const real={id:'popreal',version:2,kind:'real',resultId:'cohortresult',snapshotId:'snapshot1',definition:{rules},profile:{rows:[{key:'age',min:18,max:90}]}};
  const comparator={id:'cmp',version:1,route:'model_comparator',configuration:{modelId:model.id,modelVersion:model.version,populationId:real.id,endpoint:{type:'binary'},inputId:'snapshot1:1',inputUnits:{age:'years'}}};
  const control=vcrBuildStages({kind:'comparator',row:comparator},{...context,populations:[real]});assert.equal(control.ok,true,JSON.stringify(control));assert.deepEqual(control.stages[0].scenario.cohortRules,rules);
  const conflict=vcrBuildStages({kind:'comparator',row:{...comparator,configuration:{...comparator.configuration,cohortRules:[{name:'all',rule:{op:'compare',column:'age',comparator:'gte',value:0}}]}}},{...context,populations:[real]});assert.equal(conflict.ok,false);
});
