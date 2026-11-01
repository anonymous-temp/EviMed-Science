import { GeoStepRunButton } from './GeoStepRunButton';
import { PenLine } from 'lucide-react';
import { Link } from 'react-router';
import type { GeoProject } from '@/lib/geoClient';
import { Button, buttonClasses } from '@/components/ui/Button';
import { FactList } from '@/components/ui/FactList';
import { List, ListRow } from '@/components/ui/ListRow';
import { Note } from '@/components/ui/Note';
import { RailMark } from '@/components/ui/ProgressRail';
import { geoJourney } from './geoJourney';
import { useGeoFrame } from './geoFrame';
import { useOpenGeoConversation } from './useOpenGeoConversation';

/**
 * The work's one 「现在」: a sentence, and either what is still missing or its one way on. A choice of task only fills the composer. Saved
 * results and the native composer remain their existing destinations.
 */
export function GeoJourneySummary({project, compact = false}: {project: GeoProject; compact?: boolean}) {
  const journey = geoJourney(project);
  const frame = useGeoFrame();
  const open = useOpenGeoConversation();
  const target = {geoId:project.id,projectId:project.projectId,sessionId:frame?.conversation,primarySessionId:project.sessionId};
  const next = journey.next;
  const href = `/app/geo/${encodeURIComponent(project.id)}/evidence`;
  const intents = journey.canConverse && !['running','queued','paused'].includes(journey.stage) ? journey.intents : [];
  const draftChoices = <span className="flex flex-wrap gap-2">{intents.map(intent => <Button key={intent.key} variant="secondary" size="sm" actionKind="draft" onClick={() => void open(target,intent.draft)}><PenLine size={16} aria-hidden="true" />{intent.label}</Button>)}</span>;
  return <section aria-label="当前工作" data-geo-journey={journey.stage} className="flex flex-col gap-3">
    <div>{journey.requested && <p className="text-caption text-text-3">{journey.requested}</p>}<h2 className="mt-1 text-section font-semibold text-text">{journey.title}</h2></div>
    {journey.stage === 'inputs' ? <>
      <Note action={journey.canConverse && next.kind === 'conversation' ? <Button variant="secondary" actionKind="draft" onClick={() => void open(target,next.draft)}><PenLine size={16} aria-hidden="true" />{next.label}</Button> : <Link className={buttonClasses({variant:'secondary'})} to={href}>查看项目依据</Link>}>{journey.detail}</Note>
      <List divided label="还缺什么">
        {journey.inputs.map(input => <ListRow key={input.key} data-work-input={input.key} data-work-input-done={input.done ? '' : undefined} title={<span className="flex items-center gap-2"><RailMark state={input.done ? 'done' : 'todo'} />{input.label}</span>} chevron={false} actions={input.key === 'task' && !input.done ? draftChoices : undefined} />)}
      </List>
      {/* 这次要做什么's choices say what they do on their own: each is a draft, with the pencil, and the composer holds what it wrote. */}
    </> : <>
      {/* The way on is the header's one primary; here only what this block adds to it: the record of the run. */}
      <Note action={journey.runId ? <GeoStepRunButton project={project} runId={journey.runId} /> : null}>{journey.detail}</Note>
      {journey.retained.length > 0 && <FactList ruled={false} rows={[{label:'已保留',value:journey.retained.join('、')}]} />}
      {!compact && intents.length > 0 && <div className="flex flex-col gap-2">
        <Note action={draftChoices}>也可以直接交代一项任务，选了只会填进输入框。</Note>
      </div>}
    </>}
  </section>;
}
