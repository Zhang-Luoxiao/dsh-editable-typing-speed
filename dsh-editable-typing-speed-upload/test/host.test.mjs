import assert from 'node:assert/strict';
import test from 'node:test';

import { apply, HEAL_INTERVAL_MS } from '../lib/index.js';
import { pacingRuntime, pacingState } from '../lib/store.js';

function fakeCtx() {
  const cleanup = [];
  const ctx = {
    logger: { info() {}, warn() {} },
    get() {
      return undefined; // 没有 webServer / commands / configEditor
    },
    effect(callback) {
      cleanup.push(callback());
    },
    fiber: undefined,
  };
  return { ctx, dispose: () => cleanup.splice(0).forEach((fn) => fn()) };
}

test('apply 把配置写进共享 runtime，dispose 立刻停手', () => {
  const runtime = pacingRuntime();
  const { ctx, dispose } = fakeCtx();

  apply(ctx, { enabled: true, channels: { qq: true } });
  assert.equal(runtime.current.enabled, true);
  assert.equal(typeof HEAL_INTERVAL_MS, 'number');

  dispose();
  assert.equal(runtime.current.enabled, false, '卸载后必须不再介入');
});

test('旧一代的 dispose 不会关掉新一代的节奏', () => {
  const runtime = pacingRuntime();
  const first = fakeCtx();
  const second = fakeCtx();

  apply(first.ctx, { enabled: true });
  apply(second.ctx, { enabled: true });
  // 新世代已接管：旧一代此时才卸载（配置编辑器重启时可能出现的顺序）
  first.dispose();
  assert.equal(runtime.current.enabled, true, '旧一代的清理不能把新一代关掉');

  second.dispose();
  assert.equal(runtime.current.enabled, false);
});

test('关闭状态下的 dispose 保持关闭', () => {
  const runtime = pacingRuntime();
  const { ctx, dispose } = fakeCtx();
  apply(ctx, { enabled: false });
  assert.equal(runtime.current.enabled, false);
  dispose();
  assert.equal(runtime.current.enabled, false);
});
