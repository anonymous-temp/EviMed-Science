import { Link, useLocation } from 'react-router';
import type { GeoProject } from '@/lib/geoClient';
import type { GeoAnalysisDescriptor, GeoAnalysisId } from '@/lib/geoAnalysisClient';
import { buttonClasses } from '@/components/ui/Button';
import { GEO_ANALYSIS_OPTIONS, geoAnalysisSearch } from './geoAnalysisMode';

/**
 * Component: GeoAnalysisEntry; owner: GEO; rules: DS22.1/AT51.
 * Anatomy: Named link to one analysis main area, with originating business URL.
 * Variants: All 27 analysis descriptors; frozen strategy and target versions.
 * States: Navigation only; destination owns loading, independent errors and data.
 * Hit area: Shared small Button link.
 * Keyboard: Native link focus, activation and open-in-new-tab.
 * Long content: Shared Button sizing; descriptive view label.
 * Theme: Semantic text button roles.
 * Responsive: Single entry; no workbench or global toolbar mounted in the business body.
 * Verification: geoAnalysisMode.test.ts, GeoProjectPage.test.tsx; DS22.1/AT51.
 */
export function GeoAnalysisEntry({ initialView = 'V01', initialDescriptor, title }: {
  geoId: string; project: GeoProject; initialView?: GeoAnalysisId; initialDescriptor?: GeoAnalysisDescriptor;
  title?: string; embedded?: boolean; titleLevel?: 'section' | 'sub';
}) {
  const location = useLocation();
  const descriptor = initialDescriptor ?? { viewId: initialView };
  return <Link data-geo-analysis-entry="" className={buttonClasses({ variant: 'text', size: 'sm', className: 'self-start' })}
    to={{ pathname: location.pathname, search: geoAnalysisSearch(location.search, descriptor), hash: location.hash }}>
    {title ?? `查看${GEO_ANALYSIS_OPTIONS.find(item => item.value === descriptor.viewId)?.label ?? '数据'}分析`}
  </Link>;
}
