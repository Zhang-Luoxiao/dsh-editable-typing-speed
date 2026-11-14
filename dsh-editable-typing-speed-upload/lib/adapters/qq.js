/**
 * QQ 渠道适配器。
 *
 * 为什么打补丁而不是自己发：dsh-im 的 QQ 桥把出站文字全部汇到 SDK 的
 * `QQBot.prototype.send / sendText / sendMarkdown`，入站全部经过 `bot.on('message')`。
 * 在这几个原型方法上包一层，既不改 dsh-im、也不改它的配置，dsh-im 升级后照旧生效。
 *
 * 打补丁的三条纪律：
 *   1. 幂等：原型上留标记，重复 apply / HMR 不会套第二层；
 *   2. 自愈：宿主重载可能换掉类，指数级重探由 index.js 定时器负责；
 *   3. 失败即放行：任何异常都不能把回复吞掉，宁可回到原始发送。
 */

import { abortableSleep, splitReply, visibleLength } from '../engine.js';
import { planPacing } from '../pacer.js';
import { importExternal } from '../resolve.js';
import { chatKey, getChat, noteInbound, noteOutbound } from '../store.js';

export const CHANNEL = 'qq';
const SDK = '@tencent-connect/qqbot-nodejs';
const MARK = Symbol.for('dsh-editable-typing-speed.qq');

/** 总闸 + 本渠道闸，两个都开才介入。 */
export function isPacingEnabled(config, channel = CHANNEL) {
  return config?.enabled === true && config?.channels?.[channel] !== false;
}

function mark(proto, key) {
  const current = proto[MARK] ?? {};
  current[key] = true;
  proto[MARK] = current;
}

function isMarked(proto, key) {
  return proto[MARK]?.[key] === true;
}

/**
 * 入站：记录“这条用户消息多长、什么时候来的”，读延迟从这一刻起算。
 *
 * 挂在 `emit` 而不是 `on`：SDK 把入站消息最终 `await this.emit('message', ctx, msg)`
 * 投给监听器，而 `emit` 是原型方法——机器人实例在我们装插件之前就建好了也没关系。
 * 这一层还处在 middleware 之后，被访问策略 / @ 规则挡掉的消息不会被记进来。
 */
function patchEmit(proto, { state, log }) {
  if (isMarked(proto, 'emit')) return false;
  const original = proto.emit;
  if (typeof original !== 'function') return false;
  proto.emit = function pacedEmit(event, ...args) {
    if (event === 'message') {
      try {
        const message = args[1] ?? {};
        const target = message.replyTarget ?? {};
        noteInbound(state, chatKey(target.scope, target.targetId), visibleLength(message.content ?? ''));
      } catch (error) {
        log?.warn?.('[dsh-editable-typing-speed:qq] inbound hook failed:', error);
      }
    }
    return original.call(this, event, ...args);
  };
  mark(proto, 'emit');
  return true;
}

/**
 * 发一条之前的等待：新回合走读延迟，同一批回话的后续分段走段间隔。
 * 计时与计数都以 planPacing 的判定为准——它已经扣掉了“已经过去的时间”。
 */
async function paceOnce({ state, getConfig, key, textLength }) {
  const config = getConfig();
  if (!isPacingEnabled(config, CHANNEL)) return;
  const plan = planPacing({ state: getChat(state, key), config, textLength });
  if (plan.delayMs <= 0) return;
  if (plan.kind === 'read') state.stats.readDelays += 1;
  else if (plan.kind === 'gap') state.stats.segmentGaps += 1;
  else return;
  state.stats.lastPacingAt = Date.now();
  await abortableSleep(plan.delayMs);
}

/**
 * 统一的出站流程：读延迟 → 拆段 → 每段各自的段间隔 → 每条发出后记时间。
 * `rebuild(args, segment, index)` 负责把第 index 段塞回该方法的原始参数形状。
 */
async function runPaced({ bot, original, args, text, target, rebuild, state, getConfig, log, runtime }) {
  const config = getConfig();
  const key = chatKey(target?.scope, target?.targetId);

  // 先做文本处理（只留对话 / 去 AI 味改写 / 颜文字），失败一律回落原文。
  let outgoing = text;
  if (typeof runtime?.transform === 'function') {
    try {
      const transformed = await runtime.transform(text);
      if (typeof transformed === 'string' && transformed.trim().length > 0) outgoing = transformed;
    } catch (error) {
      log?.warn?.('[dsh-editable-typing-speed:qq] transform failed, sending original:', error);
    }
  }

  await paceOnce({ state, getConfig, key, textLength: visibleLength(outgoing) });

  const segments = splitReply(outgoing, config);
  if (segments.length <= 1) {
    const result = await original.apply(bot, rebuild(args, outgoing, 0));
    noteOutbound(state, key);
    return result;
  }

  state.stats.messagesSplit += 1;
  let last;
  for (let index = 0; index < segments.length; index += 1) {
    if (index > 0) {
      await paceOnce({ state, getConfig, key, textLength: visibleLength(segments[index]) });
    }
    try {
      last = await original.apply(bot, rebuild(args, segments[index], index));
      state.stats.segmentsSent += 1;
      noteOutbound(state, key);
    } catch (error) {
      state.stats.lastError = String(error?.message ?? error);
      log?.warn?.('[dsh-editable-typing-speed:qq] segment delivery failed:', error);
      // 第一条都发不出去：把错误交回上层，让 dsh-im 自己走它的失败路径。
      if (index === 0) throw error;
      break;
    }
  }
  return last;
}

