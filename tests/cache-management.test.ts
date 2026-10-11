import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import type { CoordinatorMessage, PageResult } from '../src/types.ts';

const bundle = await build({
  entryPoints: ['src/background.ts'],
  bundle: true,
  write: false,
  format: 'iife',
});

function worker(
  storage: Record<string, unknown>,
  read: () => Promise<PageResult>,
  beforeWrite = async () => {},
) {
  let listener!: (
    message: CoordinatorMessage,
    sender: object,
    respond: (result: Record<string, unknown>) => void,
  ) => boolean;
  const event = { addListener: () => {} };
  runInNewContext(bundle.outputFiles[0].text, {
    Date,
    setTimeout: (resolve: () => void) => resolve(),
    chrome: {
      scripting: { executeScript: async () => [{ result: await read() }] },
      storage: {
        local: {
          get: async () => structuredClone(storage),
          set: async (values: Record<string, unknown>) => {
            await beforeWrite();
            Object.assign(storage, structuredClone(values));
          },
          remove: async (keys: string[]) => {
            keys.forEach((key) => delete storage[key]);
          },
        },
        session: { set: async () => {} },
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
  return (message: CoordinatorMessage) =>
    new Promise<Record<string, unknown>>((resolve) => listener(message, {}, resolve));
}

test('selective and all cache clearing preserve preferences and unrelated storage', async () => {
  const storage: Record<string, unknown> = {
    language: 'zh_CN',
    preference: true,
    'conversation:first': {},
    'conversation:second': {},
    historyIndex: {},
  };
  const request = worker(storage, async () => ({ ids: [], total: 0 }));
  assert.equal(
    (await request({ type: 'cacheClear', keys: ['conversation:first', 'language'] })).cleared,
    1,
  );
  assert.deepEqual(Object.keys(storage).sort(), [
    'conversation:second',
    'historyIndex',
    'language',
    'preference',
  ]);
  assert.equal((await request({ type: 'cacheClear' })).cleared, 2);
  assert.deepEqual(storage, { language: 'zh_CN', preference: true });
});

test('clearing cancels an in-flight scan without restoring progress and allows a fresh scan', async () => {
  const storage: Record<string, unknown> = {};
  let release!: (value: PageResult) => void;
  let started!: () => void;
  const pending = new Promise<PageResult>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  let calls = 0;
  const request = worker(storage, async () => {
    calls++;
    if (calls === 1) {
      started();
      return pending;
    }
    return { ids: [], total: 0 };
  });
  const scan = request({ type: 'indexStep', tabId: 1 });
  await entered;
  await request({ type: 'cacheClear' });
  release({ ids: ['old-chat'], total: 1 });
  assert.equal((await scan).error, 'cacheCleared');
  assert.deepEqual(storage, {});
  assert.equal((await request({ type: 'indexStep', tabId: 1 })).done, true);
  assert.equal(calls, 2);
  assert.ok(storage.historyIndex);
});

test('clearing waits for a storage write already submitted by the scan', async () => {
  const storage: Record<string, unknown> = { language: 'en' };
  let release!: () => void;
  let started!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const request = worker(
    storage,
    async () => ({ ids: [], total: 0 }),
    async () => {
      started();
      await pending;
    },
  );
  const scan = request({ type: 'indexStep', tabId: 1 });
  await entered;
  const clear = request({ type: 'cacheClear' });
  release();
  await clear;
  assert.equal((await scan).error, 'cacheCleared');
  assert.deepEqual(storage, { language: 'en' });
});
