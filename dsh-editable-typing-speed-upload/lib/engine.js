/**
 * 纯函数层：拟人化节奏的全部算术都在这里，不碰任何 Node API、不碰渠道 SDK。
 *
 * 三个可调项对应三件真人会做的事：
 *   readDelay    收到消息到开始回话之间的「读消息」时间（随机 + 按字数折算阅读速度）
 *   segmentGap   一条回话拆成几条时，两条之间「正在打下一条」的停顿（随机 + 按字数折算打字速度）
 *   splitReply   一条回话怎么被拆成几条（按句子 / 段落，受上限约束）
 *
 * 单位统一用毫秒；随机一律 uniform(min, max)，由调用方注入 random 以便测试可复现。
 */

/** 读延迟上限：超过 5 分钟就不像“读消息慢”，而像掉线了。 */
export const READ_DELAY_ABS_MAX_MS = 300_000;
/** 段间隔上限：两条消息之间最多 30 秒。 */
export const SEGMENT_GAP_ABS_MAX_MS = 30_000;
/** 阅读 / 打字速度上限（字/秒），再快就等价于不加项。 */
export const CHARS_PER_SECOND_MAX = 1000;
/** 拆段数量上限，防止一条长文变成刷屏。 */
export const MAX_SEGMENTS_MAX = 20;

export const DEFAULTS = Object.freeze({
  /** 总开关：关掉后一切原样透传，插件完全不介入。 */
  enabled: false,
  /** 按渠道的总闸，未列出的渠道视为关闭。 */
  channels: Object.freeze({
    qq: true,
  }),
  readDelay: Object.freeze({
    enabled: true,
    /** 反应时间：看到消息到开始读的固定停顿（不随机）。 */
    baseMs: 400,
    /** 阅读速度区间（字/秒）：每回合在上限/下限之间随机取一个速度。 */
    minCharsPerSecond: 6,
    maxCharsPerSecond: 10,
    /** 单回合读延迟封顶（含按字数折算项）。 */
    maxTotalMs: 20_000,
  }),
  segmentGap: Object.freeze({
    enabled: true,
    /** 打下一条之前的固定停顿（不随机）。 */
    baseMs: 200,
    /** 打字速度区间（字/秒）：每接一条在上限/下限之间随机取一个速度。 */
    minCharsPerSecond: 10,
    maxCharsPerSecond: 16,
    /** 单次段间隔封顶（含按字数折算项）。 */
    maxTotalMs: 9000,
  }),
  split: Object.freeze({
    enabled: true,
    /** 短于这个长度的回复不拆，避免“好的。”也被拆成三条。 */
    minChars: 24,
    /** 最多拆几条。QQ 被动回复对同一条消息的 msg_seq 有条数限制，别贪多。 */
    maxSegments: 3,
    /** 按句末标点拆。 */
    sentences: true,
    /** 按空行（段落）拆。 */
    paragraphs: true,
    /** 代码块 / 表格整条不拆：拆开就废了。 */
    protectCodeAndTables: true,
    /** 让模型自己判别拆不拆（提示词要求用 `---` 分隔；失败回落本地规则）。 */
    auto: false,
    /** 把句首的称呼单独拆成一条（「张落晓。」一条，「你别磨叽。」另一条）。 */
    vocative: false,
  }),
  /** 输出前的文本处理。 */
  text: Object.freeze({
    /** 只留对话：去掉（旁白）／*动作*／【】并拆掉成对引号。 */
    dialogOnly: false,
    /** 每 2–3 句补一个颜文字。 */
    emoticon: Object.freeze({
      enabled: false,
      minSentences: 2,
      maxSentences: 3,
    }),
  }),
  /**
   * 写作风格：通过系统提示让模型换个「原文语言」写。
   * off=关；translate=模型原文写英文、插件译回中文再发；classical=原文直接写文言；
   * classicalDual=原文写文言并附白话译文。
   * 会全局生效（同 Host 所有会话），`/编码模式` 可关闭。
   */
  prompt: Object.freeze({
    style: 'off',
    /** 回答简短：提示模型一两句说完。 */
    shortAnswers: false,
    /** 编码模式：暂不注入任何写作提示（/编码模式 打开，/拟人模式 关闭）。 */
    codingMode: false,
  }),
});

