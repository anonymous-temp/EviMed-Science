import fs from 'node:fs/promises';
const file=process.argv[2];if(!file)throw new Error('Provide R10 formal evidence JSON');
const data=JSON.parse(await fs.readFile(file,'utf8'));
const task={
'01':'解释功效；有最终文字。','02':'比较虚拟队列和患者；有最终文字。','03':'缺设计参数却先计算假设演示，末尾才索要真实值；未满足先澄清预期。','04':'未计算，说明缺失数据并给清单/模板。','05':'解释功效并报告双侧设计计算；用户给出的主输入已核对。','06':'给出概念及生存设计计算；具体数值独立复核待完成。','07':'报告200人年龄情景与摘要；native生成任务succeeded。','08':'报告各40人的二分类模拟；native输入的两组人数与事件率核对一致。','09':'报告RR3.9/1.8的E-value；算术应独立复核。','10':'分别报告队列和患者情景；两条native任务均succeeded。','11':'报告三比较网络合成；估计量及额外假设需独立复核。','12':'HR0.7与0.8两个native任务成功，分别report；其余参数及保留/对比文本待核。','13':'报告两二分类情景比较；输入差异与结果保留需逐项复核。','14':'缺人数/均值/SD时未计算，返回所需信息。','15':'解释E-value不能证明因果；专业表述待复核。','16':'报告E-value并解释模拟局限；数字及解释待复核。','17':'native启动患者任务后cancel并read canceled；已有结果保留待核。','18':'启动队列任务并读至succeeded；跨会话续接未覆盖。','19':'无真实患者记录时未运行个体计算，交付资料清单/数据字典。','20':'报告二分类模拟及非临床证据边界；具体数值待复核。'};
const handling={'03':'标注假设但未先澄清','04':'保留缺失并索要','10':'额外加年龄min18，文本披露','14':'保留缺失并索要','17':'用户授权合成；具体大规模参数由模型设定','18':'用户授权合成；具体参数由模型设定','19':'无真实数据，未替代'};
const esc=x=>String(x??'').replaceAll('|','\\|').replaceAll('\n',' ');
console.log('# R10 formal conversation evidence review\n');
console.log('20 frozen questions, 20 completed run states. Completion is not correctness or a quality pass rate. This is a trace-based first review; independent numerical/clinical review and every source citation check remain open. Seven declared ordinary files were downloaded and SHA-256 checked; unexported engine study data are not claimed as preserved.\n');
console.log('| ID | Task result | Input handling | Verifiable calculation | Citation / method version | Tool selection / failures | Wall time |\n|---|---|---|---|---|---|---:|');
for(const z of data.results){
 const messages=z.transcript?.messages??[],parts=messages.flatMap(m=>m.parts??[]),tools=parts.filter(p=>p.type==='tool'),names=[...new Set(tools.map(p=>p.tool))],errs=tools.filter(p=>String(p.output??'').startsWith('Error:')).map(p=>p.tool+': '+String(p.output).slice(7,65));
 const successful=tools.filter(p=>/^(?:virtual_|synthetic_control).*_read$/.test(p.tool)&&/"state"\s*:\s*"succeeded"/.test(String(p.output??''))).length;
 const versions=[...new Set(tools.flatMap(p=>[...String(p.output??'').matchAll(/(?:methodVersion|method_version)["\s:]+([0-9]+\.[0-9]+\.[0-9]+)/g)].map(m=>m[1])))];
 const computation=successful?`${successful} native read succeeded; independent numeric replay open`:(tools.some(p=>p.tool==='mcp__evimed__vcr_simulate')?'旧VCR调用可见；计算与回执待核':'未见native任务成功回读；计算/概念内容待核');
 const provenance=versions.length?`回读版本 ${versions.join(', ')}；引用未独立核对`:'引用和方法版本未独立核对';
 const seconds=Math.round((Date.parse(z.finishedAt)-Date.parse(z.startedAt))/1000);
 console.log(`| ${z.id} | ${esc(task[z.id])} | ${esc(handling[z.id]??'题给输入与额外默认值待逐项核对')} | ${esc(computation)} | ${esc(provenance)} | ${esc(names.join(', ')||'无')}${errs.length?`; ${esc(errs.join('; '))}`:''} | ${seconds}s |`);
}
