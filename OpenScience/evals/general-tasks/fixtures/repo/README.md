# jobqueue

A small in-memory job queue for demo services.

## Usage

```ts
import { Queue } from './src/queue';
const q = new Queue<string>();
q.push('a');
```

See `src/queue.ts` and `src/utils.ts`.
