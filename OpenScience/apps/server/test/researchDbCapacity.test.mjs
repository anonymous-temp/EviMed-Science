import assert from 'node:assert/strict';
import test from 'node:test';
import { createResearchDbCapacity } from '../src/researchDbCapacity.mjs';

/** An operation that holds its slot until `release()`. */
function held() {
  let release; let entered;
  const inside = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  return { inside, release, operation: async () => { entered(); await gate; return 'done'; } };
}

test('at most four connections are open at once and one belongs to one person; a refused request answers busy at once', async () => {
  const refusals = [];
  const capacity = createResearchDbCapacity({ slots: 4, perUser: 1, onRefusal: reason => refusals.push(reason) });
  const running = Array.from({ length: 4 }, () => held());
  const outcomes = running.map((item, index) => capacity.run(`user-${index}`, item.operation));
  await Promise.all(running.map(item => item.inside));
  assert.equal(capacity.open, 4);
  await assert.rejects(capacity.run('user-0', async () => 'again'), { code: 'research_db_busy', status: 429 }, 'the same person');
  await assert.rejects(capacity.run('user-9', async () => 'fifth'), { code: 'research_db_busy', status: 429 }, 'every slot taken');
  assert.deepEqual(refusals, ['busy', 'busy']);
  running.forEach(item => item.release());
  assert.deepEqual(await Promise.all(outcomes), ['done', 'done', 'done', 'done']);
  assert.equal(capacity.open, 0);
  assert.equal(await capacity.run('user-9', async () => 'ok'), 'ok', 'a released slot is taken again');
});

test('a slot is released however the operation ends, and the person\'s own slot too', async () => {
  const capacity = createResearchDbCapacity({ slots: 1, perUser: 1 });
  await assert.rejects(capacity.run('a', async () => { throw new Error('the remote database went away'); }), /went away/);
  assert.equal(capacity.open, 0);
  assert.equal(await capacity.run('a', async () => 'after a failure'), 'after a failure');
});

test('the caps are the configured ones, and a person may hold up to their own cap', async () => {
  const capacity = createResearchDbCapacity({ slots: 3, perUser: 2 });
  const [first, second] = [held(), held()];
  const both = [capacity.run('a', first.operation), capacity.run('a', second.operation)];
  await Promise.all([first.inside, second.inside]);
  await assert.rejects(capacity.run('a', async () => 'third'), { code: 'research_db_busy' });
  const other = held(); const third = capacity.run('b', other.operation); await other.inside;
  await assert.rejects(capacity.run('c', async () => 'fourth'), { code: 'research_db_busy' });
  for (const item of [first, second, other]) item.release();
  await Promise.all([...both, third]);
});
