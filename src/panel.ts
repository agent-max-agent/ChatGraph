import type {
  CoordinatorMessage,
  Graph,
  GraphNode,
  IndexProgress,
  Layout,
  Snapshot,
} from './types.js';

import { buildGraph, layoutGraph } from './model.js';
import { createTranslator, resolveLanguage, translatedError } from './i18n.js';
import type { LanguagePreference, MessageKey } from './i18n.js';

class Panel {
  // Panel state.
  t = createTranslator(resolveLanguage('auto', chrome.i18n.getUILanguage()));
  tabId!: number;
  scale = 1;
  graph!: Graph;
  layout!: Layout;
  renderedState?: string;
  indexing = false;
  loadGeneration = 0;
  selectedNode?: GraphNode;
  conversationContext?: string;
  showScanProgress = false;
  syncing = false;

  // Language and UI text.
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
    for (const element of document.querySelectorAll<HTMLElement>('[data-i18n]')) {
      element.textContent = this.t(element.dataset.i18n as MessageKey);
    }
    for (const element of document.querySelectorAll<HTMLElement>('[data-i18n-aria]')) {
      element.setAttribute('aria-label', this.t(element.dataset.i18nAria as MessageKey));
    }
    if (this.graph) this.render();
    if (this.selectedNode) {
      document.querySelector<HTMLElement>('#details')!.textContent =
        `${this.title(this.selectedNode.conversationTitle, this.selectedNode.titleKind)}\n\n${this.selectedNode.text}`;
    }
    await this.load();
  }

  // Background communication and snapshot synchronization.
  async request<T = Snapshot>(message: CoordinatorMessage): Promise<T> {
    const result = await chrome.runtime.sendMessage<CoordinatorMessage, T & { error?: string }>({
      ...message,
      tabId: message.tabId ?? this.tabId,
    });
    if (result.error) throw new Error(result.error);
    return result;
  }

  async load(refresh = false) {
    const generation = ++this.loadGeneration;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url?.startsWith('https://chatgpt.com/')) {
      this.conversationContext = undefined;
      this.showScanProgress = false;
      this.syncing = false;
      this.scanStatus('');
      document.querySelector<HTMLElement>('#status')!.textContent = this.t('openChat');
      return;
    }
    const result = await this.request({ type: 'snapshot', tabId: tab.id });
    if (generation !== this.loadGeneration) return;
    this.tabId = tab.id!;
    const context = `${result.tabId}:${result.id ?? ''}`;
    const contextChanged = context !== this.conversationContext;
    if (contextChanged) {
      this.conversationContext = context;
      this.showScanProgress = false;
    }
    this.syncing = result.state?.id === result.id && result.state?.loading === true;
    this.indexStatus(result.index);
    const fingerprint = JSON.stringify([result.tabId, result.id, result.conversations]);
    const changed = fingerprint !== this.renderedState;
    this.renderedState = fingerprint;
    const fitView = contextChanged || !this.graph?.nodes.length;
    this.graph = buildGraph(result.conversations, result.id);
    document.querySelector<HTMLElement>('#title')!.textContent =
      this.title(this.graph.title, this.graph.titleKind) || this.t('branches');
    document.querySelector<HTMLElement>('#status')!.textContent =
      translatedError(result.state?.error ?? '', this.t) ||
      (result.id?.startsWith('local-chatgpt:')
        ? this.t('draftStatus')
        : this.t('counts', [
            String(this.graph.conversationCount),
            String(this.graph.nodes.filter((node) => node.role !== 'root').length),
          ]));
    if (changed) {
      this.layout = layoutGraph(this.graph);
      if (fitView) this.fit();
      else this.render();
    }
    if (refresh) {
      await this.request({ type: 'sync', tabId: tab.id });
      if (generation === this.loadGeneration) await this.load();
    }
  }

  error(error: Error) {
    document.querySelector<HTMLElement>('#status')!.textContent = translatedError(
      error.message,
      this.t,
    );
  }

  // Graph rendering, selection, and navigation.
  render() {
    const viewport = document.querySelector<HTMLElement>('#viewport')!;
    const { scrollTop } = viewport;
    const margin = viewport.clientWidth / 2;
    const canvas = document.querySelector<HTMLElement>('#canvas')!;
    const scrollLeft = viewport.scrollLeft + margin - parseFloat(canvas.style.left || '0');
    this.layout = layoutGraph(this.graph);
    canvas.style.left = `${margin}px`;
    canvas.style.width = `${this.layout.width}px`;
    canvas.style.height = `${this.layout.height}px`;
    canvas.style.transform = `scale(${this.scale})`;
    document.querySelector<HTMLElement>('#stage')!.style.width =
      `${this.layout.width * this.scale + margin * 2}px`;
    document.querySelector<HTMLElement>('#stage')!.style.height =
      `${this.layout.height * this.scale}px`;
    const svg = document.querySelector<SVGSVGElement>('#edges')!;
    svg.setAttribute('width', String(this.layout.width));
    svg.setAttribute('height', String(this.layout.height));
    svg.replaceChildren();
    for (const edge of this.graph.edges) {
      const from = this.layout.positions.get(edge.from)!;
      const to = this.layout.positions.get(edge.to)!;
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute(
        'd',
        `M${from.x + 56},${from.y + 80} C${from.x + 56},${from.y + 94} ${to.x + 56},${to.y - 14} ${to.x + 56},${to.y}`,
      );
      path.setAttribute('stroke', edge.kind === 'fork' ? 'var(--fork-edge)' : 'var(--edge)');
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
      button.title =
        node.role === 'root'
          ? this.t('rootHint')
          : `${this.title(node.conversationTitle, node.titleKind)}${node.unavailable ? ` · ${this.t('unavailable')}` : ''}\n${node.text}`;
      const position = this.layout.positions.get(node.key)!;
      button.style.left = `${position.x}px`;
      button.style.top = `${position.y}px`;
      const summary = node.text
        .replace(/\*\*|<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      for (const [tag, text] of [
        [
          'strong',
          node.role === 'root' ? this.t('root') : node.role === 'user' ? this.t('you') : 'ChatGPT',
        ],
        [
          'span',
          node.role === 'root'
            ? this.t('rootSummary')
            : summary || this.t(node.hasAttachments ? 'attachment' : 'messageContentUnavailable'),
        ],
      ]) {
        const element = document.createElement(tag);
        element!.textContent = text;
        button.append(element);
      }
      if (node.role !== 'root')
        button.addEventListener('click', () =>
          this.select(node, button, tabId).catch((error: Error) => this.error(error)),
        );
      container.append(button);
    }
    viewport.scrollTo(scrollLeft, scrollTop);
  }

  async select(node: GraphNode, button: HTMLButtonElement, tabId: number) {
    this.selectedNode = node;
    document.querySelector<HTMLElement>('.selected')?.classList.remove('selected');
    button.classList.add('selected');
    document.querySelector<HTMLElement>('#details')!.textContent =
      `${this.title(node.conversationTitle, node.titleKind)}\n\n${node.text}`;
    await this.request({
      type: 'navigate',
      tabId,
      conversationId: node.navigationConversationId!,
      messageId: node.id!,
    });
  }

  zoom(value: number, anchor?: { x: number; y: number }) {
    const canvas = document.querySelector<HTMLElement>('#canvas')!;
    const before = canvas.getBoundingClientRect();
    const point = anchor && {
      x: (anchor.x - before.left) / this.scale,
      y: (anchor.y - before.top) / this.scale,
    };
    this.scale = value;
    this.render();
    if (anchor && point) {
      const after = canvas.getBoundingClientRect();
      document
        .querySelector<HTMLElement>('#viewport')!
        .scrollBy(after.left + point.x * value - anchor.x, after.top + point.y * value - anchor.y);
    }
  }

  fit() {
    const viewport = document.querySelector<HTMLElement>('#viewport')!;
    this.zoom(Math.min(1, viewport.clientWidth / this.layout.width));
    viewport.scrollLeft = parseFloat(document.querySelector<HTMLElement>('#canvas')!.style.left);
  }

  // History scanning and progress display.
  indexStatus(progress?: IndexProgress) {
    if (this.syncing) {
      this.scanStatus(this.t('syncing'));
    } else if (progress && (this.showScanProgress || this.indexing || !progress.done)) {
      const counts = [String(progress.completed), String(progress.total)];
      const state = this.t(
        progress.done ? 'indexDone' : this.indexing ? 'indexRunning' : 'indexPaused',
      );
      this.scanStatus(
        this.t('indexProgressCompact', counts) + state,
        this.t('indexProgress', counts) + state,
      );
    } else {
      this.scanStatus('');
    }
    document.querySelector<HTMLElement>('#index')!.textContent = this.t(
      this.indexing ? 'indexPause' : progress?.done ? 'indexRestart' : 'indexStart',
    );
  }

  scanStatus(text: string, description = text) {
    const status = document.querySelector<HTMLElement>('#index-status')!;
    status.textContent = text;
    status.title = description;
    status.setAttribute('aria-label', description);
  }

  async index() {
    if (this.indexing) {
      this.indexing = false;
      this.indexStatus((await this.request({ type: 'snapshot' })).index);
      return;
    }
    const saved = await this.request({ type: 'snapshot' });
    if (saved.index?.done) await this.request({ type: 'indexReset' });
    this.showScanProgress = true;
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
      this.scanStatus(this.t('indexError', [translatedError((error as Error).message, this.t)]));
    }
  }
}

