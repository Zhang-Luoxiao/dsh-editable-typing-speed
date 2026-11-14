import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULTS,
  applyEmoticons,
  computeReadDelayMs,
  computeSegmentGapMs,
  normalizeConfig,
  splitReply,
  stripNarration,
  visibleLength,
} from '../lib/engine.js';

const zero = () => 0;

test('normalizeConfig 补全、钳制并调换反向的速度区间', () => {
  const config = normalizeConfig({
    enabled: true,
    readDelay: { baseMs: 2000, minCharsPerSecond: 20, maxCharsPerSecond: 4, maxTotalMs: 100 },
  });
  assert.equal(config.enabled, true);
  assert.equal(config.readDelay.baseMs, 2000);
  assert.equal(config.readDelay.minCharsPerSecond, 4, '反向的速度区间要调换');
  assert.equal(config.readDelay.maxCharsPerSecond, 20);
  assert.equal(config.readDelay.maxTotalMs, 2000, '封顶不能低于固定反应时间');
  assert.equal(config.segmentGap.baseMs, DEFAULTS.segmentGap.baseMs);
  assert.equal(config.channels.qq, true);
});

test('旧配置（minMs/maxMs + charsPerSecond）迁移到「固定反应 + 速度区间」', () => {
  const config = normalizeConfig({ readDelay: { minMs: 2000, maxMs: 3000, charsPerSecond: 10 } });
  assert.equal(config.readDelay.baseMs, 2000, '旧下限变成固定反应时间');
  assert.equal(config.readDelay.minCharsPerSecond, 6);
  assert.equal(config.readDelay.maxCharsPerSecond, 14);
  const off = normalizeConfig({ readDelay: { minMs: 500, maxMs: 900, charsPerSecond: 0 } });
  assert.equal(off.readDelay.baseMs, 500);
  assert.equal(off.readDelay.maxCharsPerSecond, 0, '0 表示不按字数折算');
});

test('normalizeConfig 默认关闭，channels.qq 显式 false 才关', () => {
  assert.equal(normalizeConfig({}).enabled, false);
  assert.equal(normalizeConfig({ channels: { qq: false } }).channels.qq, false);
  assert.equal(normalizeConfig({ channels: {} }).channels.qq, true);
});

test('visibleLength 忽略 Markdown 语法与图片', () => {
  assert.equal(visibleLength('**你好**'), 2);
  assert.equal(visibleLength('![图](http://x/y.png)'), 0);
  assert.equal(visibleLength('[链接](http://x) 好'), 4);
});

test('computeReadDelayMs = 固定反应时间 + 字数 ÷ 随机阅读速度', () => {
  const readDelay = { baseMs: 1000, minCharsPerSecond: 5, maxCharsPerSecond: 10, maxTotalMs: 60_000 };
  // random()=0 → 速度取下限 5 字/秒；20 字 = 4000ms
  assert.equal(computeReadDelayMs({ readDelay, userTextLength: 20, random: zero }), 5000);
  // random()=1 → 速度取上限 10 字/秒；20 字 = 2000ms
  assert.equal(computeReadDelayMs({ readDelay, userTextLength: 20, random: () => 1 }), 3000);
  // 速度两端相同 → 无浮动
  assert.equal(
    computeReadDelayMs({ readDelay: { ...readDelay, minCharsPerSecond: 8, maxCharsPerSecond: 8 }, userTextLength: 8, random: () => 1 }),
    2000,
  );
  // 封顶
  assert.equal(
    computeReadDelayMs({ readDelay: { ...readDelay, maxTotalMs: 1500 }, userTextLength: 1000, random: zero }),
    1500,
  );
  // 关掉这一段
  assert.equal(computeReadDelayMs({ readDelay: { ...readDelay, enabled: false } }), 0);
});

test('computeSegmentGapMs = 固定停顿 + 字数 ÷ 随机打字速度', () => {
  const segmentGap = { baseMs: 500, minCharsPerSecond: 4, maxCharsPerSecond: 8, maxTotalMs: 60_000 };
  assert.equal(computeSegmentGapMs({ segmentGap, segmentTextLength: 10, random: zero }), 3000);
  assert.equal(computeSegmentGapMs({ segmentGap, segmentTextLength: 10, random: () => 1 }), 1750);
  // 速度为 0 → 只剩固定停顿
  assert.equal(
    computeSegmentGapMs({ segmentGap: { ...segmentGap, minCharsPerSecond: 0, maxCharsPerSecond: 0 }, random: () => 1 }),
    500,
  );
});

