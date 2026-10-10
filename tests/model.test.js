import test from 'node:test';
import assert from 'node:assert/strict';
import { projectConversation, buildGraph, navigationPlan } from '../src/model.js';

function message(id, parent, role, metadata = {}) {
  return { id, parent, message: { author: { role }, metadata, content: { parts: [id] }, create_time: 1 } };
}

test('regeneration preserves the source recorded on the old fork point', () => {
  const mapping = {
    prompt: message('prompt', null, 'user'),
    original: message('original', 'prompt', 'assistant', { branching_from_conversation_id: 'source' }),
    replacement: message('replacement', 'prompt', 'assistant'),
  };
  const value = projectConversation({ id: 'child', title: '读书会', mapping, currentNode: 'replacement' });
  assert.equal(value.fork.branchSource, 'source');
  assert.deepEqual(value.activePath, ['prompt', 'replacement']);
  assert.equal(navigationPlan(value, 'original').anchorId, 'prompt');
});

test('shared prefix renders once and active prefix navigates in the current child', () => {
  const source = projectConversation({ id: 'source', title: '读书会方案', currentNode: 'answer', mapping: {
    prompt: message('prompt', null, 'user'), answer: message('answer', 'prompt', 'assistant'),
  } });
  const child = projectConversation({ id: 'child', title: '主持人开场白', currentNode: 'followup', mapping: {
    prompt: message('prompt', null, 'user'),
    answer: message('answer', 'prompt', 'assistant', { branching_from_conversation_id: 'source' }),
    followup: message('followup', 'answer', 'user'),
  } });
  const graph = buildGraph([child, source], 'child');
  assert.equal(graph.nodes.filter(node => node.role !== 'root').length, 3);
  assert.equal(graph.conversationCount, 2);
  assert.equal(graph.nodes.find(node => node.id === 'answer').navigationConversationId, 'child');
  assert.equal(graph.edges.find(edge => edge.to === 'child:followup').from, 'source:answer');
  const children = new Set(graph.edges.map(edge => edge.to));
  assert.deepEqual(graph.nodes.filter(node => !children.has(node.key)).map(node => node.key), ['conversation-start']);
});

test('regenerating a nested fork keeps its immediate parent rather than an ancestor', () => {
  const mapping = {
    first: message('first', null, 'user'),
    ancestorFork: message('ancestorFork', 'first', 'assistant', { branching_from_conversation_id: 'grandparent' }),
    second: message('second', 'ancestorFork', 'user'),
    directFork: message('directFork', 'second', 'assistant', { branching_from_conversation_id: 'parent' }),
    regenerated: message('regenerated', 'second', 'assistant'),
  };
  const conversation = projectConversation({ id: 'child', title: '读书会续聊', currentNode: 'regenerated', mapping });
  assert.equal(conversation.fork.branchSource, 'parent');
});

test('an old shared message opens its saved child path rather than source versions', () => {
  const source = projectConversation({ id: 'source', title: '读书会方案', currentNode: 'replacement', mapping: {
    prompt: message('prompt', null, 'user'),
    original: message('original', 'prompt', 'assistant'),
    replacement: message('replacement', 'prompt', 'assistant'),
  } });
  const child = projectConversation({ id: 'child', title: '旧方案分支', currentNode: 'followup', mapping: {
    prompt: message('prompt', null, 'user'),
    original: message('original', 'prompt', 'assistant', { branching_from_conversation_id: 'source' }),
    followup: message('followup', 'original', 'user'),
  } });
  const graph = buildGraph([source, child], 'source');
  const target = graph.nodes.find(node => node.id === 'original');
  assert.equal(target.navigationConversationId, 'child');
  assert.equal(navigationPlan(child, target.id).kind, 'current');
  assert.equal(graph.nodes.find(node => node.id === 'prompt').navigationConversationId, 'source');
  const draft = { ...child, id: 'local-chatgpt:draft' };
  const draftGraph = buildGraph([source, draft], 'source');
  assert.equal(draftGraph.nodes.find(node => node.id === 'original').navigationConversationId, 'source');
});
