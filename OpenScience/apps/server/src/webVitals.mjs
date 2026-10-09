import { validWebVital } from '@evimed/domain';
import { HttpError } from './security.mjs';

/** Anonymous, bounded measurements for this process's last 24 hours. Prometheus retains the aggregate history. */
export class WebVitals {
  constructor(now = () => Date.now()) { this.now = now; this.startedAt = now(); this.samples = new Map(); }
  record(input) {
    if (!validWebVital(input)) throw new HttpError(400, 'invalid_request', 'Invalid web vital.');
    this.samples.set(input.id, { name: input.name, route: input.route, device: input.device, value: input.value, at: this.now() });
    this.prune();
  }
  prune() {
    const earliest = this.now() - 86_400_000;
    for (const [id, sample] of this.samples) if (sample.at < earliest) this.samples.delete(id);
    while (this.samples.size > 10_000) this.samples.delete(this.samples.keys().next().value);
  }
  snapshot() {
    this.prune();
    const groups = new Map();
    for (const sample of this.samples.values()) {
      const key = `${sample.route}:${sample.device}:${sample.name}`;
      if (!groups.has(key)) groups.set(key, { route: sample.route, device: sample.device, metric: sample.name, values: [] });
      groups.get(key).values.push(sample.value);
    }
    return { scope: 'document', windowStart: new Date(Math.max(this.startedAt, this.now() - 86_400_000)).toISOString(),
      groups: [...groups.values()].map(({ values, ...group }) => {
        values.sort((a, b) => a - b);
        return { ...group, count: values.length, p75: values[Math.ceil(values.length * 0.75) - 1] };
      }) };
  }
  metrics() {
    return this.snapshot().groups.flatMap(row => {
      const labels = `route="${row.route}",device="${row.device}",metric="${row.metric}",scope="document"`;
      return [`evimed_web_vital_p75{${labels}} ${row.p75}`, `evimed_web_vital_samples{${labels}} ${row.count}`];
    });
  }
}
