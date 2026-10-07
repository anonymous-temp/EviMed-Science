import {useCallback, useEffect, useState} from 'react';
import {fetchEvolutionCapabilityMap, type EvolutionCapabilityMap, type EvolutionCapabilityCell} from '@/lib/evolutionClient';
import {productErrorMessage} from '@/lib/productClient';
import {DataTable, type DataColumn} from '@/components/ui/DataTable';
import {Tag} from '@/components/ui/Tag';

const STATUS = {supported: '已支持',partial: '部分支持',unsupported: '暂不支持',untested: '尚未验证'};
const OPERATIONS: Record<string,string> = {answer:'问答',search:'检索',synthesize:'证据综合',extract:'资料提取',transform:'数据转换',classify:'分类',route:'任务选择',plan:'研究规划',recall:'资料召回',edit:'写作',rank:'排序',simulate:'模拟', 'compare-groups':'组间比较','paired-analysis':'配对分析','longitudinal-analysis':'纵向分析','survival-analysis':'生存分析','competing-risk':'竞争风险分析','meta-analysis':'Meta 分析','causal-inference':'因果推断','network-analysis':'网络分析',unknown:'其他研究'};
const SHAPES: Record<string,string> = {none:'无需数据',text:'文献文本',table:'表格',paired:'配对数据',longitudinal:'纵向数据','time-to-event':'时间结局','competing-events':'竞争事件','expression-matrix':'基因表达矩阵',network:'网络',image:'图像',mixed:'多种资料',unknown:'待明确'};

const ESTIMATORS: Record<string,string> = {'meta.dl':'随机效应模型','faers.signals':'不良反应信号','bibliometric.network':'文献网络','design.analytic':'研究设计分析','comparator.evalue':'E-value',welch:'Welch 检验','benjamini-hochberg':'多重比较校正'};
const EVIDENCE: Record<string,string> = {literature:'文献',dataset:'数据',trial:'临床试验',observational:'观察性研究',label:'药品说明书',guideline:'指南'};
const DELIVERABLES: Record<string,string> = {answer:'回答',report:'报告',table:'数据表',manuscript:'论文',protocol:'研究方案',tool:'计算工具'};

export function CapabilityMap({names, query = ''}: {names: ReadonlyMap<string,string>; query?: string}) {
  const [map,setMap] = useState<EvolutionCapabilityMap | null>(null);
  const [error,setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setMap(null);setError(null);
    try {setMap(await fetchEvolutionCapabilityMap());} catch (caught) {setError(productErrorMessage(caught));}
  },[]);
  useEffect(()=>{void load();},[load]);
  const name = (cell: EvolutionCapabilityCell) => names.get(cell.capabilityId) ?? '研究能力';
  const rows = (map?.cells ?? []).filter(cell => `${name(cell)} ${OPERATIONS[cell.taskFamily.operation] ?? ''} ${SHAPES[cell.taskFamily.inputShape] ?? ''} ${STATUS[cell.status]}`.includes(query.trim()));
  const columns: DataColumn<EvolutionCapabilityCell>[] = [
    {key:'capability',header:'科研工具',rowHeader:true,cell:cell=><span>{name(cell)} {cell.newThisMonth && <Tag>本月新增</Tag>}</span>},
    {key:'operation',header:'研究任务',cell:cell=>OPERATIONS[cell.taskFamily.operation] ?? '其他研究'},
    {key:'method',header:'分析方法',isEmpty:cell=>!ESTIMATORS[cell.taskFamily.estimator],cell:cell=>ESTIMATORS[cell.taskFamily.estimator] ?? '—'},
    {key:'input',header:'资料类型',cell:cell=>SHAPES[cell.taskFamily.inputShape] ?? '待明确'},
    {key:'evidence',header:'依据',isEmpty:cell=>!EVIDENCE[cell.taskFamily.evidenceType],cell:cell=>EVIDENCE[cell.taskFamily.evidenceType] ?? '—'},
    {key:'deliverable',header:'产出',isEmpty:cell=>!DELIVERABLES[cell.taskFamily.deliverable],cell:cell=>DELIVERABLES[cell.taskFamily.deliverable] ?? '—'},
    {key:'status',header:'支持情况',cell:cell=><Tag>{STATUS[cell.status]}</Tag>},
  ];
  return <DataTable label="能力地图" columns={columns} rows={rows} rowKey={cell=>cell.id}
    state={error ? 'error' : map === null ? 'loading' : rows.length ? 'content' : 'empty'}
    emptyText="暂无符合条件的研究能力" errorMessage={error ?? undefined} onRetry={()=>void load()} />;
}
