import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGraph,
  collapseLinearChains,
  layoutGraph,
  projectConversation,
} from '../src/model.ts';
import type { Graph } from '../src/types.ts';

function tree(paths: string[][]): Graph {
  const edges = new Map<string, Graph['edges'][number]>();
  for (const path of paths) {
    for (let index = 1; index < path.length; index++) {
      edges.set(path[index], { from: path[index - 1], to: path[index], kind: 'message' });
    }
  }
  return {
    nodes: [...new Set(paths.flat())].map((key) => ({
      key,
      id: key === 'root' ? null : key,
      role: key === 'root' ? 'root' : 'user',
      text: key,
      conversationTitle: 'Book club',
      navigationConversationId: 'book-club',
      active: true,
    })),
    edges: [...edges.values()],
    title: 'Book club',
    conversationCount: 1,
  };
}

test('chains up to four messages stay intact; longer chains retain exactly their first and last two', () => {
  for (let length = 0; length <= 9; length++) {
    const keys = Array.from({ length }, (_, index) => String(index));
    const graph = tree([['root', ...keys]]);
    const saved = structuredClone(graph);
    const collapsed = collapseLinearChains(graph);
    assert.deepEqual(
      collapsed.nodes.map((node) => node.key),
      ['root', ...(length <= 4 ? keys : [...keys.slice(0, 2), ...keys.slice(-2)])],
    );
    assert.equal(
      collapsed.edges.find((edge) => edge.collapsed)?.collapsed,
      length > 4 ? length - 4 : undefined,
    );
    assert.deepEqual(graph, saved);
    for (const node of collapsed.nodes)
      assert.equal(
        node,
        graph.nodes.find((original) => original.key === node.key),
      );
    assert.equal(layoutGraph(collapsed).positions.size, collapsed.nodes.length);
  }
});

test('nested branches retain junctions, short siblings and fork connections', () => {
  const graph = tree([
    ['root', 'a', 'b', 'c', 'd', 'e', 'fork'],
    ['fork', 'f', 'g', 'h', 'i', 'j', 'nested'],
    ['fork', 'short'],
    ['nested', 'k', 'l', 'm', 'n', 'o'],
    ['nested', 'other'],
  ]);
  graph.edges.find((edge) => edge.to === 'g')!.kind = 'fork';
  const collapsed = collapseLinearChains(graph);
  assert.deepEqual(
    collapsed.nodes.map((node) => node.key),
    ['root', 'a', 'b', 'e', 'fork', 'f', 'j', 'nested', 'short', 'k', 'n', 'o', 'other'],
  );
  assert.deepEqual(
    collapsed.edges.find((edge) => edge.from === 'f'),
    { from: 'f', to: 'j', kind: 'fork', collapsed: 3 },
  );
  assert.deepEqual(
    collapsed.edges.filter((edge) => edge.from === 'fork').map((edge) => edge.to),
    ['f', 'short'],
  );
  assert.deepEqual(
    collapsed.edges.filter((edge) => edge.from === 'nested').map((edge) => edge.to),
    ['k', 'other'],
  );
  assert.equal(layoutGraph(collapsed).positions.size, collapsed.nodes.length);
});

test('multiple first-message versions collapse independently', () => {
  const graph = tree([
    ['root', 'a', 'b', 'c', 'd', 'e'],
    ['root', 'v1', 'v2'],
  ]);
  const collapsed = collapseLinearChains(graph);
  assert.deepEqual(
    collapsed.nodes.map((node) => node.key),
    ['root', 'a', 'b', 'd', 'e', 'v1', 'v2'],
  );
  assert.deepEqual(
    collapsed.edges.filter((edge) => edge.from === 'root').map((edge) => edge.to),
    ['a', 'v1'],
  );
  assert.deepEqual(collapseLinearChains({ ...graph, nodes: [], edges: [] }).nodes, []);
});

test('visible messages retain navigation targets and original ancestry from a conversation', () => {
  const ids = ['prompt', 'answer', 'followup', 'reply', 'closing', 'summary'];
  const conversation = projectConversation({
    id: 'book-club',
    title: 'Plan a neighborhood book club',
    currentNode: 'summary',
    mapping: Object.fromEntries(
      ids.map((id, index) => [
        id,
        {
          id,
          parent: index ? ids[index - 1] : null,
          message: {
            author: { role: index % 2 ? 'assistant' : 'user' },
            metadata: {},
            content: { parts: [id] },
            create_time: index,
          },
        },
      ]),
    ),
  });
  const graph = buildGraph([conversation], conversation.id);
  const collapsed = collapseLinearChains(graph);
  assert.deepEqual(
    collapsed.nodes.filter((node) => node.role !== 'root').map((node) => node.id),
    ['prompt', 'answer', 'closing', 'summary'],
  );
  assert.ok(
    collapsed.nodes
      .filter((node) => node.role !== 'root')
      .every((node) => node.navigationConversationId === 'book-club'),
  );
  assert.deepEqual(conversation.activePath, ids);
  assert.equal(graph.nodes.length, ids.length + 1);
});
