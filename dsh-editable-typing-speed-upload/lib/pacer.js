/**
 * 决策层：给定一个聊天的状态、当前回复文本，算出「这条消息现在该不该等、等多久」。
 * 纯函数（除了会写 anchoredAt 这一个标记），方便用假数据测时。
 */

import { computeReadDelayMs, computeSegmentGapMs } from './engine.js';

/** 用户消息之后这么久之内发出的回复，算“刚读到这条消息” → 走读延迟。 */
export const TURN_READ_WINDOW_MS = 120_000;
/** 上一条发出之后这么久之内的下一条，算同一次回话的后续分段 → 走段间隔。 */
export const BURST_WINDOW_MS = 60_000;

/**
 * @returns {{ delayMs: number, kind: 'read' | 'gap' | 'none', plannedMs: number }}
 *   delayMs 是“现在还需要再等多久”（已扣掉已经过去的时间），plannedMs 是计划总量。
 */
export function planPacing({ state, config, textLength, now = Date.now(), random = Math.random }) {
  const chat = state ?? {};
  const inboundAt = chat.inboundAt;
  const inboundLen = chat.inboundLen ?? 0;

  // ① 读延迟：这条回复是不是在回应一条 2 分钟内的用户消息，且该消息还没被“认领”过。
  const freshInbound = typeof inboundAt === 'number' && now - inboundAt <= TURN_READ_WINDOW_MS;
  const anchored = chat.anchoredAt ?? 0;
  const unclaimed = typeof inboundAt === 'number' && inboundAt > anchored;

  if (freshInbound && unclaimed && config.readDelay.enabled) {
    chat.anchoredAt = inboundAt;
    const plannedMs = computeReadDelayMs({
      readDelay: config.readDelay,
      userTextLength: inboundLen,
      random,
    });
    const elapsed = Math.max(0, now - inboundAt);
    return { delayMs: Math.max(0, plannedMs - elapsed), kind: 'read', plannedMs };
  }

  // ② 段间隔：同一批回话里，上一条刚发出去不久 → 像“正在打下一条”。
  const lastOutboundAt = chat.lastOutboundAt;
  if (
    config.segmentGap.enabled
    && typeof lastOutboundAt === 'number'
    && now - lastOutboundAt <= BURST_WINDOW_MS
  ) {
    const plannedMs = computeSegmentGapMs({
      segmentGap: config.segmentGap,
      segmentTextLength: textLength,
      random,
    });
    const elapsed = Math.max(0, now - lastOutboundAt);
    return { delayMs: Math.max(0, plannedMs - elapsed), kind: 'gap', plannedMs };
  }

  return { delayMs: 0, kind: 'none', plannedMs: 0 };
}
