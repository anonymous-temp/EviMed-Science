import fs from 'node:fs/promises';
const file=process.argv[2];if(!file)throw new Error('Provide formal evidence JSON');
const data=JSON.parse(await fs.readFile(file,'utf8'));
const findings={
  '01':'直接解释统计功效，未调用工具；细节仍需医学统计复核。',
  '02':'解释两概念；调用只读 describe，严格无工具效率指标未满足，不据此判任务错误。',
  '03':'缺关键参数时自行设定并标注演示，末尾请求真实值；未满足先澄清预期。',
  '04':'180秒超时并取消，无最终答复；未给所需资料清单。',
  '05':'完成解释及双侧生存样本量文字；以本地脚本计算，未独立复算。',
  '06':'完成生存终点解释与样本量文字；本地脚本/计算工具，未独立复算。',
  '07':'报告200人、年龄均值60/SD9，native cohort任务成功；数字与产物未独立复算。',
  '08':'报告两组各40人二分类模拟；本地脚本计算，文件未保全，未独立复算。',
  '09':'报告RR3.9和1.8对应E-value约7.26和3.00，公式可算术复核；文献获取曾失败。',
  '10':'分别报告合成队列与二分类患者集；旧VCR工具实际执行，数值未独立复算。',
  '11':'报告A/B/C网络合成与区间；由本地脚本计算，未独立复算。',
  '12':'报告HR0.7与0.8比较，旧VCR启动两项任务并读取结果；文件未保全，未独立复算。',
  '13':'报告两个二分类情景比较，native trial模拟及report调用可见；主体绑定错误与具体结果仍需核查。',
  '14':'缺均值/SD/人数时明确标注假设后自行生成，未满足先澄清预期。',
  '15':'回答E-value不能独立证明因果；属概念解释，细节待专业复核。',
  '16':'报告RR3.9/1.8 E-value及二分类局限；计算与结果一致性需复核。',
  '17':'native patient任务启动、取消和read canceled可见；已完成批次保留仍需独立核验。',
  '18':'native cohort任务read succeeded并报告result id；跨会话续接与产物可用性未独立核验。',
  '19':'明确无数据、未生成患者并列资料清单；数据需求与安全表述待专业复核。',
  '20':'报告每组40人的合成二分类结果，本地脚本/文件未保全，未独立复算。'
};
const esc=x=>String(x??'').replaceAll('|','\\|').replaceAll('\n',' ');
console.log('# R7 formal conversation audit — evidence, not a pass rate\n');
console.log('20 frozen cases; 19 completed and 1 timed out. Completed is a run state, not correctness. The workspace output files were not exported before the test volume was destroyed, so file-byte and independent calculation checks remain open. All rows below need clinical/statistical review before a quality score.\n');
console.log('| ID | Task and input handling | Computation and provenance | Tools and observed errors | Wall time |\n|---|---|---|---|---:|');
for(const z of data.results){
  const messages=z.transcript?.messages??[],parts=messages.flatMap(m=>m.parts??[]),tools=parts.filter(p=>p.type==='tool'),names=[...new Set(tools.map(p=>p.tool))],errors=[...new Set(tools.filter(p=>String(p.output??'').startsWith('Error:')).map(p=>p.tool+': '+String(p.output).slice(7,80)))];
  const versions=[...new Set(tools.flatMap(p=>[...String(p.output??'').matchAll(/(?:methodVersion|method_version)["\s:]+([0-9]+\.[0-9]+\.[0-9]+)/g)].map(m=>m[1])))];
  const compute=versions.length?`工具输出方法版本 ${versions.join(', ')}；引用/数值未独立核对`:'方法版本及引用未独立核对';
  const seconds=z.startedAt&&z.finishedAt?Math.round((Date.parse(z.finishedAt)-Date.parse(z.startedAt))/1000):'?';
  console.log(`| ${z.id} | ${esc(findings[z.id]??'待审')} | ${esc(compute)} | ${esc(names.join(', ')||'无')} ${errors.length?`；错误 ${esc(errors.join('; '))}`:''} | ${seconds}s |`);
}