test('splitReply 按句末标点拆，且不超过 maxSegments', () => {
  const segments = splitReply('第一句话。第二句话！第三句话？', {
    split: { enabled: true, minChars: 1, maxSegments: 2 },
  });
  assert.equal(segments.length, 2);
  assert.equal(segments.join(''), '第一句话。第二句话！第三句话？');
});

test('splitReply 保护代码块与表格', () => {
  const code = '看这个：\n```js\nconsole.log(1)\n```\n就这样。';
  assert.deepEqual(splitReply(code, { split: { enabled: true, minChars: 1, maxSegments: 5 } }), [code]);
  const table = '| a | b |\n| - | - |\n| 1 | 2 |\n\n就这些。';
  assert.deepEqual(splitReply(table, { split: { enabled: true, minChars: 1, maxSegments: 5 } }), [table]);
});

test('splitReply 短回复不拆，关掉后不拆', () => {
  assert.deepEqual(splitReply('好的。', { split: { enabled: true, minChars: 24 } }), ['好的。']);
  const text = '第一句话。第二句话！';
  assert.deepEqual(splitReply(text, { split: { enabled: false, minChars: 1 } }), [text]);
});

test('splitReply 尾段过短会并进上一段', () => {
  const segments = splitReply('一二三四五六七八九十。嗯。', { split: { enabled: true, minChars: 8, maxSegments: 5 } });
  assert.equal(segments.length, 1);
});

test('splitReply 优先采用模型给的 --- 标记', () => {
  const text = '第一条消息\n---\n第二条消息\n---\n第三条消息';
  assert.deepEqual(splitReply(text, { split: { enabled: true, minChars: 1, maxSegments: 5 } }), [
    '第一条消息',
    '第二条消息',
    '第三条消息',
  ]);
  // 超过上限时并进最后一条，不丢内容
  const capped = splitReply(text, { split: { enabled: true, minChars: 1, maxSegments: 2 } });
  assert.equal(capped.length, 2);
  assert.equal(capped.join(''), '第一条消息第二条消息第三条消息');
});

test('splitReply 拆称呼：句首称呼单独成条', () => {
  const segments = splitReply('张落晓，你校服脱了吧。', {
    split: { enabled: true, minChars: 1, maxSegments: 3, vocative: true },
  });
  assert.deepEqual(segments, ['张落晓，', '你校服脱了吧。']);
  // 关掉就不是这样
  const plain = splitReply('张落晓，你校服脱了吧。', { split: { enabled: true, minChars: 1, maxSegments: 3 } });
  assert.deepEqual(plain, ['张落晓，你校服脱了吧。']);
});

test('stripNarration 去掉旁白、动作与引号', () => {
  // 括号内容整段丢弃（那就是旁白），引号只拆壳
  assert.equal(stripNarration('（她别过头）少废话。"走吧。"'), '少废话。走吧。');
  assert.equal(stripNarration('*叹气*「随你。」'), '随你。');
  assert.equal(stripNarration('【提示】你好'), '你好');
});

test('applyEmoticons 每 2–3 句补一个颜文字', () => {
  const text = '第一句。第二句。第三句。第四句。第五句。第六句。';
  const once = applyEmoticons(text, { text: { emoticon: { enabled: true, minSentences: 2, maxSentences: 2 } } }, () => 0);
  // 每 2 句一个 → 「第一句。(￣▽￣)第二句。第三句。(￣▽￣)…」
  assert.equal((once.match(/\((￣▽￣|・ω・|｡･ω･｡)\)/g) ?? []).length, 3);
  assert.ok(once.startsWith('第一句。'));
  // 关闭时原样返回
  assert.equal(applyEmoticons(text, { text: { emoticon: { enabled: false } } }), text);
});

test('normalizeConfig 读取写作风格与文本处理开关', () => {
  const config = normalizeConfig({
    prompt: { style: 'classical', shortAnswers: true, codingMode: true },
    text: { dialogOnly: true, emoticon: { enabled: true, minSentences: 5, maxSentences: 9 } },
    split: { auto: true, vocative: true },
  });
  assert.equal(config.prompt.style, 'classical');
  assert.equal(config.prompt.shortAnswers, true);
  assert.equal(config.prompt.codingMode, true);
  assert.equal(config.text.dialogOnly, true);
  assert.equal(config.text.emoticon.minSentences, 5);
  assert.equal(config.split.auto, true);
  assert.equal(normalizeConfig({ prompt: { style: '乱写' } }).prompt.style, 'off');
});
