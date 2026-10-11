import test from 'node:test';
import assert from 'node:assert/strict';
import { projectConversation, buildGraph, navigationPlan } from '../src/model.ts';
import type { RawNode, Role } from '../src/types.js';

test('thinking, recaps and tool calls are omitted while answer ancestry remains intact', () => {
  const prompt = message('prompt', null, 'user');
  const tool = message('tool', 'prompt', 'assistant');
  tool.message!.recipient = 'web.run';
  tool.message!.content = { content_type: 'text', parts: [''] };
  const thoughts = message('thoughts', 'tool', 'assistant');
  thoughts.message!.recipient = 'all';
  thoughts.message!.content = {
    content_type: 'thoughts',
    thoughts: [{ summary: 'Checking the serving architecture' }],
  };
  const recap = message('recap', 'thoughts', 'assistant');
  recap.message!.content = { content_type: 'reasoning_recap', content: 'Thought for 15 seconds' };
  const analysis = message('analysis', 'recap', 'assistant');
  analysis.message!.channel = 'analysis';
  const answer = message('answer', 'analysis', 'assistant');
  const conversation = projectConversation({
    id: 'reference',
    title: 'Inference service',
    currentNode: 'answer',
    mapping: { prompt, tool, thoughts, recap, analysis, answer },
  });
  assert.deepEqual(
    conversation.nodes.map((node) => node.id),
    ['prompt', 'answer'],
  );
  assert.equal(conversation.nodes[1].text, 'answer');
  assert.equal(conversation.nodes[1].parent, 'prompt');
  assert.ok(conversation.nodes.every((node) => !node.hasAttachments));
  assert.deepEqual(conversation.activePath, ['prompt', 'answer']);
  assert.equal(
    projectConversation({
      id: 'thinking',
      title: '',
      currentNode: 'analysis',
      mapping: { prompt, tool, thoughts, recap, analysis, answer },
    }).currentNode,
    'prompt',
  );
});

test('empty and unsupported messages do not imply attachments, while actual attachments remain identified', () => {
  const empty = message('empty', null, 'assistant');
  empty.message!.content = { content_type: 'text', parts: [''] };
  const unknown = message('unknown', 'empty', 'assistant');
  unknown.message!.content = {
    content_type: 'future_format',
    parts: [{ value: 'structured data' }],
  };
  const image = message('image', 'unknown', 'user');
  image.message!.content = {
    content_type: 'multimodal_text',
    parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'image' }],
  };
  const file = message('file', 'image', 'user', { attachments: [{ name: 'notes.pdf' }] });
  file.message!.content = { content_type: 'text', parts: [''] };
  const caption = message('caption', 'file', 'user', { attachments: [{ name: 'photo.png' }] });
  caption.message!.content = {
    content_type: 'multimodal_text',
    parts: [
      'Compare these photographs.',
      { content_type: 'image_asset_pointer', asset_pointer: 'photo' },
    ],
  };
  const conversation = projectConversation({
    id: 'attachments',
    title: 'Files',
    currentNode: 'caption',
    mapping: { empty, unknown, image, file, caption },
  });
  assert.deepEqual(
    conversation.nodes.map((node) => node.hasAttachments),
    [false, false, true, true, true],
  );
  assert.equal(conversation.nodes.at(-1)!.text, 'Compare these photographs.');
  assert.deepEqual(
    buildGraph([conversation], conversation.id)
      .nodes.filter((node) => node.role !== 'root')
      .map((node) => node.hasAttachments),
    [false, false, true, true, true],
  );
});

function message(
  id: string,
  parent: string | null,
  role: Role,
  metadata: NonNullable<RawNode['message']>['metadata'] = {},
): RawNode {
  return {
    id,
    parent,
    message: { author: { role }, metadata, content: { parts: [id] }, create_time: 1 },
  };
}

