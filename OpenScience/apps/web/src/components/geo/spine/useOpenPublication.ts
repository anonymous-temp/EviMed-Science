import { createElement, useState, useSyncExternalStore } from 'react';
import { getResultVersion } from '@/lib/resultProvenance';
import { useProjectStore } from '@/lib/projects';
import { webErrorMessage } from '@/lib/apiClient';
import type { GeoProject } from '@/lib/geoClient';
import { toast } from '@/lib/toast';
import { sessionGeneration, subscribeSessionBoundary } from '@/lib/sessionLifecycle';
import { GeoScopedVersionPreview, type GeoVersionTarget } from '../GeoScopedVersionPreview';
import { useOpenArticle } from './useOpenArticle';

/** The server resolves the record and validates its immutable article pin. */
export function useOpenGeoPublication(geoId: string, kind: 'orders' | 'owned-links', recordId: string) {
  const generation = useSyncExternalStore(subscribeSessionBoundary, sessionGeneration, sessionGeneration);
  const [selection, setSelection] = useState<{ generation: number; geoId: string; target: GeoVersionTarget } | null>(null);
  const open = async (versionId: string, digest: string, revision?: number) => {
    setSelection({ generation: sessionGeneration(), geoId, target: { kind, recordId, versionId, digest, ...(revision == null ? {} : { revision }) } });
  };
  const dialog = selection?.generation === generation && selection.geoId === geoId && selection.target.kind === kind && selection.target.recordId === recordId
    ? createElement(GeoScopedVersionPreview, { geoId, target: selection.target, onClose: () => setSelection(null) }) : null;
  return { open, dialog };
}

/** Existing owner-only result reader for analysis views that do not identify a publication record. */
export function useOpenPublication(project: GeoProject) {
  const openArticle = useOpenArticle(project);
  return async (versionId: string, digest: string) => {
    try {
      await useProjectStore.getState().select(project.projectId);
      const version = await getResultVersion(versionId, project.projectId);
      if (version.projectId !== project.projectId || version.digest !== digest || !version.producer.runId || !openArticle({ runId: version.producer.runId, path: version.path, currentResultVersionId: version.versionId })) throw new Error('Publication version unavailable');
    } catch (error) { toast.error(webErrorMessage(error, { fallback: '当时发布的稿件版本暂时无法打开。' })); }
  };
}
