// scripts/build.ts
// 打包插件并生成索引
//
//   node scripts/build.ts            打包并写入 dist/ 与 index.json
//   node scripts/build.ts --check    只校验，不写任何文件；发现问题时以非零码退出
//
// 索引的格式定义在**应用仓库**：
//   docs/08-规划/插件生态设计.md 第 4 节
// 本脚本是该格式的生产方。格式只有那一份定义 —— 在这里再抄一份说明必然漂移。

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PACKAGE_IGNORE, readManifest, validatePlugin, type PluginManifest } from './manifest.ts';
import { createZip } from './zip.ts';

const SCHEMA_VERSION = 1;

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PLUGINS_DIR = join(ROOT, 'plugins');
const DIST_DIR = join(ROOT, 'dist');
const INDEX_FILE = join(ROOT, 'index.json');

/**
 * 索引的签名。与索引放在同一目录 —— 签名给的是索引的**字节**，分开存放必然出现
 * 「索引换了、签名没换」的错配，而那个错配的表现是所有人的市场打不开。
 *
 * 由 `tauri signer sign index.json` 生成（tauri 会写在同名的 `.sig` 文件里）。
 */
const INDEX_SIGNATURE_FILE = `${INDEX_FILE}.sig`;

/**
 * 签名命令，写在这里一次性给三处引用。
 *
 * **`-f` 不能省。** `tauri signer sign` 必须知道用哪把私钥（`-f` 或环境变量
 * `TAURI_SIGNING_PRIVATE_KEY_PATH`），少了它命令会直接失败。给一条不能照抄执行的命令，
 * 比不给更浪费时间 —— 所以这里写全，并明确标出要替换的部分。
 */
const SIGN_COMMAND =
  'pnpm tauri signer sign -f <私钥路径> "<本仓库路径>/index.json"\n' +
  '  （tauri CLI 在应用仓库里；私钥路径也可用 TAURI_SIGNING_PRIVATE_KEY_PATH 环境变量给出）';

/**
 * 检查签名是否与索引配套。
 *
 * 这道检查挡的是一个**代价很大、又很容易犯**的错误：改了插件、重新生成了索引、却忘了
 * 重新签名。客户端会因此验签失败，市场对所有人打不开 —— 而「忘了签名」这件事在本地
 * 没有任何迹象。
 *
 * 用修改时间比较是粗糙的：它挡不住「把签名也换成另一份旧索引的签名」这种组合。真正的
 * 判定只能由客户端验签完成；这里的目标是**在推送之前提醒**，不是取代验签。
 *
 * 本脚本刻意不接触私钥（它只负责打包与索引），因此它不会替你签名，只会告诉你该签。
 */
function signatureProblem(): string | null {
  if (!existsSync(INDEX_SIGNATURE_FILE)) {
    return (
      'index.json.sig 不存在：索引尚未签名，客户端会拒绝使用它。\n' +
      '  ' +
      SIGN_COMMAND
    );
  }

  if (statSync(INDEX_FILE).mtimeMs > statSync(INDEX_SIGNATURE_FILE).mtimeMs) {
    return (
      'index.json 比它的签名新：索引改过但没有重新签名。\n' +
      '  客户端会验签失败并拒绝使用该索引，市场对所有人打不开。\n' +
      '  ' +
      SIGN_COMMAND
    );
  }

  return null;
}

// ============================================================
// 索引的数据结构
// ============================================================

interface IndexPackage {
  path: string;
  size: number;
  sha256: string;
}

interface IndexVersion {
  version: string;
  tag: string;
  engines: { loopcore: string };
  permissions: string[];
  package: IndexPackage;
}

interface IndexPlugin {
  id: string;
  displayName: string;
  summary: string;
  author: { name: string; url?: string };
  license: string;
  categories?: string[];
  keywords?: string[];
  icon?: string;
  source?: string;
  latest: string;
  versions: IndexVersion[];
}

interface Index {
  schemaVersion: number;
  plugins: IndexPlugin[];
}

/** 一个已在工作区中打包好的插件 */
interface FreshPlugin {
  dirName: string;
  manifest: PluginManifest;
  buffer: Buffer;
  version: IndexVersion;
}

// ============================================================
// 版本比较
// ============================================================

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  pre: string;
}

