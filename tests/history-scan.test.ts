import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import type {
  CoordinatorMessage,
  IndexProgress,
  PageRequest,
  PageResult,
  Snapshot,
  TabState,
} from '../src/types.ts';

const bundle = await build({
  entryPoints: ['src/background.ts'],
  bundle: true,
  write: false,
  format: 'iife',
});

function conversation(id: string, source?: string): PageResult {
  return {
    id,
    title: id,
    currentNode: 'answer',
    mapping: {
      answer: {
        id: 'answer',
        parent: null,
        message: {
          author: { role: 'assistant' },
          metadata: source ? { branching_from_conversation_id: source } : {},
          content: { parts: ['Plan a neighborhood book club.'] },
          create_time: 1,
        },
      },
    },
  };
}

function worker(
  respond: (request: PageRequest) => PageResult,
  storage: Record<string, unknown> = {},
) {
  const requests: { request: PageRequest; time: number }[] = [];
  const waits: number[] = [];
  const session: Record<string, TabState> = {};
  let listener!: (
    message: CoordinatorMessage,
    sender: object,
    respond: (result: unknown) => void,
  ) => boolean;
  const state = { clock: 100000, url: 'https://chatgpt.com/c/current', onWait: () => {} };
  const event = { addListener: () => {} };
  const start = () =>
    runInNewContext(bundle.outputFiles[0].text, {
      URL,
      Date: class extends Date {
        static override now() {
          return state.clock;
        }
      },
      setTimeout: (resolve: () => void, milliseconds: number) => {
        waits.push(milliseconds);
        state.onWait();
        state.clock += milliseconds;
        resolve();
      },
      chrome: {
        scripting: {
          executeScript: async ({ args }: { args: [PageRequest] }) => {
            requests.push({ request: args[0], time: state.clock });
            return [{ result: respond(args[0]) }];
          },
        },
        storage: {
          local: {
            get: async (key: string | null) =>
              structuredClone(key === null ? storage : { [key]: storage[key] }),
            set: async (values: Record<string, unknown>) => {
              Object.assign(storage, structuredClone(values));
            },
          },
          session: {
            get: async (key: string) => structuredClone({ [key]: session[key] }),
            set: async (values: Record<string, TabState>) => {
              Object.assign(session, structuredClone(values));
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
        tabs: { onRemoved: event, get: async () => ({ url: state.url }) },
      },
    });
  start();
  const message = <T = IndexProgress>(value: CoordinatorMessage) =>
    new Promise<T>((resolve) => listener(value, {}, (result) => resolve(result as T)));
  return {
    requests,
    waits,
    storage,
    session,
    state,
    start,
    message,
    batch: () => message({ type: 'indexBatch', tabId: 1 }),
    sync: (manual = false) => message<Snapshot>({ type: 'sync', tabId: 1, manual }),
  };
}

function history(request: PageRequest): PageResult {
  if (request.kind === 'list')
    return {
      ids: Array.from(
        { length: Math.min(5, 12 - request.offset) },
        (_, index) => `chat${request.offset + index}`,
      ),
      total: 12,
    };
  return conversation(request.id, 'source-outside-the-batch');
}

test('each click scans at most five chats without fetching their ancestors, and resumes saved progress', async () => {
  const w = worker(history);
  const first = await w.batch();
  assert.equal(first.completed, 5);
  assert.equal(first.done, false);
  assert.equal(w.requests.length, 6);
  assert.ok(
    w.requests.every(
      ({ request }) => request.kind !== 'conversation' || request.id !== 'source-outside-the-batch',
    ),
  );
  for (let index = 1; index < w.requests.length; index++)
    assert.ok(w.requests[index].time - w.requests[index - 1].time >= 4000);
  w.start();
  assert.equal((await w.batch()).completed, 10);
  const last = await w.batch();
  assert.equal(last.completed, 12);
  assert.equal(last.done, true);
});

test('429 stops the batch without advancing the failed cursor or retrying, until another click', async () => {
  let limited = true;
  const w = worker((request) => {
    if (request.kind === 'conversation' && request.id === 'chat1' && limited) {
      limited = false;
      return { error: 'limited', status: 429 };
    }
    return history(request);
  });
  const first = await w.batch();
  assert.equal(first.completed, 1);
  assert.equal(first.cursor, 1);
  assert.equal(first.error, 'indexRateLimited');
  assert.equal(w.requests.length, 3);
  w.state.clock += 60000;
  await w.message({ type: 'snapshot', tabId: 1 });
  assert.equal(w.requests.length, 3);
  await w.sync();
  assert.equal(w.requests.at(-1)!.request.kind, 'conversation');
  assert.equal((w.requests.at(-1)!.request as { id: string }).id, 'source-outside-the-batch');
  w.start();
  const count = w.requests.length;
  const next = await w.batch();
  assert.equal(next.completed, 6);
  assert.equal(next.error, undefined);
  assert.equal((w.requests[count].request as { id: string }).id, 'chat1');
});

test('scan speed uses the current user setting and can change between requests', async () => {
  const w = worker(history, { scanInterval: 3000 });
  await w.batch();
  assert.deepEqual(w.waits, Array<number>(w.waits.length).fill(3000));
  w.storage.scanInterval = 5000;
  const before = w.waits.length;
  await w.batch();
  assert.deepEqual(w.waits.slice(before), Array<number>(w.waits.length - before).fill(5000));
});

test('a 404 marks the unavailable conversation and advances without discarding cached messages', async () => {
  const cached = {
    id: 'gone',
    title: 'Archived book club',
    nodes: [{ id: 'message', text: 'Keep this cached text.' }],
    activePath: ['message'],
    fork: null,
  };
  const w = worker(
    (request) =>
      request.kind === 'list' ? { ids: ['gone'], total: 1 } : { error: 'not found', status: 404 },
    { 'conversation:gone': cached },
  );
  const progress = await w.batch();
  assert.equal(progress.completed, 1);
  assert.equal(progress.done, true);
  assert.equal(progress.error, undefined);
  assert.deepEqual(w.storage['conversation:gone'], { ...cached, unavailable: true });
});

test('stopping during a scan wait cancels the next request and retains the cursor for continuation', async () => {
  const w = worker(history);
  w.state.onWait = () => {
    w.state.onWait = () => {};
    void w.message({ type: 'indexStop', tabId: 1 });
  };
  const stopped = await w.batch();
  assert.equal(w.requests.length, 1);
  assert.equal(stopped.cursor, 0);
  assert.equal(stopped.error, undefined);
  assert.equal((await w.batch()).completed, 5);
});

test('automatic sync fetches no more than ten chats; later auto sync only refreshes current, manual sync continues', async () => {
  const w = worker((request) => {
    assert.equal(request.kind, 'conversation');
    const index = Number((request as { id: string }).id.replace('chat', ''));
    return conversation(`chat${index}`, index < 24 ? `chat${index + 1}` : undefined);
  });
  w.state.url = 'https://chatgpt.com/c/chat0';
  const first = await w.sync();
  assert.equal(w.requests.length, 10);
  assert.equal(first.state!.remainingSource, 'chat10');
  assert.ok(w.waits.every((wait) => wait === 500));
  w.start();
  await w.sync();
  assert.equal(w.requests.length, 11);
  const next = await w.sync(true);
  assert.equal(w.requests.length, 21);
  assert.equal(next.state!.remainingSource, 'chat19');
  const final = await w.sync(true);
  assert.equal(w.requests.length, 28);
  assert.equal(final.state!.remainingSource, undefined);
});

test('page changes stop a waiting historical batch; syncing the new page never lists history', async () => {
  const w = worker(history);
  let syncing: Promise<Snapshot> | undefined;
  w.state.onWait = () => {
    w.state.onWait = () => {};
    w.state.url = 'https://chatgpt.com/c/new-page';
    syncing = w.sync();
  };
  await w.batch();
  await syncing;
  assert.equal(w.requests.filter(({ request }) => request.kind === 'list').length, 1);
  assert.ok(
    w.requests.every(
      ({ request }) => request.kind !== 'conversation' || !request.id.startsWith('chat'),
    ),
  );
});

test('a normal sync can issue its request while the historical scan is waiting', async () => {
  const w = worker((request) =>
    request.kind === 'list' ? { ids: ['one'], total: 1 } : conversation(request.id),
  );
  let syncing: Promise<Snapshot> | undefined;
  await w.sync();
  const start = w.requests.length;
  w.state.onWait = () => {
    w.state.onWait = () => {};
    syncing = w.sync();
  };
  await w.batch();
  await syncing;
  assert.equal((w.requests[start + 1].request as { id: string }).id, 'current');
  assert.equal((w.requests[start + 2].request as { id: string }).id, 'one');
});
