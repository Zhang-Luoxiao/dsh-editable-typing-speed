#!/usr/bin/env node
/**
 * 校验打包清单，CI 与本地发布前都跑这个。
 * 只做「装出来能不能用」这件事，不联网。
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const failures = [];
const warn = [];

function readJson(relative) {
  return JSON.parse(readFileSync(join(root, relative), 'utf8'));
}

const pkg = readJson('package.json');

// 1. 包名必须存在且符合 npm 规则
if (!/^(@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(pkg.name ?? '')) {
  failures.push(`package.json name 不合法：${pkg.name}`);
}

// 2. 许可证
if (!pkg.license) failures.push('package.json 缺少 license 字段');
if (!existsSync(join(root, 'LICENSE'))) failures.push('缺少 LICENSE 文件');

// 3. bundle patch 存在，且行 id 与包名一致
const patchPath = pkg.dsh?.bundle?.patch;
if (!patchPath) {
  failures.push('package.json 缺少 dsh.bundle.patch');
} else if (!existsSync(join(root, patchPath))) {
  failures.push(`找不到 patch 文件：${patchPath}`);
} else {
  const patch = readFileSync(join(root, patchPath), 'utf8');
  if (!new RegExp(`id:\\s*${pkg.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(patch)) {
    failures.push(`patch 里的行 id 必须等于包名 ${pkg.name}`);
  }
}

// 4. 客户端半边：manifest 与文件都要在
const clientExport = pkg.exports?.['./client'];
if (pkg.dsh?.client && !clientExport) failures.push('声明了 dsh.client 但没有 ./client 导出');
if (clientExport && !existsSync(join(root, clientExport))) failures.push(`找不到客户端文件：${clientExport}`);

// 5. files 必须覆盖运行时所需的一切
const files = new Set(pkg.files ?? []);
for (const required of ['lib', 'cordis.patch.yml', 'LICENSE', 'README.md']) {
  if (![...files].some((entry) => entry === required || entry.startsWith(`${required}/`))) {
    failures.push(`files 缺少 ${required}（否则装出来跑不起来或不合规）`);
  }
}

// 6. locale 必须有 meta.title / meta.description
for (const locale of ['locale/zh.json', 'locale/en.json']) {
  if (!existsSync(join(root, locale))) {
    warn.push(`${locale} 不存在`);
    continue;
  }
  const text = JSON.parse(readFileSync(join(root, locale), 'utf8'));
  if (!text.meta?.title) failures.push(`${locale} 缺少 meta.title`);
  if (!text.meta?.description) failures.push(`${locale} 缺少 meta.description`);
}

// 7. 图标体积
if (existsSync(join(root, 'icon.svg'))) {
  const size = statSync(join(root, 'icon.svg')).size;
  if (size > 256 * 1024) failures.push(`icon.svg 超过 256 KiB（${size} 字节）`);
}

for (const message of warn) console.warn(`[warn] ${message}`);
if (failures.length > 0) {
  for (const message of failures) console.error(`[fail] ${message}`);
  process.exit(1);
}
console.log(`[ok] ${pkg.name}@${pkg.version} 清单校验通过`);
