import test from 'node:test';
import assert from 'node:assert/strict';
import {clinicalDateInEvidence,clinicalDateInQuote,clinicalDatesPrinted,clinicalIntervalInQuote,clinicalRecordHeader,RECORD_HEADER_LABEL_MAX,RECORD_HEADER_LINE_MAX} from '../src/vcrClinicalDateEvidence.mjs';
import {verifyFactEvidence,evaluateCriterion,UNKNOWN} from '../src/vcrMatching.mjs';

test('dataset year and undated age cannot supply a manufactured birth/event date',()=>{
 for (const year of ['2021','2022','2026']) assert.equal(clinicalDateInQuote('2003-01-01',`Dataset ${year}; patient age 19.`),false);
 assert.equal(clinicalDateInQuote('2026-01-01','In 2026 the event occurred.'),false);
 for(const text of ['On 2026-01-03, MI','2026年1月3日发生','2026/1/3 MI','January 3, 2026 MI','3 January 2026 MI'])assert.equal(clinicalDateInQuote('2026-01-03T00:00:00.000Z',text),true);
 assert.equal(clinicalDateInQuote('2026-01-03','2026-01-04'),false);
 assert.equal(clinicalDateInQuote('2026-02-31','2026-02-31'),false);
});
test('new extracted fact dates are checked against actual owned source spans',()=>{
 const text='Patient age 19; prior MI.';const fact={id:'f',variable:'mi',polarity:'affirmed',extractedBy:'model',surface:'MI',occurredAt:'2003-01-01',provenance:{factSchema:2},source:{documentId:'d',start:0,end:text.length,quote:text}};
 assert.deepEqual(verifyFactEvidence(fact,{documents:{d:{text}}}),{ok:false,reason:'date_not_in_span'});
 assert.equal(verifyFactEvidence({...fact,occurredAt:null},{documents:{d:{text}}}).ok,true);
});
test('age alone cannot establish pregnancy, family history, or calendar time in structured criteria',()=>{
 const ctx={facts:[{id:'age',variable:'age',value:58,unit:'years',polarity:'affirmed',extractedBy:'snapshot'}],asOf:'2026-10-29'};
 for(const variable of ['pregnancy','family_history']){
  const criterion={id:variable,kind:'inclusion',requirement:{op:'present',variable}};
  assert.equal(evaluateCriterion(criterion,ctx).state,UNKNOWN);
 }
 const criterion={id:'women',kind:'exclusion',applicability:{op:'compare',variable:'sex',comparator:'eq',value:'female'},requirement:{op:'absent',variable:'pregnancy'}};
 const male=evaluateCriterion(criterion,{...ctx,facts:[...ctx.facts,{id:'sex',variable:'sex',value:'male',polarity:'affirmed',extractedBy:'snapshot'}]});
 assert.equal(male.applicable,false);
});

test('nested intervals require stated bounds or explicit source-anchored duration arithmetic',()=>{
 const interval={start:'2026-09-09',end:'2026-10-09'};
 assert.equal(clinicalIntervalInQuote(interval,'Currently no docetaxel recorded.',null),false);
 assert.equal(clinicalIntervalInQuote(interval,'On 2026-10-09: no docetaxel in the preceding 30 days.','30 days'),true);
 assert.equal(clinicalIntervalInQuote(interval,'Dataset 2026: no docetaxel in the preceding 30 days.','30 days'),false);
 assert.equal(clinicalIntervalInQuote(interval,'On 2026-10-09: no docetaxel for 20 days.','20 days'),false);
 const text='Currently no docetaxel recorded.';
 const fact={id:'f',variable:'docetaxel',polarity:'negated',extractedBy:'model',surface:'docetaxel',provenance:{factSchema:2},clinical:{schema:1,assertion:'negated',experiencer:'patient',medication:{state:'unknown',absenceScope:'interval'},occurredInterval:interval},source:{documentId:'d',start:0,end:text.length,quote:text}};
 assert.equal(verifyFactEvidence(fact,{documents:{d:{text}},anyPolarity:true}).reason,'date_not_in_span');
});

