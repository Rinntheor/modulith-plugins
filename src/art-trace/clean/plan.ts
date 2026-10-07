// src/art-trace/clean/plan.ts
//
// 清理策略：把界面上的开关翻译成"丢哪些块、追加什么、要不要重画像素"。
//
// ============================================================
// 为什么策略与执行要分开
// ============================================================
//
// "抹掉什么"和"怎么抹"是两件事，而它们的正确性判据完全不同：
//
//   * 策略错了 → 用户的东西被删多了或删少了（**可逆**：重新跑一次就好，
//     因为源文件没动过）；
//   * 执行错了 → 文件坏了（不可逆）。
//
// 分开之后，策略成了一个**纯函数**（块列表 + 选项 → 计划），可以在界面上先"试算"
// 给用户看（"将丢掉 3 个块，保留 4 个"），也可以在批量前对整批图先算一遍总量。
// 这比"点了开始才知道会怎样"有用得多。

import type { CleanOptions, MetaBlock, WatermarkFields } from '../model/types';
import type { ContainerBlock, RebuildOptions } from '../codec/format';

/** 一次清理的计划。它同时是"给执行层用"与"给界面显示用"的同一份东西 */
export interface CleanPlan {
  /** 交给 `rebuild` 的丢块集合 */
  drop: Set<string>;
  /** 会被丢掉的块（界面按这个列表画预览，台账按它记录） */
  dropping: ContainerBlock[];
  /** 会被保留的块 */
  keeping: ContainerBlock[];
  /** 要追加的文本块 */
  append: Array<{ key: string; value: string }>;
  /**
   * 需要走"画布重编码"这条路。
   *
   * 它由 `reencodePixels` 决定，而**不是**由"有没有水印"决定 —— 打水印是另一条
   * 独立的路径（`watermark/render`），它自己就会重编码。把两者混在一起会让
   * "只清理不打水印"也付出重编码的代价（像素经过画布往返、ICC 丢失）。
   */
  needsPixelRewrite: boolean;
  /** 给用户看的提醒。空数组表示没有什么要提醒的 */
  warnings: string[];
}

/**
 * 算出一个清理计划。
 *
 * `drop` 集合用的是 `ContainerBlock.selector` 而不是 `id`：一个 selector 可能对应
 * 多个块（例如"所有普通文本块"），而丢块这个动作的粒度本来是"按类别"。
 */
export function planClean(
  blocks: ContainerBlock[],
  options: CleanOptions,
  orientation: number | null
): CleanPlan {
  const drop = new Set<string>();
  const dropping: ContainerBlock[] = [];
  const keeping: ContainerBlock[] = [];
  const warnings: string[] = [];

  const wantsDrop = (block: ContainerBlock): boolean => {
    // 结构性块永远不丢 —— 这不该由界面上某个开关决定。丢了它就得到一个坏文件，
    // 而用户的意图从来不是"给我一个坏文件"。
    if (block.structural) return false;

    switch (block.group) {
      case 'generator':
        return options.dropGenerator;
      case 'exif':
        // 方向单独处理：`dropExif` 为真而 `keepOrientation` 也为真时，EXIF 块会被
        // 丢掉，但执行层会写回一个**只含方向**的最小块（见 `rebuild` 的约定）。
        return options.dropExif;
      case 'xmp':
        return options.dropXmp;
      case 'c2pa':
        return options.dropC2pa;
      case 'text':
        return options.dropText;
      case 'icc':
        // 保留是**默认**，而"丢掉 ICC"这条路只由 `keepIcc: false` 打开。
        // 这一项的默认值与其它项相反，因为它的性质相反：它不是隐私，是色彩。
        return !options.keepIcc;
      case 'structural':
        // 物理尺寸（pHYs）、时间戳之类的结构块。
        return !options.keepPhysical;
      default:
        return false;
    }
  };

  for (const block of blocks) {
    if (wantsDrop(block)) {
      drop.add(block.selector);
      dropping.push(block);
    } else {
      keeping.push(block);
    }
  }

  // ---- 提醒 ----
  //
  // 提醒只针对"用户很可能没意识到"的后果。把每一件小事都提醒一遍等于没有提醒。

  if (orientation !== null && orientation !== 1) {
    if (!options.keepOrientation) {
      warnings.push(
        `这张图带方向信息（EXIF Orientation = ${orientation}）。关掉「保留方向」之后，` +
          '它在大多数查看器里会变成横的 —— 因为方向决定画面怎么摆，而它存在元数据里。'
      );
    } else if (options.dropExif) {
      warnings.push(
        `EXIF 会被丢掉，但方向（Orientation = ${orientation}）会以最小 EXIF 的形式写回，` +
          '因此画面朝向不变。'
      );
    }
  }

  if (!options.keepIcc && blocks.some((block) => block.group === 'icc')) {
    warnings.push(
      '丢掉 ICC 色彩描述文件会让图片在色彩管理正确的查看器里偏色（广色域作品尤其明显）。' +
        '它不是可追踪信息，通常没有理由丢。'
    );
  }

  if (options.reencodePixels) {
    warnings.push(
      '「重编码像素」会让图片经过一次画布往返：像素可能被重新采样（不再是原图那几个字节），' +
        'ICC 与所有元数据都会丢失。它比默认的容器重建**更彻底**，代价是画面可能变化。'
    );
  }

  const hasGenerator = blocks.some((block) => block.group === 'generator');
  if (hasGenerator && !options.dropGenerator) {
    warnings.push(
      '生成参数会被保留 —— 里面通常带着完整的提示词、工作流与模型名。'
    );
  }

  return {
    drop,
    dropping,
    keeping,
    append: options.append.map((item) => ({ key: item.key, value: item.value })),
    needsPixelRewrite: options.reencodePixels,
    warnings,
  };
}

