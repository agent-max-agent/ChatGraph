import { conversationId, projectConversation, navigationPlan } from './model.js';
import { readChatGPT } from './page-api.js';
import { readVisibleConversation } from './page-state.js';

class Coordinator {
  states = new Map();
  pending = new Map();

  async read(tabId, request) {
    const [execution] = await chrome.scripting.executeScript({
      target: { tabId }, world: 'MAIN', func: readChatGPT, args: [request],
    });
    if (execution.error) throw new Error(execution.error.message);
    if (execution.result.error) throw Object.assign(new Error(execution.result.error), { status: execution.result.status, conversationId: request.id });
    return execution.result;
  }

  async collect(tabId, id, visited = new Set()) {
    if (visited.has(id)) return;
    visited.add(id);
    const conversation = projectConversation(await this.read(tabId, { kind: 'conversation', id }));
    await chrome.storage.local.set({ [`conversation:${id}`]: conversation });
    if (conversation.fork) await this.collect(tabId, conversation.fork.branchSource, visited);
  }

  async sync(tabId) {
    if (this.pending.has(tabId)) return this.pending.get(tabId);
    const task = this.refresh(tabId).finally(() => this.pending.delete(tabId));
    this.pending.set(tabId, task);
    return task;
  }

  async refresh(tabId) {
    const tab = await chrome.tabs.get(tabId);
    const id = conversationId(tab.url);
    this.states.set(tabId, { id, loading: true, error: null });
    let draft = null;
    try {
      if (id?.startsWith('local-chatgpt:')) {
        const [execution] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: readVisibleConversation, args: [id] });
        draft = execution.result;
      } else if (id) {
        await this.collect(tabId, id);
      }
      const latest = await chrome.tabs.get(tabId);
      if (conversationId(latest.url) !== id) {
        await this.refresh(tabId);
        return;
      }
      this.states.set(tabId, { id, loading: false, error: null, draft });
    } catch (error) {
      this.states.set(tabId, { id, loading: false, error: error.message, draft });
    }
    await chrome.storage.session.set({ [`tab:${tabId}`]: this.states.get(tabId) });
  }

  async snapshot(tabId) {
    const tab = await chrome.tabs.get(tabId);
    const values = await chrome.storage.local.get(null);
    return {
      tabId,
      id: conversationId(tab.url),
      state: this.states.get(tabId),
      index: values.historyIndex,
      conversations: [
        ...Object.entries(values).filter(([key]) => key.startsWith('conversation:')).map(([, value]) => value),
        ...(this.states.get(tabId)?.draft ? [this.states.get(tabId).draft] : []),
      ],
    };
  }

  async indexStep(tabId) {
    const saved = await chrome.storage.local.get('historyIndex');
    const progress = saved.historyIndex ?? { offset: 0, ids: [], cursor: 0, completed: 0, total: 0, done: false };
    if (progress.done) return progress;
    if (progress.cursor === progress.ids.length) {
      const page = await this.read(tabId, { kind: 'list', offset: progress.offset });
      progress.ids = page.ids;
      progress.cursor = 0;
      progress.offset += page.ids.length;
      progress.total = page.total;
      if (!page.ids.length) progress.done = true;
    }
    if (!progress.done) {
      try {
        await this.collect(tabId, progress.ids[progress.cursor]);
      } catch (error) {
        if (error.status !== 404) throw error;
        const key = `conversation:${error.conversationId}`;
        const saved = await chrome.storage.local.get(key);
        const conversation = saved[key] ?? { id: error.conversationId, title: '不可访问的对话', nodes: [], activePath: [], fork: null };
        await chrome.storage.local.set({ [key]: { ...conversation, unavailable: true } });
      }
      progress.cursor += 1;
      progress.completed += 1;
      progress.done = progress.cursor === progress.ids.length && progress.offset >= progress.total;
    }
    await chrome.storage.local.set({ historyIndex: progress });
    return progress;
  }

  async navigate(tabId, conversationUuid, messageId) {
    if (conversationUuid.startsWith('local-chatgpt:')) {
      const result = await chrome.tabs.sendMessage(tabId, { type: 'navigate', plan: { kind: 'current', targetId: messageId, pathIds: this.states.get(tabId).draft.activePath } });
      if (result.error) throw new Error(result.error);
      return;
    }
    const saved = await chrome.storage.local.get(`conversation:${conversationUuid}`);
    const conversation = saved[`conversation:${conversationUuid}`];
    if (conversation.unavailable) throw new Error('此对话已删除或不可访问。');
    const plan = navigationPlan(conversation, messageId);
    const tab = await chrome.tabs.get(tabId);
    await chrome.storage.session.set({ [`navigation:${tabId}`]: { conversationId: conversationUuid, ...plan } });
    if (conversationId(tab.url) !== conversationUuid) {
      await chrome.tabs.update(tabId, { url: `https://chatgpt.com/c/${conversationUuid}` });
    } else {
      const result = await chrome.tabs.sendMessage(tabId, { type: 'navigate', plan });
      if (result.error) {
        await chrome.storage.session.remove(`navigation:${tabId}`);
        throw new Error(result.error);
      }
    }
  }

  async message(message, sender) {
    const tabId = message.tabId ?? sender.tab?.id;
    switch (message.type) {
      case 'sync': await this.sync(tabId); return this.snapshot(tabId);
      case 'snapshot': return this.snapshot(tabId);
      case 'indexStep': return this.indexStep(tabId);
      case 'indexReset': await chrome.storage.local.remove('historyIndex'); return {};
      case 'navigate': await this.navigate(tabId, message.conversationId, message.messageId); return { ok: true };
      case 'ready': {
        const key = `navigation:${tabId}`;
        const saved = await chrome.storage.session.get(key);
        const plan = saved[key];
        if (plan && plan.conversationId === conversationId(sender.tab.url)) return { plan };
        return {};
      }
      case 'navigated': await chrome.storage.session.remove(`navigation:${tabId}`); return {};
      case 'navigationError': {
        await chrome.storage.session.remove(`navigation:${tabId}`);
        const state = { ...this.states.get(tabId), error: message.error };
        this.states.set(tabId, state);
        await chrome.storage.session.set({ [`tab:${tabId}`]: state });
        return {};
      }
      default: throw new Error('未知操作。');
    }
  }
}

const coordinator = new Coordinator();
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  coordinator.message(message, sender).then(respond, error => respond({ error: error.message }));
  return true;
});
const changed = details => {
  if (details.frameId === 0) coordinator.sync(details.tabId);
};
chrome.webNavigation.onCompleted.addListener(changed, { url: [{ hostEquals: 'chatgpt.com' }] });
chrome.webNavigation.onHistoryStateUpdated.addListener(changed, { url: [{ hostEquals: 'chatgpt.com' }] });
chrome.tabs.onRemoved.addListener(tabId => coordinator.states.delete(tabId));
