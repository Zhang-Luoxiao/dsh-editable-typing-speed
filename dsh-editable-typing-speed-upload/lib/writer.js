/**
 * 在**生成层**加工模型输出：只留对话、加颜文字、英文原文→中文。
 *
 * 为什么要放在这一层：这样「完整输出」——Web GUI 与 QQ 看到的是同一份处理过的文本，
 * 消息落库时也已经是最终版本。
 *
 * 成本控制：
 *   - 转译**只对这条回复的最后一段正文**做一次（中间的旁白/工具前导不翻译），
 *     避免每个文本块各发一次模型请求；代价是该回复要等整条生成完才出现。
 *   - 只留对话 / 颜文字是纯文本处理，不花 token，仍然逐块流式。
 *
 * 只处理文本块（text-delta / 带 text 的 block-end），思考块、工具调用、其它块原样透传。
 */

import { applyEmoticons, stripNarration } from './engine.js';

/** 当前配置下是否需要在生成层加工。 */
export function needsTransform(config) {
  return Boolean(
    config?.text?.dialogOnly
    || config?.text?.emoticon?.enabled
    || config?.prompt?.style === 'translate',
  );
}

/** 纯文本处理（不花 token）。 */
function processLocal(text, config) {
  let out = text;
  if (config.text?.dialogOnly) {
    const stripped = stripNarration(out);
    if (stripped.length > 0) out = stripped;
  }
  if (config.text?.emoticon?.enabled) out = applyEmoticons(out, config);
  return out;
}

/** 逐块加工：转译关闭时走这条路，保持流式。 */
async function* transformPerBlock(upstream, config) {
  const buffered = new Map();
  for await (const chunk of upstream) {
    if (chunk?.type === 'text-delta') {
      buffered.set(chunk.index, `${buffered.get(chunk.index) ?? ''}${chunk.text ?? ''}`);
      continue;
    }
    if (chunk?.type === 'block-end' && chunk.block?.type === 'text') {
      const text = processLocal(buffered.get(chunk.index) ?? chunk.block.text ?? '', config);
      buffered.delete(chunk.index);
      // 原文的 delta 已被吞掉，这里必须补一条，否则消费方拿不到这段流式文本。
      yield { type: 'text-delta', index: chunk.index, text };
      yield { ...chunk, block: { ...chunk.block, text } };
      continue;
    }
    yield chunk;
  }
}

/**
 * 转译模式：整条回复缓冲完再翻译**最后一段正文**，其余正文只做本地处理。
 * 这样一条回复只多一次模型调用，而不是每个文本块各一次。
 */
async function* transformFinalOnly(upstream, { config, translate, log }) {
  const items = [];
  let pending = null;
  for await (const chunk of upstream) {
    if (chunk?.type === 'text-delta') {
      if (!pending || pending.index !== chunk.index) {
        pending = { kind: 'text', index: chunk.index, text: '', endChunk: null };
        items.push(pending);
      }
      pending.text += chunk.text ?? '';
      continue;
    }
    if (chunk?.type === 'block-end' && chunk.block?.type === 'text') {
      if (!pending || pending.index !== chunk.index) {
        pending = { kind: 'text', index: chunk.index, text: '', endChunk: null };
        items.push(pending);
      }
      pending.endChunk = chunk;
      pending.text = pending.text || chunk.block.text || '';
      pending = null;
      continue;
    }
    items.push({ kind: 'chunk', chunk });
  }

  const textItems = items.filter((item) => item.kind === 'text');
  const last = textItems.at(-1);

  for (const item of items) {
    if (item.kind === 'chunk') {
      yield item.chunk;
      continue;
    }
    let text = processLocal(item.text, config);
    if (item === last) {
      try {
        const translated = await translate(text);
        if (translated) text = translated;
        else log?.warn?.('转译失败，按英文原文发送');
      } catch (error) {
        log?.warn?.('转译异常，按英文原文发送:', error);
      }
    }
    yield { type: 'text-delta', index: item.index, text };
    if (item.endChunk) yield { ...item.endChunk, block: { ...item.endChunk.block, text } };
  }
}

/**
 * 包装模型输出流。
 * @param upstream 原始 StreamChunk 迭代器
 * @param options.config 当前配置
 * @param options.translate (text) => Promise<string | undefined> 英文→中文
 */
export async function* transformStream(upstream, options) {
  const { config } = options;
  if (config?.prompt?.style === 'translate') {
    yield* transformFinalOnly(upstream, options);
    return;
  }
  yield* transformPerBlock(upstream, config);
}