// Drag the graph without changing its layout.
function enablePanning() {
  const viewport = document.querySelector<HTMLElement>('#viewport')!;
  let origin: { x: number; y: number; left: number; top: number } | null;
  viewport.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || (event.target as Element).closest('.node')) return;
    event.preventDefault();
    origin = {
      x: event.clientX,
      y: event.clientY,
      left: viewport.scrollLeft,
      top: viewport.scrollTop,
    };
    viewport.setPointerCapture(event.pointerId);
    viewport.classList.add('panning');
  });
  viewport.addEventListener('pointermove', (event) => {
    if (!origin) return;
    viewport.scrollLeft = origin.left + origin.x - event.clientX;
    viewport.scrollTop = origin.top + origin.y - event.clientY;
  });
  viewport.addEventListener('lostpointercapture', () => {
    origin = null;
    viewport.classList.remove('panning');
  });
}
// Resize, collapse, and reopen the floating preview.
function enablePreviewResize() {
  const workspace = document.querySelector<HTMLElement>('#workspace')!;
  const preview = document.querySelector<HTMLElement>('#preview')!;
  const resizer = document.querySelector<HTMLElement>('#preview-resizer')!;
  const opener = document.querySelector<HTMLButtonElement>('#preview-open')!;
  const closer = document.querySelector<HTMLButtonElement>('#preview-close')!;
  let expandedHeight = 180;
  let origin: { y: number; height: number } | null = null;

  function resize(height: number) {
    const maximum = workspace.clientHeight;
    const value = height < 48 ? 0 : Math.round(Math.min(height, maximum));
    if (value > 0) expandedHeight = value;
    workspace.style.setProperty('--preview-height', `${value}px`);
    preview.hidden = value === 0;
    opener.hidden = value !== 0;
    resizer.setAttribute('aria-valuemin', '0');
    resizer.setAttribute('aria-valuemax', String(maximum));
    resizer.setAttribute('aria-valuenow', String(value));
    if (value === 0 && preview.contains(document.activeElement)) opener.focus();
  }

  closer.addEventListener('click', () => resize(0));
  opener.addEventListener('click', () => {
    resize(expandedHeight);
    resizer.focus();
  });
  resizer.addEventListener('dblclick', () => resize(0));

  resizer.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    origin = { y: event.clientY, height: preview.getBoundingClientRect().height };
    resizer.setPointerCapture(event.pointerId);
  });
  resizer.addEventListener('pointermove', (event) => {
    if (origin) resize(origin.height + origin.y - event.clientY);
  });
  resizer.addEventListener('lostpointercapture', () => {
    origin = null;
  });
  resizer.addEventListener('keydown', (event) => {
    const height = preview.getBoundingClientRect().height;
    switch (event.key) {
      case 'ArrowUp':
        resize(height + 24);
        break;
      case 'ArrowDown':
        resize(height - 24);
        break;
      case 'Home':
        resize(0);
        break;
      case 'End':
        resize(workspace.clientHeight);
        break;
      default:
        return;
    }
    event.preventDefault();
  });
  new ResizeObserver(() => resize(preview.getBoundingClientRect().height)).observe(workspace);
}

