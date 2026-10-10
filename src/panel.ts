import type { CoordinatorMessage, Graph, GraphNode, IndexProgress, Layout, Snapshot } from './types.js';

import { buildGraph, layoutGraph } from './model.js';
import { createTranslator, resolveLanguage, translatedError } from './i18n.js';
import type { LanguagePreference, MessageKey } from './i18n.js';

class Panel {
  t = createTranslator(resolveLanguage('auto', chrome.i18n.getUILanguage()));
  tabId!: number;
  scale = 1;
  graph!: Graph;
  layout!: Layout;
  renderedState?: string;
  indexing = false;
  loadGeneration = 0;
  selectedNode?: GraphNode;

  title(text: string, kind?: Graph['titleKind']) {
    if (kind === 'unavailable') return this.t('unavailableTitle');
    if (kind === 'draft') return text ? this.t('draftTitle', [text]) : this.t('draftUntitled');
    return text;
  }

  async language() {
    const saved = await chrome.storage.local.get<{ language?: LanguagePreference }>('language');
    const preference = saved.language ?? 'auto';
    const language = resolveLanguage(preference, chrome.i18n.getUILanguage());
    this.t = createTranslator(language);
    document.documentElement.lang = language === 'zh_CN' ? 'zh-CN' : 'en';
    document.querySelector<HTMLSelectElement>('#language')!.value = preference;
    for (const element of document.querySelectorAll<HTMLElement>('[data-i18n]')) {
      element.textContent = this.t(element.dataset.i18n as MessageKey);
    }
    for (const element of document.querySelectorAll<HTMLElement>('[data-i18n-aria]')) {
      element.setAttribute('aria-label', this.t(element.dataset.i18nAria as MessageKey));
    }
    if (this.graph) this.render();
    if (this.selectedNode) {
      document.querySelector<HTMLElement>('#details')!.textContent = `${this.title(this.selectedNode.conversationTitle, this.selectedNode.titleKind)}\n\n${this.selectedNode.text}`;
    }
    await this.load();
  }

  async request<T = Snapshot>(message: CoordinatorMessage): Promise<T> {
    const result = await chrome.runtime.sendMessage<CoordinatorMessage, T & { error?: string }>({ ...message, tabId: message.tabId ?? this.tabId });
    if (result.error) throw new Error(result.error);
    return result;
  }

  async load(refresh = false) {
    const generation = ++this.loadGeneration;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url?.startsWith('https://chatgpt.com/')) {
      document.querySelector<HTMLElement>('#status')!.textContent = this.t('openChat');
      return;
    }
    const result = await this.request({ type: 'snapshot', tabId: tab.id });
    if (generation !== this.loadGeneration) return;
    this.tabId = tab.id!;
    this.indexStatus(result.index);
    const fingerprint = JSON.stringify([result.tabId, result.id, result.conversations]);
    const changed = fingerprint !== this.renderedState;
    this.renderedState = fingerprint;
    this.graph = buildGraph(result.conversations, result.id);
    document.querySelector<HTMLElement>('#title')!.textContent = this.title(this.graph.title, this.graph.titleKind) || this.t('branches');
    document.querySelector<HTMLElement>('#status')!.textContent = translatedError(result.state?.error ?? '', this.t)
      || (result.id?.startsWith('local-chatgpt:') ? this.t('draftStatus')
        : this.t('counts', [String(this.graph.conversationCount), String(this.graph.nodes.filter(node => node.role !== 'root').length)]) + (result.state?.loading ? this.t('syncing') : ''));
    if (changed) {
      this.layout = layoutGraph(this.graph);
      this.scale = Math.min(1, document.querySelector<HTMLElement>('#viewport')!.clientWidth / this.layout.width);
      this.render();
    }
    if (refresh) {
      await this.request({ type: 'sync', tabId: tab.id });
      if (generation === this.loadGeneration) await this.load();
    }
  }

  render() {
    this.layout = layoutGraph(this.graph);
    const canvas = document.querySelector<HTMLElement>('#canvas')!;
    canvas.style.width = `${this.layout.width}px`;
    canvas.style.height = `${this.layout.height}px`;
    canvas.style.transform = `scale(${this.scale})`;
    document.querySelector<HTMLElement>('#stage')!.style.width = `${this.layout.width * this.scale}px`;
    document.querySelector<HTMLElement>('#stage')!.style.height = `${this.layout.height * this.scale}px`;
    const svg = document.querySelector<SVGSVGElement>('#edges')!;
    svg.setAttribute('width', String(this.layout.width));
    svg.setAttribute('height', String(this.layout.height));
    svg.replaceChildren();
    for (const edge of this.graph.edges) {
      const from = this.layout.positions.get(edge.from)!;
      const to = this.layout.positions.get(edge.to)!;
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', `M${from.x + 56},${from.y + 80} C${from.x + 56},${from.y + 94} ${to.x + 56},${to.y - 14} ${to.x + 56},${to.y}`);
      path.setAttribute('stroke', edge.kind === 'fork' ? '#93c5fd' : '#749985');
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke-width', '2');
      if (edge.kind === 'fork') path.setAttribute('stroke-dasharray', '5 4');
      svg.append(path);
    }
    const container = document.querySelector<HTMLElement>('#nodes')!;
    const tabId = this.tabId;
    container.replaceChildren();
    for (const node of this.graph.nodes) {
      const button = document.createElement('button');
      button.className = `node${node.active ? ' active' : ''}`;
      if (node.key === this.selectedNode?.key) button.classList.add('selected');
      if (node.unavailable) button.classList.add('unavailable');
      if (node.role === 'root') button.classList.add('root');
      button.title = node.role === 'root' ? this.t('rootHint') : `${this.title(node.conversationTitle, node.titleKind)}${node.unavailable ? ` · ${this.t('unavailable')}` : ''}\n${node.text}`;
      const position = this.layout.positions.get(node.key)!;
      button.style.left = `${position.x}px`;
      button.style.top = `${position.y}px`;
      const summary = node.text.replace(/\*\*|<[^>]+>/g, '').replace(/\s+/g, ' ');
      for (const [tag, text] of [['strong', node.role === 'root' ? this.t('root') : node.role === 'user' ? this.t('you') : 'ChatGPT'], ['span', node.role === 'root' ? this.t('rootSummary') : summary || this.t('attachment')]]) {
        const element = document.createElement(tag);
        element!.textContent = text;
        button.append(element);
      }
      if (node.role !== 'root') button.addEventListener('click', () => this.select(node, button, tabId).catch((error: Error) => this.error(error)));
      container.append(button);
    }
  }

  async select(node: GraphNode, button: HTMLButtonElement, tabId: number) {
    this.selectedNode = node;
    document.querySelector<HTMLElement>('.selected')?.classList.remove('selected');
    button.classList.add('selected');
    document.querySelector<HTMLElement>('#details')!.textContent = `${this.title(node.conversationTitle, node.titleKind)}\n\n${node.text}`;
    await this.request({ type: 'navigate', tabId, conversationId: node.navigationConversationId!, messageId: node.id! });
  }

  indexStatus(progress?: IndexProgress) {
    document.querySelector<HTMLElement>('#index-status')!.textContent = progress
      ? this.t('indexProgress', [String(progress.completed), String(progress.total)]) + this.t(progress.done ? 'indexDone' : this.indexing ? 'indexRunning' : 'indexPaused')
      : this.t('indexHint');
    document.querySelector<HTMLElement>('#index')!.textContent = this.t(this.indexing ? 'indexPause' : progress?.done ? 'indexRestart' : 'indexStart');
  }

  async index() {
    if (this.indexing) {
      this.indexing = false;
      this.indexStatus((await this.request({ type: 'snapshot' })).index);
      return;
    }
    const saved = await this.request({ type: 'snapshot' });
    if (saved.index?.done) await this.request({ type: 'indexReset' });
    this.indexing = true;
    try {
      while (this.indexing) {
        const progress = await this.request<IndexProgress>({ type: 'indexStep' });
        if (progress.done) this.indexing = false;
        this.indexStatus(progress);
      }
    } catch (error) {
      this.indexing = false;
      document.querySelector<HTMLElement>('#index')!.textContent = this.t('indexResume');
      document.querySelector<HTMLElement>('#index-status')!.textContent = this.t('indexError', [translatedError((error as Error).message, this.t)]);
    }
  }

  zoom(value: number) {
    this.scale = value;
    this.render();
  }

  error(error: Error) { document.querySelector<HTMLElement>('#status')!.textContent = translatedError(error.message, this.t); }
}

