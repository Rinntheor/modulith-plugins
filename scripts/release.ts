// scripts/release.ts
//
// 插件发布：一条命令走完「打包 → 校验 → 提交 → 打 tag → 推送 → 端到端验证」。
//
//   node scripts/release.ts                 打包 + 全部校验（**不改动仓库以外的东西**）
//   node scripts/release.ts --check         只校验，不打包、不写任何文件（CI 用）
//   node scripts/release.ts --tags-only     只补缺的 tag 并推送（不提交、不动分支）
//   node scripts/release.ts --push          提交 + 打 tag + 推送 + 验证线上可取
//   node scripts/release.ts --verify        只验线上：索引里每个版本都能按 tag 取到且哈希一致
//
// ============================================================
// `--tags-only` 为什么必须是一个独立模式
// ============================================================
//
// 它来自一次真实的使用：那些 `.lcp` **早就提交在 main 上**了，用户装不了只是因为
// 缺 tag。而当时只有 `--push` 一条路，于是为了补 tag，脚本还要顺带提交并推送分支 ——
// 那一次分支推送恰好撞上"远端已经被另一个并发的推送更新过"而失败：
//
//   ! [remote rejected] HEAD -> main
//     (cannot lock ref 'refs/heads/main': is at c3f6269… but expected 947c9f3f…)
//
// 异常一路冒到顶层，用户看到一屏 Node 内部错误栈，**无法判断 tag 到底推上去了没有** ——
// 而那次 tag 其实已经推送成功了。一个与用户想修的问题毫无关系的失败，把真正
// 关心的结果盖住了。
//
// 教训：**修 404 只需要推 tag**（它写的是 `refs/tags`，与分支指针无关）。
// 把"补 ref"和"推内容"绑在一次操作里，会让一件本来只需一次写操作的事多出一次
// 可能失败的写操作。因此这里把它们拆开。
//
// ============================================================
// 推送失败时必须逐条报告"哪一步成了"
// ============================================================
//
// 推送不是原子的：tag 与分支是两次独立的写。任何一次失败都不该让已经成功的部分
// 变成不可知 —— 因此下面每推一步就记一步，失败时把**已完成**与**未完成**分开列出，
// 并给出可照抄的下一步命令。这条规则来自上面那次事故：当时脚本什么都没说。
//
// ============================================================
// 它修的是什么：一次真实的、把整个市场打挂的事故
// ============================================================
//
// 用户报「市场里装任何插件都弹 404」：
//
//   cdn.jsdelivr.net：下载失败: HTTP 404 Not Found
//     （…/modulith-plugins@notes-v1.0.3/dist/com.modulith.sample.notes-1.0.3.lcp）
//
// 根因不是网络，也不是 CDN 缓存：**索引里每个插件的最新版本都没有对应的 git tag**。
// 宿主下载用的是 `version.tag` 拼出来的地址（`src/config/pluginRegistry.ts`），
// 远端没有那个 ref，jsDelivr 只能 404。发包的人做了「升版本、重打包、重签索引、
// 推 main」，唯独漏了 `git tag` —— 于是 10 个最新版本全都取不到。
//
// ============================================================
// 为什么工具层一点都没拦住
// ============================================================
//
// `build.ts` 从**清单版本**推出 tag 字符串（`tag: \`${dirName}-v${version}\``），
// 从头到尾**不读 git**；它的校验只问「dist 里那个文件在不在、哈希对不对」。
// 因此「索引先行、tag 未打」在工具层没有任何拦截点，只剩文档里的 tag 纪律 ——
// 而纪律正是这次没被执行的东西。
//
// 本脚本因此补上那条缺失的判据：**索引只能引用「远端真的取得到」的版本**。
// 校验分两层：
//
//   · 本地层（一定能跑）：每个索引版本都有对应的本地 tag，且那个 tag 指向的提交
//     里确实含有该 `.lcp`，字节与索引记录的 sha256 一致；
//   · 远端层（联网时可跑）：那个 ref 在 jsDelivr 上真的能取到同一份字节。
//
// ============================================================
// 关于 tag：为什么「非要打 tag」不能靠改代码绕过
// ============================================================
//
// 技术上不是必须的：`pluginRegistry.ts` 的 `ref` 可以是分支名，实测 `@main`
// 能取到同一份文件。但分支引用会让**内容可变**，而索引里记着 sha256 ——
// 一旦有人在同一分支上改了那个文件，所有客户端都会拿到"哈希不符"并拒绝安装，
// 且这个错误看起来像"发布者的包坏了"。tag 是让「版本号 = 一份确定的内容」
// 这句话成立的机制，jsDelivr 的永久缓存也建立在它之上。
//
// 因此正确的做法不是去掉 tag，而是**让 tag 自动产生并强制校验**：本脚本在推送
// 索引之前先把缺失的 tag 补上并推送，再确认它们可取 —— 索引于是不可能领先于 tag。
//
// ============================================================
// 补 tag 只对「包已经在 main 上」的版本有效
// ============================================================
//
// 补打 tag 之所以能救回这次事故，是因为那些 `.lcp` 早就提交在 main 上了 ——
// 缺的只是 ref。本脚本为每个待补的 tag 找到「包含该包、且清单版本正好等于它」的
// **最新提交**并指向它：指到 HEAD 更省事，但若 HEAD 的清单已经升到下一个版本，
// 那种 tag 会指向一个与它名字不符的状态。

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INDEX_FILE = join(ROOT, 'index.json');

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

