import test from 'node:test';
import assert from 'node:assert/strict';
import { scanRequest } from '../src/scan-rate.ts';
import type { IndexProgress } from '../src/types.ts';

test('each 429 further reduces the rate and leaves the scan cursor intact', async () => {
  const progress: IndexProgress = {
    offset: 100,
    ids: ['conversation'],
    cursor: 0,
    completed: 12,
    total: 200,
    done: false,
  };
  let clock = 0;
  const waits: number[] = [];
  const saved: IndexProgress[] = [];
  const save = async () => {
    saved.push(structuredClone(progress));
  };
  const wait = async (milliseconds: number) => {
    waits.push(milliseconds);
    clock += milliseconds;
  };
  const limited = async () => {
    throw Object.assign(new Error('limited'), { status: 429 });
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    await assert.rejects(
      scanRequest(progress, limited, save, () => clock, wait),
      /limited/,
    );
  }
  assert.deepEqual(
    saved.map((state) => state.requestInterval),
    [1000, 2000, 4000],
  );
  assert.deepEqual(waits, [1000, 2000]);
  assert.equal(progress.cursor, 0);
  assert.equal(progress.completed, 12);
  assert.deepEqual(progress.ids, ['conversation']);
  assert.equal(progress.offset, 100);

  // A resumed worker uses the stored cooldown and retains the slower rate after success.
  const resumed = structuredClone(saved.at(-1)!);
  assert.equal(
    await scanRequest(
      resumed,
      async () => 'ok',
      async () => {},
      () => clock,
      wait,
    ),
    'ok',
  );
  assert.equal(resumed.requestInterval, 4000);
  assert.equal(waits.at(-1), 4000);
  await scanRequest(
    resumed,
    async () => 'next',
    async () => {},
    () => clock,
    wait,
  );
  assert.equal(waits.at(-1), 4000);
});

test('normal scan requests are paced and other failures do not reduce the rate', async () => {
  const progress: IndexProgress = {
    offset: 0,
    ids: [],
    cursor: 0,
    completed: 0,
    total: 0,
    done: false,
  };
  let clock = 100;
  const waits: number[] = [];
  const wait = async (milliseconds: number) => {
    waits.push(milliseconds);
    clock += milliseconds;
  };
  const save = async () => {};
  await scanRequest(
    progress,
    async () => 'list',
    save,
    () => clock,
    wait,
  );
  await assert.rejects(
    scanRequest(
      progress,
      async () => {
        throw Object.assign(new Error('missing'), { status: 404 });
      },
      save,
      () => clock,
      wait,
    ),
    /missing/,
  );
  assert.deepEqual(waits, [500]);
  assert.equal(progress.requestInterval, undefined);
  clock += 1000;
  await scanRequest(
    progress,
    async () => 'conversation',
    save,
    () => clock,
    wait,
  );
  assert.deepEqual(waits, [500]);
});
