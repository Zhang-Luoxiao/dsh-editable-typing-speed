/**
 * dsh-editable-typing-speed · 宿主半边
 *
 * 只做一件事：让 IM 机器人的回话节奏像真人——先「读」一会儿，然后一条一条地
 * 「打」出来，条与条之间的停顿带随机浮动。
 *
 * 三个旋钮（全局一份配置，按渠道各有开关）：
 *   readDelay   读消息的时间：随机 min–max + 用户消息字数 / 阅读速度
 *   segmentGap  打下一条的停顿：随机 min–max + 这条回复字数 / 打字速度
 *   split       一条回复怎么拆成几条：按句末标点 / 空行，带上限保护
 *
 * 开关：`/pacing on|off`、`/pacing qq on|off`、设置面板，或 HTTP
 * `POST /dsh-editable-typing-speed/config`。关掉时插件完全不介入，出站调用原样透传。
 */

import {
  AUTO_SPLIT_PROMPT,
  DEFAULTS,
  SHORT_ANSWER_PROMPT,
  STYLE_PROMPTS,
  normalizeConfig,
} from './engine.js';
import { CHANNEL as QQ_CHANNEL, installQqAdapter } from './adapters/qq.js';
import { translateToChinese } from './llm.js';
import { pacingRuntime, pacingState } from './store.js';
import { needsTransform, transformStream } from './writer.js';

export const name = 'dsh-editable-typing-speed';

/** 自愈探针间隔：宿主重载换掉 SDK 类之后，最多这么久补回来。 */
export const HEAL_INTERVAL_MS = 5000;

/** 写作提示在系统提示里的段名；`/编码模式` 用它注册同名的空段来遮蔽。 */
export const PROMPT_SECTION = 'dsh-editable-typing-speed:writing';
export const PROMPT_ORDER = 820;

const CHANNELS = [QQ_CHANNEL];

function mergePatch(base, patch) {
  const next = { ...base, ...patch };
  for (const section of ['channels', 'readDelay', 'segmentGap', 'split', 'text', 'prompt']) {
    if (patch?.[section] && typeof patch[section] === 'object') {
      next[section] = { ...base[section], ...patch[section] };
    }
  }
  if (patch?.text?.emoticon) {
    next.text = { ...base.text, emoticon: { ...base.text.emoticon, ...patch.text.emoticon } };
  }
  if (patch?.channels) {
    next.channels = { ...base.channels, ...patch.channels };
  }
  return next;
}

/** 把当前配置拼成注入系统提示的写作要求；没有任何要求时返回空串。 */
export function buildPromptText(config) {
  if (!config?.prompt || config.prompt.codingMode) return '';
  const lines = [];
  const style = STYLE_PROMPTS[config.prompt.style];
  if (style) lines.push(style);
  if (config.prompt.shortAnswers) lines.push(SHORT_ANSWER_PROMPT);
  if (config.split?.auto) lines.push(AUTO_SPLIT_PROMPT);
  return lines.join('\n');
}

