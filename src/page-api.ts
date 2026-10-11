import type { ConversationData, PageRequest, PageResult } from './types.js';

export async function readChatGPT(request: PageRequest): Promise<PageResult> {
  try {
    const sessionResponse = await fetch('/api/auth/session', { credentials: 'include' });
    if (!sessionResponse.ok) throw new Error(`sessionLoad|${sessionResponse.status}`);
    const session = (await sessionResponse.json()) as { accessToken?: string };
    if (!session.accessToken) throw new Error('signIn');

    const headers = { Authorization: `Bearer ${session.accessToken}` };
    let path;
    if (request.kind === 'conversation') {
      path = `/backend-api/conversation/${encodeURIComponent(request.id)}`;
    } else if (request.kind === 'versions') {
      path = `/backend-api/conversations/${encodeURIComponent(request.id)}/versions?message_id=${encodeURIComponent(request.messageId)}`;
    } else {
      path = `/backend-api/conversations?offset=${request.offset}&limit=100&order=updated`;
    }

    const response = await fetch(path, { headers, credentials: 'include' });
    if (!response.ok)
      return { error: `conversationLoad|${response.status}`, status: response.status };
    const data: unknown = await response.json();
    if (request.kind === 'list') {
      const page = data as { items: { id: string }[]; total: number };
      return { ids: page.items.map((item) => item.id), total: page.total };
    }
    if (request.kind === 'versions')
      return (data as { id: string }[][]).map((messages) => messages.map((message) => message.id));
    const conversation = data as {
      title: string;
      current_node: string | null;
      mapping: ConversationData['mapping'];
    };
    return {
      id: request.id,
      title: conversation.title,
      currentNode: conversation.current_node,
      mapping: conversation.mapping,
    };
  } catch (error) {
    return { error: (error as Error).message };
  }
}
