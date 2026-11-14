import assert from 'node:assert/strict';
import test from 'node:test';

import { needsTransform, transformStream } from '../lib/writer.js';

/** 把数组包成 async 迭代器。 */
async function* fromArray(items) {
  for (const item of items) yield item;
}

async function collect(stream) {
  const out = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

const textBlock = (index, text) => [
  { type: 'block-start', index, blockType: 'text' },
  { type: 'text-delta', index, text },
  { type: 'block-end', index, block: { type: 'text', text } },
  { type: 'finish', reason: { kind: 'stop' } },
];

test('needsTransform 只在开了文本处理或转译时为真', () => {
  assert.equal(needsTransform({}), false);
  assert.equal(needsTransform({ text: { dialogOnly: true } }), true);
  assert.equal(needsTransform({ text: { emoticon: { enabled: true } } }), true);
  assert.equal(needsTransform({ prompt: { style: 'translate' } }), true);
  assert.equal(needsTransform({ prompt: { style: 'classical' } }), false, '文言在提示层完成，不需要改写流');
});

test('transformStream 把英文块换成中文，并保持块结构', async () => {
  const chunks = await collect(transformStream(fromArray(textBlock(0, 'Hello there.')), {
    config: { prompt: { style: 'translate' } },
    translate: async () => '你好呀。',
    log: { warn() {} },
  }));
  assert.deepEqual(chunks.map((c) => c.type), ['block-start', 'text-delta', 'block-end', 'finish']);
  assert.equal(chunks[1].text, '你好呀。');
  assert.equal(chunks[2].block.text, '你好呀。');
});

test('转译只对最后一段正文调用一次，中间旁白不翻译', async () => {
  let calls = 0;
  const chunks = await collect(transformStream(fromArray([
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'Let me check. ' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'Let me check. ' } },
    { type: 'tool-call-delta', index: 1, id: 't1', name: 'read', argumentsDelta: '{}' },
    { type: 'block-end', index: 1, block: { type: 'tool-call', id: 't1', name: 'read', arguments: '{}' } },
    { type: 'block-start', index: 2, blockType: 'text' },
    { type: 'text-delta', index: 2, text: 'Here is the answer.' },
    { type: 'block-end', index: 2, block: { type: 'text', text: 'Here is the answer.' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]), {
    config: { prompt: { style: 'translate' } },
    translate: async () => {
      calls += 1;
      return '这是答案。';
    },
    log: { warn() {} },
  }));

  assert.equal(calls, 1, '一条回复只翻译一次');
  const texts = chunks.filter((c) => c.type === 'block-end' && c.block?.type === 'text').map((c) => c.block.text);
  assert.deepEqual(texts, ['Let me check. ', '这是答案。']);
});

test('翻译失败时保留原文', async () => {
  const chunks = await collect(transformStream(fromArray(textBlock(0, 'Hello there.')), {
    config: { prompt: { style: 'translate' } },
    translate: async () => undefined,
    log: { warn() {} },
  }));
  assert.equal(chunks.length, 4);
  const delta = chunks.find((c) => c.type === 'text-delta');
  assert.equal(delta.text, 'Hello there.');
  const end = chunks.find((c) => c.type === 'block-end');
  assert.equal(end.block.text, 'Hello there.');
});

test('思考块与工具块原样透传', async () => {
  const chunks = await collect(transformStream(fromArray([
    { type: 'reasoning-delta', index: 0, text: 'thinking' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'thinking' } },
    { type: 'tool-call-delta', index: 1, id: 't1', name: 'read', argumentsDelta: '{}' },
  ]), {
    config: { text: { dialogOnly: true } },
    translate: async () => 'unused',
    log: { warn() {} },
  }));
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].type, 'reasoning-delta');
});

test('只留对话在流里也生效', async () => {
  const chunks = await collect(transformStream(fromArray(textBlock(0, '（别过头）少废话。')), {
    config: { text: { dialogOnly: true } },
    translate: async () => undefined,
    log: { warn() {} },
  }));
  const end = chunks.find((c) => c.type === 'block-end');
  assert.equal(end.block.text, '少废话。');
});
