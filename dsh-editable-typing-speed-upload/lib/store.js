/**
 * 每个会话（聊天）的节奏状态。跨插件代际共享：配置编辑会让插件重启，重启后
 * 不能把“刚刚才回过话”这件事忘掉，否则读延迟会重复触发。
 *
 * 状态挂在 globalThis 的一个 Symbol 上，URL 换代（HMR / 重装）也不会丢。
 */

const STATE_KEY = Symbol.for('dsh-editable-typing-speed.state');

function emptyState() {
  return {
    /** chatKey -> { inboundAt, inboundLen, anchoredAt, lastOutboundAt } */
    chats: new Map(),
    /** 统计，只用于 /pacing 与 status 展示 */
    stats: {
      readDelays: 0,
      segmentGaps: 0,
      segmentsSent: 0,
      messagesSplit: 0,
      bypassed: 0,
      lastError: '',
      lastPacingAt: 0,
    },
    /** 已安装的渠道适配器状态：channel -> { patched, detail, since } */
    adapters: new Map(),
  };
}

export function pacingState() {
  let state = globalThis[STATE_KEY];
  if (!state) {
    state = emptyState();
    globalThis[STATE_KEY] = state;
  }
  return state;
}

const RUNTIME_KEY = Symbol.for('dsh-editable-typing-speed.runtime');

/**
 * 跨代际的「当前配置」。
 *
 * 补丁只会在第一次安装时包上渠道 SDK 的原型方法，那些包层会一直闭包着第一代
 * 的 bag；所以包层不能读「自己这一代的配置」，只能读这份共享的 `current`。
 * 这样改配置（插件重启）后新配置立刻生效，卸载/禁用时把 `enabled` 置 false
 * 也就立刻停止介入——不必重启宿主。
 */
export function pacingRuntime() {
  let runtime = globalThis[RUNTIME_KEY];
  if (!runtime) {
    runtime = { current: { enabled: false, channels: { qq: true } } };
    globalThis[RUNTIME_KEY] = runtime;
  }
  return runtime;
}

export function chatKey(scope, targetId) {
  return `${scope ?? 'unknown'}:${targetId ?? 'unknown'}`;
}

/** 记录一条用户来消息：读延迟的起点与“这条消息多长”。 */
export function noteInbound(state, key, textLength, now = Date.now()) {
  const chat = state.chats.get(key) ?? {};
  chat.inboundAt = now;
  chat.inboundLen = Math.max(0, Number(textLength) || 0);
  state.chats.set(key, chat);
  trimChats(state);
  return chat;
}

export function getChat(state, key) {
  return state.chats.get(key) ?? {};
}

export function noteOutbound(state, key, now = Date.now()) {
  const chat = state.chats.get(key) ?? {};
  chat.lastOutboundAt = now;
  state.chats.set(key, chat);
  return chat;
}

/** 聊天表最多留 200 条，避免长期运行无限增长（按最后活动时间淘汰）。 */
function trimChats(state, limit = 200) {
  if (state.chats.size <= limit) return;
  const entries = [...state.chats.entries()].sort(
    (a, b) => (b[1].lastOutboundAt ?? b[1].inboundAt ?? 0) - (a[1].lastOutboundAt ?? a[1].inboundAt ?? 0),
  );
  state.chats = new Map(entries.slice(0, limit));
}
