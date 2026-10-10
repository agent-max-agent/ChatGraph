export function conversationId(url) {
  return new URL(url).pathname.match(/\/c\/([^/]+)/)?.[1] && decodeURIComponent(new URL(url).pathname.match(/\/c\/([^/]+)/)[1]);
}

export function pathTo(nodes, id) {
  const path = [];
  for (let node = nodes.get(id); node; node = nodes.get(node.parent)) path.unshift(node.id);
  return path;
}

export function projectConversation(data) {
  const visible = new Set(Object.values(data.mapping)
    .filter(node => node.message && ['user', 'assistant'].includes(node.message.author.role)
      && !node.message.metadata.is_visually_hidden_from_conversation)
    .map(node => node.id));

  const nodes = Object.values(data.mapping).filter(node => visible.has(node.id)).map(node => {
    let parent = node.parent;
    while (parent && !visible.has(parent)) parent = data.mapping[parent].parent;
    const message = node.message;
    const text = (message.content.parts ?? []).filter(part => typeof part === 'string').join('\n');
    return {
      id: node.id,
      parent,
      role: message.author.role,
      text: text.replace(/<\/?WritingBlock[^>]*>/g, ''),
      branchSource: message.metadata.branching_from_conversation_id ?? null,
      createdAt: message.create_time,
    };
  });
  let currentNode = data.currentNode;
  while (currentNode && !visible.has(currentNode)) currentNode = data.mapping[currentNode].parent;
  const byId = new Map(nodes.map(node => [node.id, node]));
  const fork = nodes.filter(node => node.branchSource)
    .sort((left, right) => pathTo(byId, right.id).length - pathTo(byId, left.id).length)[0] ?? null;
  return {
    id: data.id,
    title: data.title,
    currentNode,
    nodes,
    activePath: pathTo(byId, currentNode),
    fork,
  };
}

export function navigationPlan(conversation, targetId) {
  const nodes = new Map(conversation.nodes.map(node => [node.id, node]));
  const targetPath = pathTo(nodes, targetId);
  if (!nodes.has(targetId)) throw new Error('消息已不在当前对话树中，请刷新图。');
  if (conversation.activePath.includes(targetId)) return { kind: 'current', targetId, pathIds: conversation.activePath };
  const index = targetPath.findIndex((id, position) => id !== conversation.activePath[position]);
  const activeId = conversation.activePath[index];
  if (!activeId) throw new Error('该历史路径没有可打开的当前版本入口。');
  let anchor = nodes.get(activeId);
  while (anchor.role !== 'user') anchor = nodes.get(anchor.parent);
  const branchId = targetPath[index];
  const branch = nodes.get(branchId);
  const matchId = branch.role === 'assistant' ? branch.id : conversation.nodes.find(node => node.parent === branchId && node.role === 'assistant')?.id;
  return { kind: 'version', targetId, anchorId: anchor.id, branchId, matchId,
    targetRole: nodes.get(targetId).role, targetText: nodes.get(targetId).text, pathIds: conversation.activePath };
}

export function buildGraph(conversations, currentId) {
  const byConversation = new Map(conversations.map(conversation => [conversation.id, conversation]));
  const current = byConversation.get(currentId);
  if (!current) return { nodes: [], edges: [], title: '', conversationCount: 0 };

  const family = new Set([currentId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const conversation of conversations) {
      const source = conversation.fork?.branchSource;
      if (source && byConversation.has(source) && (family.has(source) || family.has(conversation.id))) {
        if (!family.has(source) || !family.has(conversation.id)) changed = true;
        family.add(source);
        family.add(conversation.id);
      }
    }
  }

  const nodes = [];
  const edges = [];
  const replacements = new Map();
  const key = (id, messageId) => `${id}:${messageId}`;
  for (const id of family) {
    const conversation = byConversation.get(id);
    const source = byConversation.get(conversation.fork?.branchSource);
    const inherited = source ? pathTo(new Map(conversation.nodes.map(node => [node.id, node])), conversation.fork.id) : [];
    for (const messageId of inherited) {
      if (source.nodes.some(node => node.id === messageId)) replacements.set(key(id, messageId), key(source.id, messageId));
    }
    for (const node of conversation.nodes) {
      const nodeKey = key(id, node.id);
      if (replacements.has(nodeKey)) continue;
      nodes.push({ ...node, key: nodeKey, conversationId: id, conversationTitle: conversation.title, unavailable: conversation.unavailable ?? false, active: false });
      if (node.parent) edges.push({ from: key(id, node.parent), to: nodeKey, kind: 'message' });
    }
  }

  const resolve = value => {
    while (replacements.has(value)) value = replacements.get(value);
    return value;
  };
  const visibleKeys = new Set(nodes.map(node => node.key));
  const resolvedEdges = edges.map(edge => ({
    ...edge,
    from: resolve(edge.from),
    kind: replacements.has(edge.from) ? 'fork' : 'message',
  })).filter(edge => visibleKeys.has(edge.from));
  const activeKeys = new Set(current.activePath.map(id => resolve(key(currentId, id))));
  for (const node of nodes) {
    node.active = activeKeys.has(node.key);
    const owner = byConversation.get(node.conversationId);
    const savedPath = [...family].map(id => byConversation.get(id)).find(conversation =>
      !conversation.id.startsWith('local-chatgpt:') && !conversation.unavailable
      && conversation.activePath.includes(node.id)
      && resolve(key(conversation.id, node.id)) === node.key);
    node.navigationConversationId = node.active ? currentId
      : owner.activePath.includes(node.id) ? owner.id
        : savedPath?.id ?? owner.id;
  }
  const childKeys = new Set(resolvedEdges.map(edge => edge.to));
  const roots = nodes.filter(node => !childKeys.has(node.key));
  const rootKey = 'conversation-start';
  nodes.push({ key: rootKey, id: null, role: 'root', text: '对话开始', conversationTitle: '', active: true });
  for (const root of roots) resolvedEdges.push({ from: rootKey, to: root.key, kind: 'version' });
  return { nodes, edges: resolvedEdges, title: current.title, conversationCount: family.size };
}

export function layoutGraph(graph) {
  const children = new Map(graph.nodes.map(node => [node.key, []]));
  const parents = new Set();
  for (const edge of graph.edges) {
    children.get(edge.from).push(edge.to);
    parents.add(edge.to);
  }
  const positions = new Map();
  let leaf = 0;
  const place = (id, depth) => {
    const descendants = children.get(id);
    const columns = descendants.map(child => place(child, depth + 1));
    const x = columns.length ? (columns[0] + columns.at(-1)) / 2 : leaf++ * 128 + 12;
    positions.set(id, { x, y: depth * 108 + 12 });
    return x;
  };
  for (const node of graph.nodes.filter(node => !parents.has(node.key))) place(node.key, 0);
  return {
    positions,
    width: Math.max(128, leaf * 128 + 12),
    height: Math.max(108, ...[...positions.values()].map(position => position.y + 92)),
  };
}
