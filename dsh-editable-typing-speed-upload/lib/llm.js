/**
 * 用宿主的 llm 服务把「英文原文」译成中文（转译档）。
 *
 * 设计原则：这一步只负责把英文变中文——失败（服务缺失、没选模型、超时）就返回
 * undefined，调用方宁可原样发英文，也不能丢消息。每调用一次就是一次额外模型请求，
 * token 消耗会翻倍，所以默认关闭并在面板上警告。
 */

import { TRANSLATE_TO_CHINESE_PROMPT } from './engine.js';

/** 判断一段文本是否基本是英文（用于避免把中文再"翻译"一遍）。 */
export function looksEnglish(text) {
  if (typeof text !== 'string' || text.trim().length === 0) return false;
  const letters = (text.match(/[A-Za-z]/g) ?? []).length;
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  return letters > 0 && cjk * 2 < letters;
}

/** 把英文译成中文；失败返回 undefined。 */
export async function translateToChinese({ llm, selection, text, signal }) {
  if (!llm || typeof llm.stream !== 'function') return undefined;
  if (!looksEnglish(text)) return undefined;
  const provider = selection?.provider;
  const model = selection?.model;
  if (!provider || !model) return undefined;

  let out = '';
  try {
    const stream = llm.stream({
      provider,
      model,
      system: TRANSLATE_TO_CHINESE_PROMPT,
      messages: [{ role: 'user', content: [{ type: 'text', text }] }],
      temperature: 0.3,
      maxTokens: 1500,
      signal,
      // 标记内部调用，避免被我们自己的输出加工瀑布再次拦截（会无限递归）。
      __dshEditableTypingSpeedInternal: true,
    });
    for await (const chunk of stream) {
      if (chunk?.type === 'text-delta') out += chunk.text;
      else if (chunk?.type === 'finish' && chunk.reason?.kind === 'error') return undefined;
    }
  } catch {
    return undefined;
  }
  const trimmed = out.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
