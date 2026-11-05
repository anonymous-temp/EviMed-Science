import assert from 'node:assert/strict';
import {test} from 'node:test';
import {patientMatchingRankingDocument} from '../src/patientMatchingRankingText.mjs';
test('ranking view retains inclusion and late exclusion with bounded literal source sections',()=>{
 const record={title:'Clinical trial',conditions:['lung cancer'],interventions:['drug'],eligibilityText:`Inclusion Criteria:\n* ${'Adults with lung cancer. '.repeat(200)}\nExclusion Criteria:\n* Active infection is excluded.`};
 const view=patientMatchingRankingDocument(record);assert.match(view.text,/inclusion: Adults with lung cancer/);assert.match(view.text,/exclusion: Active infection is excluded/);assert.ok(view.text.length<=1500);assert.equal(view.truncated,true);assert.match(record.eligibilityText,/Active infection/);
});
test('a listing presence marker is never passed to the ranker as eligibility content',()=>{
 const view=patientMatchingRankingDocument({title:'Trial',eligibilityText:'in_record'});assert.doesNotMatch(view.text,/in_record/);assert.equal(view.sourceEligibilityChars,0);
});
test('all populated source slots together stay within the declared1500character view',()=>{
 const text='Z'.repeat(4000),candidate={title:text,conditions:[text],interventions:[text],sexStated:text,ageStated:text,summary:text,eligibilityText:`${text}\nInclusion Criteria:\n* ${text}\nExclusion Criteria:\n* ${text}`};
 const view=patientMatchingRankingDocument(candidate);assert.ok(view.text.length<=1500,view.text.length);assert.match(view.text,/unclassified:/);assert.match(view.text,/inclusion:/);assert.match(view.text,/exclusion:/);
});
