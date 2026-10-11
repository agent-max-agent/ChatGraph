import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import type { CoordinatorMessage, IndexProgress, PageRequest, PageResult } from '../src/types.ts';

test('background scanning retries list and conversation 429s without losing progress', async () => {
  const bundle = await build({
    entryPoints: ['src/background.ts'],
    bundle: true,
    write: false,
    format: 'iife',
  });
  const storage: Record<string, unknown> = {};
  const requests: PageRequest[] = [];
  const waits: number[] = [];
  const responses: PageResult[] = [
    { error: 'limited', status: 429 },
    { ids: ['chat'], total: 1 },
    { error: 'limited', status: 429 },
    { error: 'limited', status: 429 },
    { id: 'chat', title: 'A conversation', currentNode: null, mapping: {} },
  ];
  let listener!: (
    message: CoordinatorMessage,
    sender: object,
    respond: (result: IndexProgress) => void,
  ) => boolean;
  let clock = 0;
  const event = { addListener: () => {} };
  runInNewContext(bundle.outputFiles[0].text, {
    Date: class extends Date {
      static override now() {
        return clock;
      }
    },
    setTimeout: (resolve: () => void, milliseconds: number) => {
      waits.push(milliseconds);
      clock += milliseconds;
      resolve();
    },
    chrome: {
      scripting: {
        executeScript: async ({ args }: { args: [PageRequest] }) => {
          requests.push(args[0]);
          return [{ result: responses.shift()! }];
        },
      },
      storage: {
        local: {
          get: async () => structuredClone(storage),
          set: async (values: Record<string, unknown>) => {
            Object.assign(storage, structuredClone(values));
          },
        },
      },
      sidePanel: { setPanelBehavior: () => {} },
      runtime: {
        onMessage: {
          addListener: (callback: typeof listener) => {
            listener = callback;
          },
        },
      },
      webNavigation: { onCompleted: event, onHistoryStateUpdated: event },
      tabs: { onRemoved: event },
    },
  });
  const step = () =>
    new Promise<IndexProgress>((resolve) => listener({ type: 'indexStep', tabId: 1 }, {}, resolve));
  const first = await step();
  assert.equal(first.offset, 0);
  assert.equal(first.requestInterval, 1000);
  const second = await step();
  assert.equal(second.offset, 1);
  assert.equal(second.cursor, 0);
  assert.equal(second.completed, 0);
  assert.equal(second.requestInterval, 2000);
  const third = await step();
  assert.equal(third.cursor, 0);
  assert.equal(third.requestInterval, 4000);
  const final = await step();
  assert.equal(final.completed, 1);
  assert.equal(final.cursor, 1);
  assert.equal(final.done, true);
  assert.equal(final.requestInterval, 4000);
  assert.deepEqual(
    requests.map((request) => request.kind),
    ['list', 'list', 'conversation', 'conversation', 'conversation'],
  );
  assert.deepEqual(waits, [1000, 1000, 2000, 4000]);
  assert.equal((storage.historyIndex as IndexProgress).completed, 1);
});
