import { evolutionDataMatch } from '@evimed/domain';
import { useCallback, useEffect, useState } from 'react';
import { listEvolutionTools, listEvolutionDossiers, downloadEvolutionRequirements, downloadEvolutionTemplate, useEvolutionAccess, type EvolutionTool } from '@/lib/evolutionClient';
import { productErrorMessage, type ProductRecord } from '@/lib/productClient';
import { Button } from '@/components/ui/Button';
import { Tag } from '@/components/ui/Tag';
import { Disclosure } from '@/components/ui/Disclosure';
import { EmptyState } from '@/components/cards/EmptyState';
import { FilesSkeleton } from '@/components/cards/Skeletons';
import { LoadError } from '@/components/cards/LoadError';
import { Link } from 'react-router';

const VALIDATION: Record<string, string> = { V0: '已构建', V1: '仅模拟验证', V2: '已复现已发表算例', V3: '已复现已发表研究', V4: '已用于真实研究' };
const DATA: Record<string, string> = { D0: '等待数据来源', D1: '模拟数据', D2: '公开数据', D3: '用户数据已匹配', D4: '真实与外部数据' };

export function EvolutionPanel({ projectId, dataset }: { projectId?: string; dataset?: Record<string, unknown> }) {
  const access = useEvolutionAccess();
  const [tools, setTools] = useState<EvolutionTool[] | null>(null);
  const [dossiers, setDossiers] = useState<ProductRecord<{title?: string; goal?: string; status: string}>[]>([]);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setTools(null); setError(null);
    try { const next = await listEvolutionTools(projectId); setTools(dataset ? next.filter(tool => tool.dataRequirements && evolutionDataMatch(tool.dataRequirements, dataset).matched) : next); if (!projectId && access.operator) setDossiers(await listEvolutionDossiers()); }
    catch (caught) { setError(productErrorMessage(caught)); setTools([]); }
  }, [projectId, access.operator, dataset]);
  useEffect(() => { if (access.enabled && (projectId || access.operator)) void load(); }, [access.enabled, access.operator, projectId, load]);
  if (!access.enabled || (!projectId && !access.operator)) return null;
  // Beside a dataset's meaning the panel says what the data can use and is silent when it can use nothing yet.
  if (dataset && tools !== null && tools.length === 0 && !error) return null;
  return <section aria-label="进化工具" className="mt-6 space-y-3">
    <h2 className="text-body font-semibold text-text">{dataset ? "这份数据可用的工具" : "进化工具"}</h2>
    {error && <LoadError message={error} onRetry={() => void load()} />}
    {tools === null ? <FilesSkeleton /> : tools.length === 0 ? !error && <EmptyState title={dataset ? "暂无已匹配的工具" : "暂无新工具"} /> : <ul className="space-y-3">{tools.map(tool => <li key={tool.id} className="rounded-card bg-surface-1 p-4">
      <h3 className="text-ui font-medium text-text">{tool.name ?? tool.description ?? '科研工具'}</h3>
      {tool.description && <p className="mt-1 text-ui text-text-2">{tool.description}</p>}
      <div className="mt-2 flex flex-wrap gap-2"><Tag>{tool.validationLevel === 'V4' && Number.isInteger(tool.usage?.runs) && (tool.usage?.runs ?? -1) >= 0 ? `已用于 ${tool.usage?.runs} 次研究` : VALIDATION[tool.validationLevel] ?? tool.validationLevel}</Tag><Tag>{DATA[tool.dataLevel] ?? tool.dataLevel}</Tag>{tool.maintenanceState === 'deprecating' && <Tag>待修复</Tag>}{access.operator && tool.status && <Tag>{{ staged: "待上线", active: "已上线", alias: "历史别名", retired: "已退役" }[tool.status]}</Tag>}</div>
      {tool.papers && tool.papers.length > 0 && <Disclosure summary="依据文献"><ul className="mt-2 space-y-2">{tool.papers.map(paper => <li key={paper.id}><a href={paper.url} target="_blank" rel="noreferrer" className="text-ui text-accent">{paper.title}</a></li>)}</ul></Disclosure>}
      {tool.dataRequirements && <Disclosure summary="数据要求"><Button variant="text" size="sm" onClick={() => downloadEvolutionRequirements(tool)}>下载数据要求</Button><Button variant="text" size="sm" onClick={() => downloadEvolutionTemplate(tool)}>下载表格模板</Button></Disclosure>}
      {access.operator && tool.artifactDigest && <Disclosure summary="版本"><p className="break-all font-mono text-caption text-text-3">{tool.artifactDigest}</p></Disclosure>}
    </li>)}</ul>}
    {!projectId && access.operator && <><Disclosure summary="研发计划"><ul className="space-y-2">{dossiers.map(row => <li key={row.id} className="text-ui text-text-2">{row.payload.title ?? row.payload.goal ?? '研发计划'}</li>)}</ul>{dossiers.length === 0 && <EmptyState title="暂无研发计划" />}</Disclosure><Link to="/app/inbox" className="text-ui text-accent">查看裁决</Link></>}
  </section>;
}