// Bind controls and browser events, then load the initial view.
const panel = new Panel();
enablePanning();
enablePreviewResize();
document.querySelector<HTMLElement>('#viewport')!.addEventListener(
  'wheel',
  (event) => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1;
    panel.zoom(Math.max(0.3, Math.min(2, panel.scale * Math.exp(-event.deltaY * unit * 0.002))), {
      x: event.clientX,
      y: event.clientY,
    });
  },
  { passive: false },
);
document
  .querySelector<HTMLElement>('#refresh')!
  .addEventListener('click', () => panel.load(true).catch((error: Error) => panel.error(error)));
document
  .querySelector<HTMLElement>('#index')!
  .addEventListener('click', () => panel.index().catch((error: Error) => panel.error(error)));
document
  .querySelector<HTMLElement>('#in')!
  .addEventListener('click', () => panel.zoom(Math.min(2, panel.scale + 0.15)));
document
  .querySelector<HTMLElement>('#out')!
  .addEventListener('click', () => panel.zoom(Math.max(0.3, panel.scale - 0.15)));
document.querySelector<HTMLElement>('#fit')!.addEventListener('click', () => panel.fit());
chrome.storage.onChanged.addListener((changes) => {
  if (changes.language) panel.language().catch((error: Error) => panel.error(error));
  if (
    Object.keys(changes).some(
      (key) =>
        key.startsWith('conversation:') || key === 'historyIndex' || key === `tab:${panel.tabId}`,
    )
  ) {
    panel.load().catch((error: Error) => panel.error(error));
  }
});
chrome.tabs.onActivated.addListener(() =>
  panel.load(true).catch((error: Error) => panel.error(error)),
);
chrome.tabs.onUpdated.addListener((tabId, changes) => {
  if (tabId === panel.tabId && changes.url) {
    panel.load().catch((error: Error) => panel.error(error));
  }
});
panel
  .language()
  .then(() => panel.load(true))
  .catch((error: Error) => panel.error(error));
