import fs from 'node:fs/promises';
const input=process.argv[2];if(!input)throw new Error('Provide the saved case result file');
const data=JSON.parse(await fs.readFile(input,'utf8'));
const cases=data.results.map(result=>{
  const messages=result.transcript?.messages??[],parts=messages.flatMap(message=>(message.parts??[]).map(part=>({role:message.role,...part})));
  const tools=parts.filter(part=>part.type==='tool');
  return {id:result.id,intent:result.intent,status:result.status,runStatus:result.run?.status??null,automated:result.run?.automated??null,
    researchSkills:result.researchSkills??null,toolCounts:tools.reduce((all,part)=>{all[part.tool]=(all[part.tool]??0)+1;return all;},{}),
    nativeCalls:tools.filter(part=>/^(?:virtual_|synthetic_control)/.test(part.tool)).map(part=>({tool:part.tool,method:part.input?.method??null,status:part.status})),
    finalTextLengths:parts.filter(part=>part.role==='assistant'&&part.type==='text').map(part=>String(part.text??'').length),
    error:result.error??null};
});
console.log(JSON.stringify({denominator:data.denominator,recorded:cases.length,cases},null,2));