function parseVersion(value: string): ParsedVersion | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(value);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] ?? '',
  };
}

/** 预发布标识符比较，遵循 semver：数字段按数值比，且数字段小于字母段 */
function comparePrerelease(a: string, b: string): number {
  const left = a.split('.');
  const right = b.split('.');
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const x = left[i];
    const y = right[i];
    if (x === undefined) return -1; // 段数少的更小
    if (y === undefined) return 1;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) {
      if (Number(x) !== Number(y)) return Number(x) - Number(y);
      continue;
    }
    if (xNumeric) return -1;
    if (yNumeric) return 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** 升序比较。无法解析的版本回退为字符串比较，保证排序仍然确定。 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return a < b ? -1 : a > b ? 1 : 0;

  for (const key of ['major', 'minor', 'patch'] as const) {
    if (left[key] !== right[key]) return left[key] - right[key];
  }
  // 同号时，带预发布后缀的低于正式版
  if (left.pre === right.pre) return 0;
  if (left.pre === '') return 1;
  if (right.pre === '') return -1;
  return comparePrerelease(left.pre, right.pre);
}

// ============================================================
// 文件遍历与哈希
// ============================================================

/** 递归列出目录下的常规文件，返回以 `/` 分隔的相对路径（已排序） */
function walkFiles(dir: string): string[] {
  const found: string[] = [];

  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const abs = join(current, entry.name);

      // **符号链接必须显式拒绝，不能静默跳过。**
      //
      // `Dirent` 对符号链接既不是 isDirectory 也不是 isFile，因此下面两个分支都不命中，
      // 条目会被安静地漏掉。而 `manifest.ts` 用 `existsSync` + `statSync`（两者都**跟随**
      // 链接）判定必需文件是否存在 —— 于是一个把 `index.js` 写成符号链接的插件能通过
      // 全部校验、被打包"成功"，而包内缺少入口文件。
      if (entry.isSymbolicLink()) {
        throw new Error(
          `不支持符号链接: ${relative(dir, abs)} —— 链接不会进入 .lcp，` +
            `而清单校验会跟随它认为文件存在，结果是「校验通过但包内缺文件」`
        );
      }

      if (entry.isDirectory()) {
        visit(abs);
      } else if (entry.isFile()) {
        found.push(relative(dir, abs).split(sep).join('/'));
      }
    }
  };

  visit(dir);
  return found.sort();
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function pluginDirNames(): string[] {
  return readdirSync(PLUGINS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort();
}

// ============================================================
// 打包
// ============================================================

function packagePlugin(dir: string): Buffer {
  const files = walkFiles(dir).filter((rel) => !PACKAGE_IGNORE.has(basename(rel)));
  if (files.length === 0) throw new Error(`${dir} 下没有可打包的文件`);
  return createZip(files.map((rel) => ({ name: rel, data: readFileSync(resolve(dir, rel)) })));
}

function packOne(dirName: string): FreshPlugin {
  const dir = join(PLUGINS_DIR, dirName);
  const manifest = readManifest(dir);
  const buffer = packagePlugin(dir);

  // 确定性是索引里 sha256 有意义的前提（见 zip.ts 开头）。它不是「应该成立」的性质，
  // 而是每次都验证的不变量：这里再打一次并比对字节。一旦有人引入时间戳、随机顺序之类
  // 的非确定因素，构建会当场失败，而不是安静地生成一个每次都不一样的包。
  const again = packagePlugin(dir);
  if (!buffer.equals(again)) {
    throw new Error(`${manifest.name}: 两次打包结果不一致，zip 输出不是确定性的`);
  }

  return {
    dirName,
    manifest,
    buffer,
    version: {
      version: manifest.version,
      tag: `${dirName}-v${manifest.version}`,
      engines: { loopcore: manifest.engines?.loopcore ?? '*' },
      permissions: [...(manifest.permissions ?? [])],
      package: {
        path: `dist/${manifest.name}-${manifest.version}.lcp`,
        size: buffer.length,
        sha256: sha256(buffer),
      },
    },
  };
}

// ============================================================
// 索引
// ============================================================

function readIndex(): Index | null {
  if (!existsSync(INDEX_FILE)) return null;
  try {
    return JSON.parse(readFileSync(INDEX_FILE, 'utf8')) as Index;
  } catch (err) {
    throw new Error(`index.json 不是合法 JSON：${err instanceof Error ? err.message : err}`);
  }
}

function stringifyIndex(index: Index): string {
  return `${JSON.stringify(index, null, 2)}\n`;
}

/**
 * 把当前工作区打好的版本并入既有索引。
 *
 * 必须**并入**而不是重建：索引记录的是历史上发布过的每个版本，而工作区里只有当前
 * 版本的源码。直接重建会让旧版本的条目连同它的哈希一起消失，客户端随即失去
 * 「某个老版本还在、内容是什么」这一事实。
 *
 * 工作区里已经不存在的插件目录会被整体移出索引（那表示插件被下架），调用方负责
 * 把这件事报出来 —— 静默消失是最难排查的一类问题。
 */
function buildIndex(previous: Index | null, fresh: readonly FreshPlugin[]): Index {
  const byDir = new Map(fresh.map((item) => [item.dirName, item]));
  const plugins: IndexPlugin[] = [];

  for (const dirName of pluginDirNames()) {
    const item = byDir.get(dirName);
    if (!item) continue; // 同一来源，不应发生
    const { manifest, version } = item;

    const older = (previous?.plugins.find((p) => p.id === manifest.name)?.versions ?? []).filter(
      (v) => v.version !== version.version
    );
    const versions = [...older, version].sort((a, b) => compareVersions(b.version, a.version));

    const iconPath =
      manifest.icon && manifest.icon.endsWith('.svg') ? `plugins/${dirName}/${manifest.icon}` : undefined;

    plugins.push({
      id: manifest.name,
      displayName: manifest.displayName ?? manifest.name,
      summary: manifest.description ?? '',
      author: {
        name: manifest.author?.name ?? '',
        ...(manifest.author?.url ? { url: manifest.author.url } : {}),
      },
      license: manifest.license ?? '',
      ...(manifest.categories?.length ? { categories: [...manifest.categories] } : {}),
      ...(manifest.keywords?.length ? { keywords: [...manifest.keywords] } : {}),
      ...(iconPath ? { icon: iconPath } : {}),
      source: `plugins/${dirName}`,
      latest: versions[0].version,
      versions,
    });
  }

  plugins.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { schemaVersion: SCHEMA_VERSION, plugins };
}

/** 索引里引用的每个包都必须存在，且哈希与记录一致 */
function verifyIndexArtifacts(index: Index): string[] {
  const problems: string[] = [];
  for (const plugin of index.plugins) {
    for (const version of plugin.versions) {
      const file = join(ROOT, version.package.path);
      if (!existsSync(file)) {
        problems.push(`${plugin.id} ${version.version}: 索引引用的包不存在 ${version.package.path}`);
        continue;
      }
      if (sha256(readFileSync(file)) !== version.package.sha256) {
        problems.push(`${plugin.id} ${version.version}: ${version.package.path} 的哈希与索引不符`);
      }
    }
  }
  return problems;
}

/**
 * 找出「同一个版本号被打包出了不同字节」的情况。
 *
 * 这类情况必须被**拒绝**而不是静默接受：索引里的 `sha256` 是「这个版本号对应这份内容」
 * 的唯一凭据，一旦同一版本号出现两份内容，客户端缓存、CDN 缓存与用户手里已装的包就会
 * 互相矛盾 —— 而 `README.md` 承诺的「同一个版本号下的内容永远一致」也就只是句话。
 *
 * 这个错误最常见的成因是「改了源码但忘了升版本」。此前的脚本在这种情况下会正常成功，
 * `--check` 也随之通过（它比对的正是刚生成的新索引），因此工具层没有任何拦截，只剩
 * tag 纪律在撑。正确做法是升一个版本（PATCH）。
 */
function findVersionRewrites(previous: Index | null, fresh: readonly FreshPlugin[]): string[] {
  const problems: string[] = [];

  for (const item of fresh) {
    const recorded = previous?.plugins
      .find((p) => p.id === item.manifest.name)
      ?.versions.find((v) => v.version === item.version.version);

    if (recorded && recorded.package.sha256 !== item.version.package.sha256) {
      problems.push(
        `${item.manifest.name} ${item.version.version}: 该版本已在索引里发布过，但当前源码打包出的哈希不同\n` +
          `      索引记录 ${recorded.package.sha256}\n` +
          `      当前打包 ${item.version.package.sha256}\n` +
          `      已发布的版本号不可改写 —— 请升一个版本后重新打包`
      );
    }
  }

  return problems;
}

/**
 * 检查**历史条目**引用的包是否仍在位且哈希一致。
 *
 * 本次工作区里存在的插件版本会被重新打包、其字节稍后才落盘，因此这里跳过它们；
 * 其余条目（旧版本、以及 `plugins/` 下已不存在的插件）必须能在磁盘上找到。
 *
 * 它存在的意义是让「产物与索引不一致」这一类失败发生在**落盘之前**：原先这件事由
 * `verifyIndexArtifacts` 在落盘之后做，失败时 `dist/` 已经被本次运行改写，
 * 与文档承诺的「任何一步失败都不会写出产物」矛盾。
 */
function verifyRecordedArtifacts(
  previous: Index | null,
  fresh: readonly FreshPlugin[]
): string[] {
  const problems: string[] = [];
  const freshlyPacked = new Set(
    fresh.map((item) => `${item.manifest.name}@${item.version.version}`)
  );

  for (const plugin of previous?.plugins ?? []) {
    for (const version of plugin.versions) {
      if (freshlyPacked.has(`${plugin.id}@${version.version}`)) continue;

      const file = join(ROOT, version.package.path);
      if (!existsSync(file)) {
        problems.push(`${plugin.id} ${version.version}: 索引引用的包不存在 ${version.package.path}`);
        continue;
      }
      if (sha256(readFileSync(file)) !== version.package.sha256) {
        problems.push(`${plugin.id} ${version.version}: ${version.package.path} 的哈希与索引不符`);
      }
    }
  }

  return problems;
}

function reportDropped(previous: Index | null, next: Index): void {
  const kept = new Set(next.plugins.map((p) => p.id));
  for (const plugin of previous?.plugins ?? []) {
    if (kept.has(plugin.id)) continue;
    console.warn(
      `  ! ${plugin.id} 已从索引移除（plugins/ 下不再有对应目录），其 ${plugin.versions.length} 个已发布版本同时消失`
    );
  }
}

// ============================================================
// 主流程
// ============================================================

function main(): number {
  const checkOnly = process.argv.includes('--check');

  if (!existsSync(PLUGINS_DIR)) {
    console.error(`找不到插件目录：${PLUGINS_DIR}`);
    return 1;
  }

  const dirNames = pluginDirNames();
  if (dirNames.length === 0) {
    console.error('plugins/ 下没有任何插件');
    return 1;
  }

  // ---- 1. 校验全部清单。先收集完再报，避免「改一个跑一次」 ----
  const problems: string[] = [];
  for (const dirName of dirNames) {
    const dir = join(PLUGINS_DIR, dirName);
    if (!existsSync(join(dir, 'manifest.json'))) {
      problems.push(`plugins/${dirName}: 缺少 manifest.json`);
      continue;
    }
    for (const problem of validatePlugin(dir, dirName)) {
      problems.push(`plugins/${dirName}: ${problem}`);
    }
  }
  if (problems.length > 0) {
    console.error('清单校验未通过：\n');
    for (const problem of problems) console.error(`  ✘ ${problem}`);
    console.error(`\n共 ${problems.length} 个问题，未生成任何产物。`);
    return 1;
  }

  // ---- 2. 打包（只进内存，check 模式不落盘） ----
  const fresh = dirNames.map(packOne);

  if (checkOnly) return runCheck(fresh);

  // ---- 3. 落盘之前的全部校验 ----
  //
  // 顺序是刻意的：**能在落盘前发现的失败，一律在落盘前拒绝**。此前是 dist/ 先落盘、
  // 复核在其后，于是「索引与产物不一致」时留下的是「dist 已换、index 未换」的半更新
  // 状态，与本文件开头和 docs/发布流程.md 承诺的「任何一步失败都不会写出产物」相矛盾。
  const previous = readIndex();

  const rewrites = findVersionRewrites(previous, fresh);
  if (rewrites.length > 0) {
    console.error('已发布版本的内容被改写，未生成任何产物：\n');
    for (const problem of rewrites) console.error(`  ✘ ${problem}`);
    return 1;
  }

  const staleProblems = verifyRecordedArtifacts(previous, fresh);
  if (staleProblems.length > 0) {
    console.error('历史产物与索引不一致，未生成任何产物：\n');
    for (const problem of staleProblems) console.error(`  ✘ ${problem}`);
    return 1;
  }

  // ---- 4. 落盘 ----
  mkdirSync(DIST_DIR, { recursive: true });
  for (const item of fresh) {
    writeFileSync(join(ROOT, item.version.package.path), item.buffer);
    console.log(
      `  ✔ ${item.version.package.path}  ${item.buffer.length} 字节  ${item.version.package.sha256.slice(0, 12)}…`
    );
  }

  // ---- 5. 生成索引并复核 ----
  const index = buildIndex(previous ?? { schemaVersion: SCHEMA_VERSION, plugins: [] }, fresh);

  // 新包此刻已在位，因此这一步能抓住「手工改过 index.json」与「dist 里的包被换」两类问题。
  const mismatches = verifyIndexArtifacts(index);
  if (mismatches.length > 0) {
    console.error('\n产物与索引不一致，未写入索引：');
    for (const problem of mismatches) console.error(`  ✘ ${problem}`);
    return 1;
  }

  reportDropped(previous, index);
  writeFileSync(INDEX_FILE, stringifyIndex(index));

  const versionCount = index.plugins.reduce((sum, p) => sum + p.versions.length, 0);
  console.log(
    `\n索引已写入 index.json：${index.plugins.length} 个插件、${versionCount} 个版本，哈希全部复核通过。`
  );

  if (signatureProblem() !== null) {
    // 不当作失败：签名需要私钥，而本脚本刻意不接触私钥。但必须说得足够响 ——
    // 忘了这一步的代价是所有人的市场打不开。
    console.log(
      '\n⚠ 索引需要签名（推送前必须完成）：\n  ' +
        SIGN_COMMAND +
        '\n  生成的 index.json.sig 需要与 index.json 在同一次提交里。'
    );
  }

  return 0;
}

/** 只校验：源码与索引是否一致、索引与 dist 里的包是否一致 */
function runCheck(fresh: readonly FreshPlugin[]): number {
  const problems: string[] = [];
  const previous = readIndex();

  if (!previous) {
    console.error('index.json 不存在。运行 node scripts/build.ts 生成。');
    return 1;
  }

  for (const item of fresh) {
    const recorded = previous.plugins
      .find((p) => p.id === item.manifest.name)
      ?.versions.find((v) => v.version === item.manifest.version);

    if (!recorded) {
      problems.push(
        `${item.manifest.name} ${item.manifest.version}: index.json 里没有该版本，需要重新生成索引`
      );
    } else if (recorded.package.sha256 !== item.version.package.sha256) {
      problems.push(
        `${item.manifest.name} ${item.manifest.version}: 源码当前打包出的哈希与索引记录不符 —— ` +
          `要么改了源码没重新打包，要么改了源码没重新生成索引`
      );
    }
  }

  problems.push(...verifyIndexArtifacts(previous));

  const expected = buildIndex(previous, fresh);
  if (stringifyIndex(expected) !== readFileSync(INDEX_FILE, 'utf8')) {
    problems.push('index.json 与仓库内容不一致，需要重新生成');
  }

  const signatureIssue = signatureProblem();
  if (signatureIssue) problems.push(signatureIssue);

  if (problems.length > 0) {
    console.error('校验未通过：\n');
    for (const problem of problems) console.error(`  ✘ ${problem}`);

    // 结尾的指引必须与问题匹配。签名缺失**不是**重新生成索引能解决的，
    // 一律提示 build 会让人照着做一遍然后发现毫无变化。
    const onlySignatureIssue = problems.length === 1 && signatureIssue !== null;
    console.error(
      onlySignatureIssue
        ? '\n签名需要私钥，本脚本刻意不接触它，因此不会代签。'
        : '\n修复后重新运行校验；若提示索引与产物不一致，运行 node scripts/build.ts。'
    );
    return 1;
  }

  const versionCount = previous.plugins.reduce((sum, p) => sum + p.versions.length, 0);
  console.log(`校验通过：${previous.plugins.length} 个插件、${versionCount} 个版本，索引与产物一致。`);
  return 0;
}

process.exit(main());
