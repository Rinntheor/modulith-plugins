// scripts/build.ts
// 打包插件并生成索引
//
//   node scripts/build.ts            打包并写入 dist/ 与 index.json
//   node scripts/build.ts --check    只校验，不写任何文件；发现问题时以非零码退出
//
// 索引的格式定义在**应用仓库**：
//   docs/02-开发指南/插件开发/清单文件参考.md
// 本脚本是该格式的生产方。格式只有那一份定义 —— 在这里再抄一份说明必然漂移。
//
// ============================================================
// dist/ 有**两种形状**，而且两种会长期并存
// ============================================================
//
//   * 历史版本（2026-10 之前发布）：平铺，`dist/<插件 ID>-<版本号>.lcp`；
//   * 新版本（本次改动之后发布）：分目录，`dist/<插件目录名>/<版本号>.lcp`。
//
// **历史的那一种不能改。** 索引里每个版本的 `package.path` 是客户端直接拼接的仓库内
// 相对路径（宿主 `src/services/pluginMarket.ts` 的 `registrySources(version.tag,
// version.package.path, ...)`），而 `release.ts --check` 会验证「tag 指向的提交里含有
// `package.path` 那个包」。旧 tag 的提交树里文件就在平铺路径上 —— 改一个字节，已发布
// 版本就会 404。
//
// 因此本文件里**只有"新生成一个路径"的那一处**用到新规则（`distPathFor`）。
// 所有"从磁盘已有产物建立索引条目"的历史保留逻辑一律读索引里原有的 `package.path`：
//
//   * `packOne` —— 某个版本号已在索引里时，沿用索引记录的路径（新版本才用新规则）；
//   * `verifyRecordedArtifacts` / `verifyIndexArtifacts` —— 只按 `package.path` 找文件。
//
// 于是 `--check` 天然同时接受两种形状，`dist/` 里两种布局并存也不会互相干扰。

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PACKAGE_IGNORE, namingAdvisories, readManifest, validatePlugin, type PluginManifest } from './manifest.ts';
import { createZip } from './zip.ts';
import { bundleAll, orphanedOutputs } from './bundle.ts';

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

/**
 * 检查签名文件的**字节形状**。
 *
 * ============================================================
 * 为什么需要它（2026-10-07 的市场事故）
 * ============================================================
 *
 * `index.json.sig` 的内容是**正确且新鲜**的签名，但文件后面被多写了 30 个字节：
 *
 *     node scripts/build.ts --check\n
 *
 * 也就是说，紧接着要跑的那条命令被写进了签名文件里。后果不是"新插件看不到"，
 * 而是**所有人的市场都打不开**：
 *
 * 客户端对签名的解码是严格的 —— 整个文件必须是合法 base64。多出来的字节让 `=`
 * 不再位于末尾，解码在 offset 394 失败，客户端拒绝使用**整份索引**。
 * 两条候选来源（jsDelivr 与 GitHub 直连）拿到的是同一份坏文件，因此两条一起失败。
 *
 * ============================================================
 * 为什么此前没有任何东西拦得住
 * ============================================================
 *
 * - `signatureProblem()` 只比较索引与签名的**修改时间** —— 签名确实被改过，
 *   而且比索引新，因此这一项是"通过"的；
 * - `release.ts --check` 只查 tag；
 * - 两者都不看签名的字节。
 *
 * 更隐蔽的一点：**`Buffer.from(str, 'base64')` 会静默跳过非法字符**，
 * 于是"解一下再验签"也会得出「签名有效」这个错误结论 —— 我第一版线上验证脚本
 * 就是这么被骗过去的。只有显式的字符表与补位检查能发现它。
 *
 * 这一步不需要私钥（它只看形状），因此可以放进 CI。
 */