test('a date may rest on a second verbatim quotation of the same document, and on nothing outside it (dateQuote)',()=>{
 assert.equal(clinicalDateInEvidence('2100-03-01','Takes aspirin daily.','Record date: 2100-03-01'),true);
 assert.equal(clinicalDateInEvidence('2100-03-01','Takes aspirin daily.',null),false);
 assert.equal(clinicalDateInEvidence('2100-03-01','Takes aspirin daily.','Seen 3/1 for review'),false,'a short form with no year supplies nothing');
 assert.equal(clinicalDateInEvidence('2100-01-01','Takes aspirin daily.','Dataset year 2100'),false,'a year alone is not a date');
 const text='Record date: 2100-03-01\n\nTakes aspirin daily.\nUploaded 2100-06-30.';
 const fact={id:'f',variable:'aspirin',polarity:'affirmed',extractedBy:'model',surface:'aspirin',occurredAt:'2100-03-01',provenance:{factSchema:2},
  source:{documentId:'d',start:25,end:45,quote:'Takes aspirin daily.',dateQuote:{start:0,end:23,quote:'Record date: 2100-03-01'}}};
 assert.deepEqual(verifyFactEvidence(fact,{documents:{d:{text}}}),{ok:true,reason:null});
 const refuse=(over,reason)=>assert.deepEqual(verifyFactEvidence({...fact,...over},{documents:{d:{text}}}),{ok:false,reason});
 refuse({source:{...fact.source,dateQuote:{start:0,end:23,quote:'Record date: 2100-03-02'}}},'date_quote_mismatch');
 refuse({source:{...fact.source,dateQuote:{start:0,end:999,quote:'x'}}},'date_quote_mismatch');
 refuse({source:{...fact.source,dateQuote:'Record date: 2100-03-01'}},'date_quote_mismatch');
 refuse({occurredAt:'2100-06-30'},'date_not_in_span');
 refuse({source:{...fact.source,dateQuote:undefined},occurredAt:'2100-03-01'},'date_not_in_span');
 refuse({recordedAt:'2100-05-01'},'date_not_in_span');
 assert.equal(verifyFactEvidence({...fact,recordedAt:'2100-03-01'},{documents:{d:{text}}}).ok,true,'recordedAt reads the same evidence');
});

test('the dates a text prints are the ones the evidence check accepts, real calendar dates only',()=>{
 assert.deepEqual(clinicalDatesPrinted('Record date: 2067-05-03').map(d=>d.iso),['2067-05-03']);
 assert.deepEqual(clinicalDatesPrinted('入院日期：2026年3月4日 10:20').map(d=>d.iso),['2026-03-04']);
 assert.deepEqual(clinicalDatesPrinted('on May 3, 2067 and 3 June 2067').map(d=>d.iso),['2067-05-03','2067-06-03']);
 assert.deepEqual(clinicalDatesPrinted('2067/5/3').map(d=>d.iso),['2067-05-03']);
 for(const none of ['seen 3/14','in 2067','2067-02-30','Feb 30, 2067','2067-13-01',''])assert.deepEqual(clinicalDatesPrinted(none),[],none);
 const [one]=clinicalDatesPrinted('Takes aspirin; seen 2067-05-03.');
 assert.deepEqual([one.start,one.end],[20,30]);
 assert.equal(clinicalDateInQuote('2067-05-03','Record date: 2067-05-03'),true,'the evidence check reads through the same helper');
});

// A record header is a matter of format: the nearest line above that prints one complete date and little else (owner ruling 2026-11-02).
test('a record header is the nearest short line above that prints one date with its year: English, Chinese, bare, with a time',()=>{
 const at=(text,needle)=>text.indexOf(needle);
 const english='Record date: 2067-05-03\n\nTakes aspirin daily.\n';
 assert.deepEqual(clinicalRecordHeader(english,at(english,'Takes')),{date:'2067-05-03',start:0,end:23,quote:'Record date: 2067-05-03'});
 const chinese='记录日期：2026-07-01\n\n每日口服多种维生素。\n';
 assert.equal(clinicalRecordHeader(chinese,at(chinese,'每日'))?.date,'2026-07-01');
 const trailing='2026-07-01 门诊记录\n患者主诉头晕。';
 assert.deepEqual(clinicalRecordHeader(trailing,at(trailing,'患者')),{date:'2026-07-01',start:0,end:15,quote:'2026-07-01 门诊记录'});
 const admitted='入院日期：2026年3月4日 10:20\n既往高血压病史。';
 assert.equal(clinicalRecordHeader(admitted,at(admitted,'既往'))?.date,'2026-03-04');
 const bare='  2067-05-03  \nTakes aspirin.';
 const found=clinicalRecordHeader(bare,at(bare,'Takes'));
 assert.deepEqual([found?.date,found?.quote,bare.slice(found?.start,found?.end)],['2067-05-03','2067-05-03','2067-05-03'],'the line is trimmed as the document holds it');
 const named='Date of visit: May 3, 2067\nTakes aspirin.';
 assert.equal(clinicalRecordHeader(named,at(named,'Takes'))?.date,'2067-05-03');
 const crlf='Record date: 2067-05-03\r\nTakes aspirin.';
 assert.deepEqual(clinicalRecordHeader(crlf,at(crlf,'Takes')),{date:'2067-05-03',start:0,end:23,quote:'Record date: 2067-05-03'});
});

