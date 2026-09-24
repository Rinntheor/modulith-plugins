// scripts/typecheck.ts
//
// 用 TypeScript 编译器 API 做类型检查 —— **在同一个进程里**，不 spawn `tsc`。
//
// ============================================================
// 为什么不用 `tsc --noEmit`
// ============================================================
//
// `pnpm typecheck` 仍然是 `tsc --noEmit`，它是对外的入口，行为没有任何变化。
// 但 `pnpm dev`（watch）需要在**每次改动之后**再查一遍类型，而那种循环里
// 起一个子进程的代价是不可忽略的：进程启动加上重新读一遍 lib.d.ts，
// 在小改动上会比真正要查的东西还慢。
//
// 于是这里把同一件事在进程内做掉。**两者必须给出同一个答案** —— 所以下面的
// 编译选项一律从 `tsconfig.json` 读，不在这里重写一遍。副本必然漂移，
// 而「watch 说没问题、CI 说有问题」是最难查的一类不一致。
//
// ============================================================
// 为什么构建里不做类型检查
// ============================================================
//
// esbuild **只擦除类型、不检查类型**，这是它快的原因，也是它最大的陷阱：
// 类型写错时构建照样成功，产物照样生成，错误要等到运行时才以别的形态出现。
//
// 但把类型检查塞进 `bundleText` 是错的解 —— 那是 esbuild 唯一的快路径，
// 而类型检查是全量的。正确的位置是**构建的调用方**（`build.ts` 与 `watch.ts`），
// 它们才知道「这一次值不值得查」。见 `bundleAll` 的 `typecheck` 选项。

import { readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** 一条类型诊断，已经整理成可直接打印的行 */
export interface TypeDiagnostic {
  /** `src/kanban/ui.tsx:42:7` 这种形状；无法定位时是 `tsconfig.json` */
  where: string;
  message: string;
}

export interface TypecheckResult {
  /** 做检查用了多久（毫秒） */
  ms: number;
  diagnostics: TypeDiagnostic[];
}

/**
 * 读 tsconfig.json 的编译选项与文件列表。
 *
 * `parseJsonConfigFileContent` 会展开 `include` / `exclude` 并解析 `extends`，
 * 因此这里不重复实现任何一条匹配规则。
 */
function loadProject(): { options: ts.CompilerOptions; files: string[] } {
  const configPath = join(ROOT, 'tsconfig.json');
  const raw = ts.readConfigFile(configPath, (path) => readFileSync(path, 'utf8'));

  if (raw.error) {
    const message = ts.flattenDiagnosticMessageText(raw.error.messageText, '\n');
    throw new Error(`tsconfig.json 读取失败：${message}`);
  }

  const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, ROOT, undefined, configPath);

  return { options: parsed.options, files: parsed.fileNames };
}

/** 把诊断里的文件位置变成相对仓库根的短路径 */
function locate(diagnostic: ts.Diagnostic): string {
  if (!diagnostic.file || diagnostic.start === undefined) {
    return relative(ROOT, join(ROOT, 'tsconfig.json')).split('\\').join('/');
  }

  const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
  const file = relative(ROOT, diagnostic.file.fileName).split('\\').join('/');
  // 行号与列号都从 1 开始 —— 编译器 API 给的是 0 基，而所有人都按 1 基去找
  return `${file}:${line + 1}:${character + 1}`;
}

/**
 * 全量检查一次。**同步**：它只读文件、不写任何东西，也不需要事件循环。
 *
 * 错误被整理成一行一条，而不是原样透传 TypeScript 的报告器 —— 后者的输出是给
 * 终端看的彩排文本，没法在 watch 循环里只打印「这一轮新增了什么」。
 */
export function typecheck(): TypecheckResult {
  const started = Date.now();
  const { options, files } = loadProject();

  // `noEmit` 在 tsconfig 里已经开了；这里再设一次是防止将来有人把它关掉 ——
  // 本函数只做检查，一旦开始发射文件，watch 循环就会与 esbuild 抢同一个输出目录。
  const program = ts.createProgram(files, { ...options, noEmit: true });
  const diagnostics = ts.getPreEmitDiagnostics(program);

  return {
    ms: Date.now() - started,
    diagnostics: diagnostics.map((diagnostic) => ({
      where: locate(diagnostic),
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    })),
  };
}

/** 把结果打印到终端。返回是否通过（没有诊断即通过） */
export function reportTypecheck(result: TypecheckResult): boolean {
  if (result.diagnostics.length === 0) return true;

  console.error(`类型检查未通过（${result.diagnostics.length} 个问题）：\n`);
  for (const diagnostic of result.diagnostics) {
    console.error(`  ✘ ${diagnostic.where}\n    ${diagnostic.message}`);
  }
  console.error(
    '\n**注意：类型错误不会阻止 esbuild 生成产物** —— esbuild 只擦除类型。' +
      '\n产物里跑的是"类型错了但语法合法"的代码，问题只会在运行时以别的形态出现。'
  );
  return false;
}

/** 诊断所在的文件名（去掉行列），供 watch 循环判断"改的是不是有问题的那个文件" */
export function diagnosticFiles(result: TypecheckResult): string[] {
  const files = new Set<string>();
  for (const diagnostic of result.diagnostics) {
    const colon = diagnostic.where.indexOf(':');
    files.add(colon === -1 ? diagnostic.where : diagnostic.where.slice(0, colon));
  }
  return [...files];
}

// 直接运行：`node scripts/typecheck.ts`
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = typecheck();
  if (reportTypecheck(result)) {
    console.log(`类型检查通过（${result.ms} ms）`);
  } else {
    process.exit(1);
  }
}
