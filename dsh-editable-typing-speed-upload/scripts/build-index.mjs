#!/usr/bin/env node
/**
 * 生成 format 1 插件市场索引 index.json。
 *
 * 用法：
 *   node scripts/build-index.mjs                 # 用 git HEAD 作为安装来源（还没发 npm 时用这个）
 *   node scripts/build-index.mjs --npm 0.2.0     # 发过 npm 之后，改成按 npm 版本安装
 *
 * 产物 index.json 会被打进 npm 包，所以可以直接用 jsdelivr 当索引源：
 *   https://cdn.jsdelivr.net/npm/<包名>/index.json
 * 也可以放仓库里用 raw.githubusercontent.com 的地址。
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const npmFlag = process.argv.indexOf('--npm');
const npmVersion = npmFlag > -1 ? process.argv[npmFlag + 1] : undefined;

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

const repositoryUrl = pkg.repository?.url?.replace(/^git\+/, '').replace(/\.git$/, '');
if (!repositoryUrl || repositoryUrl.includes('OWNER')) {
  console.warn('[warn] package.json 的 repository 还是占位符，索引里的仓库地址会不可用');
}

let source;
let publishTimestamp;
if (npmVersion) {
  // npm 源：dsh 会安装 name@version；发布时间取当前秒数即可（真实时间以 registry 为准）
  source = { type: 'npm' };
  publishTimestamp = Math.floor(Date.now() / 1000);
} else {
  const commit = git(['rev-parse', 'HEAD']);
  const seconds = Number(git(['log', '-1', '--format=%ct']));
  source = { type: 'git', url: repositoryUrl, commit };
  publishTimestamp = Number.isFinite(seconds) ? seconds : Math.floor(Date.now() / 1000);
}

const index = {
  format: 1,
  title: {
    en: pkg.name,
    zh: '可调打字速度',
  },
  description: {
    en: 'Humanized send pacing for DSH IM replies: editable reading delay, typing speed and randomized gaps.',
    zh: '把 IM 回复拆成几条按随机间隔发出：可调阅读延迟、打字速度与条间停顿。',
  },
  metadata: {
    // 词表声明：条目里的 category / labels / sortKeys 只能引用这里出现过的 id
    categories: [],
    labels: [],
    sortKeys: {},
  },
  plugins: [
    {
      name: pkg.name,
      title: pkg.name,
      description: {
        en: pkg.description,
        zh: 'IM 回话拟人化节奏：可调阅读延迟、打字速度与随机间隔，按句拆条。',
      },
      author: typeof pkg.author === 'string' ? pkg.author : undefined,
      repository: repositoryUrl ? { url: repositoryUrl } : undefined,
      versions: [
        {
          version: pkg.version,
          publishTimestamp,
          source,
          engines: {
            dsh: '>=0.2.0-rc.1',
          },
        },
      ],
    },
  ],
};

writeFileSync('index.json', `${JSON.stringify(index, null, 2)}\n`, 'utf8');
console.log(`[ok] index.json 已生成：${pkg.name}@${pkg.version} via ${source.type}`);
