import assert from 'node:assert/strict';
import test from 'node:test';
import { presentLongitudinal, presentLongitudinalRead } from '../src/vcrLongitudinalPresentation.mjs';
import { suppressForModel } from '@evimed/domain';

test('synthetic zero-event groups retain metrics; real small cells retain only their horizon and display reason',()=>{
  const record={id:'vlf_fixture',kind:'evaluation',summary:{dataClass:'synthetic',groups:[{horizonDays:30,subjects:100,events:0,metrics:{brier:{value:.04}}}]}};
  assert.equal(presentLongitudinal({records:[record]}).records[0].summary.groups[0].metrics.brier.value,.04);
  const real={...record,summary:{...record.summary,dataClass:'patient'}};
  const group=presentLongitudinal({records:[real]}).records[0].summary.groups[0];
  assert.equal(group.horizonDays,30);assert.equal(group.displayReason,'small_cell_suppression');assert.equal(group.metrics,undefined);
  const report={model:{longitudinal:{records:[record]},modelAnalysis:{longitudinal:{records:[record]}},card:{dataClass:'synthetic',groups:[{subjects:1,mean:7}]}}};
  const shown=presentLongitudinalRead(report,suppressForModel(report),'report_model',{});
  assert.equal(shown.model.longitudinal.records[0].summary.groups[0].events,0);
  assert.equal(shown.model.modelAnalysis.longitudinal.records[0].summary.groups[0].events,0);
  assert.equal(shown.model.card.groups[0].mean,undefined);
  const status={result:{kind:'longitudinal',diagnostics:{longitudinal:record}}};
  assert.equal(presentLongitudinalRead(status,suppressForModel(status),'job_result',{}).result.diagnostics.longitudinal.summary.groups[0].events,0);
});

test('site subgroups and stable report references retain identity while honoring existing small-cell projections',()=>{
  const record={id:'vlf_site',kind:'evaluation',summary:{dataClass:'patient',groups:[],subgroups:[
    {site:'A',subjects:2,groups:[{horizonDays:30,subjects:2,metrics:{mae:{value:7}}}]},
    {site:'B',subjects:40,groups:[{horizonDays:30,subjects:40,metrics:{mae:{value:8}}}]},
  ]}};
  const shown=presentLongitudinal({records:[record],byId:{vlf_site:record.summary}});
  assert.equal(shown.records[0].summary.subgroups[0].site,'A');
  assert.equal(shown.records[0].summary.subgroups[0].groups[0].horizonDays,30);
  assert.equal(shown.records[0].summary.subgroups[0].groups[0].displayReason,'small_cell_suppression');
  assert.equal(shown.records[0].summary.subgroups[0].groups[0].metrics,undefined);
  assert.deepEqual(shown.byId.vlf_site,shown.records[0].summary);
  const synthetic={...record,summary:{...record.summary,dataClass:'synthetic'}};
  assert.equal(presentLongitudinal({records:[synthetic],byId:{vlf_site:synthetic.summary}}).byId.vlf_site.subgroups[0].groups[0].metrics.mae.value,7);
});