test('a birth date line is passed over for the record header above it',()=>{
 for(const line of ['DOB: 1950-03-02','Date of birth: March 2, 1950','出生日期：1950-03-02','生日 1950年3月2日','Birthdate 1950-03-02']){
  const file=`Record date: 2067-01-10\n${line}\nTakes aspirin.`;
  assert.equal(clinicalRecordHeader(file,file.indexOf('Takes'))?.date,'2067-01-10',line);
  const alone=`${line}\nTakes aspirin.`;
  assert.equal(clinicalRecordHeader(alone,alone.indexOf('Takes')),null,line);
 }
});

test('with several records in one file the header is the nearest one above the position',()=>{
 const file=['Record date: 2067-01-10','','Takes aspirin.','','*'.repeat(40),'Record date: 2067-03-01','','Admitted with chest pain.'].join('\n');
 assert.equal(clinicalRecordHeader(file,file.indexOf('Takes'))?.date,'2067-01-10');
 assert.equal(clinicalRecordHeader(file,file.indexOf('Admitted'))?.date,'2067-03-01');
 assert.equal(clinicalRecordHeader(file,file.indexOf('Record date: 2067-03-01')+3)?.date,'2067-01-10','a position on the header line itself looks above it');
 // A position in the middle of a long line is in that line; the line is never its own header.
 const long=`Record date: 2067-01-10\n${'Takes aspirin and other things. '.repeat(4)}Seen 2067-02-02 again.`;
 assert.equal(clinicalRecordHeader(long,long.indexOf('Seen'))?.date,'2067-01-10');
});

test('a body sentence that holds a date is not a header, and neither is a line with two dates or a short form',()=>{
 const body='Record date: 2067-01-10\nPatient was seen on 2067-02-02 for chest pain and discussed medications with the family.\nTakes aspirin.';
 assert.equal(clinicalRecordHeader(body,body.indexOf('Takes'))?.date,'2067-01-10','the sentence is passed over for the header above it');
 const two='Admitted 2067-02-02 discharged 2067-02-09\nTakes aspirin.';
 assert.equal(clinicalRecordHeader(two,two.indexOf('Takes')),null);
 const short='Seen 3/14 for review\nTakes aspirin.';
 assert.equal(clinicalRecordHeader(short,short.indexOf('Takes')),null);
 const year='Dataset year 2067\nTakes aspirin.';
 assert.equal(clinicalRecordHeader(year,year.indexOf('Takes')),null);
 const label='x'.repeat(RECORD_HEADER_LABEL_MAX);
 assert.equal(clinicalRecordHeader(`${label} 2067-05-03\nTakes aspirin.`,label.length+14)?.date,'2067-05-03','a label of the longest length is still a label');
 assert.equal(clinicalRecordHeader(`${label}y 2067-05-03\nTakes aspirin.`,label.length+15),null,'one character more and the line is a sentence');
 const wide=`Record date: 2067-05-03 ${'.'.repeat(70)}\nTakes aspirin.`;
 assert.equal(clinicalRecordHeader(wide,wide.indexOf('Takes')),null,'a line longer than a header is a body line whatever it holds');
});