const args = new Set(process.argv.slice(2));
const CHECK_ONLY = args.has('--check');
const PUSH = args.has('--push');
const VERIFY_ONLY = args.has('--verify');
/** 只补 tag 并推送：不打包、不提交、不动分支 */
const TAGS_ONLY = args.has('--tags-only');

/**
 * 推送分支用的 refspec，**写死而不依赖 `push.default`**。
 *
 * `git push origin HEAD` 的落点取决于 `push.default`：取 `simple`（默认）时推同名
 * 分支，取 `upstream` / `current` 时是别的行为。而这条命令的语义必须是确定的 ——
 * 它决定索引对谁可见。写全了就没有"在我机器上是好的"这类空间。
 */
const BRANCH_REFSPEC = 'HEAD:main';
const BRANCH_NAME = 'main';

// ============================================================
// git 封装
// ============================================================

/**
 * git 输出的落点。
 *
 * ============================================================
 * 为什么不用 `execFileSync` 默认的 `pipe`
 * ============================================================
 *
 * 默认实现会为子进程创建管道并读回来。而**受限沙箱不允许创建管道** —— 那种
 * 环境下 `git` 一被捕获输出就以 `EPERM` 失败，报错来自 Node 的
 * `spawnSync`，与 git 本身毫无关系，归因成本极高（这条边界在本仓库的多个脚本里
 * 都撞过：`stdio: 'inherit'` 与 `'ignore'` 可以，被捕获的 `pipe` 不行）。
 *
 * 因此这里改成**让 git 直接写进一个临时文件**，再从文件读出来：不开管道，
 * 于是无论环境是否受限都能跑。代价是多一次小文件的读写 —— 这些命令的输出都是
 * 几 KB 级的文本，可以忽略。
 *
 * ============================================================
 * 落点为什么要带兜底
 * ============================================================
 *
 * 系统临时目录不总是可写：只读沙箱、被策略限制的 `%TEMP%`、容器里的只读 `/tmp`
 * 都遇到过。那种环境下的失败发生在 `mkdtemp`，报错是 `EPERM`，而它与 git、
 * 与索引、与用户想做的事**毫无关系** —— 却让整个脚本一步都跑不下去。
 *
 * 因此退一步用一个仓库内的小目录（已被 `.gitignore` 排除）。它只在系统临时目录
 * 不可用时才会出现，且脚本退出前会删掉。
 */
const SCRATCH = (() => {
  const candidates = [
    process.env.MODULITH_RELEASE_SCRATCH,
    join(tmpdir(), `modulith-release-${process.pid}`),
    join(ROOT, '.release-scratch'),
  ].filter((value): value is string => Boolean(value));

  for (const dir of candidates) {
    try {
      mkdirSync(dir, { recursive: true });
      return dir;
    } catch {
      // 换下一个候选；全失败时下面的抛错会带上所有尝试过的路径
    }
  }

  throw new Error(`找不到可写的临时目录，尝试过：\n  ${candidates.join('\n  ')}`);
})();

function git(...args: string[]): string {
  const out = join(SCRATCH, `git-${Math.random().toString(36).slice(2)}.txt`);
  const fd = openSync(out, 'w');
  try {
    execFileSync('git', args, { cwd: ROOT, stdio: ['ignore', fd, 'inherit'] });
  } finally {
    closeSync(fd);
  }
  const text = readFileSync(out, 'utf8');
  rmSync(out, { force: true });
  return text.trim();
}

/** 同一件事，但要的是**原始字节**（`cat-file blob` 用；`git()` 会 trim 掉首尾字节） */
function gitBytes(...args: string[]): Buffer {
  const out = join(SCRATCH, `blob-${Math.random().toString(36).slice(2)}.bin`);
  const fd = openSync(out, 'w');
  try {
    execFileSync('git', args, { cwd: ROOT, stdio: ['ignore', fd, 'inherit'] });
  } finally {
    closeSync(fd);
  }
  const bytes = readFileSync(out);
  rmSync(out, { force: true });
  return bytes;
}

