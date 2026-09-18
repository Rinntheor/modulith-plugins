// scripts/manifest.ts
// 插件清单的读取与校验
//
// 这里校验的是**形状**，不是**成员资格**。权限名是否真实存在，由宿主的权限注册表
// 说了算（应用里的 `PluginPermission` 枚举，未知权限会让清单反序列化失败并拒绝安装）。
//
// 为什么不在本仓库再维护一份权限名单：那就是同一份清单的第二份副本，必然漂移。
// 本仓库只检查「写法是否可能合法」—— 小写 kebab-case、不含冒号 —— 因为冒号写法
// 会让整份清单解析失败，而那是最常见的一种笔误。

import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

export interface PluginAuthor {
  name?: string;
  email?: string;
  url?: string;
}

export interface PluginManifest {
  name: string;
  displayName?: string;
  version: string;
  description?: string;
  author?: PluginAuthor;
  license?: string;
  homepage?: string;
  repository?: { type?: string; url?: string };
  categories?: string[];
  keywords?: string[];
  engines?: { loopcore?: string };
  main?: string;
  style?: string;
  icon?: string;
  iconSvg?: string;
  permissions?: string[];
  sandboxLevel?: number;
}

/** 仓库要求每个插件都提供的文件（应用本身不强制，见 docs/目录规范.md） */
const REQUIRED_FILES = ['manifest.json', 'index.js', 'README.md', 'LICENSE'];

/** 打包时需要跳过的操作系统噪声 */
export const PACKAGE_IGNORE = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const ENGINES_RE = /^(\*|(?:>=|<=|>|<|=|\^|~)?\d+\.\d+\.\d+)$/;
const PERMISSION_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export function readManifest(dir: string): PluginManifest {
  const file = resolve(dir, 'manifest.json');
  const text = readFileSync(file, 'utf8');
  try {
    return JSON.parse(text) as PluginManifest;
  } catch (err) {
    throw new Error(`manifest.json 不是合法 JSON：${err instanceof Error ? err.message : err}`);
  }
}

/** 路径必须是插件目录内的相对路径（与应用侧的校验保持一致） */
function isSafeRelative(rel: string): boolean {
  if (rel.length === 0) return false;
  if (rel.startsWith('/') || rel.startsWith('\\')) return false;
  if (/^[A-Za-z]:/.test(rel)) return false;
  return !rel.split(/[/\\]/).includes('..');
}

/**
 * 校验一份清单与它所在目录。返回问题列表，空数组表示通过。
 *
 * `dirName` 用于校验「目录名与插件 ID 最后一段一致」这条本仓库自己的约定。
 */
export function validatePlugin(dir: string, dirName: string): string[] {
  const problems: string[] = [];
  const manifest = readManifest(dir);

  // ---- 身份 ----
  if (!manifest.name) {
    problems.push('缺少 name');
  } else if (!NAME_RE.test(manifest.name)) {
    problems.push(`name 非法（1-64 字符，首字符为字母或数字，其余可为字母数字与 . _ -）：${manifest.name}`);
  } else {
    const tail = manifest.name.split('.').pop();
    if (tail !== dirName) {
      problems.push(`目录名与插件 ID 最后一段不一致：目录 ${dirName}，ID 末段 ${tail}`);
    }
  }

  if (!manifest.version) {
    problems.push('缺少 version');
  } else if (!VERSION_RE.test(manifest.version)) {
    problems.push(`version 非法（需要 MAJOR.MINOR.PATCH）：${manifest.version}`);
  }

  if (!manifest.displayName) problems.push('缺少 displayName（界面显示名）');
  if (!manifest.description) problems.push('缺少 description（一句话描述）');
  if (!manifest.license) problems.push('缺少 license');
  if (!manifest.author || !manifest.author.name) problems.push('缺少 author.name');

  // ---- 兼容性 ----
  const engines = manifest.engines?.loopcore;
  if (!engines) {
    problems.push('缺少 engines.loopcore（兼容的宿主版本范围）');
  } else if (!ENGINES_RE.test(engines)) {
    problems.push(`engines.loopcore 语法非法（不支持复合范围）：${engines}`);
  } else if (!engines.startsWith('>=')) {
    problems.push(`engines.loopcore 应当只带下界，例如 >=1.0.0（当前 ${engines}）`);
  }

  // ---- 入口 ----
  if (!manifest.main) {
    problems.push('缺少 main（代码包路径）');
  }
  for (const key of ['main', 'style', 'icon'] as const) {
    const rel = manifest[key];
    if (!rel) continue;
    if (!isSafeRelative(rel)) {
      problems.push(`${key} 必须是插件目录内的相对路径：${rel}`);
      continue;
    }
    if (!existsSync(resolve(dir, rel))) {
      problems.push(`${key} 指向的文件不存在：${rel}`);
    }
  }

  // 图标要么是文件，要么是宿主内置的图标名；写 .svg 却不存在会在上一条被拦下，
  // 而未以 .svg 结尾的值会被宿主当作图标名处理，因此不额外校验。
  if (!manifest.icon && !manifest.iconSvg) {
    problems.push('缺少 icon 或 iconSvg');
  }

  // ---- 权限 ----
  if (manifest.permissions !== undefined) {
    if (!Array.isArray(manifest.permissions)) {
      problems.push('permissions 必须是数组');
    } else {
      const seen = new Set<string>();
      for (const permission of manifest.permissions) {
        if (typeof permission !== 'string') {
          problems.push('permissions 只能包含字符串');
          continue;
        }
        if (permission.includes(':')) {
          // 这条单独列出：冒号写法会让宿主整份清单反序列化失败，安装被拒，
          // 而用户看到的只是「清单非法」—— 排查成本与错误本身不成比例。
          problems.push(
            `权限 "${permission}" 使用了冒号写法，会导致清单解析失败；正确写法是 kebab-case，例如 filesystem-read`
          );
        } else if (!PERMISSION_RE.test(permission)) {
          problems.push(`权限 "${permission}" 不是合法的小写 kebab-case`);
        }
        if (seen.has(permission)) problems.push(`权限 "${permission}" 重复声明`);
        seen.add(permission);
      }
    }
  }

  // ---- 仓库自己的要求 ----
  for (const file of REQUIRED_FILES) {
    const path = resolve(dir, file);
    if (!existsSync(path)) {
      problems.push(`缺少 ${file}（本仓库要求提供）`);
    } else if (!statSync(path).isFile()) {
      problems.push(`${file} 不是文件`);
    }
  }

  return problems;
}
