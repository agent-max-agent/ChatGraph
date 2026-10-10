import type { CoordinatorMessage, Graph, GraphNode, IndexProgress, Layout, Snapshot } from './types.js';

import { buildGraph, layoutGraph } from './model.js';

class Panel {
  tabId!: number;
  scale = 1;
  graph!: Graph;
  layout!: Layout;
  renderedState?: string;
  indexing = false;
  loadGeneration = 0;

  async request<T = Snapshot>(message: CoordinatorMessage): Promise<T> {
    const result = await chrome.runtime.sendMessage<CoordinatorMessage, T & { error?: string }>({ ...message, tabId: message.tabId ?? this.tabId });
    if (result.error) throw new Error(result.error);
    return result;
  }

  async load(refresh = false) {
    const generation = ++this.loadGeneration;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url?.startsWith('https://chatgpt.com/')) {
      document.querySelector<HTMLElement>('#status')!.textContent = '请打开 ChatGPT 对话。';
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
    document.querySelector<HTMLElement>('#title')!.textContent = this.graph.title || '对话分支';
    document.querySelector<HTMLElement>('#status')!.textContent = result.state?.error
      || (result.id?.startsWith('local-chatgpt:') ? '新分支尚未保存；发送消息后会自动记录正式对话。'
        : `${this.graph.conversationCount} 个对话 · ${this.graph.nodes.filter(node => node.role !== 'root').length} 条消息${result.state?.loading ? ' · 正在同步' : ''}`);
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
      if (node.unavailable) button.classList.add('unavailable');
      if (node.role === 'root') button.classList.add('root');
      button.title = node.role === 'root' ? '不同首轮版本从这里展开' : `${node.conversationTitle}${node.unavailable ? ' · 不可访问' : ''}\n${node.text}`;
      const position = this.layout.positions.get(node.key)!;
      button.style.left = `${position.x}px`;
      button.style.top = `${position.y}px`;
      const summary = node.text.replace(/\*\*|<[^>]+>/g, '').replace(/\s+/g, ' ');
      for (const [tag, text] of [['strong', node.role === 'root' ? '对话开始' : node.role === 'user' ? '你' : 'ChatGPT'], ['span', node.role === 'root' ? '首轮版本与后续分支' : summary || '附件消息']]) {
        const element = document.createElement(tag);
        element!.textContent = text;
        button.append(element);
      }
      if (node.role !== 'root') button.addEventListener('click', () => this.select(node, button, tabId).catch(error => this.error(error)));
      container.append(button);
    }
  }

  async select(node: GraphNode, button: HTMLButtonElement, tabId: number) {
    document.querySelector<HTMLElement>('.selected')?.classList.remove('selected');
    button.classList.add('selected');
    document.querySelector<HTMLElement>('#details')!.textContent = `${node.conversationTitle}\n\n${node.text}`;
    await this.request({ type: 'navigate', tabId, conversationId: node.navigationConversationId!, messageId: node.id! });
  }

  indexStatus(progress?: IndexProgress) {
    document.querySelector<HTMLElement>('#index-status')!.textContent = progress
      ? `历史补录 ${progress.completed}/${progress.total}${progress.done ? ' · 完成' : this.indexing ? ' · 进行中' : ' · 已暂停'}`
      : '补录已有会话，发现历史分支。';
    document.querySelector<HTMLElement>('#index')!.textContent = this.indexing ? '暂停补录' : progress?.done ? '重新补录' : '补录历史';
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
      document.querySelector<HTMLElement>('#index')!.textContent = '继续补录';
      document.querySelector<HTMLElement>('#index-status')!.textContent = `补录暂停：${(error as Error).message}`;
    }
  }

  zoom(value: number) {
    this.scale = value;
    this.render();
  }

  error(error: Error) { document.querySelector<HTMLElement>('#status')!.textContent = error.message; }
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
document.querySelector<HTMLElement>('#refresh')!.addEventListener('click', () => panel.load(true).catch(error => panel.error(error)));
document.querySelector<HTMLElement>('#index')!.addEventListener('click', () => panel.index().catch(error => panel.error(error)));
document.querySelector<HTMLElement>('#in')!.addEventListener('click', () => panel.zoom(Math.min(2, panel.scale + 0.15)));
document.querySelector<HTMLElement>('#out')!.addEventListener('click', () => panel.zoom(Math.max(0.3, panel.scale - 0.15)));
document.querySelector<HTMLElement>('#fit')!.addEventListener('click', () => panel.zoom(Math.min(1, document.querySelector<HTMLElement>('#viewport')!.clientWidth / panel.layout.width)));
chrome.storage.onChanged.addListener(changes => {
  if (Object.keys(changes).some(key => key.startsWith('conversation:') || key === 'historyIndex' || key === `tab:${panel.tabId}`)) {
    panel.load().catch(error => panel.error(error));
  }
});
chrome.tabs.onActivated.addListener(() => panel.load(true).catch(error => panel.error(error)));
panel.load(true).catch(error => panel.error(error));