const panel = new Panel();
function enablePanning() {
  const viewport = document.querySelector<HTMLElement>('#viewport')!;
  let origin: { x: number; y: number; left: number; top: number } | null;
  viewport.addEventListener('pointerdown', event => {
    if (event.button !== 0 || (event.target as Element).closest('.node')) return;
    origin = { x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop };
    viewport.setPointerCapture(event.pointerId);
    viewport.classList.add('panning');
  });
  viewport.addEventListener('pointermove', event => {
    if (!origin) return;
    viewport.scrollLeft = origin.left + origin.x - event.clientX;
    viewport.scrollTop = origin.top + origin.y - event.clientY;
  });
  viewport.addEventListener('lostpointercapture', () => {
    origin = null;
    viewport.classList.remove('panning');
  });
}
enablePanning();
document.querySelector<HTMLElement>('#refresh')!.addEventListener('click', () => panel.load(true).catch((error: Error) => panel.error(error)));
document.querySelector<HTMLElement>('#index')!.addEventListener('click', () => panel.index().catch((error: Error) => panel.error(error)));
document.querySelector<HTMLElement>('#in')!.addEventListener('click', () => panel.zoom(Math.min(2, panel.scale + 0.15)));
document.querySelector<HTMLElement>('#out')!.addEventListener('click', () => panel.zoom(Math.max(0.3, panel.scale - 0.15)));
document.querySelector<HTMLElement>('#fit')!.addEventListener('click', () => panel.zoom(Math.min(1, document.querySelector<HTMLElement>('#viewport')!.clientWidth / panel.layout.width)));
chrome.storage.onChanged.addListener(changes => {
  if (changes.language) panel.language().catch((error: Error) => panel.error(error));
  if (Object.keys(changes).some(key => key.startsWith('conversation:') || key === 'historyIndex' || key === `tab:${panel.tabId}`)) {
    panel.load().catch((error: Error) => panel.error(error));
  }
});
chrome.tabs.onActivated.addListener(() => panel.load(true).catch((error: Error) => panel.error(error)));
document.querySelector<HTMLSelectElement>('#language')!.addEventListener('change', event => {
  const language = (event.target as HTMLSelectElement).value as LanguagePreference;
  chrome.storage.local.set({ language });
});
panel.language().then(() => panel.load(true)).catch((error: Error) => panel.error(error));