test('no header above the position, or no position, gives no date',()=>{
 assert.equal(clinicalRecordHeader('Takes aspirin.\nRecord date: 2067-05-03\n',0),null,'nothing above the first line');
 assert.equal(clinicalRecordHeader('Takes aspirin.\nRecord date: 2067-05-03\n',3),null,'a header below the fact does not date it');
 assert.equal(clinicalRecordHeader('Takes aspirin.',5),null);
 assert.equal(clinicalRecordHeader('',0),null);
 assert.equal(clinicalRecordHeader('Record date: 2067-05-03\nTakes aspirin.',-1),null);
 assert.equal(clinicalRecordHeader('Record date: 2067-05-03\nTakes aspirin.',Number.NaN),null);
 assert.equal(clinicalRecordHeader('Record date: 2067-05-03\nTakes aspirin.',9999)?.date,'2067-05-03','a position past the end reads the whole text above');
});

// REVIEWFIX 8: the header above a position is found from an index of the document's header lines, built once, and answers what the backward scan did.
const referenceRecordHeader=(text,position)=>{
 const body=String(text??'');
 if(!Number.isInteger(position)||position<=0)return null;
 let lineStart=body.lastIndexOf('\n',Math.min(position,body.length)-1)+1;
 while(lineStart>0){
  const lineEnd=lineStart-1;
  const start=lineEnd===0?0:body.lastIndexOf('\n',lineEnd-1)+1;
  const line=body.slice(start,lineEnd);
  const trimmed=line.trim();
  if(trimmed&&trimmed.length<=RECORD_HEADER_LINE_MAX){
   const printed=clinicalDatesPrinted(trimmed);
   if(printed.length===1){
    const label=`${trimmed.slice(0,printed[0].start)} ${trimmed.slice(printed[0].end)}`.replace(/\s+/g,' ').trim();
    if(label.length<=RECORD_HEADER_LABEL_MAX&&!/\b(?:d\.?o\.?b\.?|birth\s*date|date\s+of\s+birth|born)\b|出生|生日/i.test(label)){
     const from=start+line.indexOf(trimmed);
     return{date:printed[0].iso,start:from,end:from+trimmed.length,quote:trimmed};
    }
   }
  }
  lineStart=start;
 }
 return null;
};

test('the header index answers what the backward scan answered, for a position at the start of any line of a mixed document',()=>{
 let seed=20261102;
 const random=(n)=>{seed=(seed*1103515245+12345)&0x7fffffff;return seed%n;};
 const pool=['Record date: 2067-05-03','2026-07-01 门诊记录','DOB: 1950-03-02','Seen 3/14 for review','Admitted 2067-02-02 discharged 2067-02-09','',' ','   2067-08-09   ',
  'Takes aspirin daily.','入院日期：2026年3月4日 10:20','Date of visit: May 3, 2067','Patient was seen on 2067-02-02 for chest pain and discussed medications with the family.',
  'x'.repeat(RECORD_HEADER_LABEL_MAX)+' 2067-05-03','Dataset year 2067','*****','记录日期：2026-07-01\r'];
 for(let round=0;round<60;round+=1){
  const lines=Array.from({length:1+random(40)},()=>pool[random(pool.length)]);
  const text=lines.join(random(2)?'\n':'\n\n')+(random(2)?'\n':'');
  const starts=[0];
  for(let at=text.indexOf('\n');at>=0;at=text.indexOf('\n',at+1))starts.push(at+1);
  for(const position of [...starts,text.length,text.length+7,-1,1.5]){
   assert.deepEqual(clinicalRecordHeader(text,position),referenceRecordHeader(text,position),`round ${round} at ${position}`);
  }
 }
});

test('a document of many short lines with no header costs one pass, not one pass for every fact',()=>{
 const text=Array.from({length:150_000},(_,at)=>`line ${at} ok`).join('\n');
 const positions=Array.from({length:150},(_,at)=>text.length-1-at*17);
 const began=process.hrtime.bigint();
 for(const position of positions)assert.equal(clinicalRecordHeader(text,position),null);
 const elapsedMs=Number(process.hrtime.bigint()-began)/1e6;
 assert.ok(elapsedMs<1500,`150 facts of one document took ${Math.round(elapsedMs)} ms`);
 // the same document with one header at the top is found from every position
 const headed=`Record date: 2067-05-03\n${text}`;
 assert.equal(clinicalRecordHeader(headed,headed.length-5)?.date,'2067-05-03');
});
