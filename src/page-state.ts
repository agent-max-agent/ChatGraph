import type { Conversation, MessageNode } from './types.js';

export function readVisibleConversation(id: string): Conversation {
  const region = [...document.querySelectorAll<HTMLElement>('[aria-label="Conversation"]')]
    .find(element => element.checkVisibility({ checkVisibilityCSS: true }));
  if (!region) return { id, title: '新分支草稿', nodes: [], activePath: [], currentNode: null, fork: null };
  const elements = [...region.querySelectorAll<HTMLElement>('[data-chatgpt-search-message-ids]')]
    .filter(element => element.checkVisibility({ checkVisibilityCSS: true }));
  const nodes: MessageNode[] = elements.map((element, index) => ({
    id: element.getAttribute('data-chatgpt-search-message-ids')!.split(' ')[0],
    parent: index ? elements[index - 1].getAttribute('data-chatgpt-search-message-ids')!.split(' ')[0] : null,
    role: element.getAttribute('data-chatgpt-search-unit-key')!.includes(':assistant') ? 'assistant' : 'user',
    text: element.innerText.replace(/^ChatGPT said:\s*/, ''),
    branchSource: null,
  }));
  const sourceLink = [...region.querySelectorAll<HTMLAnchorElement>('a[href*="/c/"]')]
    .find(link => link.parentElement!.textContent!.includes('Continued from'));
  const forkElement = sourceLink && elements.filter(element => element.compareDocumentPosition(sourceLink) & Node.DOCUMENT_POSITION_FOLLOWING).at(-1);
  const fork = forkElement ? {
    id: forkElement.getAttribute('data-chatgpt-search-message-ids')!.split(' ')[0],
    branchSource: decodeURIComponent(new URL(sourceLink!.href).pathname.split('/').at(-1)!),
  } : null;
  return { id, title: `${document.title} · 草稿`, nodes, activePath: nodes.map(node => node.id), currentNode: nodes.at(-1)?.id ?? null, fork };
}