export function apply(ctx, config) {
  const state = pacingState();
  const runtime = pacingRuntime();
  // 每一代 apply 领一张票：卸载时只有「当前这一代」能把共享配置关掉，
  // 避免旧一代的清理晚于新一代的 apply，把刚开起来的节奏又关掉。
  const generation = Symbol('dsh-editable-typing-speed.generation');
  let current = normalizeConfig(config ?? {});
  runtime.current = current;
  runtime.owner = generation;

  const logger = ctx?.logger;
  const log = {
    info: (message, ...rest) => (logger?.info
      ? logger.info(`[dsh-editable-typing-speed] ${message}`, ...rest)
      : console.log('[dsh-editable-typing-speed]', message, ...rest)),
    warn: (message, ...rest) => (logger?.warn
      ? logger.warn(`[dsh-editable-typing-speed] ${message}`, ...rest)
      : console.warn('[dsh-editable-typing-speed]', message, ...rest)),
  };
  const getConfig = () => runtime.current;
  const startedAt = Date.now();

  // 先声明清理容器：后面很多注册发生在 apply 早期，不能晚于它们。
  const disposers = [];
  const promptShadows = new Map();
  function addDisposer(disposer) {
    if (typeof disposer === 'function') disposers.push(disposer);
  }

  // ---- 生成层文本加工：Web 与 QQ 看到同一份处理过的文本 -----------------
  // 只留对话 / 加颜文字 / 英文原文→中文 都放在这里，而不是 IM 出站口，
  // 这样「完整输出」才成立（Web 里也能看到翻译后的中文）。
  runtime.transform = async (text) => text; // 兼容旧出站钩子：加工已在上游完成

  function service(serviceName) {
    try {
      return typeof ctx?.get === 'function' ? ctx.get(serviceName) : undefined;
    } catch {
      return undefined;
    }
  }

  // 挂在模型输出流上做加工（Web 与 QQ 都经过这里）。
  // 优先用 llm/stream 事件；某些宿主版本上该事件的注册会抛错，就退化为包装 llm.stream。
  function wrapStream(options, upstream) {
    // 我们自己发起的翻译请求不能再被拦一次，否则无限递归。
    if (options?.__dshEditableTypingSpeedInternal) return upstream;
    const config = runtime.current;
    if (!needsTransform(config)) return upstream;
    const translate = (text) => translateToChinese({
      llm: service('llm'),
      selection: service('agentDefaultModel')?.currentSelection?.(),
      text,
    });
    return transformStream(upstream, { config, translate, log });
  }

  function installStreamTransform() {
    const llm = service('llm');
    if (!llm) {
      log.warn('没有 llm 服务：生成层文本加工不可用（拆条与节奏不受影响）');
      return 'none';
    }
    try {
      if (typeof ctx?.on === 'function') {
        addDisposer(ctx.on('llm/stream', (options, next) => wrapStream(options, next())));
        return 'event';
      }
    } catch (error) {
      log.warn('llm/stream 事件注册失败，改用包装 llm.stream:', error);
    }
    const original = llm.stream;
    if (typeof original !== 'function') {
      log.warn('llm.stream 不可包装：生成层文本加工不可用');
      return 'none';
    }
    const patched = function patchedStream(options, ...rest) {
      const upstream = original.call(this, options, ...rest);
      return wrapStream(options, upstream);
    };
    llm.stream = patched;
    addDisposer(() => {
      if (llm.stream === patched) llm.stream = original;
    });
    return 'wrap';
  }

  const streamTransformMode = installStreamTransform();

  // ---- 渠道适配器 -------------------------------------------------------
  async function installAdapters() {
    const bag = { state, getConfig, log, runtime };
    for (const channel of CHANNELS) {
      try {
        const result = channel === QQ_CHANNEL
          ? await installQqAdapter(bag)
          : { ok: false, patched: false, detail: '尚未实现' };
        state.adapters.set(channel, { ...result, since: Date.now() });
      } catch (error) {
        state.adapters.set(channel, {
          ok: false,
          patched: false,
          detail: String(error?.message ?? error),
          since: Date.now(),
        });
        log.warn(`${channel} 适配器安装失败:`, error);
      }
    }
  }

  // ---- 配置读写 ---------------------------------------------------------
  function snapshot() {
    const adapters = {};
    for (const [channel, value] of state.adapters) adapters[channel] = { ...value };
    const live = runtime.current;
    return {
      enabled: live.enabled,
      channels: { ...live.channels },
      config: live,
      defaults: DEFAULTS,
      adapters,
      streamTransform: streamTransformMode,
      stats: { ...state.stats },
      activeChats: state.chats.size,
      uptimeMs: Date.now() - startedAt,
    };
  }

  async function persist(next) {
    const entry = ctx?.fiber?.entry;
    const editor = typeof ctx?.get === 'function' ? ctx.get('configEditor') : undefined;
    if (!entry || !editor?.edit) return { saved: false, reason: '当前 profile 没有 configEditor，改动只在本次运行生效' };
    try {
      await editor.edit(entry, (previous) => ({ ...previous, ...next }));
      return { saved: true };
    } catch (error) {
      return { saved: false, reason: String(error?.message ?? error) };
    }
  }

  async function update(patch) {
    current = normalizeConfig(mergePatch(current, patch ?? {}));
    // 先让包层立刻用上新配置，再落盘（落盘会重启插件）。
    runtime.current = current;
    const persisted = await persist(current);
    return { config: current, persisted };
  }

  // ---- /pacing 命令 -----------------------------------------------------
  function statusText() {
    const lines = [
      `拟人化节奏：${current.enabled ? '开' : '关'}`,
      `渠道：${CHANNELS.map((channel) => `${channel}=${current.channels[channel] === false ? '关' : '开'}`).join('  ')}`,
      `读延迟：反应 ${current.readDelay.baseMs / 1000}s + 阅读速度 ${current.readDelay.minCharsPerSecond}–${current.readDelay.maxCharsPerSecond} 字/秒，封顶 ${current.readDelay.maxTotalMs / 1000}s`,
      `段间隔：停顿 ${current.segmentGap.baseMs / 1000}s + 打字速度 ${current.segmentGap.minCharsPerSecond}–${current.segmentGap.maxCharsPerSecond} 字/秒，封顶 ${current.segmentGap.maxTotalMs / 1000}s`,
      `拆条：${current.split.enabled ? `按${current.split.sentences ? '句' : ''}${current.split.paragraphs ? '段' : ''}拆，最多 ${current.split.maxSegments} 条，短于 ${current.split.minChars} 字不拆` : '关'}`,
      `文本处理：只留对话 ${current.text?.dialogOnly ? '开' : '关'} · 颜文字 ${current.text?.emoticon?.enabled ? '开' : '关'}`,
      `写作风格：${({ off: '关', translate: '转译（英文原文→中文）', classical: '文言', classicalDual: '文言+白话' })[current.prompt?.style] ?? '关'} · 简短回答 ${current.prompt?.shortAnswers ? '开' : '关'} · 编码模式 ${current.prompt?.codingMode ? '开' : '关'}（已持久化会话 ${current.prompt?.codingSessions?.length ?? 0} 个）`,
      `已延迟 ${state.stats.readDelays} 次读 / ${state.stats.segmentGaps} 次段间隔，拆出 ${state.stats.messagesSplit} 条回复`,
    ];
    for (const [channel, value] of state.adapters) {
      lines.push(`适配器 ${channel}：${value.patched ? value.detail : `未生效（${value.detail}）`}`);
    }
    lines.push('用法：/pacing on|off|status、/pacing qq on|off、/编码模式、/拟人模式');
    return lines.join('\n');
  }

  async function handleCommand(rawInput) {
    const tokens = String(rawInput ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.length === 0 || tokens[0] === 'status') {
      return { kind: 'success', text: statusText() };
    }
    if (tokens[0] === 'on' || tokens[0] === 'off') {
      const { persisted } = await update({ enabled: tokens[0] === 'on' });
      return {
        kind: 'success',
        text: `拟人化节奏已${tokens[0] === 'on' ? '开启' : '关闭'}。${persisted.saved ? '' : `（${persisted.reason}）`}`,
      };
    }
    if (CHANNELS.includes(tokens[0]) && (tokens[1] === 'on' || tokens[1] === 'off')) {
      await update({ channels: { [tokens[0]]: tokens[1] === 'on' } });
      return { kind: 'success', text: `${tokens[0]} 渠道的节奏已${tokens[1] === 'on' ? '开启' : '关闭'}。` };
    }
    return { kind: 'error', text: `没看懂「${rawInput}」。用法：/pacing on|off|status、/pacing qq on|off` };
  }

  // ---- HTTP 接口 --------------------------------------------------------
  function json(res, status, payload) {
    const body = JSON.stringify(payload, null, 2);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(body);
  }

  async function readJsonBody(req, limit = 64 * 1024) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw new Error('请求体过大');
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8').trim();
    return text.length === 0 ? {} : JSON.parse(text);
  }

  // ---- 生命周期 ---------------------------------------------------------

  // 写作提示：注入系统提示，让模型按选定风格「写原文」。
  // text 是函数，所以改配置立刻生效，不用重新注册。
  try {
    const systemPrompt = typeof ctx?.get === 'function' ? ctx.get('systemPrompt') : undefined;
    if (systemPrompt?.section) {
      addDisposer(systemPrompt.section({
        name: PROMPT_SECTION,
        order: PROMPT_ORDER,
        text: () => buildPromptText(runtime.current),
      }));
    } else {
      log.warn('没有 systemPrompt 服务：写作风格提示不可用（其余功能不受影响）');
    }
  } catch (error) {
    log.warn('注册写作提示失败:', error);
  }

  addDisposer(() => {
    // 卸载 / 禁用：包层还在渠道 SDK 上，把共享配置关掉就等于立刻停手。
    // 只有仍持有所有权的那一代才动手，避免关掉已经接手的新一代。
    if (runtime.owner !== generation) return;
    runtime.current = { ...runtime.current, enabled: false };
    runtime.transform = undefined;
    for (const dispose of promptShadows.values()) {
      try {
        dispose();
      } catch {
        /* 单个会话的作用域清理失败不影响卸载 */
      }
    }
    promptShadows.clear();
    for (const adapter of state.adapters.values()) adapter.patched = false;
  });

  installAdapters().catch((error) => log.warn('适配器安装异常:', error));

  // 路由与命令可能比插件晚就绪（冷启动时 apply 早于 webServer / commands 服务），
  // 所以它们也进自愈探针：谁先出现就先挂上，挂过就不再重复。
  let routesReady = false;
  let commandReady = false;

  function ensureRoutes() {
    if (routesReady) return;
    const webServer = typeof ctx?.get === 'function' ? ctx.get('webServer') : undefined;
    if (!webServer?.register) return;
    try {
      addDisposer(webServer.register({
        kind: 'exact',
        path: '/dsh-editable-typing-speed/status',
        handler: async (req, res) => json(res, 200, snapshot()),
      }));
      addDisposer(webServer.register({
        kind: 'exact',
        path: '/dsh-editable-typing-speed/config',
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            json(res, 405, { error: 'METHOD_NOT_ALLOWED', hint: 'POST 一份部分配置，例如 {"enabled":true}' });
            return;
          }
          try {
            const patch = await readJsonBody(req);
            const { config: next, persisted } = await update(patch);
            json(res, 200, { config: next, persisted, adapters: snapshot().adapters });
          } catch (error) {
            json(res, 400, { error: 'BAD_REQUEST', message: String(error?.message ?? error) });
          }
        },
      }));
      routesReady = true;
    } catch (error) {
      log.warn('注册 HTTP 路由失败:', error);
    }
  }

  function ensureCommand() {
    if (commandReady) return;
    const commands = typeof ctx?.get === 'function' ? ctx.get('commands') : undefined;
    if (!commands?.register) return;
    const register = (definition) => {
      try {
        addDisposer(commands.register(definition));
        return true;
      } catch (error) {
        log.warn(`注册 /${definition.name} 命令失败:`, error);
        return false;
      }
    };
    const ok = register({
      name: 'pacing',
      description: '拟人化节奏开关：/pacing on|off|status、/pacing qq on|off',
      input: { hint: 'on|off|status|<渠道> on|off' },
      handler: async (invocation) => handleCommand(invocation?.rawInput),
    });
    // 命令名只允许 `^[a-z][a-z0-9_-]*$`（CJK 会被宿主直接拒绝），所以用 ascii 名。
    register({
      name: 'coding',
      description: '本会话进入编码模式：不再注入写作风格/简短/拆条提示（对应 /编码模式）',
      handler: async (invocation) => codingMode(invocation, true),
    });
    register({
      name: 'persona',
      description: '本会话恢复拟人模式：重新注入写作提示（对应 /拟人模式）',
      handler: async (invocation) => codingMode(invocation, false),
    });
    if (ok) commandReady = true;
  }

  /** /编码模式 与 /拟人模式：优先生效到「本会话」，并把状态持久化，重装/重启后自动恢复。 */
  async function codingMode(invocation, enabled) {
    const agent = invocation?.agent;
    const sessionId = agent?.id === undefined ? undefined : String(agent.id);
    const scoped = enabled ? enableScopedSuppression(agent, sessionId) : false;

    if (!enabled && sessionId) {
      const dispose = promptShadows.get(sessionId);
      if (dispose) {
        try {
          dispose();
        } catch {
          /* 关闭失败不影响持久化 */
        }
        promptShadows.delete(sessionId);
      }
    }

    // 持久化会话名单：插件重装会 dispose 所有遮蔽，下次 apply 靠这份名单重新挂上。
    const next = new Set(runtime.current.prompt?.codingSessions ?? []);
    if (sessionId !== undefined) {
      if (enabled) next.add(sessionId);
      else next.delete(sessionId);
    }
    const patch = { prompt: { codingSessions: [...next] } };
    if (!enabled) patch.prompt.codingMode = false;
    // 拿不到会话作用域又只勾了会话：退化为全局关闭（否则这条指令完全没效果）。
    if (enabled && !scoped && sessionId === undefined) patch.prompt.codingMode = true;
    const { persisted } = await update(patch);

    if (enabled) {
      return {
        kind: 'success',
        text: scoped || sessionId !== undefined
          ? `本会话已进入编码模式：不再注入写作提示，且已记入持久化名单（重装插件后自动恢复）。${persisted.saved ? '' : `（${persisted.reason}）`}`
          : `拿不到会话信息，已全局关闭写作提示。${persisted.saved ? '' : `（${persisted.reason}）`}输入 /persona 恢复。`,
      };
    }
    return {
      kind: 'success',
      text: `本会话已恢复拟人模式：写作提示重新生效。${persisted.saved ? '' : `（${persisted.reason}）`}`,
    };
  }

  /** 在本会话的作用域里注册一个同名空段，遮蔽全局写作提示。 */
  function enableScopedSuppression(agent, sessionId) {
    const agentCtx = agent?.ctx;
    const section = agentCtx?.systemPrompt?.section;
    if (typeof section !== 'function' || sessionId === undefined) return false;
    try {
      promptShadows.set(sessionId, section({ name: PROMPT_SECTION, order: PROMPT_ORDER, text: '' }));
      return true;
    } catch (error) {
      log.warn('注册会话级写作提示遮蔽失败，退化为全局开关:', error);
      return false;
    }
  }

  /** 插件重装/重启后，按持久化名单给还活着的会话重新挂遮蔽。 */
  function reapplyShadows() {
    const agents = service('agents');
    if (!agents?.get) return;
    for (const sessionId of runtime.current.prompt?.codingSessions ?? []) {
      if (promptShadows.has(sessionId)) continue;
      const agent = agents.get(sessionId);
      if (!agent?.ctx?.systemPrompt?.section) continue;
      try {
        promptShadows.set(sessionId, agent.ctx.systemPrompt.section({ name: PROMPT_SECTION, order: PROMPT_ORDER, text: '' }));
      } catch (error) {
        log.warn('恢复编码模式遮蔽失败:', error);
      }
    }
  }

  reapplyShadows();

  /** 在本会话的作用域里注册一个同名空段，遮蔽全局写作提示。 */
  function enableScopedSuppression(agent, sessionId) {
    const agentCtx = agent?.ctx;
    const section = agentCtx?.systemPrompt?.section;
    if (typeof section !== 'function' || sessionId === undefined) return false;
    try {
      promptShadows.set(sessionId, section({ name: PROMPT_SECTION, order: PROMPT_ORDER, text: '' }));
      return true;
    } catch (error) {
      log.warn('注册会话级写作提示遮蔽失败，退化为全局开关:', error);
      return false;
    }
  }

  ensureRoutes();
  ensureCommand();

  const healTimer = setInterval(() => {
    installAdapters().catch(() => {});
    ensureRoutes();
    ensureCommand();
    reapplyShadows();
  }, HEAL_INTERVAL_MS);
  healTimer.unref?.();
  addDisposer(() => clearInterval(healTimer));

  if (typeof ctx?.effect === 'function') {
    ctx.effect(() => () => {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose();
        } catch {
          /* 收尾失败不影响卸载 */
        }
      }
    });
  }

  log.info(`已加载：${current.enabled ? '开启' : '关闭'}，渠道 ${CHANNELS.join('/')}`);
}
