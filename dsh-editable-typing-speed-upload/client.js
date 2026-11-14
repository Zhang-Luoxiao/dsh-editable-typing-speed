/**
 * dsh-editable-typing-speed · 浏览器半边
 *
 * 注册到 `plugins.row.config`（keyed，键为 `<包名>#<行 id>`）：插件页里这个 bundle
 * 的每一行会多出一个「配置」入口，点开就是这里的表单。
 *
 * 表单只干一件事：把三个旋钮画出来，改动后 POST 给宿主已有的
 * `/dsh-editable-typing-speed/config`（宿主侧会写进 profile 的 cordis.patch.yml）。
 * 所以这里不需要任何 Remote 定义，也不会和宿主侧的表单契约耦合。
 */

window.__ModuleLoader__.load({
  id: 'dsh-editable-typing-speed',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useState } = React;

    const STATUS_URL = '/dsh-editable-typing-speed/status';
    const CONFIG_URL = '/dsh-editable-typing-speed/config';

    // 面板上用秒（支持小数），配置里仍然是毫秒：整数毫秒是宿主侧的唯一单位。
    const msToSec = (ms) => Number((Number(ms || 0) / 1000).toFixed(3));
    const secToMs = (seconds) => {
      const value = Number(seconds);
      return Number.isFinite(value) ? Math.max(0, Math.round(value * 1000)) : 0;
    };

    const PRESETS = {
      light: {
        label: '轻拟人',
        hint: '反应 0.5s，阅读 7–11 字/秒，打字 14–20 字/秒',
        patch: {
          readDelay: { baseMs: 500, minCharsPerSecond: 7, maxCharsPerSecond: 11, maxTotalMs: 20000 },
          segmentGap: { baseMs: 300, minCharsPerSecond: 14, maxCharsPerSecond: 20, maxTotalMs: 9000 },
          split: { enabled: true, minChars: 24, maxSegments: 3 },
        },
      },
      slow: {
        label: '慢性子',
        hint: '反应 1.2s，阅读 3.5–6 字/秒，打字 8–12 字/秒',
        patch: {
          readDelay: { baseMs: 1200, minCharsPerSecond: 3.5, maxCharsPerSecond: 6, maxTotalMs: 30000 },
          segmentGap: { baseMs: 600, minCharsPerSecond: 8, maxCharsPerSecond: 12, maxTotalMs: 15000 },
          split: { enabled: true, minChars: 18, maxSegments: 4 },
        },
      },
      instant: {
        label: '即刻应答',
        hint: '反应 0.15s，阅读 20–30 字/秒，打字 25–35 字/秒',
        patch: {
          readDelay: { baseMs: 150, minCharsPerSecond: 20, maxCharsPerSecond: 30, maxTotalMs: 3000 },
          segmentGap: { baseMs: 100, minCharsPerSecond: 25, maxCharsPerSecond: 35, maxTotalMs: 3000 },
          split: { enabled: true, minChars: 24, maxSegments: 2 },
        },
      },
    };

    const muted = { color: 'var(--dsw-alias-label-secondary)', fontSize: 12, lineHeight: 1.5 };
    const card = {
      border: '1px solid var(--dsw-alias-border-l1)',
      background: 'var(--dsw-alias-bg-layer-1)',
      borderRadius: 10,
      padding: '12px 14px',
      display: 'grid',
      gap: 10,
    };
    const row = { display: 'grid', gridTemplateColumns: '1fr 96px 96px', gap: 8, alignItems: 'center' };
    const input = {
      width: '100%',
      boxSizing: 'border-box',
      padding: '5px 8px',
      borderRadius: 6,
      border: '1px solid var(--dsw-alias-border-l1)',
      background: 'var(--dsw-alias-bg-base)',
      color: 'var(--dsw-alias-label-primary)',
      fontSize: 13,
      fontVariantNumeric: 'tabular-nums',
    };
    const button = {
      padding: '6px 14px',
      borderRadius: 6,
      border: '1px solid var(--dsw-alias-border-l1)',
      background: 'var(--dsw-alias-bg-layer-2)',
      color: 'var(--dsw-alias-label-primary)',
      fontSize: 13,
      cursor: 'pointer',
    };
    const primary = { ...button, background: 'var(--dsw-alias-brand-primary)', borderColor: 'var(--dsw-alias-brand-primary)', color: '#fff' };

    function Section({ title, hint, children }) {
      return h('section', { style: card },
        h('div', null,
          h('div', { style: { fontWeight: 600, fontSize: 13 } }, title),
          hint ? h('div', { style: muted }, hint) : null,
        ),
        children,
      );
    }

    function NumberCell({ label, value, min, max, step, onChange }) {
      return h('label', { style: { display: 'grid', gap: 3 } },
        h('span', { style: { ...muted, fontSize: 11 } }, label),
        h('input', {
          type: 'number', value: value ?? '', min, max, step,
          style: input,
          onChange: (event) => {
            const next = event.target.value === '' ? 0 : Number(event.target.value);
            onChange(Number.isFinite(next) ? next : 0);
          },
        }),
      );
    }

    function Switch({ label, hint, checked, onChange }) {
      return h('label', { style: { display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer' } },
        h('input', { type: 'checkbox', checked: Boolean(checked), onChange: (event) => onChange(event.target.checked) }),
        h('span', null,
          h('span', { style: { fontSize: 13 } }, label),
          hint ? h('div', { style: muted }, hint) : null,
        ),
      );
    }

    function setPath(source, path, value) {
      const next = { ...source };
      let cursor = next;
      for (const key of path.slice(0, -1)) {
        cursor[key] = { ...cursor[key] };
        cursor = cursor[key];
      }
      cursor[path[path.length - 1]] = value;
      return next;
    }

    function Panel(props) {
      const [status, setStatus] = useState(null);
      const [draft, setDraft] = useState(null);
      const [busy, setBusy] = useState(false);
      const [message, setMessage] = useState('');
      const [error, setError] = useState('');

      const load = useCallback(async () => {
        try {
          const response = await fetch(STATUS_URL, { headers: { accept: 'application/json' } });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const data = await response.json();
          setStatus(data);
          setDraft(data.config);
          setError('');
        } catch (cause) {
          setError(`读取状态失败：${cause?.message ?? cause}`);
        }
      }, []);

      useEffect(() => { load(); }, [load]);

      const save = useCallback(async (patch) => {
        setBusy(true);
        setMessage('');
        setError('');
        try {
          const response = await fetch(CONFIG_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(patch),
          });
          const data = await response.json();
          if (!response.ok) throw new Error(data?.message ?? `HTTP ${response.status}`);
          setDraft(data.config);
          setStatus((previous) => (previous ? { ...previous, enabled: data.config.enabled, config: data.config } : previous));
          setMessage(data.persisted?.saved ? '已保存并持久化' : `已生效（${data.persisted?.reason ?? '未持久化'}）`);
          setBusy(false);
          load();
        } catch (cause) {
          setError(`保存失败：${cause?.message ?? cause}`);
          setBusy(false);
        }
      }, [load]);

      const update = useCallback((path, value) => {
        setDraft((previous) => setPath(previous, path, value));
      }, []);

      const summary = useMemo(() => {
        if (!draft) return '阅读速度 / 打字速度 / 随机浮动';
        const read = `读速 ${draft.readDelay.minCharsPerSecond}–${draft.readDelay.maxCharsPerSecond} 字/秒`;
        const gap = `打字 ${draft.segmentGap.minCharsPerSecond}–${draft.segmentGap.maxCharsPerSecond} 字/秒`;
        const split = draft.split.enabled ? `拆≤${draft.split.maxSegments}条` : '不拆条';
        return `${read} · ${gap} · ${split}${draft.enabled ? '' : '（已关闭）'}`;
      }, [draft]);

      if (props?.view === 'summary') {
        return h('span', { style: muted }, summary);
      }

      if (error && !draft) {
        return h('div', { style: { ...card, color: 'var(--dsw-alias-state-error-primary)' } },
          error,
          h('div', null, h('button', { type: 'button', style: button, onClick: load }, '重试')),
        );
      }
      if (!draft) {
        return h('div', { style: muted }, '读取配置中…');
      }

      const adapter = status?.adapters?.qq;

      return h('div', { style: { display: 'grid', gap: 12, maxWidth: 720 } },
        // 总开关 + 渠道
        h('section', { style: card },
          h(Switch, {
            label: '开启拟人化节奏',
            hint: '关掉后出站调用原样透传，插件完全不介入',
            checked: draft.enabled,
            onChange: (value) => save({ enabled: value }),
          }),
          h('div', { style: { height: 1, background: 'var(--dsw-alias-border-l1)' } }),
          h(Switch, {
            label: 'QQ 渠道',
            hint: adapter
              ? (adapter.patched ? `适配器：${adapter.detail}` : `适配器未生效：${adapter.detail}`)
              : '适配器状态未知',
            checked: draft.channels?.qq !== false,
            onChange: (value) => update(['channels', 'qq'], value),
          }),
          adapter && !adapter.patched
            ? h('div', { style: { ...muted, color: 'var(--dsw-alias-state-warn-primary)' } }, '没有挂上 QQ 适配器：检查是否装了 dsh-im 的 QQ 渠道。')
            : null,
        ),

        // 预设
        h('section', { style: card },
          h('div', { style: { fontWeight: 600, fontSize: 13 } }, '一键预设'),
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
            Object.entries(PRESETS).map(([key, preset]) => h('button', {
              key, type: 'button', style: button, disabled: busy,
              title: preset.hint,
              onClick: () => save(preset.patch),
            }, preset.label)),
          ),
        ),

        // 读延迟
        h(Section, { title: '读延迟', hint: '收到消息后先静默一会儿：固定反应时间 + 用户消息字数 ÷ 随机阅读速度（速度每个回合重新取）' },
          h('div', { style: row },
            h(NumberCell, { label: '反应时间（秒）', value: msToSec(draft.readDelay.baseMs), min: 0, step: 0.1, onChange: (v) => update(['readDelay', 'baseMs'], secToMs(v)) }),
            h(NumberCell, { label: '阅读速度下限（字/秒）', value: draft.readDelay.minCharsPerSecond, min: 0, step: 0.5, onChange: (v) => update(['readDelay', 'minCharsPerSecond'], v) }),
            h(NumberCell, { label: '阅读速度上限（字/秒）', value: draft.readDelay.maxCharsPerSecond, min: 0, step: 0.5, onChange: (v) => update(['readDelay', 'maxCharsPerSecond'], v) }),
          ),
          h('div', { style: row },
            h(NumberCell, { label: '单回合封顶（秒）', value: msToSec(draft.readDelay.maxTotalMs), min: 0, step: 0.5, onChange: (v) => update(['readDelay', 'maxTotalMs'], secToMs(v)) }),
            h('div'),
            h('div'),
          ),
        ),

        // 段间隔
        h(Section, { title: '段间隔', hint: '拆出来的两条之间「正在打下一条」：固定停顿 + 这条回复字数 ÷ 随机打字速度（速度每条重新取）' },
          h('div', { style: row },
            h(NumberCell, { label: '基础停顿（秒）', value: msToSec(draft.segmentGap.baseMs), min: 0, step: 0.1, onChange: (v) => update(['segmentGap', 'baseMs'], secToMs(v)) }),
            h(NumberCell, { label: '打字速度下限（字/秒）', value: draft.segmentGap.minCharsPerSecond, min: 0, step: 0.5, onChange: (v) => update(['segmentGap', 'minCharsPerSecond'], v) }),
            h(NumberCell, { label: '打字速度上限（字/秒）', value: draft.segmentGap.maxCharsPerSecond, min: 0, step: 0.5, onChange: (v) => update(['segmentGap', 'maxCharsPerSecond'], v) }),
          ),
          h('div', { style: row },
            h(NumberCell, { label: '单次封顶（秒）', value: msToSec(draft.segmentGap.maxTotalMs), min: 0, step: 0.5, onChange: (v) => update(['segmentGap', 'maxTotalMs'], secToMs(v)) }),
            h('div'),
            h('div'),
          ),
        ),

        // 拆条
        h(Section, { title: '拆条 / 换行', hint: '按句末标点或空行把一条回复拆成多条消息分开发；代码块与表格永远整条不拆，分段是原文的连续切片' },
          h(Switch, {
            label: '按句 / 段拆条',
            hint: '关掉就只按渠道自身的长消息分片发送',
            checked: draft.split.enabled,
            onChange: (value) => update(['split', 'enabled'], value),
          }),
          h(Switch, {
            label: '让模型自己判别拆不拆',
            hint: '打开后会在写作提示里要求模型用独占一行的 --- 分隔消息；模型没给标记时回落本地规则',
            checked: draft.split.auto,
            onChange: (value) => update(['split', 'auto'], value),
          }),
          h(Switch, {
            label: '拆称呼',
            hint: '把句首的称呼单独拆成一条，例如「张落晓。」一条、「你别磨叽。」另一条',
            checked: draft.split.vocative,
            onChange: (value) => update(['split', 'vocative'], value),
          }),
          h('div', { style: row },
            h(NumberCell, { label: '短于此不拆 字', value: draft.split.minChars, min: 0, step: 1, onChange: (v) => update(['split', 'minChars'], v) }),
            h(NumberCell, { label: '最多几条', value: draft.split.maxSegments, min: 1, max: 20, step: 1, onChange: (v) => update(['split', 'maxSegments'], v) }),
            h('div'),
          ),
        ),

        // 文本处理（不花 token）
        h(Section, { title: '文本处理', hint: '发送前的纯文本处理，不额外消耗 token' },
          h(Switch, {
            label: '只留对话（去旁白）',
            hint: '去掉（旁白）/（动作）/*动作*/【提示】和成对引号，只保留实际说出来的内容',
            checked: draft.text?.dialogOnly,
            onChange: (value) => update(['text', 'dialogOnly'], value),
          }),
          h(Switch, {
            label: '加颜文字',
            hint: '每 2–3 句补一个颜文字',
            checked: draft.text?.emoticon?.enabled,
            onChange: (value) => update(['text', 'emoticon', 'enabled'], value),
          }),
          draft.text?.emoticon?.enabled
            ? h('div', { style: row },
              h(NumberCell, { label: '最少几句一个', value: draft.text.emoticon.minSentences, min: 1, max: 20, step: 1, onChange: (v) => update(['text', 'emoticon', 'minSentences'], v) }),
              h(NumberCell, { label: '最多几句一个', value: draft.text.emoticon.maxSentences, min: 1, max: 20, step: 1, onChange: (v) => update(['text', 'emoticon', 'maxSentences'], v) }),
              h('div'),
            )
            : null,
        ),

        // 写作风格（提示词，全局生效）
        h(Section, {
          title: '写作风格（提示词，全局生效）',
          hint: '通过系统提示让模型换个「原文语言」写；对本 Host 下所有会话生效。在某个会话里输入 /编码模式 可让它跳过这些提示。',
        },
          h('div', { style: { display: 'grid', gap: 6 } },
            [['off', '关闭'], ['translate', '转译：模型原文写英文，发送前译回中文'], ['classical', '文言：原文直接写文言文'], ['classicalDual', '文言转译：原文文言 + 白话译文']]
              .map(([value, label]) => h('label', { key: value, style: { display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer', fontSize: 13 } },
                h('input', {
                  type: 'radio',
                  name: 'style-mode',
                  checked: (draft.prompt?.style ?? 'off') === value,
                  onChange: () => update(['prompt', 'style'], value),
                }),
                h('span', null, label),
              )),
          ),
          h(Switch, {
            label: '回答简短',
            hint: '在提示里要求模型一两句说完（与拆条无关）',
            checked: draft.prompt?.shortAnswers,
            onChange: (value) => update(['prompt', 'shortAnswers'], value),
          }),
          draft.prompt?.style === 'translate'
            ? h('div', { style: { ...muted, color: 'var(--dsw-alias-state-warn-primary)' } },
              '⚠️ 转译需要把英文原文再译回中文，等于每条回复多一次模型请求，token 消耗会翻倍。')
            : null,
          h('div', { style: muted },
            '想临时让某个会话不受影响：在那个会话里发送 /编码模式；恢复用 /拟人模式。',
          ),
        ),

        h('div', { style: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' } },
          h('button', { type: 'button', style: primary, disabled: busy, onClick: () => save(draft) }, busy ? '保存中…' : '保存'),
          h('button', { type: 'button', style: button, disabled: busy, onClick: load }, '放弃改动 / 重新读取'),
          message ? h('span', { style: { ...muted, color: 'var(--dsw-alias-state-success-primary)' } }, message) : null,
          error ? h('span', { style: { ...muted, color: 'var(--dsw-alias-state-error-primary)' } }, error) : null,
        ),

        status
          ? h('div', { style: muted },
            `本轮统计：读延迟 ${status.stats.readDelays} 次 · 段间隔 ${status.stats.segmentGaps} 次 · 拆出 ${status.stats.messagesSplit} 条`,
            status.stats.lastError ? ` · 最近错误：${status.stats.lastError}` : '',
          )
          : null,
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 两个入口都注册：
        //  - bundle 级（键=包名）→ 插件详情页里直接就是这张表单，点开卡片就能改；
        //  - 行级（键=<包名>#<行 id>）→ 从「包含的组件」里点进这一行时的页面。
        // 只注册行级的话，入口藏在「包含的组件」的 › 箭头里，很难找。
        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config',
          key: 'dsh-editable-typing-speed',
        }, Panel));
        ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
          name: 'plugins.row.config',
          key: 'dsh-editable-typing-speed#dsh-editable-typing-speed',
        }, Panel));
      },
    };
  },
});