function signatureShapeProblem(): string | null {
  if (!existsSync(INDEX_SIGNATURE_FILE)) return null; // 缺文件由上面那道负责

  const text = readFileSync(INDEX_SIGNATURE_FILE, 'utf8');
  // 与客户端一致：先 trim。tauri 写出的文件没有尾随换行，但尾随空白本身
  // 不影响解码，把它当成错误会造成假失败。
  const trimmed = text.trim();

  const broken = (detail: string): string =>
    `index.json.sig 的字节形状非法：${detail}\n` +
    '  客户端会拒绝使用**整份索引** —— 市场对所有人打不开。\n' +
    '  常见成因：签名文件被追加了别的内容（例如把下一条命令写进了文件），' +
    '或用重定向/编辑器保存时改了编码。\n' +
    '  ' +
    SIGN_COMMAND;

  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(trimmed)) {
    const bad = trimmed.search(/[^A-Za-z0-9+/=]/);
    return broken(
      `含 base64 字符表之外的字符（第一个在第 ${bad} 个字符处：` +
        `${JSON.stringify(trimmed.slice(bad, bad + 40))}）`
    );
  }

  if (trimmed.length % 4 !== 0) {
    return broken(`长度不是 4 的倍数（${trimmed.length} 个字符）`);
  }

  // `=` 只能出现在最后两个位置。字符表正则已经限定了"最多两个且在末尾"，
  // 这里再查一次位置，是为了在**中间**出现 `=`（本次事故的形态）时能指到具体位置。
  const firstEq = trimmed.indexOf('=');
  if (firstEq !== -1 && firstEq < trimmed.length - 2) {
    return broken(
      `\`=\` 出现在第 ${firstEq} 个字符处，但它只能出现在最后两位 —— ` +
        '文件多半被追加了内容'
    );
  }

  const lines = Buffer.from(trimmed, 'base64')
    .toString('utf8')
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.trim().length > 0);

  if (lines.length < 4) {
    return broken(`解出的 minisign 内容只有 ${lines.length} 行，应当有 4 行`);
  }
  if (!lines[0].startsWith('untrusted comment:')) {
    return broken('第 1 行不是 `untrusted comment:`');
  }
  if (!lines[2].startsWith('trusted comment:')) {
    return broken('第 3 行不是 `trusted comment:`');
  }

  // 10 字节头（算法 2 + key id 8）+ 64 字节签名
  const blob = Buffer.from(lines[1], 'base64');
  if (blob.length !== 74) {
    return broken(`签名数据段是 ${blob.length} 字节，应当是 74 字节（10 字节头 + 64 字节签名）`);
  }

  if (text.includes('\r')) {
    return broken('文件含 CR（CRLF 换行）—— 签名文件应当是 LF 换行');
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
  engines: { modulith: string };
  permissions: string[];
  /**
   * 这个版本贡献了哪些种类。
   *
   * **由清单派生，不是作者填写。** 形态决定"这个插件会不会占用户侧边栏一行"，
   * 是用户的判断依据 —— 与权限风险同理，由被审查的一方提供的信息不可信。
   *
   * 放在**版本级**而不是插件级：形态可以随版本变化（例如纯命令插件长出了界面），
   * 位置与 `permissions` 一致。
   */
  kinds?: string[];
  /** 声明了 `onStartup`：应用可用之后它就会开始工作 */
  background?: boolean;
  /**
   * 这个版本跑在哪里：`"sandboxed"` 或 `"in-process"`。
   *
   * **由清单派生，不是作者填写** —— 与 `kinds` / `permissions` 同一个位置、
   * 同一个理由。
   *
   * ============================================================
   * 为什么这一项比 `kinds` 重要得多
   * ============================================================
   *
   * `kinds` 只决定"它会不会占用户侧边栏一行"，而这一项决定**宿主放不放行安装**：
   * 未隔离插件与宿主跑在同一个 JS 上下文里，它申请的权限只是声明、不是约束，
   * 因此 v1.6.0 起宿主默认只允许安装已隔离的插件。
   *
   * 基于这一点，写作方式与 `kinds` 有一处**刻意的不同**：
   *
   *   * `kinds` 在空数组时**不写**（"没有这个字段"与"声明了但一个都不生效"
   *     是两件事，前者该被如实表达）；
   *   * `runtime` **每个版本都写**，包含缺省的那一档 `"in-process"`。
   *
   * 因为缺省值就落在这个字段本身上：清单里不写 `runtime` 就是 `in-process`。
   * 而索引里"没有这个字段"会被宿主解读为**不知道**（索引比清单旧），
   * 于是宿主要多走一道"打开包、读清单"的核实。把每一档都写明，
   * 那条核实路径就不会在正常情况下被走到。
   *
   * 宿主侧的三档处理与"不知道"为什么放行，见应用仓库
   * `src/services/pluginMarket.ts` 的 `installGate`。
   */
  runtime: 'sandboxed' | 'in-process';
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

/**
 * 宿主会消费的贡献点名称。
 *
 * **这是一份跨仓库契约**：名单必须与宿主 `src/services/pluginContributions.ts` 的
 * `CONTRIBUTION_KINDS` 逐字一致。不一致的后果不是报错，而是市场把某个插件归错档 ——
 * 那种错没人会报 bug，只会有人默默觉得"这个分类不太对"。
 *
 * 不做成"从清单里读到什么就写什么"：那样一个拼错的键会被原样写进索引，宿主既不认识
 * 也不会报错。白名单让拼错变成一次**派生不出来**（该种类缺席），是可观察的。
 */
const CONTRIBUTION_KINDS = ['modules', 'commands', 'settings', 'contextMenus'] as const;

/** 清单里实际声明了内容的贡献点（空数组合"没声明"等价） */
function contributionKinds(manifest: PluginManifest): string[] {
  const contributes = manifest.contributes ?? {};
  return CONTRIBUTION_KINDS.filter((kind) => {
    const list = contributes[kind];
    return Array.isArray(list) && list.length > 0;
  });
}

/**
 * **新版本的**产物路径：`dist/<插件目录名>/<版本号>.lcp`。
 *
 * 这是新布局唯一的"生产点"。它**只用于生成还没在索引里出现过的版本** ——
 * 已经在索引里的版本号必须沿用索引记录的 `package.path`（见 `packOne`），
 * 否则已发布版本会指向一个那个 tag 的提交树里不存在的路径。
 *
 * 用目录名而不是插件 ID 做目录段：目录名是仓库内的稳定身份（tag 也用它，
 * `<目录名>-v<版本号>`），而 ID 的末段与目录名已经解耦（见 docs/目录规范.md 第 3 节）。
 * 版本号做文件名：同一个插件下多个版本因此互不覆盖，`git status` 里也一眼看得出
 * 新增了哪一版。
 *
 * 导出是为了能在进程内直接验证它的输出（沙箱里跑不起 esbuild，把规则导出比
 * 事后从磁盘形状反推可靠）。
 */
export function distPathFor(dirName: string, version: string): string {
  return `dist/${dirName}/${version}.lcp`;
}

/**
 * 打包一个插件。
 *
 * `previous` 用来决定**产物路径**：某个版本号已经在索引里，就沿用索引记录的那一条
 * （`recorded.package.path`），不按新规则重算 —— 这就是"新布局只对将来的版本生效"
 * 的落点。已发布版本的路径与不可变 tag 的提交树必须逐字对应，重算会让老用户 404。
 *
 * 导出是为了能在**进程内**验证这条规则：受限环境里 esbuild 起不了子进程
 * （`spawn EPERM`），整条 `build.ts --check` 跑不起来，而"已发布的路径不被重算"
 * 恰恰是这次改动最不能错的一条。`compareVersions` 是同样的用途。
 */
export function packOne(dirName: string, previous: Index | null): FreshPlugin {
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

  // 形态信息：两个字段都只在**有内容时**写入。
  // 写 `"kinds": []` 与"没有这个字段"在宿主侧含义不同 —— 前者会被解读为
  // "这个插件声明了贡献点但一个都没生效"，而我们要表达的是"老插件没有这个信息"。
  const kinds = contributionKinds(manifest);
  const background = (manifest.activationEvents ?? []).includes('onStartup');

  // 路径的两种来源，顺序即优先级：
  //   1. 索引已经记过这个版本 → 用**记录的**那一条（历史平铺，或上一次发布时定的新路径）；
  //   2. 否则 → 新布局 `dist/<目录名>/<版本号>.lcp`。
  // 认版本号而不是文件是否存在：文件在不在是"产物有没有丢"，不是"路径该叫什么"。
  const recorded = previous?.plugins
    .find((plugin) => plugin.id === manifest.name)
    ?.versions.find((item) => item.version === manifest.version);

  return {
    dirName,
    manifest,
    buffer,
    version: {
      version: manifest.version,
      tag: `${dirName}-v${manifest.version}`,
      engines: { modulith: manifest.engines?.modulith ?? '*' },
      permissions: [...(manifest.permissions ?? [])],
      ...(kinds.length > 0 ? { kinds } : {}),
      ...(background ? { background: true } : {}),
      // 运行位置。**每一档都写**，包括缺省的 `in-process` —— 理由见索引结构里
      // `runtime` 上那段说明：宿主把"没有这个字段"读成"不知道"，而"不知道"
      // 会让它多走一道打开包读清单的核实。正常情况下不该走到那里。
      runtime: manifest.runtime === 'sandboxed' ? 'sandboxed' : 'in-process',
      package: {
        path: recorded?.package.path ?? distPathFor(dirName, manifest.version),
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
function buildIndex(fresh: readonly FreshPlugin[]): Index {
  const byDir = new Map(fresh.map((item) => [item.dirName, item]));
  const plugins: IndexPlugin[] = [];

  for (const dirName of pluginDirNames()) {
    const item = byDir.get(dirName);
    if (!item) continue; // 同一来源，不应发生
    const { manifest, version } = item;

    // ============================================================
    // 索引里**只保留当前版本**（2026 的政策变更）
    // ============================================================
    //
    // 此前这里把索引里已有的旧版本一并带上（`older`），理由是"工作区里只有当前
    // 版本的源码，直接重建会让旧版本连同它的哈希一起消失"。
    //
    // 那个理由本身成立，但它换来的是一个**没有任何消费方**的历史：客户端只安装
    // `latest`（`latestVersionOf()` 是市场唯一的入口，`planUpdate()` 第一行就是它，
    // 全仓没有任何"选一个版本"的界面）。而代价是**每个版本一条不可变 tag** ——
    // 32 个版本就是 32 个 tag，插件数量上去之后 tag 线性膨胀：每个 ref 都要推送、
    // 都要被 CDN 建缓存，而它们全部指向永远不会被拉取的内容。
    //
    // 现在的取舍是**三件事各归其位，谁都不重复**：
    //
    //   * 索引只回答"现在该装哪一版" —— 一个插件一条，tag 因此也只剩一条；
    //   * 历史产物留在 `dist/` 里归档（不再被索引引用，因此也不再被 `--check` 校验）；
    //   * "某个版本当时发的是什么"由 **git 历史里的 `index.json`** 回答 ——
    //     每一次发布都改过它，旧条目连同 sha256 全在历史里，`git log -p index.json`
    //     查得到，`git checkout <那个提交>` 就能逐字节核对。
    //
    // 代价如实写下：**历史版本不再可安装**（没有 tag 就没有不可变地址，`@main`
    // 地址是可变且按小时缓存的，不能拿来当版本标识）。这是一个有意的取舍 ——
    // 客户端从来不安装旧版本，而维护者要"查当时发了什么"时，git 历史比 index
    // 更完整。
    const versions = [version];

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

/**
 * 索引里引用的每个包都必须存在，且哈希与记录一致。
 *
 * **唯一准绳是索引里的 `package.path`**，因此平铺（`dist/<ID>-<版本>.lcp`）与
 * 新分目录（`dist/<目录名>/<版本>.lcp`）两种形状都通过 —— `--check` 不需要知道
 * 布局，它只回答"索引说的那个文件在不在、字节对不对"。
 */
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

async function main(): Promise<number> {
  const checkOnly = process.argv.includes('--check');

  // ---- 0. 先把多文件源码构建成单文件 IIFE ----
  //
  // 放在**最前面**：包里的 `index.js` 是产物，后面所有校验（文件哈希、索引记录）
  // 都必须基于构建之后的内容。顺序反了会出现最难查的一种状态 —— 索引对得上、
  // 而包里的代码是旧的。
  //
  // 没有 `src/<插件>/` 的插件会被跳过：它们仍然是手写单文件，这条链路可选。
  const bundles = await bundleAll({ check: checkOnly });
  const stale = bundles.filter((report) => report.changed);

  if (checkOnly && stale.length > 0) {
    console.error('插件产物与源码不一致：\n');
    for (const report of stale) {
      console.error(`  ✘ plugins/${report.name}/index.js 需要重新构建`);
    }
    console.error(`\n共 ${stale.length} 个。改完源码后跑一次 pnpm build。`);
    return 1;
  }

  if (bundles.length > 0) {
    console.log(
      checkOnly
        ? `src/ 下的 ${bundles.length} 个插件产物均为最新`
        : `已从 src/ 构建 ${bundles.length} 个插件的产物`
    );
  }

  // 源码删了、产物还在：它会以一个"没有源码的构建产物"继续出现在索引里，
  // 而下次有人想改它时才会发现无从下手。
  const orphans = orphanedOutputs();
  if (orphans.length > 0) {
    console.error('这些目录里有构建产物，但没有对应的源码：\n');
    for (const name of orphans) {
      console.error(`  ✘ plugins/${name}（src/${name}/ 不存在，产物还在）`);
    }
    console.error('\n删掉它的 index.js，或者把源码放回 src/。');
    return 1;
  }

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
  //
  // 索引在这里就**读出来备用**（而不是等到落盘前）：`packOne` 要靠它判断某个版本号
  // 是否已经发布过 —— 已发布的版本必须沿用索引里记录的 `package.path`，
  // 新布局只能作用于将来的版本。读索引本来就没有副作用，提前读不改变任何不变量。
  const previous = readIndex();

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

  // 命名建议：**不是错误**，不阻断构建。理由见 docs/目录规范.md 第 3 节 ——
  // 硬要求是"目录名在本仓库内唯一"（tag 用的就是它），与 ID 的末段无关。
  for (const dirName of dirNames) {
    for (const advice of namingAdvisories(join(PLUGINS_DIR, dirName), dirName)) {
      console.log(`  ! plugins/${dirName}: ${advice}`);
    }
  }

  // ---- 2. 打包（只进内存，check 模式不落盘） ----
  const fresh = dirNames.map((dirName) => packOne(dirName, previous));

  if (checkOnly) return runCheck(fresh, previous);

  // ---- 3. 落盘之前的全部校验 ----
  //
  // 顺序是刻意的：**能在落盘前发现的失败，一律在落盘前拒绝**。此前是 dist/ 先落盘、
  // 复核在其后，于是「索引与产物不一致」时留下的是「dist 已换、index 未换」的半更新
  // 状态，与本文件开头和 docs/发布流程.md 承诺的「任何一步失败都不会写出产物」相矛盾。
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
  //
  // 每个包各自 `mkdir` 它的父目录：新布局下是 `dist/<目录名>/`，而那是**第一次发这个
  // 插件的新版本时**才出现的目录。只建 `dist/` 那一层会让新布局在第一次使用时
  // 以一个 ENOENT 收场。
  mkdirSync(DIST_DIR, { recursive: true });
  for (const item of fresh) {
    const target = join(ROOT, item.version.package.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, item.buffer);
    console.log(
      `  ✔ ${item.version.package.path}  ${item.buffer.length} 字节  ${item.version.package.sha256.slice(0, 12)}…`
    );
  }

  // ---- 5. 生成索引并复核 ----
  const index = buildIndex(fresh);

  // 新包此刻已在位，因此这一步能抓住「手工改过 index.json」与「dist 里的包被换」两类问题。
  const mismatches = verifyIndexArtifacts(index);
  if (mismatches.length > 0) {
    console.error('\n产物与索引不一致，未写入索引：');
    for (const problem of mismatches) console.error(`  ✘ ${problem}`);
    return 1;
  }

  reportDropped(previous, index);

  // ============================================================
  // 内容没变就**不重写**索引（这条不是洁癖）
  // ============================================================
  //
  // 此前这里无条件 `writeFileSync`。而 `index.json` 的修改时间是 `--check` 里
  // **唯一**能判断"索引改了没重新签名"的依据（签名本身验不了，见
  // `signatureProblem`）。于是出现一个真实撞到过的假失败：
  //
  //   签名 → `release.ts --push`（它会先跑一次 build，把同一份索引原样重写）
  //        → 索引的 mtime 比签名新 → `--check` 报"索引改过但没有重新签名"
  //
  // 内容一模一样、签名完全有效，工具却坚持说没签 —— 而作者照着提示去重签，
  // 下次 push 又会重写一遍 mtime。这是一个自己制造的死循环。
  //
  // 只写"变了的内容"就把它断掉了：确定性构建下重复运行产出同一份文本，
  // mtime 因此停在上一次真正的改动上。
  const serialized = stringifyIndex(index);
  const versionCount = index.plugins.reduce((sum, p) => sum + p.versions.length, 0);
  if (readFileSync(INDEX_FILE, 'utf8') === serialized) {
    console.log('\n索引内容未变，未重写 index.json（保持它的修改时间，那是签名校验的依据）');
  } else {
    writeFileSync(INDEX_FILE, serialized);
    console.log(
      `\n索引已写入 index.json：${index.plugins.length} 个插件、${versionCount} 个版本，哈希全部复核通过。`
    );
  }

  if (signatureProblem() !== null) {
    // 不当作失败：签名需要私钥，而本脚本刻意不接触私钥。但必须说得足够响 ——
    // 忘了这一步的代价是所有人的市场打不开。
    console.log(
      '\n⚠ 索引需要签名（推送前必须完成）：\n  ' +
        SIGN_COMMAND +
        '\n  生成的 index.json.sig 需要与 index.json 在同一次提交里。'
    );
  }

  // 形状问题是**已经存在**的坏文件，与"还没签"不同：它必须说出来。
  const shapeIssue = signatureShapeProblem();
  if (shapeIssue !== null) {
    console.log('\n⚠ ' + shapeIssue);
  }

  return 0;
}

/**
 * 只校验：源码与索引是否一致、索引与 dist 里的包是否一致。
 *
 * **它不认识任何布局。** 索引引用的每个包都按 `package.path` 逐字去找
 * （`verifyIndexArtifacts`），因此 `dist/` 里平铺的与新分目录的两种形状同时合法 ——
 * 这不是"特意兼容"，而是"唯一准绳本来就是索引里的那一条路径"。
 *
 * `previous` 由调用方传入（它在打包之前就得读出来给 `packOne` 定路径）；
 * 传 `null` 表示索引文件不存在。
 */
function runCheck(fresh: readonly FreshPlugin[], previous: Index | null): number {
  const problems: string[] = [];

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

  const expected = buildIndex(fresh);
  if (stringifyIndex(expected) !== readFileSync(INDEX_FILE, 'utf8')) {
    problems.push('index.json 与仓库内容不一致，需要重新生成');
  }

  // 两道与签名有关的检查，都不需要私钥：
  //   1. `signatureProblem`      —— 索引比签名新（「可能忘了签」）
  //   2. `signatureShapeProblem` —— 签名文件的字节形状非法（「签名文件坏了」）
  // 第 2 道是 2026-10-07 市场事故之后补的：当时第 1 道是**通过**的，
  // 因为签名确实被改过、而且比索引新。
  const signatureIssues: string[] = [];
  const freshnessIssue = signatureProblem();
  if (freshnessIssue) signatureIssues.push(freshnessIssue);
  const shapeIssue = signatureShapeProblem();
  if (shapeIssue) signatureIssues.push(shapeIssue);
  problems.push(...signatureIssues);

  if (problems.length > 0) {
    console.error('校验未通过：\n');
    for (const problem of problems) console.error(`  ✘ ${problem}`);

    // 结尾的指引必须与问题匹配。签名缺失**不是**重新生成索引能解决的，
    // 一律提示 build 会让人照着做一遍然后发现毫无变化。
    const onlySignatureIssue =
      signatureIssues.length > 0 && problems.length === signatureIssues.length;
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

// 直接运行：`node scripts/build.ts` / `node scripts/build.ts --check`
//
// 与 `bundle.ts` / `typecheck.ts` 同一形状的入口判断。**它不只是风格问题。**
// 本文件导出的 `distPathFor` 是"新布局落在哪"这条规则的唯一生产者，而受限环境里
// esbuild 起不了子进程（`spawn EPERM`），整条构建跑不起来 —— 那种环境下要验证这条
// 规则只能靠 `import`。没有这层判断，`import` 会顺带执行整个构建并 `process.exit()`。
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
