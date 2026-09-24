// scripts/watch.ts
//
// `pnpm dev` —— 改完源码不用再手动跑一次构建。
//
// ============================================================
// 它做三件事，顺序是刻意的
// ============================================================
//
//   1. **类型检查**：先查类型。esbuild 只擦除类型、不检查类型，所以构建成功
//      完全不代表代码是对的。类型不过时**照样重建产物** —— 作者要在应用里看的是
//      界面，不该因为一个类型错误连产物都拿不到 —— 但会明确报出来。
//   2. **重建产物**：把 `src/<插件>/` 编译成 `plugins/<插件>/index.js`。
//   3. **打印一句时间戳**：作者要能确认"这一次改动确实进去了"。没有这句话，
//      改完盯着终端什么动静都没有，只能靠猜。
//
// ============================================================
// 为什么是轮询，不是 fs.watch
// ============================================================
//
// `fs.watch` 在 Windows 上对「编辑器先写临时文件再改名」这类写入会漏事件，
// 而插件作者最常用的正是这种保存方式。轮询慢 400ms，但**不会漏**。
// 对一个只有几十个文件的源码目录，一次轮询的开销可以忽略。
//
// ============================================================
// 它替换不掉什么
// ============================================================
//
// 产物写回 `plugins/<插件>/index.js` 之后，**宿主还需要重新加载插件**才会生效。
// 在宿主的开发模式热重载落地之前（v1.5 目标 5），仍然需要在应用里让插件重新加载。
// 这里不假装自己做到了那一步 —— 它只保证"磁盘上的产物永远是最新的"。

import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { bundleAll, PLUGINS_DIR, SRC_DIR } from './bundle.ts';
import { reportTypecheck, typecheck } from './typecheck.ts';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** 轮询间隔（毫秒）。改小会更灵敏，也更容易在一次保存的中途看到半成品 */
const POLL_MS = 400;

/** 监听目录。`types/` 影响类型，`src/` 影响产物 */
const WATCH_DIRS = [SRC_DIR, join(ROOT, 'types')];

/** 只看这些扩展名 —— 编辑器留下的备份文件不该触发重建 */
const WATCHED_EXT = /\.(ts|tsx|js|jsx|json|css)$/;

interface Snapshot {
  /** 相对路径 → `mtime:size` */
  files: Map<string, string>;
}

/**
 * 扫一遍被监听的目录。
 *
 * 缺目录不是错误：`types/` 在早期仓库里可能不存在，而一个目录不存在就让
 * watch 崩掉是最没必要的失败。
 */
function snapshot(): Snapshot {
  const files = new Map<string, string>();

  const visit = (dir: string, prefix: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 目录不存在或不可读
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = join(dir, entry.name);

      if (entry.isDirectory()) {
        visit(abs, rel);
        continue;
      }
      if (!entry.isFile() || !WATCHED_EXT.test(entry.name)) continue;

      try {
        const stat = statSync(abs);
        files.set(rel, `${stat.mtimeMs}:${stat.size}`);
      } catch {
        // 半写状态：下一次轮询会再看到它
      }
    }
  };

  for (const dir of WATCH_DIRS) visit(dir, '');
  files.set('tsconfig.json', stamp(join(ROOT, 'tsconfig.json')));

  return { files };
}

function stamp(path: string): string {
  try {
    const stat = statSync(path);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return 'absent';
  }
}

/** 两个快照之间变了的文件（新增、修改、删除都算） */
function diff(before: Snapshot, after: Snapshot): string[] {
  const changed: string[] = [];
  for (const [file, value] of after.files) {
    if (before.files.get(file) !== value) changed.push(file);
  }
  for (const file of before.files.keys()) {
    if (!after.files.has(file)) changed.push(file);
  }
  return changed.sort();
}

function clock(): string {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

/**
 * 一次完整的重建。
 *
 * 类型检查**不接受开关之外的参数**：它总是全量的。增量类型检查需要 tsconfig 的
 * `incremental` 与一份 `.tsbuildinfo`，而那份缓存会在「改了东西但没触发重建」时
 * 给出一个陈旧的"通过" —— 那正是 watch 最不能犯的错。
 */
async function rebuild(label: string, dryRun: boolean, withTypes: boolean): Promise<void> {
  console.log(`\n[${clock()}] ${label}`);

  if (withTypes) {
    const checked = typecheck();
    if (reportTypecheck(checked)) {
      console.log(`  ✔ 类型检查通过（${checked.ms} ms）`);
    }
  }

  const reports = await bundleAll({ check: false, dryRun });
  if (reports.length === 0) {
    console.log('  • src/ 下没有源码目录，没有需要构建的插件');
    return;
  }

  for (const report of reports) {
    // `dryRun` 时 `changed` 的含义是「产物与源码不一致」，而这一次**没有写盘** ——
    // 所以不能借用「已生成 / 未变化」那两个词，否则一个正常的初次检查会看起来像
    // 一次失败。这里说的是事实：它有没有过期，以及我没有动它。
    const verdict = dryRun
      ? report.changed
        ? '✘ 产物过期（本次未写盘）'
        : '• 产物已是最新'
      : report.changed
        ? '✔ 已生成'
        : '• 未变化';
    console.log(`  ${verdict}  plugins/${report.name}/index.js`);
  }

  if (!dryRun) {
    console.log(
      '  → 产物已就绪。宿主侧仍需让插件重新加载才会生效（开发模式热重载见 v1.5 目标 5）。'
    );
  }
}

async function main(): Promise<void> {
  const withTypes = !process.argv.includes('--no-typecheck');

  console.log('插件开发监听已启动');
  console.log(
    `  监听：src/ 与 types/（每 ${POLL_MS} ms 检查一次，${withTypes ? '含类型检查' : '不查类型'}）`
  );
  console.log(`  产物：${PLUGINS_DIR}`);
  console.log('  退出：Ctrl+C');

  // 第一轮只报告，**不写盘**。启动一个监听不该修改工作区 —— 否则
  // 「我只是开了个 dev，工作树怎么脏了」会是一件没法解释的事。
  await rebuild('初次检查（尚未写盘）', true, withTypes);

  let before = snapshot();
  for (;;) {
    await sleep(POLL_MS);
    const after = snapshot();
    const changed = diff(before, after);
    if (changed.length === 0) continue;

    before = after;
    const names = changed.length <= 3 ? `：${changed.join('、')}` : `（共 ${changed.length} 个）`;
    await rebuild(`${changed.length} 个文件变化${names}`, false, withTypes);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

await main();
