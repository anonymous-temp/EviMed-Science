import { getResultVersion } from '@/lib/resultProvenance';
import { useProjectStore } from '@/lib/projects';
import { webErrorMessage } from '@/lib/apiClient';
import type { GeoProject } from '@/lib/geoClient';
import { toast } from '@/lib/toast';
import { useOpenArticle } from './useOpenArticle';

/** Open the recorded bytes, never substitute the article's latest version. */
export function useOpenPublication(project: GeoProject) {
  const openArticle = useOpenArticle(project);
  return async (versionId: string, digest: string) => {
    try {
      await useProjectStore.getState().select(project.projectId);
      const version = await getResultVersion(versionId);
      if (version.projectId !== project.projectId || version.digest !== digest || !version.producer.runId || !openArticle({ runId: version.producer.runId, path: version.path, currentResultVersionId: version.versionId })) throw new Error('Publication version unavailable');
    } catch (error) { toast.error(webErrorMessage(error, { fallback: '当时发布的稿件版本暂时无法打开。' })); }
  };
}