function withMsgSeq(extra, index) {
  if (!extra || typeof extra !== 'object') return extra;
  const seq = Number(extra.msg_seq);
  if (!Number.isFinite(seq)) return extra;
  return { ...extra, msg_seq: (Math.trunc(seq) + index) & 0xffff };
}

/** `bot.send({ target, msgType, content | markdown })`。 */
function wrapSend(original, { state, getConfig, log }) {
  return async function pacedSend(opts) {
    const config = getConfig();
    if (!isPacingEnabled(config, CHANNEL)) return original.call(this, opts);
    const text = typeof opts?.markdown?.content === 'string' ? opts.markdown.content : opts?.content;
    if (typeof text !== 'string' || text.trim().length === 0) return original.call(this, opts);
    // 媒体 / ark / embed / 带按钮的消息不参与拆段：拆开就废了。
    if (opts?.media || opts?.ark || opts?.embed || opts?.keyboard) return original.call(this, opts);
    if (opts?.msgType !== undefined && opts.msgType !== 0 && opts.msgType !== 2) {
      return original.call(this, opts);
    }
    const isMarkdown = typeof opts?.markdown?.content === 'string';
    return runPaced({
      bot: this,
      original,
      args: [opts],
      text,
      target: opts?.target,
      state,
      getConfig,
      log,
      rebuild: ([base], segment, index) => [
        isMarkdown
          ? { ...base, markdown: { ...base.markdown, content: segment }, extra: withMsgSeq(base.extra, index) }
          : { ...base, content: segment, extra: withMsgSeq(base.extra, index) },
      ],
    });
  };
}

/** `bot.sendText(target, content)`。 */
function wrapSendText(original, { state, getConfig, log }) {
  return async function pacedSendText(target, content, ...rest) {
    const config = getConfig();
    if (!isPacingEnabled(config, CHANNEL)) return original.call(this, target, content, ...rest);
    if (typeof content !== 'string' || content.trim().length === 0) {
      return original.call(this, target, content, ...rest);
    }
    return runPaced({
      bot: this,
      original,
      args: [target, content, ...rest],
      text: content,
      target,
      state,
      getConfig,
      log,
      rebuild: ([targetArg, , ...restArgs], segment) => [targetArg, segment, ...restArgs],
    });
  };
}

/** `bot.sendMarkdown(target, content, opts)`。 */
function wrapSendMarkdown(original, { state, getConfig, log }) {
  return async function pacedSendMarkdown(target, content, opts) {
    const config = getConfig();
    if (!isPacingEnabled(config, CHANNEL)) return original.call(this, target, content, opts);
    if (typeof content !== 'string' || content.trim().length === 0) {
      return original.call(this, target, content, opts);
    }
    // 带按钮的 Markdown 不拆：按钮只属于整条。
    if (opts?.keyboard) return original.call(this, target, content, opts);
    return runPaced({
      bot: this,
      original,
      args: [target, content, opts],
      text: content,
      target,
      state,
      getConfig,
      log,
      rebuild: ([targetArg, , optsArg], segment, index) => [
        targetArg,
        segment,
        { ...optsArg, extra: withMsgSeq(optsArg?.extra, index) },
      ],
    });
  };
}

/**
 * 在一份 QQBot 原型上挂钩子。抽成独立函数，好让测试用假原型跑同一条代码路径。
 * @returns {string[]} 已挂钩的方法名
 */
export function patchPrototype(proto, bag) {
  patchEmit(proto, bag);
  if (typeof proto.send === 'function' && !isMarked(proto, 'send')) {
    proto.send = wrapSend(proto.send, bag);
    mark(proto, 'send');
  }
  if (typeof proto.sendText === 'function' && !isMarked(proto, 'sendText')) {
    proto.sendText = wrapSendText(proto.sendText, bag);
    mark(proto, 'sendText');
  }
  if (typeof proto.sendMarkdown === 'function' && !isMarked(proto, 'sendMarkdown')) {
    proto.sendMarkdown = wrapSendMarkdown(proto.sendMarkdown, bag);
    mark(proto, 'sendMarkdown');
  }
  return ['emit', 'send', 'sendText', 'sendMarkdown'].filter((name) => isMarked(proto, name));
}

/**
 * 安装（或确认已安装）QQ 适配器。
 * @returns {Promise<{ ok: boolean, patched: boolean, detail: string }>}
 */
export async function installQqAdapter({ state, getConfig, log }) {
  let sdk;
  try {
    sdk = await importExternal(SDK);
  } catch (error) {
    return { ok: false, patched: false, detail: `SDK 未安装或无法解析：${error?.detail ?? error?.message ?? error}` };
  }
  const proto = sdk?.QQBot?.prototype;
  if (!proto || typeof proto.send !== 'function') {
    return { ok: false, patched: false, detail: 'SDK 里找不到 QQBot.prototype.send' };
  }

  const bag = { state, getConfig, log };
  const before = ['emit', 'send', 'sendText', 'sendMarkdown'].filter((name) => isMarked(proto, name)).length;
  const methods = patchPrototype(proto, bag);
  const changed = methods.length > before;

  return {
    ok: true,
    patched: true,
    detail: changed ? `已挂钩：${methods.join(' / ')}` : `已在位：${methods.join(' / ')}`,
  };
}
