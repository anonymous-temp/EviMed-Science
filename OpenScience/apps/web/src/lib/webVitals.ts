import { webVitalRoute } from '@evimed/domain';
import { recordWebVital } from './apiClient';

/** Stable document metrics are attributed to the entry route, even after an SPA navigation.
 * The frame's content is outside these browser observers; it is not included in this measurement.
 */
export function startWebVitals() {
  const route = webVitalRoute(window.location.pathname);
  if (!route) return;
  const device = window.matchMedia('(max-width: 767px)').matches ? 'mobile' : 'desktop';
  void import('web-vitals').then(({ onLCP, onINP, onCLS }) => {
    const send = (metric: { name: string; id: string; value: number }) => {
      void recordWebVital({ route, device, name: metric.name, id: metric.id, value: metric.value }).catch(() => {});
    };
    onLCP(send); onINP(send); onCLS(send);
  }).catch(() => {});
}
