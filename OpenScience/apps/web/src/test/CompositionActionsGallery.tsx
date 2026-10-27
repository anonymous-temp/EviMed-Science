import { StepRail } from "@/components/ui/StepRail";
import { Button } from "@/components/ui/Button";
import { useRef, useState } from 'react';
import { PageHeader } from '@/components/layout/PageHeader';
import type { PageActionPlan } from '@/components/layout/HeaderActions';
import { Toolbar } from '@/components/ui/Toolbar';
import { Switch } from '@/components/ui/Switch';

/** Browser fixture: visit /__gallery?suite=composition at 390, 768 and 1024px; inspect page overflow, action priority, menu paths and focus return. */
function CompositionActionsExample() {
  const [enabled, setEnabled] = useState(true);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState(false);
  const [count, setCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const guard = useRef(false);
  const start = () => {
    if (guard.current) return;
    guard.current = true;
    setBusy(true);
    setCount(value => value + 1);
  };

  const plan: PageActionPlan = {
    primary: { id: 'start', label: '开始这项包含较长名称的循证研究', loading: busy, onSelect: start },
    secondary: [{ id: 'results', label: '查看已经保存的全部研究结果', to: '/app', loading: busy }, { id: 'export', label: '导出当前完整研究材料', onSelect() {} }],
    overflow: [{ id: 'history', label: '查看历史版本及其实际来源', to: '/app', loading: busy }],
    preference: { label: '记忆偏好', control: <Switch showLabel label="使用我的研究记忆偏好" checked={enabled} onChange={setEnabled} /> },
  };
  return <div data-composition-actions-fixture="" className="space-y-6">
    <p role="status">已启动 {count} 次；{busy ? '正在处理' : '等待启动'}</p>
    <Button variant="secondary" onClick={() => { guard.current = false; setBusy(false); }}>完成本地演示</Button>
    <PageHeader title="用于验证长标题与操作优先级的研究工作区" documentTitle={false} actionPlan={plan} />
    <StepRail label="研究步骤" visible showState activeSteps={['questions']} trailing="正在准备下一轮研究材料，已保存结果仍然可用" steps={[
      { id: 'definition', label: '定义', state: 'done', href: '/app?step=definition' },
      { id: 'evidence', label: '证据', state: 'done', href: '/app?step=evidence' },
      { id: 'questions', label: '问题', state: 'active', href: '/app?step=questions' },
      { id: 'sources', label: '信源', state: 'waiting', href: '/app?step=sources' },
      { id: 'content', label: '内容', state: 'todo', href: '/app?step=content' },
      { id: 'review', label: '复核', state: 'todo', href: '/app?step=review' },
      { id: 'delivery', label: '投放', state: 'todo', href: '/app?step=delivery' },
      { id: 'monitor', label: '监测', state: 'todo', href: '/app?step=monitor' },
    ]} />
    <Toolbar oneRow scopeAction={{ label: '分析范围 · 已筛选', onSelect: () => setCount(value => value + 1) }} filters={[{ kind: "toggle", label: "只看收藏", pressed: filter, onChange: setFilter }]} onClear={() => { setFilter(false); setQuery(''); }} onReset={() => setFilter(false)} views={{ label: '研究视图', value: 'current', items: [{ value: 'current', label: '当前研究结果' }, { value: 'history', label: '研究历史版本' }], onChange() {} }} actionPlan={plan} search={{ label: '搜索研究', value: query, onChange: setQuery }} />
  </div>;
}


/** Regular and constrained allocations exercise the same component state without API writes. */
export function CompositionActionsGallery() {
  return <div className="space-y-6">
    <section data-composition-width="regular" aria-label="完整宽度操作布局"><CompositionActionsExample /></section>
    <section data-composition-width="500" aria-label="500 像素分栏操作布局" style={{ width: 500, maxWidth: '100%' }}><CompositionActionsExample /></section>
  </div>;
}
