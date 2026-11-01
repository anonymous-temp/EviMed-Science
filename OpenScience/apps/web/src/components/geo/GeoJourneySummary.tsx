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
import { useGeoDestinationPath } from './useGeoPath';
import { GEO_STEP_HOME } from './geoTabs';

/**
 * The work's one 「现在」: a sentence, and either what is still missing or its one way on. A choice of task only fills the composer. Saved
 * results and the native composer remain their existing destinations.
 */
export function GeoJourneySummary({project, compact = false}: {project: GeoProject; compact?: boolean}) {
  const journey = geoJourney(project);
  const frame = useGeoFrame();
  const open = useOpenGeoConversation();
  const destination = useGeoDestinationPath();
  const target = {geoId:project.id,projectId:project.projectId,sessionId:frame?.conversation,primarySessionId:project.sessionId};
  const next = journey.next;
  const href = next.step ? destination(project.id, GEO_STEP_HOME[next.step]) : `/app/geo/${encodeURIComponent(project.id)}`;
  const intents = journey.canConverse && !['running','queued','paused'].includes(journey.stage) ? journey.intents : [];
  const draftChoices = <span className="flex flex-wrap gap-2">{intents.map(intent => <Button key={intent.key} variant="secondary" size="sm" actionKind="draft" onClick={() => void open(target,intent.draft)}><PenLine size={14} aria-hidden="true" />{intent.label}</Button>)}</span>;
  return <section aria-label="当前工作" data-geo-journey={journey.stage} className="flex flex-col gap-3">
    <div>{journey.requested && <p className="text-caption text-text-3">{journey.requested}</p>}<h2 className="mt-1 text-section font-semibold text-text">{journey.title}</h2></div>
    {journey.stage === 'inputs' ? <>
      <Note>{journey.detail}</Note>
      <List divided label="还缺什么">
        {journey.inputs.map(input => <ListRow key={input.key} data-work-input={input.key} data-work-input-done={input.done ? '' : undefined} title={<span className="flex items-center gap-2"><RailMark state={input.done ? 'done' : 'todo'} />{input.label}</span>} chevron={false} actions={input.key === 'task' && !input.done ? draftChoices : undefined} />)}
      </List>
      {/* 这次要做什么's choices say what they do on their own: each is a draft, with the pencil, and the composer holds what it wrote. */}
    </> : <>
      {/* The sentence and its one way on are a note; what is kept is a fact, not a second grey line. */}
      <Note action={<span className="flex flex-wrap gap-2">
        {next.kind === 'conversation' && journey.canConverse ? <Button variant="secondary" actionKind="draft" onClick={() => void open(target,next.draft)}><PenLine size={14} aria-hidden="true" />{next.label}</Button> : <Link className={buttonClasses({variant:'secondary'})} to={href}>{next.kind === 'conversation' ? '查看项目依据' : next.label}</Link>}
        {journey.runId && <GeoStepRunButton project={project} runId={journey.runId} />}
      </span>}>{journey.detail}</Note>
      {journey.retained.length > 0 && <FactList ruled={false} rows={[{label:'已保留',value:journey.retained.join('、')}]} />}
      {!compact && intents.length > 0 && <div className="flex flex-col gap-2">
        <Note action={draftChoices}>也可以直接交代一项任务，选了只会填进输入框。</Note>
      </div>}
    </>}
  </section>;
}
