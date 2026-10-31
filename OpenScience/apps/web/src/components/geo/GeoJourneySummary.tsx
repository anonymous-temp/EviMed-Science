import { GeoStepRunButton } from './GeoStepRunButton';
import { Link } from 'react-router';
import type { GeoProject } from '@/lib/geoClient';
import { Button, buttonClasses } from '@/components/ui/Button';
import { geoJourney } from './geoJourney';
import { useGeoFrame } from './geoFrame';
import { useOpenGeoConversation } from './useOpenGeoConversation';
import { useGeoDestinationPath } from './useGeoPath';
import { GEO_STEP_HOME } from './geoTabs';

/** One current-task block; saved results and the native composer remain their existing destinations. */
export function GeoJourneySummary({project, compact = false}: {project: GeoProject; compact?: boolean}) {
  const journey = geoJourney(project);
  const frame = useGeoFrame();
  const open = useOpenGeoConversation();
  const destination = useGeoDestinationPath();
  const target = {geoId:project.id,projectId:project.projectId,sessionId:frame?.conversation,primarySessionId:project.sessionId};
  const next = journey.next;
  const href = next.step ? destination(project.id, GEO_STEP_HOME[next.step]) : `/app/geo/${encodeURIComponent(project.id)}`;
  return <section aria-label="当前工作" data-geo-journey={journey.stage} className="flex flex-col gap-3">
    <div><p className="text-caption text-text-3">{journey.requested}</p><h2 className="mt-1 text-section font-semibold text-text">{journey.title}</h2></div>
    <p className="max-w-measure text-ui text-text-2">{journey.detail}</p>
    {journey.retained.length > 0 && <p className="text-caption text-text-3">{`已保留：${journey.retained.join('、')}`}</p>}
    <div className="flex flex-wrap gap-2">
      {next.kind === 'conversation' && journey.canConverse ? <Button variant="secondary" onClick={() => void open(target,next.draft)}>{next.label}</Button> : <Link className={buttonClasses({variant:'secondary'})} to={href}>{next.kind === 'conversation' ? '查看产品依据' : next.label}</Link>}
      {journey.runId && <GeoStepRunButton project={project} runId={journey.runId} />}
    </div>
    {!compact && journey.canConverse && !['running','queued','paused'].includes(journey.stage) && <div className="flex flex-col gap-2">
      <p className="text-caption text-text-3">在同一对话中交代任务和附上资料，发送后开始。</p>
      <div className="flex flex-wrap gap-2">{journey.intents.map(intent => <Button key={intent.key} variant="text" size="sm" onClick={() => void open(target,intent.draft)}>{`在对话中${intent.label}`}</Button>)}</div>
    </div>}
  </section>;
}
