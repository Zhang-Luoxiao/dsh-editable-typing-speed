import assert from 'node:assert/strict';
import test from 'node:test';

import { patchPrototype } from '../lib/adapters/qq.js';
import { normalizeConfig } from '../lib/engine.js';

function freshState() {
  return {
    chats: new Map(),
    stats: { readDelays: 0, segmentGaps: 0, segmentsSent: 0, messagesSplit: 0, bypassed: 0, lastError: '', lastPacingAt: 0 },
    adapters: new Map(),
  };
}

function freshProto(calls) {
  return {
    async emit(event, ...args) {
      for (const handler of this.handlers?.get(event) ?? []) {
        await handler(...args);
      }
    },
    async send(opts) {
      calls.push({ method: 'send', opts });
      return { id: calls.length };
    },
    async sendText(target, content) {
      calls.push({ method: 'sendText', target, content });
      return { id: calls.length };
    },
    async sendMarkdown(target, content, opts) {
      calls.push({ method: 'sendMarkdown', target, content, opts });
      return { id: calls.length };
    },
    on(event, handler) {
      this.handlers ??= new Map();
      const set = this.handlers.get(event) ?? new Set();
      set.add(handler);
      this.handlers.set(event, set);
      return this;
    },
    off(event, handler) {
      this.handlers?.get(event)?.delete(handler);
      return this;
    },
  };
}

const fastConfig = (overrides = {}) => normalizeConfig({
  enabled: true,
  readDelay: { minMs: 20, maxMs: 20, charsPerSecond: 0, maxTotalMs: 1000 },
  segmentGap: { minMs: 20, maxMs: 20, charsPerSecond: 0, maxTotalMs: 1000 },
  split: { enabled: true, minChars: 6, maxSegments: 3 },
  ...overrides,
});

function setup(config) {
  const calls = [];
  const proto = freshProto(calls);
  const state = freshState();
  const bag = { state, getConfig: () => config, log: { warn() {} } };
  patchPrototype(proto, bag);
  const bot = Object.create(proto);
  bot.on('message', () => {});
  return { calls, proto, state, bot, bag };
}

/** 像 SDK 那样把入站消息投给监听器：钩子挂在 emit 上。 */
async function inbound(bot, content = '你好') {
  await bot.emit('message', {}, { content, replyTarget: { scope: 'c2c', targetId: 'u1' } });
}

test('关闭时原样透传：一条、零延迟', async () => {
  const { calls, bot } = setup(normalizeConfig({ enabled: false }));
  await inbound(bot);
  const started = performance.now();
  await bot.send({ target: { scope: 'c2c', targetId: 'u1' }, content: '第一句。第二句。第三句。' });
  const elapsed = performance.now() - started;
  assert.equal(calls.length, 1);
  assert.ok(elapsed < 15, `不应有延迟，实际 ${elapsed}ms`);
});

test('开启后：读延迟 + 按句拆条 + 段间隔', async () => {
  const { calls, bot, state } = setup(fastConfig());
  await inbound(bot, '你好呀，在吗');
  assert.equal(state.chats.get('c2c:u1').inboundLen, 6);

  const started = performance.now();
  await bot.send({ target: { scope: 'c2c', targetId: 'u1' }, content: '第一句话。第二句话！第三句话？' });
  const elapsed = performance.now() - started;

  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((call) => call.opts.content), ['第一句话。', '第二句话！', '第三句话？']);
  // 1 次读延迟 + 2 次段间隔，每次 20ms
  assert.ok(elapsed >= 55, `应有约 60ms 延迟，实际 ${elapsed}ms`);
  assert.equal(state.stats.readDelays, 1);
  assert.equal(state.stats.segmentGaps, 2);
  assert.equal(state.stats.messagesSplit, 1);
});

test('第二条消息不再重复读延迟，只走段间隔', async () => {
  const { bot, state } = setup(fastConfig());
  await inbound(bot);
  await bot.send({ target: { scope: 'c2c', targetId: 'u1' }, content: '一。' });
  const readDelays = state.stats.readDelays;
  await bot.send({ target: { scope: 'c2c', targetId: 'u1' }, content: '二。' });
  assert.equal(state.stats.readDelays, readDelays, '同一回合不应重复读延迟');
});

test('换一份配置后，旧包层立刻改用新配置', async () => {
  const holder = { current: fastConfig() };
  const calls = [];
  const proto = freshProto(calls);
  const state = freshState();
  patchPrototype(proto, { state, getConfig: () => holder.current, log: { warn() {} } });
  const bot = Object.create(proto);

  holder.current = normalizeConfig({ enabled: false });
  await inbound(bot);
  const started = performance.now();
  await bot.send({ target: { scope: 'c2c', targetId: 'u1' }, content: '第一句话。第二句话！' });
  assert.equal(calls.length, 1, '关掉之后不应再拆条');
  assert.ok(performance.now() - started < 15, '关掉之后不应再等待');
});

test('带按钮的消息不拆', async () => {
  const { calls, bot } = setup(fastConfig());
  await inbound(bot);
  await bot.send({
    target: { scope: 'c2c', targetId: 'u1' },
    content: '第一句话。第二句话！',
    keyboard: { content: { rows: [] } },
  });
  assert.equal(calls.length, 1);
});

test('markdown 拆条保留 markdown 形状并递增 msg_seq', async () => {
  const { calls, bot } = setup(fastConfig());
  await inbound(bot);
  await bot.sendMarkdown(
    { scope: 'group', targetId: 'g1', msgId: 'm1' },
    '第一句话。第二句话！',
    { extra: { msg_seq: 10 } },
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, 'sendMarkdown');
  assert.equal(calls[0].opts.extra.msg_seq, 10);
  assert.equal(calls[1].opts.extra.msg_seq, 11);
});

test('重复打补丁不会套两层', async () => {
  const { calls, bot, proto, bag } = setup(fastConfig());
  patchPrototype(proto, bag);
  patchPrototype(proto, bag);
  await inbound(bot);
  await bot.send({ target: { scope: 'c2c', targetId: 'u1' }, content: '第一句话。第二句话！' });
  assert.equal(calls.length, 2, '每次发送只应产生 2 条，不应翻倍');
});

test('媒体消息不参与节奏', async () => {
  const { calls, bot } = setup(fastConfig());
  await inbound(bot);
  await bot.send({ target: { scope: 'c2c', targetId: 'u1' }, msgType: 7, media: { file_info: 'x' } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.msgType, 7);
});
