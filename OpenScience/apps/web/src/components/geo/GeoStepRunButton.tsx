import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { ProgrammeRunsDrawer } from '@/components/runs/ProgrammeRunsDrawer';
import { getGeoProgrammeRuns, type GeoProject } from '@/lib/geoClient';
import type { ProgrammeRun } from '@/lib/programmeRuns';
import { webErrorMessage } from '@/lib/apiClient';
import { toast } from '@/lib/toast';
import { getGeoSignalRunRecord, geoSignalResultHref } from '@/lib/geoSignalsClient';

/** Open the exact preserved background execution, never the user's primary conversation. */
export function GeoStepRunButton({project,runId}: {project:GeoProject;runId:string}) {
  const [busy,setBusy]=useState(false);
  const [run,setRun]=useState<ProgrammeRun|null>(null);
  const load = () => getGeoProgrammeRuns(project.id);
  const open = async () => {
    setBusy(true);
    try {
      let page = await load();
      const seen = new Set<string>();
      let found = page.runs.find(item => item.runId === runId);
      while (!found && page.nextCursor && !seen.has(page.nextCursor)) {
        seen.add(page.nextCursor);
        page = await getGeoProgrammeRuns(project.id,page.nextCursor);
        found = page.runs.find(item => item.runId === runId);
      }
      if (!found) throw new Error('This execution is unavailable.');
      setRun(found);
    } catch(error:unknown) { toast.error(webErrorMessage(error,{fallback:'这次运行记录暂时无法打开，请稍后重试。'})); }
    finally {setBusy(false);}
  };
  return <>
    <Button variant="text" size="sm" loading={busy} onClick={() => void open()}>查看这次运行</Button>
    {run && <ProgrammeRunsDrawer projectId={project.projectId} load={load} loadMore={cursor => getGeoProgrammeRuns(project.id,cursor)} initialRun={run}
      readRecord={project.signalsSupported ? async selected => {
        if (!selected.runId) throw new Error('The execution is unavailable.');
        const record = await getGeoSignalRunRecord(project.id,null,selected.runId);
        if (record.runId !== selected.runId || record.sessionId !== selected.sessionId) throw new Error('The execution does not match.');
        return {history:record.history,files:record.files.map(file => ({...file,href:geoSignalResultHref(project.id,null,file)}))};
      } : undefined} onClose={() => setRun(null)} />}
  </>;
}
