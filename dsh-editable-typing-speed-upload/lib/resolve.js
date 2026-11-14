/**
 * 解析「别人装的包」。本插件以 workspace 目录安装，自己 node_modules 里没有渠道 SDK，
 * 必须从当前 profile 解析——profile 的 node_modules 才是 dsh-im 真正加载的那一份。
 *
 * 为什么不用 createRequire().resolve：渠道 SDK 常是 ESM-only（exports 里只有
 * `import` 条件，没有 `require`），CJS 解析器会直接报 "No exports main defined"。
 * 所以这里自己沿目录向上找 node_modules/<name>，再按 exports.import → main 取入口，
 * 最后用 file: URL 导入——同一物理文件拿到的就是宿主里那个模块实例。
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

function splitSpecifier(specifier) {
  const parts = specifier.split('/');
  if (specifier.startsWith('@')) {
    return { name: parts.slice(0, 2).join('/'), subpath: parts.slice(2).join('/') };
  }
  return { name: parts[0], subpath: parts.slice(1).join('/') };
}

function candidateRoots() {
  const roots = [];
  if (process.env.DSH_PROFILE_DIR) roots.push(process.env.DSH_PROFILE_DIR);
  if (process.env.DSH_HOME && process.env.DSH_PROFILE) {
    roots.push(join(process.env.DSH_HOME, 'profiles', process.env.DSH_PROFILE));
  }
  roots.push(process.cwd());
  return roots;
}

/** 从某个起点一路向上找 node_modules/<name>。 */
function findPackageDir(name, startDir) {
  let dir = startDir;
  for (let depth = 0; depth < 24; depth += 1) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/** 按 exports["./sub"] → exports["."] → module → main 的顺序取入口文件。 */
function pickEntry(manifest, subpath) {
  const key = subpath ? `./${subpath}` : '.';
  const exportsField = manifest?.exports;
  let target;
  if (typeof exportsField === 'string') {
    target = exportsField;
  } else if (exportsField && typeof exportsField === 'object') {
    const entry = exportsField[key] ?? exportsField['.'];
    if (typeof entry === 'string') target = entry;
    else if (entry && typeof entry === 'object') {
      target = entry.import ?? entry.node ?? entry.default ?? entry.module;
    }
  }
  if (typeof target === 'string') return target;
  return manifest?.module ?? manifest?.main ?? 'index.js';
}

/** 同一个物理文件只导入一次：自愈探针每 5 秒跑一遍，别每次都 readFileSync。 */
const moduleCache = new Map();

/** 依次尝试 profile / 工作目录 / 直接裸导入；全部失败时抛出带每一次失败的错误。 */
export async function importExternal(specifier) {
  const failures = [];
  const { name, subpath } = splitSpecifier(specifier);

  for (const root of candidateRoots()) {
    const dir = findPackageDir(name, root);
    if (!dir) {
      failures.push(`${root}: 没有 node_modules/${name}`);
      continue;
    }
    let key;
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      const entry = pickEntry(manifest, subpath);
      const url = pathToFileURL(join(dir, entry)).href;
      key = url;
      const cached = moduleCache.get(url);
      if (cached) return cached;
      const loaded = await import(url);
      moduleCache.set(url, loaded);
      return loaded;
    } catch (error) {
      if (key) moduleCache.delete(key);
      failures.push(`${dir}: ${error?.message ?? error}`);
    }
  }

  try {
    const cached = moduleCache.get(`bare:${specifier}`);
    if (cached) return cached;
    const loaded = await import(specifier);
    moduleCache.set(`bare:${specifier}`, loaded);
    return loaded;
  } catch (error) {
    failures.push(`bare import: ${error?.message ?? error}`);
  }

  const error = new Error(`cannot resolve ${specifier}`);
  error.code = 'unresolved-external';
  error.detail = failures.join(' | ');
  throw error;
}
