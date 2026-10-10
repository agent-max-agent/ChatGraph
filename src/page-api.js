export async function readChatGPT(request) {
  try {
    const sessionResponse = await fetch('/api/auth/session', { credentials: 'include' });
    if (!sessionResponse.ok) throw new Error(`登录状态加载失败 (${sessionResponse.status})，请在 ChatGPT 重试后刷新图。`);
    const session = await sessionResponse.json();
    if (!session.accessToken) throw new Error('请先登录 ChatGPT。');

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
    if (!response.ok) return { error: `对话加载失败 (${response.status})，请重试。`, status: response.status };
    const data = await response.json();
    if (request.kind === 'list') return { ids: data.items.map(item => item.id), total: data.total };
    if (request.kind === 'versions') return data.map(messages => messages.map(message => message.id));
    return { id: request.id, title: data.title, currentNode: data.current_node, mapping: data.mapping };
  } catch (error) {
    return { error: error.message };
  }
}
