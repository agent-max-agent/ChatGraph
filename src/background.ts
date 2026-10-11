import type {
  Conversation,
  ConversationData,
  CoordinatorMessage,
  IndexProgress,
  NavigationPlan,
  NavigationReply,
  PageRequest,
  PageResult,
  Snapshot,
  TabState,
} from './types.js';

import { conversationId, projectConversation, navigationPlan } from './model.js';
import { readChatGPT } from './page-api.js';
import { readVisibleConversation } from './page-state.js';

class Coordinator {
  states = new Map<number, TabState>();
  pending = new Map<number, Promise<void>>();
  requestQueue = Promise.resolve();
  nextRequestAt = 0;
  lastIndexRequestAt = -Infinity;
  scanGeneration = 0;
  scan?: {
    tabId: number;
    id: string | undefined;
    generation: number;
    task: Promise<IndexProgress>;
  };

  async read<T extends PageResult>(
    tabId: number,
    request: PageRequest,
    generation?: number,
  ): Promise<T> {
    const task = this.requestQueue.then(() => this.readNext<T>(tabId, request, generation));
    this.requestQueue = task.then(
      () => {},
      () => {},
    );
    return task;
  }

  async readNext<T extends PageResult>(
    tabId: number,
    request: PageRequest,
    generation?: number,
  ): Promise<T> {
    const remaining = this.nextRequestAt - Date.now();
    if (remaining > 0) await new Promise<void>((resolve) => setTimeout(resolve, remaining));
    if (generation !== undefined && generation !== this.scanGeneration)
      throw new Error('indexStopped');
    const [execution] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: readChatGPT,
      args: [request],
    });
    this.nextRequestAt = Date.now() + 500;
    const result = execution.result!;
    if ('error' in result)
      throw Object.assign(new Error(result.error), {
        status: result.status,
        conversationId: 'id' in request ? request.id : undefined,
      });
    return result as T;
  }

  async collect(tabId: number, id: string, sources: boolean) {
    const visited = new Set<string>();
    let next: string | undefined = id;
    let updated = 0;
    while (next && !visited.has(next)) {
      if (conversationId((await chrome.tabs.get(tabId)).url!) !== id) return;
      visited.add(next);
      const key: string = `conversation:${next}`;
      const saved = await chrome.storage.local.get<Record<string, Conversation>>(key);
      let conversation: Conversation = saved[key];
      if (next === id || !conversation) {
        if (updated === 10) return next;
        conversation = projectConversation(
          await this.read<ConversationData>(tabId, { kind: 'conversation', id: next }),
        );
        await chrome.storage.local.set({ [key]: conversation });
        updated++;
      }
      next = conversation.fork?.branchSource ?? undefined;
      if (!sources) return;
    }
  }

  async sync(tabId: number, manual = false) {
    if (this.pending.has(tabId)) return this.pending.get(tabId);
    const task = this.refresh(tabId, manual).finally(() => this.pending.delete(tabId));
    this.pending.set(tabId, task);
    return task;
  }

  async refresh(tabId: number, manual = false) {
    const tab = await chrome.tabs.get(tabId);
    const id = conversationId(tab.url!);
    const savedState = await chrome.storage.session.get<Record<string, TabState>>(`tab:${tabId}`);
    const previous = this.states.get(tabId) ?? savedState[`tab:${tabId}`];
    const changed = previous?.id !== id;
    if (changed && this.scan?.tabId === tabId) this.stopIndex();
    let remainingSource = changed ? undefined : previous?.remainingSource;
    this.states.set(tabId, { id, loading: true, error: null, remainingSource });
    await chrome.storage.session.set({ [`tab:${tabId}`]: this.states.get(tabId) });
    let draft: Conversation | null = null;
    try {
      if (id?.startsWith('local-chatgpt:')) {
        const [execution] = await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          func: readVisibleConversation,
          args: [id],
        });
        draft = execution.result!;
      } else if (id) {
        const remaining = await this.collect(tabId, id, manual || changed);
        if (manual || changed) remainingSource = remaining;
      }
      this.states.set(tabId, { id, loading: false, error: null, draft, remainingSource });
    } catch (error) {
      this.states.set(tabId, {
        id,
        loading: false,
        error: (error as Error).message,
        draft,
        remainingSource,
      });
    }
    const latest = await chrome.tabs.get(tabId);
    if (conversationId(latest.url!) !== id) {
      await this.refresh(tabId, manual);
      return;
    }
    await chrome.storage.session.set({ [`tab:${tabId}`]: this.states.get(tabId) });
  }

  async snapshot(tabId: number): Promise<Snapshot> {
    const tab = await chrome.tabs.get(tabId);
    const values = await chrome.storage.local.get<
      Record<string, Conversation> & { historyIndex?: IndexProgress }
    >(null);
    return {
      tabId,
      id: conversationId(tab.url!),
      state: this.states.get(tabId),
      index: values.historyIndex,
      indexing: this.scan?.generation === this.scanGeneration,
      conversations: [
        ...Object.entries(values)
          .filter(([key]) => key.startsWith('conversation:'))
          .map(([, value]) => value as Conversation),
        ...(this.states.get(tabId)?.draft ? [this.states.get(tabId)!.draft!] : []),
      ],
    };
  }

  stopIndex() {
    this.scanGeneration++;
  }

  async indexBatch(tabId: number) {
    if (this.scan?.generation === this.scanGeneration) return this.scan.task;
    const generation = ++this.scanGeneration;
    const id = conversationId((await chrome.tabs.get(tabId)).url!);
    const previous = this.scan?.task;
    const task = (previous ?? Promise.resolve()).then(() => this.runIndexBatch(tabId, generation));
    this.scan = { tabId, id, generation, task };
    return task.finally(() => {
      if (generation === this.scanGeneration) this.stopIndex();
    });
  }

  async runIndexBatch(tabId: number, generation: number) {
    const saved = await chrome.storage.local.get<{ historyIndex?: IndexProgress }>('historyIndex');
    const progress: IndexProgress =
      !saved.historyIndex?.done && saved.historyIndex
        ? saved.historyIndex
        : {
            offset: 0,
            ids: [],
            cursor: 0,
            completed: 0,
            total: 0,
            done: false,
          };
    delete progress.error;
    await chrome.storage.local.set({ historyIndex: progress });
    try {
      for (
        let count = 0;
        count < 5 && generation === this.scanGeneration && !progress.done;
        count++
      ) {
        await this.advanceIndex(tabId, progress, generation);
      }
    } catch (error) {
      if (generation === this.scanGeneration)
        progress.error =
          (error as { status?: number }).status === 429
            ? 'indexRateLimited'
            : (error as Error).message;
    }
    if (generation === this.scanGeneration) this.stopIndex();
    await chrome.storage.local.set({ historyIndex: progress });
    return progress;
  }

  async advanceIndex(tabId: number, progress: IndexProgress, generation: number) {
    const read = async <T extends PageResult>(request: PageRequest): Promise<T> => {
      const saved = await chrome.storage.local.get<{ scanInterval?: number }>('scanInterval');
      const remaining = this.lastIndexRequestAt + (saved.scanInterval ?? 4000) - Date.now();
      if (remaining > 0) await new Promise<void>((resolve) => setTimeout(resolve, remaining));
      const id = conversationId((await chrome.tabs.get(tabId)).url!);
      if (generation !== this.scanGeneration || id !== this.scan!.id)
        throw new Error('indexStopped');
      try {
        return await this.read<T>(tabId, request, generation);
      } finally {
        this.lastIndexRequestAt = Date.now();
      }
    };
    if (progress.cursor === progress.ids.length) {
      const page = await read<{ ids: string[]; total: number }>({
        kind: 'list',
        offset: progress.offset,
      });
      progress.ids = page.ids;
      progress.cursor = 0;
      progress.offset += page.ids.length;
      progress.total = page.total;
      if (!page.ids.length) progress.done = true;
      await chrome.storage.local.set({ historyIndex: progress });
    }
    if (!progress.done) {
      try {
        const id = progress.ids[progress.cursor];
        const conversation = projectConversation(
          await read<ConversationData>({ kind: 'conversation', id }),
        );
        await chrome.storage.local.set({ [`conversation:${id}`]: conversation });
      } catch (error) {
        const failure = error as Error & { status?: number; conversationId: string };
        if (failure.status !== 404) throw error;
        const key = `conversation:${failure.conversationId}`;
        const saved = await chrome.storage.local.get<Record<string, Conversation>>(key);
        const conversation = saved[key] ?? {
          id: failure.conversationId,
          title: '',
          titleKind: 'unavailable',
          nodes: [],
          activePath: [],
          fork: null,
        };
        await chrome.storage.local.set({ [key]: { ...conversation, unavailable: true } });
      }
      progress.cursor += 1;
      progress.completed += 1;
      progress.done = progress.cursor === progress.ids.length && progress.offset >= progress.total;
    }
    await chrome.storage.local.set({ historyIndex: progress });
    return progress;
  }

  async navigate(tabId: number, conversationUuid: string, messageId: string) {
    if (conversationUuid.startsWith('local-chatgpt:')) {
      const result = await chrome.tabs.sendMessage<
        { type: 'navigate'; plan: NavigationPlan },
        NavigationReply
      >(tabId, {
        type: 'navigate',
        plan: {
          kind: 'current',
          targetId: messageId,
          pathIds: this.states.get(tabId)!.draft!.activePath,
        },
      });
      if (result.error) throw new Error(result.error);
      return;
    }
    const saved = await chrome.storage.local.get<Record<string, Conversation>>(
      `conversation:${conversationUuid}`,
    );
    const conversation = saved[`conversation:${conversationUuid}`];
    if (conversation.unavailable) throw new Error('conversationUnavailable');
    const plan = navigationPlan(conversation, messageId);
    const tab = await chrome.tabs.get(tabId);
    await chrome.storage.session.set({
      [`navigation:${tabId}`]: { conversationId: conversationUuid, ...plan },
    });
    if (conversationId(tab.url!) !== conversationUuid) {
      await chrome.tabs.update(tabId, { url: `https://chatgpt.com/c/${conversationUuid}` });
    } else {
      const result = await chrome.tabs.sendMessage<
        { type: 'navigate'; plan: NavigationPlan },
        NavigationReply
      >(tabId, { type: 'navigate', plan });
      if (result.error) {
        await chrome.storage.session.remove(`navigation:${tabId}`);
        throw new Error(result.error);
      }
    }
  }

  async message(message: CoordinatorMessage, sender: chrome.runtime.MessageSender) {
    const tabId = (message.tabId ?? sender.tab?.id)!;
    switch (message.type) {
      case 'sync':
        await this.sync(tabId, message.manual);
        return this.snapshot(tabId);
      case 'snapshot':
        return this.snapshot(tabId);
      case 'indexBatch':
        return this.indexBatch(tabId);
      case 'indexStop':
        this.stopIndex();
        return {};
      case 'navigate':
        await this.navigate(tabId, message.conversationId, message.messageId);
        return { ok: true };
      case 'ready': {
        const key = `navigation:${tabId}`;
        const saved =
          await chrome.storage.session.get<
            Record<string, NavigationPlan & { conversationId: string }>
          >(key);
        const plan = saved[key];
        if (plan && plan.conversationId === conversationId(sender.tab!.url!)) return { plan };
        return {};
      }
      case 'navigated':
        await chrome.storage.session.remove(`navigation:${tabId}`);
        return {};
      case 'navigationError': {
        await chrome.storage.session.remove(`navigation:${tabId}`);
        const state = { ...this.states.get(tabId)!, error: message.error };
        this.states.set(tabId, state);
        await chrome.storage.session.set({ [`tab:${tabId}`]: state });
        return {};
      }
      default:
        throw new Error('unknownOperation');
    }
  }
}

const coordinator = new Coordinator();
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
chrome.runtime.onMessage.addListener((message: CoordinatorMessage, sender, respond) => {
  coordinator
    .message(message, sender)
    .then(respond, (error: Error) => respond({ error: error.message }));
  return true;
});
const changed = (details: { frameId: number; tabId: number }) => {
  if (details.frameId === 0) coordinator.sync(details.tabId);
};
chrome.webNavigation.onCompleted.addListener(changed, { url: [{ hostEquals: 'chatgpt.com' }] });
chrome.webNavigation.onHistoryStateUpdated.addListener(changed, {
  url: [{ hostEquals: 'chatgpt.com' }],
});
chrome.tabs.onRemoved.addListener((tabId) => coordinator.states.delete(tabId));