function finite(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * 归一化「固定反应时间 + 速度区间」这一对参数。
 *
 * 随机只发生在**速度**上：每回合从 [minCharsPerSecond, maxCharsPerSecond] 里随机取一个速度，
 * 时间由「字数 ÷ 速度」得出；baseMs 是固定的反应停顿，不参与随机。
 *
 * 兼容旧配置（v0.2.x）：旧的 minMs/maxMs 随机窗口 + 单一 charsPerSecond。
 *   baseMs         ← 旧 minMs（保底停顿）
 *   速度区间       ← 旧 charsPerSecond 的 0.6x–1.4x（给出浮动空间；0 表示不按字数）
 */
function normalizeTiming(range, fallback, absMax, totalFallback) {
  const source = range && typeof range === 'object' && !Array.isArray(range) ? range : {};
  const legacyBase = finite(source.minMs, undefined);
  const baseSource = finite(source.baseMs, legacyBase);
  let baseMs = clamp(finite(baseSource, fallback.baseMs), 0, absMax);

  const legacySpeed = finite(source.charsPerSecond, undefined);
  let minSpeed;
  let maxSpeed;
  if (source.minCharsPerSecond !== undefined || source.maxCharsPerSecond !== undefined) {
    minSpeed = finite(source.minCharsPerSecond, fallback.minCharsPerSecond);
    maxSpeed = finite(source.maxCharsPerSecond, fallback.maxCharsPerSecond);
  } else if (legacySpeed !== undefined) {
    minSpeed = legacySpeed <= 0 ? 0 : Math.round(legacySpeed * 0.6 * 10) / 10;
    maxSpeed = legacySpeed <= 0 ? 0 : Math.round(legacySpeed * 1.4 * 10) / 10;
  } else {
    minSpeed = fallback.minCharsPerSecond;
    maxSpeed = fallback.maxCharsPerSecond;
  }
  minSpeed = clamp(minSpeed, 0, CHARS_PER_SECOND_MAX);
  maxSpeed = clamp(maxSpeed, 0, CHARS_PER_SECOND_MAX);
  if (minSpeed > maxSpeed) [minSpeed, maxSpeed] = [maxSpeed, minSpeed];

  let maxTotalMs = clamp(finite(source.maxTotalMs, totalFallback), 0, absMax);
  if (maxTotalMs < baseMs) maxTotalMs = baseMs;
  return {
    enabled: source.enabled !== false,
    baseMs,
    minCharsPerSecond: minSpeed,
    maxCharsPerSecond: maxSpeed,
    maxTotalMs,
  };
}

/**
 * 宽松归一化：磁盘 / 命令行 / HTTP 传来的半截配置一律补全，越界钳制，反向区间自动调换。
 * 永远返回一份完整配置，调用方不需要再判空。
 */
export function normalizeConfig(partial) {
  const source = partial && typeof partial === 'object' && !Array.isArray(partial) ? partial : {};
  const channelsSource = source.channels && typeof source.channels === 'object' ? source.channels : {};
  const splitSource = source.split && typeof source.split === 'object' ? source.split : {};
  const splitFallback = DEFAULTS.split;
  const textSource = source.text && typeof source.text === 'object' ? source.text : {};
  const emoticonSource = textSource.emoticon && typeof textSource.emoticon === 'object' ? textSource.emoticon : {};
  const emoticonFallback = DEFAULTS.text.emoticon;
  const promptSource = source.prompt && typeof source.prompt === 'object' ? source.prompt : {};
  return {
    enabled: source.enabled === true,
    channels: {
      qq: (channelsSource.qq ?? DEFAULTS.channels.qq) !== false,
    },
    readDelay: normalizeTiming(source.readDelay, DEFAULTS.readDelay, READ_DELAY_ABS_MAX_MS, DEFAULTS.readDelay.maxTotalMs),
    segmentGap: normalizeTiming(
      source.segmentGap,
      DEFAULTS.segmentGap,
      SEGMENT_GAP_ABS_MAX_MS,
      DEFAULTS.segmentGap.maxTotalMs,
    ),
    split: {
      enabled: splitSource.enabled !== false,
      minChars: clamp(finite(splitSource.minChars, splitFallback.minChars), 0, 10_000),
      maxSegments: clamp(
        Math.round(finite(splitSource.maxSegments, splitFallback.maxSegments)),
        1,
        MAX_SEGMENTS_MAX,
      ),
      sentences: splitSource.sentences !== false,
      paragraphs: splitSource.paragraphs !== false,
      protectCodeAndTables: splitSource.protectCodeAndTables !== false,
      auto: splitSource.auto === true,
      vocative: splitSource.vocative === true,
    },
    text: {
      dialogOnly: textSource.dialogOnly === true,
      emoticon: {
        enabled: emoticonSource.enabled === true,
        minSentences: clamp(Math.round(finite(emoticonSource.minSentences, emoticonFallback.minSentences)), 1, 20),
        maxSentences: clamp(Math.round(finite(emoticonSource.maxSentences, emoticonFallback.maxSentences)), 1, 20),
      },
    },
    prompt: {
      style: STYLE_MODES.includes(promptSource.style) ? promptSource.style : 'off',
      shortAnswers: promptSource.shortAnswers === true,
      codingMode: promptSource.codingMode === true,
      /** 哪些会话被 /coding 标记过：插件重装/重启后按这个列表重新挂遮蔽。 */
      codingSessions: Array.isArray(promptSource.codingSessions)
        ? [...new Set(promptSource.codingSessions.filter((id) => typeof id === 'string' && id.length > 0))].slice(0, 50)
        : [],
    },
  };
}

/** 写作风格档位：关闭 / 英文原文+回译 / 文言 / 文言+白话。 */
export const STYLE_MODES = Object.freeze(['off', 'translate', 'classical', 'classicalDual']);

/** 注进系统提示的写作要求（按档位）。 */
export const STYLE_PROMPTS = Object.freeze({
  translate:
    '这一轮请用英文写完你的回复（英文是你的原文，读者会看到它被翻译后的中文）。只输出英文正文，不要附中文、不要解释。',
  classical: '这一轮请直接用文言文回复。只输出文言文正文，不要加白话翻译、不要解释。',
  classicalDual:
    '这一轮请先用文言文写回复，再在下一段给出信达雅的白话译文，两段之间单独一行写 `——`。不要解释、不要加标题。',
});

/** 让模型按 IM 节奏自己分段时的要求（配合 splitReply 的 `---` 解析）。 */
export const AUTO_SPLIT_PROMPT =
  '如果一条回复要分成几条消息发送，请用独占一行的 `---` 分隔；每条是一个完整意思。';

/** 回答简短的提示。 */
export const SHORT_ANSWER_PROMPT = '回答尽量简短：一两句话说完，不要长篇解释。';

/** 把一次翻译英文原文的指令（转译档用）。 */
export const TRANSLATE_TO_CHINESE_PROMPT =
  '把下面的英文翻译成自然、口语化的中文，保留说话人的语气和情绪，不要解释、不要总结、只输出译文。';

/** 让模型自己拆条时用的分隔标记。 */
export const SEGMENT_MARKER = '---';

/** 颜文字池（ASCII 安全，避免平台渲染问题）。 */
const KAOMOJI = Object.freeze([
  '(￣▽￣)', '(・ω・)', '(｡･ω･｡)', '(￣ー￣)', '(´・ω・`)', '(=ω=)', '(๑•̀ㅂ•́)و', '(・∀・)', '(￣^￣)', '(＾▽＾)',
]);

/**
 * 可见字数：去掉围栏代码的语法壳、图片、链接目标、行内标记，空白折叠。
 * 只用来给阅读 / 打字时长按比例放大，不需要精确。
 */
export function visibleLength(text) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  const out = text
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```[^\n]*\n?/g, ''))
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_~>#]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(out).length;
}

function uniform(min, max, random) {
  if (!(max > min)) return min;
  return min + random() * (max - min);
}

/** 在速度区间里随机取一个速度；两端都是 0 表示「不按字数折算」。 */
function pickSpeed(cfg, random) {
  if (cfg.maxCharsPerSecond <= 0) return 0;
  return uniform(cfg.minCharsPerSecond, cfg.maxCharsPerSecond, random);
}

/**
 * 阶段①：读消息要多久。
 * speed  = uniform(阅读速度下限, 上限)                   —— 随机只发生在速度上
 * read   = 用户消息可见字数 / speed * 1000
 * result = min(固定反应时间 + read, maxTotalMs)
 */
export function computeReadDelayMs({ readDelay, userTextLength = 0, random = Math.random } = {}) {
  const cfg = normalizeConfig({ readDelay }).readDelay;
  if (!cfg.enabled) return 0;
  const length = Math.max(0, finite(userTextLength, 0));
  const speed = pickSpeed(cfg, random);
  const readingMs = speed > 0 ? (length / speed) * 1000 : 0;
  return Math.min(cfg.baseMs + readingMs, cfg.maxTotalMs);
}

/**
 * 阶段②：打下一条要多久。
 * speed  = uniform(打字速度下限, 上限)                   —— 随机只发生在速度上
 * typing = 这条消息可见字数 / speed * 1000
 * result = min(固定停顿 + typing, maxTotalMs)
 */
export function computeSegmentGapMs({ segmentGap, segmentTextLength = 0, random = Math.random } = {}) {
  const cfg = normalizeConfig({ segmentGap }).segmentGap;
  if (!cfg.enabled) return 0;
  const length = Math.max(0, finite(segmentTextLength, 0));
  const speed = pickSpeed(cfg, random);
  const typingMs = speed > 0 ? (length / speed) * 1000 : 0;
  return Math.min(cfg.baseMs + typingMs, cfg.maxTotalMs);
}

/** 拆句用的切点：句末标点之后，以及空行之前。切点只记录位置，原文一字不改。 */
function toUnits(text, { sentences, paragraphs }) {
  if (!sentences && !paragraphs) return [text];
  const cuts = new Set();
  if (sentences) {
    for (const match of text.matchAll(/[。！？!?…]+/gu)) {
      cuts.add(match.index + match[0].length);
    }
  }
  if (paragraphs) {
    for (const match of text.matchAll(/\n{2,}/gu)) {
      cuts.add(match.index);
    }
  }
  const points = [...cuts].filter((point) => point > 0 && point < text.length).sort((a, b) => a - b);
  if (points.length === 0) return [text];
  const units = [];
  let cursor = 0;
  for (const point of points) {
    units.push(text.slice(cursor, point));
    cursor = point;
  }
  units.push(text.slice(cursor));
  return units;
}

function looksLikeCodeOrTable(text) {
  return /```/.test(text) || /^\s*\|.*\|\s*$/m.test(text);
}