test('regeneration preserves the source recorded on the old fork point', () => {
  const mapping = {
    prompt: message('prompt', null, 'user'),
    original: message('original', 'prompt', 'assistant', {
      branching_from_conversation_id: 'source',
    }),
    replacement: message('replacement', 'prompt', 'assistant'),
  };
  const value = projectConversation({
    id: 'child',
    title: '读书会',
    mapping,
    currentNode: 'replacement',
  });
  assert.equal(value.fork!.branchSource, 'source');
  assert.deepEqual(value.activePath, ['prompt', 'replacement']);
  assert.equal(
    (
      navigationPlan(value, 'original') as Extract<
        ReturnType<typeof navigationPlan>,
        { kind: 'version' }
      >
    ).anchorId,
    'prompt',
  );
});

test('shared prefix renders once and active prefix navigates in the current child', () => {
  const source = projectConversation({
    id: 'source',
    title: '读书会方案',
    currentNode: 'answer',
    mapping: {
      prompt: message('prompt', null, 'user'),
      answer: message('answer', 'prompt', 'assistant'),
    },
  });
  const child = projectConversation({
    id: 'child',
    title: '主持人开场白',
    currentNode: 'followup',
    mapping: {
      prompt: message('prompt', null, 'user'),
      answer: message('answer', 'prompt', 'assistant', {
        branching_from_conversation_id: 'source',
      }),
      followup: message('followup', 'answer', 'user'),
    },
  });
  const graph = buildGraph([child, source], 'child');
  assert.equal(graph.nodes.filter((node) => node.role !== 'root').length, 3);
  assert.equal(graph.conversationCount, 2);
  assert.equal(graph.nodes.find((node) => node.id === 'answer')!.navigationConversationId, 'child');
  assert.equal(graph.edges.find((edge) => edge.to === 'child:followup')!.from, 'source:answer');
  const children = new Set(graph.edges.map((edge) => edge.to));
  assert.deepEqual(
    graph.nodes.filter((node) => !children.has(node.key)).map((node) => node.key),
    ['conversation-start'],
  );
});

test('regenerating a nested fork keeps its immediate parent rather than an ancestor', () => {
  const mapping = {
    first: message('first', null, 'user'),
    ancestorFork: message('ancestorFork', 'first', 'assistant', {
      branching_from_conversation_id: 'grandparent',
    }),
    second: message('second', 'ancestorFork', 'user'),
    directFork: message('directFork', 'second', 'assistant', {
      branching_from_conversation_id: 'parent',
    }),
    regenerated: message('regenerated', 'second', 'assistant'),
  };
  const conversation = projectConversation({
    id: 'child',
    title: '读书会续聊',
    currentNode: 'regenerated',
    mapping,
  });
  assert.equal(conversation.fork!.branchSource, 'parent');
});

test('an old shared message opens its saved child path rather than source versions', () => {
  const source = projectConversation({
    id: 'source',
    title: '读书会方案',
    currentNode: 'replacement',
    mapping: {
      prompt: message('prompt', null, 'user'),
      original: message('original', 'prompt', 'assistant'),
      replacement: message('replacement', 'prompt', 'assistant'),
    },
  });
  const child = projectConversation({
    id: 'child',
    title: '旧方案分支',
    currentNode: 'followup',
    mapping: {
      prompt: message('prompt', null, 'user'),
      original: message('original', 'prompt', 'assistant', {
        branching_from_conversation_id: 'source',
      }),
      followup: message('followup', 'original', 'user'),
    },
  });
  const graph = buildGraph([source, child], 'source');
  const target = graph.nodes.find((node) => node.id === 'original')!;
  assert.equal(target.navigationConversationId, 'child');
  assert.equal(navigationPlan(child, target.id!).kind, 'current');
  assert.equal(
    graph.nodes.find((node) => node.id === 'prompt')!.navigationConversationId,
    'source',
  );
  const draft = { ...child, id: 'local-chatgpt:draft' };
  const draftGraph = buildGraph([source, draft], 'source');
  assert.equal(
    draftGraph.nodes.find((node) => node.id === 'original')!.navigationConversationId,
    'source',
  );
});