/** 把计划变成 `rebuild` 的选项 */
export function toRebuildOptions(
  plan: CleanPlan,
  orientation: number | null,
  keepOrientation: boolean
): RebuildOptions {
  return {
    drop: plan.drop,
    append: plan.append,
    keepOrientation,
    orientation,
  };
}

// ============================================================
// 追加信息
// ============================================================
//
// ============================================================
// 为什么关键字刻意用英文、且避开 `Comment`
// ============================================================
//
// `Comment` 在 NovelAI 那里是**生成参数**的载体（一段 JSON）。把作者信息写进
// `Comment` 会让下一个人用任何识图工具看这张图时，看到一段"看起来像生成参数、
// 但解析不出来"的东西 —— 那比没有更坏。
//
// 因此这里用一组含义明确、且在各家工具里都不承载生成参数的关键字。

/** 一次清理要追加上去的身份信息 */
export interface IdentityInput {
  author: string;
  platform: string;
  profile: string;
  contact: string;
  license: string;
  extra: string;
  /** 追踪编号。留空表示这次不写编号 */
  traceId: string;
  /** 发放日期 `yyyyMMdd` */
  date: string;
  /** 写不写 `Software` 那一行 */
  writeSoftware: boolean;
}

/**
 * 把身份信息编成要追加的文本块。
 *
 * **空字段不写。** 一个 `Author: ` 的空块在界面上看起来像"没写成功"，而且它会白占
 * 一次重建时的位置 —— 用户看到的是"我明明没填作者，怎么多了一条"。
 */
export function buildIdentityBlocks(
  input: IdentityInput,
  softwareName: string
): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  const push = (key: string, value: string): void => {
    const trimmed = (value ?? '').trim();
    if (trimmed.length === 0) return;
    out.push({ key, value: trimmed });
  };

  push('Author', input.author);

  const copyrightParts: string[] = [];
  if (input.author.trim()) {
    copyrightParts.push(`© ${input.date.slice(0, 4) || ''} ${input.author.trim()}`.trim());
  }
  if (input.license.trim()) copyrightParts.push(input.license.trim());
  push('Copyright', copyrightParts.join(' · '));

  push('Contact', input.contact);

  const sourceParts: string[] = [];
  if (input.platform.trim()) sourceParts.push(input.platform.trim());
  if (input.profile.trim()) sourceParts.push(input.profile.trim());
  push('Source', sourceParts.join(' · '));

  push('License', input.license);
  push('Description', input.extra);

  if (input.traceId.trim()) {
    // 机器可读的一条：`k=v|k=v`，与隐形水印用的是同一套键名，
    // 因此从元数据里读到的编号与从 LSB 里读到的可以对上。
    const pairs = [`v=1`, `id=${input.traceId.trim()}`, `d=${input.date}`];
    if (input.author.trim()) pairs.push(`a=${input.author.trim()}`);
    if (input.platform.trim()) pairs.push(`p=${input.platform.trim()}`);
    push('art-trace', pairs.join('|'));
  }

  if (input.writeSoftware) push('Software', softwareName);

  return out;
}

/** 从水印字段推断一份身份信息，用于"水印设置与追加信息保持一致" */
export function identityFromFields(
  fields: WatermarkFields,
  date: string,
  writeSoftware: boolean
): IdentityInput {
  return {
    author: fields.author,
    platform: fields.platform,
    profile: fields.profile,
    contact: fields.contact,
    license: fields.license,
    extra: fields.extra,
    traceId: fields.id,
    date,
    writeSoftware,
  };
}

/** 计划的摘要文本，给界面上那句"将丢掉 N 个块（含生成参数）"用 */
export function summarizePlan(plan: CleanPlan): {
  dropped: number;
  kept: number;
  appended: number;
  hasGenerator: boolean;
} {
  return {
    dropped: plan.dropping.length,
    kept: plan.keeping.length,
    appended: plan.append.length,
    hasGenerator: plan.dropping.some((block) => block.group === 'generator'),
  };
}

/** 把块按组归类，界面用它画分组的统计条 */
export function groupCounts(blocks: MetaBlock[] | ContainerBlock[]): Array<{
  group: string;
  count: number;
  bytes: number;
}> {
  const tally = new Map<string, { count: number; bytes: number }>();
  for (const block of blocks) {
    const entry = tally.get(block.group) ?? { count: 0, bytes: 0 };
    entry.count += 1;
    entry.bytes += block.bytes;
    tally.set(block.group, entry);
  }
  return [...tally.entries()]
    .map(([group, entry]) => ({ group, count: entry.count, bytes: entry.bytes }))
    .sort((a, b) => b.bytes - a.bytes);
}
