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

  async read<T extends PageResult>(tabId: number, request: PageRequest): Promise<T> {
    const [execution] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: readChatGPT,
      args: [request],
    });
    const result = execution.result!;
    if ('error' in result)
      throw Object.assign(new Error(result.error), {
        status: result.status,
        conversationId: 'id' in request ? request.id : undefined,
      });
    return result as T;
  }

  async collect(
    tabId: number,
    id: string,
    visited = new Set<string>(),
    read = (request: PageRequest) => this.read<ConversationData>(tabId, request),
  ) {
    if (visited.has(id)) return;
    visited.add(id);
    const conversation = projectConversation(await read({ kind: 'conversation', id }));
    await chrome.storage.local.set({ [`conversation:${id}`]: conversation });
    if (conversation.fork)
      await this.collect(tabId, conversation.fork.branchSource!, visited, read);
  }

  async sync(tabId: number) {
    if (this.pending.has(tabId)) return this.pending.get(tabId);
    const task = this.refresh(tabId).finally(() => this.pending.delete(tabId));
    this.pending.set(tabId, task);
    return task;
  }

  async refresh(tabId: number) {
    const tab = await chrome.tabs.get(tabId);
    const id = conversationId(tab.url!);
    this.states.set(tabId, { id, loading: true, error: null });
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
        await this.collect(tabId, id);
      }
      const latest = await chrome.tabs.get(tabId);
      if (conversationId(latest.url!) !== id) {
        await this.refresh(tabId);
        return;
      }
      this.states.set(tabId, { id, loading: false, error: null, draft });
    } catch (error) {
      this.states.set(tabId, { id, loading: false, error: (error as Error).message, draft });
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
      conversations: [
        ...Object.entries(values)
          .filter(([key]) => key.startsWith('conversation:'))
          .map(([, value]) => value as Conversation),
        ...(this.states.get(tabId)?.draft ? [this.states.get(tabId)!.draft!] : []),
      ],
    };
  }

  async indexStep(tabId: number) {
    const saved = await chrome.storage.local.get<{ historyIndex?: IndexProgress }>('historyIndex');
    const progress = saved.historyIndex ?? {
      offset: 0,
      ids: [],
      cursor: 0,
      completed: 0,
      total: 0,
      done: false,
    };
    if (progress.done) return progress;
    try {
      return await this.advanceIndex(tabId, progress);
    } catch (error) {
      if ((error as { status?: number }).status !== 429) throw error;
      return progress;
    }
  }

  async advanceIndex(tabId: number, progress: IndexProgress) {
    const read = async <T extends PageResult>(request: PageRequest): Promise<T> => {
      const remaining = (progress.nextRequestAt ?? 0) - Date.now();
      if (remaining > 0) await new Promise<void>((resolve) => setTimeout(resolve, remaining));
      try {
        return await this.read<T>(tabId, request);
      } catch (error) {
        if ((error as { status?: number }).status === 429) {
          progress.requestInterval = (progress.requestInterval ?? 500) * 2;
        }
        throw error;
      } finally {
        progress.nextRequestAt = Date.now() + (progress.requestInterval ?? 500);
        await chrome.storage.local.set({ historyIndex: progress });
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
    }
    if (!progress.done) {
      try {
        await this.collect(tabId, progress.ids[progress.cursor], new Set(), read<ConversationData>);
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
        await this.sync(tabId);
        return this.snapshot(tabId);
      case 'snapshot':
        return this.snapshot(tabId);
      case 'indexStep':
        return this.indexStep(tabId);
      case 'indexReset':
        await chrome.storage.local.remove('historyIndex');
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