function gitOk(...args: string[]): boolean {
  try {
    execFileSync('git', args, { cwd: ROOT, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** 把一条 git 命令的输出原样透到终端（推送这种要看见进度的动作用它） */
function gitPassthrough(...args: string[]): void {
  execFileSync('git', args, { cwd: ROOT, stdio: 'inherit' });
}

/**
 * 读某个提交里某个文件的内容。
 *
 * 用 `cat-file blob <rev>:<path>` 而不是 `git show <rev>:<path>`：
 *
 *  · `cat-file blob` 的输出是**原始字节**，不经过任何格式化与分页；
 *  · `git show` 会做一次"智能"处理（属性、过滤器、可能的 pager），
 *    而它的输出在重定向到文件时被截断过一次（表现为 JSON 解析失败，进而让
 *    "该给这个版本打哪个提交"的判断退化到 HEAD —— 见 `collectFacts` 里的说明）。
 *
 * 拿不到内容时返回 `null`（该提交里没有这个文件）。
 */
function fileAt(commit: string, path: string): string | null {
  if (!gitOk('cat-file', '-e', `${commit}:${path}`)) return null;
  try {
    return gitBytes('cat-file', 'blob', `${commit}:${path}`).toString('utf8');
  } catch {
    return null;
  }
}

// ============================================================
// 索引
// ============================================================

interface IndexVersion {
  version: string;
  tag: string;
  package: { path: string; size: number; sha256: string };
}
interface IndexPlugin {
  id: string;
  source: string;
  latest: string;
  versions: IndexVersion[];
}
interface Index {
  schemaVersion: number;
  plugins: IndexPlugin[];
}

function readIndex(): Index {
  if (!existsSync(INDEX_FILE)) {
    fail('index.json 不存在。先跑 node scripts/build.ts。');
  }
  return JSON.parse(readFileSync(INDEX_FILE, 'utf8')) as Index;
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function fail(message: string): never {
  console.error(`\n${RED}${message}${RESET}\n`);
  process.exit(1);
}

// ============================================================
// 第一层：本地不变量
// ============================================================

interface LocalIssue {
  version: string;
  kind: 'missing-tag' | 'tag-lacks-package' | 'hash-mismatch' | 'no-package';
  detail: string;
  /**
   * 对应的事实（补 tag 要指向哪个提交）。
   *
   * **必须把事实本身带在问题里，不能用版本号回查。** 不同插件会有相同的版本号
   * （`1.0.3` 同时出现在八个插件上），按版本号 `find` 会永远命中数组里第一个
   * 匹配项 —— 表现是"所有缺失的 tag 都指向同一个提交"，而那是个纯粹的显示错误，
   * 却足以让人以为补 tag 的逻辑坏了，进而去改一段本来正确的代码。
   */
  fact?: VersionFact;
}

/** 判定时用到的信息，供补 tag 复用 */
interface VersionFact {
  pluginId: string;
  dir: string;
  version: string;
  tag: string;
  path: string;
  recordedSha: string;
  localTagExists: boolean;
  /** 补 tag 时要指向的提交（`null` 表示找不到合适的那一个） */
  tagTarget: string | null;
}

function collectFacts(index: Index): VersionFact[] {
  const tags = new Set(git('tag', '-l').split('\n').filter(Boolean));
  const history = git('log', '--format=%H', '-400').split('\n').filter(Boolean);

  // **包里那个 `package.path` 是这里唯一的路径来源，本脚本不认识 dist/ 的布局。**
  //
  // 这是刻意的，而且现在更重要了：dist/ 里平铺（`dist/<插件 ID>-<版本>.lcp`，历史版本）
  // 与分目录（`dist/<目录名>/<版本>.lcp`，新版本）两种形状会长期并存。用通配或按文件名
  // 反解"这是哪个插件的哪一版"会把"已发布版本的路径"变成脚本的猜测结果 —— 而
  // `index.json` 记的那一条才是客户端真正会去请求的地址（宿主 `pluginMarket.ts` 的
  // `registrySources`）。校验必须对同一个地址发言，否则它证明的是另一件事。
  const facts: VersionFact[] = [];

  for (const plugin of index.plugins) {
    const dir = plugin.source.replace(/^plugins\//, '');
    for (const version of plugin.versions) {
      const localTagExists = tags.has(version.tag);

      let tagTarget: string | null = null;
      if (!localTagExists) {
        // 「包含该包」且「清单版本正好等于它」的最新提交。
        //
        // 两个条件都必要：只看文件会选中"包在、而清单已经升到下一版"的提交；
        // 只看清单会选中"清单对、包还没打出来"的提交。
        //
        // **读不出来的提交一律跳过，绝不兜底成"就是 HEAD"**：指向 HEAD 看起来
        // 更省事，但若 HEAD 的清单已经是下一个版本，那个 tag 就会指向一个与它
        // 名字不符的状态 —— 而 tag 正是"版本号标识一份确定内容"的唯一凭据。
        for (const commit of history) {
          if (fileAt(commit, version.package.path) === null) continue;

          const manifest = fileAt(commit, `plugins/${dir}/manifest.json`);
          if (manifest === null) continue;

          try {
            if ((JSON.parse(manifest) as { version?: string }).version === version.version) {
              tagTarget = commit;
              break;
            }
          } catch {
            // 该提交里清单解析不了（旧格式）：跳过它，继续往前找
          }
        }
      }

      facts.push({
        pluginId: plugin.id,
        dir,
        version: version.version,
        tag: version.tag,
        path: version.package.path,
        recordedSha: version.package.sha256,
        localTagExists,
        tagTarget,
      });
    }
  }

  return facts;
}

/** 本地校验：索引引用的每个版本在本地 git 里都成立 */
function checkLocal(facts: VersionFact[]): LocalIssue[] {
  const issues: LocalIssue[] = [];

  for (const fact of facts) {
    const label = `${fact.pluginId} ${fact.version}`;

    // 1) 包必须在 HEAD 里（tag 只能指向含有它的提交；不在 HEAD 就不是"已发布"）
    if (!gitOk('cat-file', '-e', `HEAD:${fact.path}`)) {
      issues.push({
        version: label,
        kind: 'no-package',
        detail: `${fact.path} 不在 HEAD 里 —— 它要么没提交，要么只在某个分支上`,
        fact,
      });
      continue;
    }

    // 2) 字节必须与索引记录的哈希一致
    const blob = gitBytes('cat-file', 'blob', `HEAD:${fact.path}`);
    if (sha256(blob) !== fact.recordedSha) {
      issues.push({
        version: label,
        kind: 'hash-mismatch',
        detail: `HEAD 里 ${fact.path} 的哈希与索引记录不符（跑 node scripts/build.ts 重新生成索引）`,
        fact,
      });
    }

    // 3) tag 必须在本地存在
    if (!fact.localTagExists) {
      // 找不到"该指向哪个提交"时**不补**，而是如实报出来：一个指向错误提交的
      // tag 比没有 tag 更糟 —— 它会以一个看起来正常的状态被推送出去，
      // 而客户端按它取到的可能是另一份内容（或 404）。
      if (!fact.tagTarget) {
        issues.push({
          version: label,
          kind: 'no-package',
          detail:
            `缺少 tag ${fact.tag}，而且在历史里找不到「含有 ${fact.path} 且清单版本为 ` +
            `${fact.version}」的提交 —— 无法自动补，请手工确认那个版本是怎么发出去的`,
          fact,
        });
        continue;
      }
      issues.push({
        version: label,
        kind: 'missing-tag',
        detail: `缺少 tag ${fact.tag}`,
        fact,
      });
      continue;
    }

    // 4) tag 指向的提交里必须有那个包
    if (!gitOk('cat-file', '-e', `${fact.tag}:${fact.path}`)) {
      issues.push({
        version: label,
        kind: 'tag-lacks-package',
        detail: `tag ${fact.tag} 指向的提交里没有 ${fact.path}`,
        fact,
      });
    }
  }

  return issues;
}

// ============================================================
// 第二层：远端
// ============================================================

const REPO = 'Rinntheor/modulith-plugins';

function jsdelivrUrl(ref: string, path: string): string {
  return `https://cdn.jsdelivr.net/gh/${REPO}@${ref}/${path}`;
}

function rawUrl(ref: string, path: string): string {
  return `https://raw.githubusercontent.com/${REPO}/${ref}/${path}`;
}

/** HEAD 里那个包的 sha256 */
function headSha(path: string): string {
  return sha256(gitBytes('cat-file', 'blob', `HEAD:${path}`));
}

/**
 * 线上验证：每个索引版本都能按**它的 tag**取到，且字节与索引记录一致。
 *
 * 这是唯一能真正证明"用户点安装会成功"的检查 —— 本地校验只能证明仓库状态自洽。
 * 它要联网，因此单独一个模式（`--verify`），失败时不改动任何东西。
 *
 * **注意它验的是 HEAD 里的字节**，而不是索引记录的 sha256：索引与 HEAD 的一致性
 * 已经由 `checkLocal` 证明过，这里要回答的是另一个问题 —— CDN 在你按 tag 请求时
 * 究竟给出了什么。
 */
async function verifyRemote(facts: VersionFact[]): Promise<string[]> {
  const problems: string[] = [];

  for (const fact of facts) {
    const expected = headSha(fact.path);
    const url = jsdelivrUrl(fact.tag, fact.path);

    let response: Response;
    try {
      response = await fetch(url, { redirect: 'follow' });
    } catch (error) {
      problems.push(
        `${fact.tag}: 请求失败（${error instanceof Error ? error.message : error}）\n` +
          `      ${DIM}${url}${RESET}\n` +
          `      ${DIM}若是 DNS 问题，试试 raw 通道：${rawUrl(fact.tag, fact.path)}${RESET}`
      );
      continue;
    }

    if (!response.ok) {
      problems.push(
        `${fact.tag}: HTTP ${response.status}（${response.statusText}）\n` +
          `      ${DIM}${url}${RESET}\n` +
          `      ${DIM}404 通常意味着这个 tag 还没推上去 —— 跑 node scripts/release.ts --tags-only${RESET}`
      );
      continue;
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    const got = sha256(bytes);

    if (got !== expected) {
      problems.push(
        `${fact.tag}: 取到的字节与仓库里那份不一致\n` +
          `      线上 ${got}\n` +
          `      HEAD ${expected}\n` +
          `      ${DIM}这说明同名 tag 指向了另一份内容（tag 被移动过？）${RESET}`
      );
      continue;
    }

    console.log(
      `  ${GREEN}✔${RESET} ${fact.tag}  ${String(bytes.length).padStart(7)} 字节  ${got.slice(0, 12)}…`
    );
  }

  return problems;
}

// ============================================================
// 推送：分步记录成败
// ============================================================

/**
 * 一次推送动作的结果。
 *
 * ============================================================
 * 为什么推送必须"分步记账"
 * ============================================================
 *
 * 推送**不是原子的**：tag 与分支是两次独立的写入，任何一次都可能单独失败，
 * 而失败之后已经成功的部分照样留在远端。若把整个过程包成一个 try/catch，
 * 得到的结果只有"失败"两个字 —— 而用户真正需要知道的是**哪一半成功了**。
 *
 * 这不是假想：真实发生过一次分支推送被拒（远端已被并发的推送更新），
 * 而那次 tag 其实已经推送成功。当时的脚本让异常直接冒到顶层，用户看到一屏
 * Node 内部错误栈，完全无法判断自己的市场修好了没有。
 */
interface PushStep {
  label: string;
  /** 失败时可直接照抄的命令 */
  retry: string;
  done: boolean;
  error?: string;
}

async function main(): Promise<number> {
  const mode = PUSH
    ? '（会推送）'
    : TAGS_ONLY
      ? '（只补 tag 并推送）'
      : CHECK_ONLY
        ? '（只校验）'
        : VERIFY_ONLY
          ? '（只验线上）'
          : '（不改远端）';
  console.log(`\n${BOLD}插件发布${RESET}  ${DIM}${mode}${RESET}\n`);

  if (!CHECK_ONLY && !VERIFY_ONLY && !TAGS_ONLY) {
    // ---- 1. 打包 + 生成索引 ----
    //
    // 交回给 `build.ts`：它已经把这套不变量做得很细（确定性打包、落盘前的全部校验、
    // 哈希复核、签名提醒）。在这里重写一遍只会多出一份会漂的实现。
    console.log(`${BOLD}1. 打包并生成索引${RESET}  ${DIM}(node scripts/build.ts)${RESET}`);

    // 逃生舱：跳过打包。
    //
    // 存在的理由是**受限环境**：某些沙箱禁止创建子进程，而 `build.ts` 里的 esbuild
    // 必须起一个子进程（`spawn EPERM`）。那种环境下要么跳过这一步、要么什么都验不了，
    // 而"验不了"会让下面那两条本地不变量的断言永远没人跑。
    //
    // 它**不会**让人绕过校验：跳过的只是"重新生成产物与索引"，
    // 索引与 git 的一致性照样逐条检查（那才是这次 404 事故的判据）。
    if (process.env.MODULITH_RELEASE_SKIP_BUILD === '1') {
      console.log(`  ${YELLOW}已跳过${RESET}${DIM}（MODULITH_RELEASE_SKIP_BUILD=1）${RESET}`);
    } else {
      try {
        execFileSync(process.execPath, [join(ROOT, 'scripts', 'build.ts')], {
          cwd: ROOT,
          stdio: 'inherit',
        });
      } catch {
        fail('打包失败，未做任何推送。先修掉上面报的问题。');
      }
    }
  }

  const index = readIndex();
  const versionCount = index.plugins.reduce((sum, p) => sum + p.versions.length, 0);

  // ---- 2. 本地不变量 ----
  const stepNumber = TAGS_ONLY || CHECK_ONLY || VERIFY_ONLY ? 1 : 2;
  console.log(
    `\n${BOLD}${stepNumber}. 校验索引与 git 的一致性${RESET}  ` +
      `${DIM}(${index.plugins.length} 个插件、${versionCount} 个版本)${RESET}`
  );

  const facts = collectFacts(index);
  const issues = checkLocal(facts);

  const missingTags = issues.filter((issue) => issue.kind === 'missing-tag');
  const otherIssues = issues.filter((issue) => issue.kind !== 'missing-tag');

  for (const issue of otherIssues) {
    console.log(`  ${RED}✘${RESET} ${issue.version}：${issue.detail}`);
  }
  if (otherIssues.length === 0) {
    console.log(`  ${GREEN}✔${RESET} 每个索引版本都有对应的本地 tag，且 tag 指向的提交里含有该包`);
    console.log(`  ${GREEN}✔${RESET} 每个包的字节都与索引记录的 sha256 一致`);
  }

  if (missingTags.length > 0) {
    console.log(`\n  ${YELLOW}!${RESET} ${missingTags.length} 个版本缺 tag（这正是那次 404 事故的根因）：`);
    for (const issue of missingTags) {
      const fact = issue.fact;
      const target = fact?.tagTarget ? fact.tagTarget.slice(0, 8) : 'N/A';
      console.log(`      ${fact?.tag}  ${DIM}-> ${target}${RESET}`);
    }
  }

  if (otherIssues.length > 0) {
    fail('存在无法自动修复的问题，未推送。修掉之后重跑。');
  }

  if (VERIFY_ONLY) {
    console.log(`\n${BOLD}2. 线上验证${RESET}  ${DIM}(jsDelivr)${RESET}`);
    const problems = await verifyRemote(facts);
    if (problems.length > 0) {
      console.error(`\n${RED}${problems.length} 个版本在线上取不到：${RESET}\n`);
      for (const problem of problems) console.error(`  ${RED}✘${RESET} ${problem}\n`);
      return 1;
    }
    console.log(`\n${GREEN}${BOLD}线上 ${facts.length} 个版本全部可取，且字节与仓库一致。${RESET}\n`);
    return 0;
  }

  if (CHECK_ONLY) {
    if (missingTags.length > 0) {
      console.error(
        `\n${RED}${BOLD}校验未通过：${missingTags.length} 个索引版本没有对应的 git tag。${RESET}\n` +
          `${DIM}推送之前必须补上，否则用户装这些版本会拿到 404。${RESET}\n` +
          `${DIM}跑 node scripts/release.ts --tags-only 可以只补这一步。${RESET}\n`
      );
      return 1;
    }
    console.log(`\n${GREEN}${BOLD}校验通过：索引与 git 状态一致。${RESET}\n`);
    return 0;
  }

  // ---- 3. 补 tag（本地） ----
  let taggingStep = 3;
  if (TAGS_ONLY) taggingStep = 2;

  if (missingTags.length > 0) {
    console.log(`\n${BOLD}${taggingStep}. 补打缺失的 tag${RESET}`);
    for (const issue of missingTags) {
      const fact = issue.fact;
      if (!fact?.tagTarget) continue;
      try {
        git('-c', 'user.name=modulith-release', '-c', 'user.email=release@localhost',
          'tag', '-a', fact.tag, '-m', `${fact.dir} ${fact.version}`, fact.tagTarget);
        console.log(`  ${GREEN}✔${RESET} ${fact.tag} -> ${fact.tagTarget.slice(0, 8)}`);
      } catch (error) {
        fail(`打 tag ${fact.tag} 失败：${error instanceof Error ? error.message : error}`);
      }
    }
  } else {
    console.log(`\n${BOLD}${taggingStep}. 补打缺失的 tag${RESET}  ${DIM}（没有缺失）${RESET}`);
  }

  // ---- `--tags-only` 到此为止：只推 tag，不碰分支 ----
  if (TAGS_ONLY) {
    console.log(`\n${BOLD}${taggingStep + 1}. 推送 tag${RESET}`);
    if (!gitOk('ls-remote', '--exit-code', 'origin')) {
      // 只是为了早一点把"远端不可达"说清楚；失败不阻断推送（有些环境不允许 ls-remote）
      console.log(`  ${DIM}（无法探测远端，继续尝试推送）${RESET}`);
    }
    try {
      gitPassthrough('push', 'origin', '--tags');
      console.log(`  ${GREEN}✔${RESET} tag 已推送`);
    } catch (error) {
      console.error(
        `\n${RED}tag 推送失败${RESET}${DIM}：${error instanceof Error ? error.message : error}${RESET}\n` +
          `tag 已经在本地建好了，重试即可：\n` +
          `  ${DIM}git push origin --tags${RESET}\n`
      );
      return 1;
    }

    const refreshed = collectFacts(readIndex());
    const problems = await verifyRemote(refreshed);
    if (problems.length > 0) {
      console.error(`\n${YELLOW}${problems.length} 个版本暂时还取不到：${RESET}\n`);
      for (const problem of problems) console.error(`  ${YELLOW}!${RESET} ${problem}\n`);
      console.error(
        `新 tag 生效通常需要几秒到一分钟。稍后重跑 ${DIM}node scripts/release.ts --verify${RESET}。\n` +
          `${DIM}注意：此模式不动分支，因此索引本身没有变化 —— 无需清 CDN 缓存。${RESET}\n`
      );
      return 1;
    }
    console.log(`\n${GREEN}${BOLD}完成：${refreshed.length} 个版本线上可取。分支未被改动。${RESET}\n`);
    return 0;
  }

  // ---- 4. 提交 ----
  //
  // **只暂存索引、签名与产物。**
  //
  // `git add -A` 会把工作区里**任何**改动一起卷进这次发布提交 —— 包括正在改的
  // 文档、别人的半成品、乃至本脚本自己。一次发布提交的语义是"索引与产物更新"，
  // 掺进无关改动之后，回滚或审阅它都会变得不可靠。
  //
  // 索引与它的签名必须**一起**提交：分开提交意味着中间那一瞬间远端是坏的。
  const RELEASE_PATHS = ['index.json', 'index.json.sig', 'dist'];

  console.log(`\n${BOLD}4. 提交${RESET}`);
  const dirty = git('status', '--porcelain');
  if (!dirty) {
    console.log(`  ${DIM}工作区干净，没有需要提交的改动${RESET}`);
  } else {
    const releaseChanges = git('status', '--porcelain', '--', ...RELEASE_PATHS);
    if (!releaseChanges) {
      console.log(`  ${DIM}索引与产物没有变化（本次只有别的文件被改过）${RESET}`);
    } else {
      const lines = releaseChanges.split('\n').filter(Boolean);
      console.log(
        `  ${DIM}待提交 ${lines.length} 项：${lines.slice(0, 5).join('、')}${lines.length > 5 ? ' …' : ''}${RESET}`
      );
    }

    // 除发布产物之外还有改动时**说出来**，但不动它 —— 由作者自己决定
    // 那些改动该不该进这次提交。
    const others = git('status', '--porcelain')
      .split('\n')
      .filter(Boolean)
      .filter((line) => !RELEASE_PATHS.some((path) => line.slice(3).startsWith(path)));
    if (others.length > 0) {
      console.log(
        `  ${YELLOW}!${RESET} 工作区还有 ${others.length} 项与本次发布无关的改动，**不会**被提交：`
      );
      for (const line of others.slice(0, 5)) console.log(`      ${DIM}${line}${RESET}`);
      if (others.length > 5) console.log(`      ${DIM}…${RESET}`);
    }
  }

  // ---- 5. 推送 ----
  console.log(`\n${BOLD}5. 推送${RESET}`);

  /** 顺序不可颠倒：**先 tag，后分支**。索引一旦可见，用户就可能立刻去装。 */
  const steps: PushStep[] = [
    {
      label: '推送 tag',
      retry: 'git push origin --tags',
      done: false,
    },
    {
      label: `推送分支（${BRANCH_REFSPEC}）`,
      retry: `git push origin ${BRANCH_REFSPEC}`,
      done: false,
    },
  ];

  if (!PUSH) {
    console.log(`  ${YELLOW}未推送${RESET}${DIM} —— 加 --push 才会真的推送${RESET}`);
    console.log(
      `\n${DIM}推送顺序在 --push 下是刻意的：**先推 tag，再推分支**。${RESET}\n` +
        `${DIM}反过来的话，索引会在"tag 还没到"的那段时间里对所有人可见 —— 而 CDN 不会替你等。${RESET}\n` +
        `${DIM}只想补 tag（例如这次 404 事故）就用 --tags-only：它完全不碰分支。${RESET}\n`
    );
    return 0;
  }

  if (dirty) {
    const releaseChanges = git('status', '--porcelain', '--', ...RELEASE_PATHS);
    if (releaseChanges) {
      gitPassthrough('add', '--', ...RELEASE_PATHS);
      gitPassthrough('-c', 'user.name=modulith-release', '-c', 'user.email=release@localhost',
        'commit', '-m', 'chore(release): 更新插件索引与产物');
      console.log(`  ${GREEN}✔${RESET} 已提交（只含 index.json / index.json.sig / dist）`);
    } else {
      console.log(`  ${DIM}索引与产物没有变化，无需提交${RESET}`);
    }
  }

  for (const step of steps) {
    console.log(`  ${DIM}${step.label}…${RESET}`);
    try {
      if (step.label === '推送 tag') {
        gitPassthrough('push', 'origin', '--tags');
      } else {
        gitPassthrough('push', 'origin', BRANCH_REFSPEC);
      }
      step.done = true;
      console.log(`  ${GREEN}✔${RESET} ${step.label}完成`);
    } catch (error) {
      step.error = error instanceof Error ? error.message : String(error);
      break; // 后面的步骤依赖前面的结果，不再继续
    }
  }

  // 有失败时：把"哪一步成了"逐条说清楚，并给出可照抄的下一步。
  if (steps.some((step) => !step.done)) {
    console.error(`\n${RED}${BOLD}推送未全部完成${RESET}\n`);
    for (const step of steps) {
      const mark = step.done ? `${GREEN}✔ 已完成${RESET}` : `${RED}✘ 未完成${RESET}`;
      console.error(`  ${mark}  ${step.label}`);
      if (step.error) console.error(`      ${DIM}${step.error.split('\n')[0]}${RESET}`);
    }

    const firstFailed = steps.find((step) => !step.done);
    console.error(
      `\n${DIM}已经完成的部分留在远端，不会回退。` +
        `重试那一步即可：${RESET}\n  ${DIM}${firstFailed?.retry}${RESET}\n`
    );

    // 分支推送被拒（远端已被别人更新）时说清性质：这是安全机制，不是数据损坏。
    if (firstFailed?.error && /cannot lock ref|non-fast-forward|fetch first|rejected/i.test(firstFailed.error)) {
      console.error(
        `${YELLOW}这条拒绝是 git 的比较并交换机制${RESET}${DIM} —— 它发现远端分支已经不在你` +
          `预期的那次提交上，因此拒绝覆盖。常见原因：同一个提交被另一次推送先送到了，` +
          `或者远端有本地没有的提交。${RESET}\n` +
          `${DIM}先看清楚再动：${RESET}\n` +
          `  ${DIM}git fetch origin && git log --oneline origin/${BRANCH_NAME} -5${RESET}\n` +
          `${DIM}若远端就是你想推的那份内容（提交号相同），什么都不用做。${RESET}\n` +
          `${DIM}若远端有本地没有的提交，先合并或变基，**不要**直接强推。${RESET}\n`
      );
    }

    return 1;
  }

  // ---- 6. 端到端验证 ----
  console.log(`\n${BOLD}6. 线上验证${RESET}`);
  console.log(`  ${DIM}jsDelivr 对分支引用的回源有延迟；tag 引用是新的，通常立刻可取。${RESET}`);

  const refreshed = collectFacts(readIndex());
  const problems = await verifyRemote(refreshed);

  if (problems.length > 0) {
    console.error(`\n${RED}${problems.length} 个版本仍未取到：${RESET}\n`);
    for (const problem of problems) console.error(`  ${RED}✘${RESET} ${problem}\n`);
    console.error(
      `${YELLOW}提示${RESET}：新 tag 生效通常需要几秒到一分钟。稍后重跑 ${DIM}node scripts/release.ts --verify${RESET}。\n` +
        `索引本身（分支引用）若被 CDN 缓存，去清一下：\n` +
        `  ${DIM}https://purge.jsdelivr.net/gh/${REPO}@main/index.json${RESET}\n` +
        `  ${DIM}https://purge.jsdelivr.net/gh/${REPO}@main/index.json.sig${RESET}\n`
    );
    return 1;
  }

  console.log(`\n${GREEN}${BOLD}发布完成：${refreshed.length} 个版本线上可取，字节与仓库一致。${RESET}\n`);
  return 0;
}

const code = await main();

// 清掉 git 输出的临时落点。`rmSync` 在 `process.exit` 之前跑是必须的：
// exit 之后连 exit 钩子里的同步代码都不会再执行。
rmSync(SCRATCH, { recursive: true, force: true });

process.exit(code);
