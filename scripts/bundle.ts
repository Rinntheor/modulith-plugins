// scripts/bundle.ts
//
// 把插件的**多文件源码**编译成**单文件 IIFE**。
//
// ============================================================
// 为什么需要它
// ============================================================
//
// 宿主只要求清单的 `main` 指向一个可执行的 JS 文件 —— 它不关心那是手写的还是
// 打包出来的。所以"多文件源码"不需要宿主配合：源码拆开写，构建成一个文件，
// 产物与手写时完全一样，`build.ts` 的打包与索引流程一个字都不用改。
//
// 在此之前，插件只有一个选择：手写单文件。代价已经摆在仓库里 —— `kanban` 的
// `index.js` 是 3575 行，它的文件头自己写着「手写 IIFE，不使用构建工具，因此
// 不能写 JSX」。
//
// **它是可选的。** 没有 `src/<插件>/` 的插件仍然是手写单文件，一切照旧 ——
// 这条链路是快车道，不是新的门槛。
//
// ============================================================
// 两条刻意的约束
// ============================================================
//
// 1. **react 只能是 external。** 宿主给的是**它自己那个 React 实例**
//    （`Modulith.React`），插件不能打包一份进去：两个 React 实例互相不认识，
//    context 取不到、hook 调用错乱。下面的 shim 把 `react` 与 `react/jsx-runtime`
//    接到全局实例上，**其它任何 import 一律报错** —— 一个插件引第三方库会让包
//    体积与审核成本一起失控，而审核是人工读代码。
//
// 2. **不压缩。** 产物是分发的，但它同时是**要被人读的代码**：插件的审核就是
//    人工阅读（见「已知问题」里关于共享 JS 上下文的那几条）。压缩会把这件事
//    从"读一遍"变成"读不了"。

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const SRC_DIR = join(ROOT, 'src');
export const PLUGINS_DIR = join(ROOT, 'plugins');

/** 产物的第一行。**别删** —— 它是"这份文件不该手改"的唯一提示 */
export const GENERATED_BANNER =
  '/* 生成物，请勿手改。源码在 src/<插件>/，改完跑 `pnpm build` */';

/**
 * `react` 的接法。
 *
 * esbuild 在 `format: 'iife'` 加 `external` 时会产生 `require("react")`，而 IIFE
 * 里没有 `require` —— 所以这里补一个。esbuild 自己的 `__require` 会优先用它。
 *
 * 写成 `var` 而不是 `const`：产物里通过 `typeof require !== "undefined"` 判断，
 * 顶层 `var` 才有这个效果。
 */
const REACT_SHIM = `var require = function (id) {
  if (id === 'react') return globalThis.Modulith.React;
  if (id === 'react/jsx-runtime') return globalThis.Modulith;
  throw new Error('插件不允许引入外部依赖（react 与 react/jsx-runtime 除外）: ' + id);
};`;

export interface BundleTarget {
  /** 插件目录名，同时也是清单里的 `name` 后缀 */
  name: string;
  /** 源码入口的绝对路径 */
  entry: string;
  /** 产物的绝对路径 */
  outfile: string;
}

/** 源码入口的文件名，按优先级 */
const ENTRY_NAMES = ['index.ts', 'index.tsx', 'index.js', 'index.jsx'];

/**
 * 找出所有"有源码目录"的插件。
 *
 * 没有 `src/<插件>/` 的插件会被跳过 —— 它们仍然是手写单文件，本节不碰。
 */
export function bundleTargets(): BundleTarget[] {
  if (!existsSync(SRC_DIR)) return [];

  const targets: BundleTarget[] = [];
  for (const entry of readdirSync(SRC_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const dir = join(SRC_DIR, entry.name);
    const found = ENTRY_NAMES.map((name) => join(dir, name)).find((path) => existsSync(path));
    if (!found) continue;

    targets.push({
      name: entry.name,
      entry: found,
      outfile: join(PLUGINS_DIR, entry.name, 'index.js'),
    });
  }

  return targets.sort((a, b) => a.name.localeCompare(b.name));
}

/** 编译一个目标，返回产物文本（不写盘） */
export async function bundleText(target: BundleTarget): Promise<string> {
  const result = await build({
    entryPoints: [target.entry],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    write: false,
    // 不压缩：产物要能被人读（见文件头第 2 条）
    minify: false,
    // 保留换行与缩进，便于逐行阅读与 diff
    charset: 'utf8',
    jsx: 'automatic',
    jsxImportSource: 'react',
    external: ['react', 'react/jsx-runtime'],
    banner: { js: `${GENERATED_BANNER}\n${REACT_SHIM}` },
    logLevel: 'silent',
  });

  return result.outputFiles[0].text;
}

function normalize(text: string): string {
  return text.replace(/\r\n/g, '\n').trimEnd();
}

export interface BundleReport {
  name: string;
  outfile: string;
  changed: boolean;
}

/**
 * 构建（或核对）全部目标。
 *
 * `check` 为真时**不写任何文件**，只报告哪些产物与源码不一致 —— 与
 * `build.ts --check` 的整体约定一致：校验不产生副作用。
 */
export async function bundleAll(options: { check: boolean }): Promise<BundleReport[]> {
  const reports: BundleReport[] = [];

  for (const target of bundleTargets()) {
    const text = await bundleText(target);
    const current = existsSync(target.outfile)
      ? readFileSync(target.outfile, 'utf8')
      : null;
    const changed = current === null || normalize(current) !== normalize(text);

    if (!options.check && changed) {
      // 目录由插件自己维护（manifest / css / icon 都在那里），但产物可能还没有
      if (!existsSync(join(PLUGINS_DIR, target.name))) {
        throw new Error(
          `插件目录不存在: plugins/${target.name} —— 有源码但缺清单等文件，先补齐再构建`
        );
      }
      writeFileSync(target.outfile, `${text.trimEnd()}\n`, 'utf8');
    }

    reports.push({ name: target.name, outfile: target.outfile, changed });
  }

  return reports;
}

/** 供 `build.ts` 做"有没有多余的产物"检查：产物存在但没有源码，说明源码被删了 */
export function orphanedOutputs(): string[] {
  const withSource = new Set(bundleTargets().map((target) => target.name));
  if (!existsSync(PLUGINS_DIR)) return [];

  return readdirSync(PLUGINS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !withSource.has(entry.name))
    .map((entry) => entry.name)
    .filter((name) => {
      // 只有"看起来是构建产物"的才算孤儿：手写插件的 index.js 开头没有那行 banner
      const candidate = join(PLUGINS_DIR, name, 'index.js');
      if (!existsSync(candidate)) return false;
      return readFileSync(candidate, 'utf8').startsWith(GENERATED_BANNER);
    });
}

// 直接运行：`node scripts/bundle.ts` / `node scripts/bundle.ts --check`
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  const reports = await bundleAll({ check });

  if (reports.length === 0) {
    console.log('没有需要构建的插件（src/ 下没有源码目录，全部是手写单文件）');
  }

  for (const report of reports) {
    const state = report.changed ? (check ? '✘ 产物过期' : '✔ 已生成') : '• 已是最新';
    console.log(`  ${state}  plugins/${report.name}/index.js`);
  }

  const stale = reports.filter((report) => report.changed);
  if (check && stale.length > 0) {
    console.error(
      `\n${stale.length} 个插件的产物与源码不一致 —— 改完源码后忘记重新构建了`
    );
    process.exit(1);
  }
}