/** 模型用独占一行的 `---` 自己分段时，优先采用它的划分。 */
export function splitByMarkers(text) {
  if (typeof text !== 'string') return [];
  return text
    .split(/^[ \t]*---+[ \t]*$/m)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** 超出上限的部分并进最后一条，绝不丢内容。 */
function capSegments(list, maxSegments) {
  if (list.length <= maxSegments) return list;
  const head = list.slice(0, maxSegments - 1);
  const tail = list.slice(maxSegments - 1).join('');
  return [...head, tail];
}

/** 把句首称呼（「张落晓，」「喂，」）单独拆成一条。受上限保护。 */
function splitVocatives(list, maxSegments) {
  const out = [];
  for (const segment of list) {
    const match = /^([^\s，,。！？!?…、]{1,6})([，,。！？!?…]+)\s*(\S[\s\S]*)$/u.exec(segment);
    if (match && out.length + 2 <= maxSegments) {
      out.push(`${match[1]}${match[2]}`);
      out.push(match[3].trim());
    } else {
      out.push(segment);
    }
  }
  return out;
}

/**
 * 只留对话：去掉（旁白）／（动作）／【提示】／[方括号]／*动作*，并拆掉成对引号只留内容。
 * 用于「像评论一样只输出实际对话」的模式。
 */
export function stripNarration(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/（[^）]*）/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/【[^】]*】/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\*[^*\n]+\*/g, '')
    .replace(/「([^」]*)」/g, '$1')
    .replace(/“([^”]*)”/g, '$1')
    .replace(/"([^"\n]*)"/g, '$1')
    .replace(/[ \t]+/g, ' ')
    .replace(/^[ \t]+|[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function pickEmoticonInterval(cfg, random) {
  if (cfg.maxSentences <= cfg.minSentences) return cfg.minSentences;
  return Math.floor(cfg.minSentences + random() * (cfg.maxSentences - cfg.minSentences + 1));
}

/** 每 2–3 句（可调）补一个颜文字；只在文本处理开启时生效。 */
export function applyEmoticons(text, config, random = Math.random) {
  const cfg = normalizeConfig(config).text.emoticon;
  const source = typeof text === 'string' ? text : '';
  if (!cfg.enabled || source.trim().length === 0) return source;
  const units = toUnits(source, { sentences: true, paragraphs: false });
  let sinceLast = 0;
  let target = pickEmoticonInterval(cfg, random);
  const out = units.map((unit) => {
    if (unit.trim().length === 0) return unit;
    sinceLast += 1;
    if (sinceLast < target) return unit;
    sinceLast = 0;
    target = pickEmoticonInterval(cfg, random);
    const kaomoji = KAOMOJI[Math.min(KAOMOJI.length - 1, Math.floor(random() * KAOMOJI.length))];
    return `${unit.replace(/\s+$/u, '')}${kaomoji}`;
  });
  return out.join('');
}

/**
 * 把一条回复拆成多条。返回数组（长度 ≥ 1，且每项非空）。
 * 优先级：模型自带分隔标记 > 本地按句/段拆 > 称呼单独拆。
 * 任何一项可疑（含代码块 / 表格、太短、拆不出）时整条不拆，宁可少拆不可拆坏。
 */
export function splitReply(text, config) {
  const cfg = normalizeConfig(config).split;
  const source = typeof text === 'string' ? text : '';
  if (!cfg.enabled || cfg.maxSegments <= 1) return [source];
  if (source.trim().length === 0) return [source];
  if (cfg.protectCodeAndTables && looksLikeCodeOrTable(source)) return [source];

  const marked = splitByMarkers(source);
  if (marked.length > 1) return capSegments(marked, cfg.maxSegments);

  if (visibleLength(source) < cfg.minChars) return [source];

  const units = toUnits(source, cfg)
    .map((unit) => unit.trim())
    .filter((unit) => unit.length > 0);
  if (units.length <= 1) {
    return cfg.vocative ? splitVocatives([source], cfg.maxSegments) : [source];
  }

  // 均匀分组：每组约占 ceil(units / maxSegments) 个句子单元。
  const groupSize = Math.max(1, Math.ceil(units.length / cfg.maxSegments));
  const groups = [];
  for (let index = 0; index < units.length; index += groupSize) {
    groups.push(units.slice(index, index + groupSize).join(''));
  }
  // 尾巴太短就并进上一组，别让最后一条只剩两个字的“嗯”。
  if (groups.length > 1 && visibleLength(groups.at(-1)) < Math.max(4, cfg.minChars / 3)) {
    const tail = groups.pop();
    groups[groups.length - 1] = `${groups.at(-1)}${tail}`;
  }
  const result = groups.length > 1 ? groups : [source];
  return cfg.vocative ? splitVocatives(result, cfg.maxSegments) : result;
}

/** 睡眠；被 abort 时立刻以 signal.reason 拒绝，便于回合被打断时不再继续发。 */
export function abortableSleep(ms, signal) {
  if (!(ms > 0)) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('aborted'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('aborted'));
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}
