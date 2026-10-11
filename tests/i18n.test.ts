import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTranslator, resolveLanguage, translatedError } from '../src/i18n.ts';

test('browser language resolves to a supported language and explicit choice takes precedence', () => {
  assert.equal(resolveLanguage('auto', 'zh-CN'), 'zh_CN');
  assert.equal(resolveLanguage('auto', 'en-GB'), 'en');
  assert.equal(resolveLanguage('auto', 'fr'), 'en');
  assert.equal(resolveLanguage('en', 'zh-CN'), 'en');
  assert.equal(resolveLanguage('zh_CN', 'en-US'), 'zh_CN');
});

test('catalogs have matching keys and positional substitutions', () => {
  const en = JSON.parse(readFileSync('public/_locales/en/messages.json', 'utf8')) as Record<
    string,
    { message: string }
  >;
  const zh = JSON.parse(readFileSync('public/_locales/zh_CN/messages.json', 'utf8')) as typeof en;
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
  for (const key of Object.keys(en)) {
    assert.deepEqual(en[key].message.match(/\$\d/g), zh[key].message.match(/\$\d/g), key);
  }
  assert.equal(createTranslator('en')('counts', ['2', '10']), '2 conversations · 10 messages');
  assert.equal(createTranslator('zh_CN')('counts', ['2', '10']), '2 个对话 · 10 条消息');
});

test('persisted error codes translate in the newly selected language and external errors remain readable', () => {
  assert.equal(
    translatedError('conversationLoad|403', createTranslator('en')),
    'Could not load the conversation (403). Try again.',
  );
  assert.equal(
    translatedError('conversationLoad|403', createTranslator('zh_CN')),
    '对话加载失败（403），请重试。',
  );
  assert.equal(translatedError('Failed to fetch', createTranslator('zh_CN')), 'Failed to fetch');
});
