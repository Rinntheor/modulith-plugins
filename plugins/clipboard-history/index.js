// plugins/clipboard-history/index.js
//
// 剪贴板历史 —— 把复制过的东西留下来，需要时再贴回去。
//
// ============================================================
// 这个插件的核心是**一条容易写错、而且写错了很难看出来**的规则
// ============================================================
//
// 「复制回去」这个动作本身会改变剪贴板。宿主每 800 ms 看一次剪贴板的序列号，
// 因此写入之后必然会产生一次变化事件 —— 而如果我们把每一次变化都当成"用户复制了
// 新东西"记下来，就会得到一条重复条目；那条重复条目又会让列表重排、让下次复制
// 再触发一次……两个方向一合，就是一个自我维持的**回声**。
//
// 因此这里的做法是：**记住自己写出去的值，丢弃与它匹配的下一次观察**。
// 实现见 `rememberOwnWrite` / `isOwnWrite` 那一节，那里逐条说明了为什么是
// "一次"、为什么按 `at` 而不是按值本身去重、以及这个判断的边界在哪。
//
// ============================================================
// 数据放在哪里（三层各司其职）
// ============================================================
//
//   * `ctx.db`（每插件一个 SQLite）——**历史条目本身**。它有 `query` 与 `LIMIT`
//     / `OFFSET`，1 万条时的分页是 SQLite 在做，不是把所有行拉进 JS 自己过滤；
//     而 `ctx.storage` 是一键一个 JSON（单值 1 MB、总量 8 MB），装一个会增长的
//     列表是错的形状。
//   * `ctx.dataDir`（插件私有目录）——**只有图片的字节**。PNG 是二进制，进数据库
//     只能变成 base64 文本，那样只会更占地方。
//   * `ctx.storage` —— 这里**一条都不存**。设置项走清单声明的 `contributes.settings`，
//     由 `ctx.settings` 读（同步），历史走 `ctx.db`。
//
// ============================================================
// 隐私：这个插件能看到什么，以及它不做什么
// ============================================================
//
// `clipboard-monitor` 是权限表里风险最高的几项之一（宿主把它显式覆盖成 high），
// 理由写在权限描述里：它读到的是**用户在这台电脑上复制的任何内容**。因此：
//
//   1. **内容绝不进日志。** 整个文件里没有一处把 `text` 交给 `console` 或
//      `ctx.logger` —— 日志是明文文件，用户会把它发给维护者排查问题。
//      要记只记条数与字节数。要传日志就写 `entryText.length`，不写 `entryText`。
//   2. **内容绝不进通知。** `ctx.notifications` 的正文只会是"已复制"这类固定短语。
//   3. **条目文本是不可信输入。** 它是别人程序放上剪贴板的字节，可以包含 `<script>`、
//      引号、换行、控制字符。UI 里它一律作为 React 文本子节点渲染（自动转义），
//      **不进 `dangerouslySetInnerHTML`、不拼进 `href`/`src`/`style`**。
//   4. **不加密，而且说清楚。** 插件数据目录在 `%LOCALAPPDATA%` 下，是明文；
//      面板里有常驻的隐私说明，且给出关掉的办法（暂停采集 / 关掉采集 / 清空）。
//   5. **列表不假装完整。** 复制内容的程序主动标记为敏感的内容，宿主一个字节都不读
//      （见 `clipboard.rs` 的隐私守卫），因此这里必然会有缺口 —— 界面上写明了这一点。

(function () {
  'use strict';

  var Modulith = window.Modulith;
  if (!Modulith) {
    console.error('[clipboard-history] 未找到 window.Modulith，插件无法加载');
    return;
  }

  var React = Modulith.React;
  var h = React.createElement;

  // ============================================================
  // 与宿主契约对齐的常量
  // ============================================================
  //
  // 这三个数字来自宿主实现（`plugins/clipboard.rs` 的 `MAX_TEXT_BYTES` 等），
  // 在这里抄一份是**故意的**：插件的判据与宿主的实现必须是同一个数，而插件
  // 读不到宿主的常量。宿主改了上限时这里要跟着改 —— 抄错的后果写在 `add()` 里。

  /** 一次变化事件里文本的上限（UTF-8 字节）。超过它的文本**没有截断标志位**。 */
  var HOST_TEXT_BYTES = 64 * 1024;

  /** 一次交付的 PNG 上限（编码后 8 MiB），宿主超限时**抛错**而不是返回 `null`。 */
  var HOST_IMAGE_BYTES = 8 * 1024 * 1024;

  /** 宿主给出的文本按字节算，而 JS 的字符串按 UTF-16 单元算。用它换算一个保守的字符数。 */
  var TEXT_BYTE_LIMIT = 64 * 1024;

  /** 自我写入回执的存活时间。宿主轮询间隔 800 ms，留几倍余量。 */
  var OWN_WRITE_TTL_MS = 6000;

  /** 回执队列长度。连点两次「复制」不该把第一条的回执挤掉。 */
  var OWN_WRITE_QUEUE = 4;

  /** 内存去重窗口：最近这么多次"把内容放到剪贴板的最前面"已经出现过的文本不再重复入库。 */
  var RECENT_TEXTS = 24;

  /** 列表一页多少条。SQLite 的 `LIMIT` 用它，滚动到底时再取下一页。 */
  var PAGE_SIZE = 200;

  /**
   * 一次最多取多少条。
   *
   * 刷新列表时请求的条数是"当前已经载入多少条"，好让用户翻出来的后面几页不被
   * 丢掉（丢掉会让内容高度塌陷、滚动位置被夹回去）。这个上限兜住最坏情况：
   * 一条记录的预览按几百字节算，5000 条也就是一两 MB 的 IPC 体积。
   * 要走到这个上限得点 25 次「载入更多」，正常使用到不了。
   */
  var MAX_FETCH_LIMIT = 5000;

  /** 下面这些是**兜底**，正常情况下以设置页里的值为准。 */
  var FALLBACK = {
    captureEnabled: true,
    maxEntries: 1000,
    maxAgeDays: 30,
    captureImages: false,
  };

  /** 图片字节总量上限（MiB）。见 README 里的成本说明。 */
  var IMAGE_BUDGET_MB = 256;

  var SETTING_IDS = {
    captureEnabled: 'captureEnabled',
    maxEntries: 'maxEntries',
    maxAgeDays: 'maxAgeDays',
    captureImages: 'captureImages',
    maxImageMb: 'maxImageMb',
  };

  // ============================================================
  // ctx
  // ============================================================
  //
  // 两种入口都要能跑：`Modulith.run(fn)` 是显式引导入口，宿主把身份、设置快照与
  // `ctx` 作为**参数**交进来；`Modulith.createContext()` 返回的是**同一个对象**。
  // 这里用前者，因为它是跨进程也能成立的那一种 —— 它不依赖"当前正在加载哪个插件"
  // 这个隐式全局。

  var ctx = null;

  // ============================================================
  // 设置  ← 沙箱里这一节是**异步**的，与类型包上写着的不一样
  // ============================================================
  //
  // `types/modulith.d.ts` 的 `PluginSettingsAPI.get` 声明成同步返回
  // （`get<T>(id): T | undefined`），而**沙箱桥接层返回的是 Promise**
  // （`sandbox-bridge.js` 的 `settings.get` → `rpc('settings.all', {})`）。
  // 两处都是对的、也都不该改：类型包映射的是宿主 in-process 那份契约，而沙箱是
  // 另一个 realm，值只能经 RPC 拿。
  //
  // 因此这里**不能假定是哪种**：`readOne()` 同时接受同步值与 Promise，
  // 用 `Promise.resolve` 统一收口。这是"同一份代码在两个运行位置都能跑"的代价，
  // 而它比"只在其中一个位置能跑"划算得多。
  //
  // 另外两个由此而来的结论：
  //
  //   * **沙箱里没有 `ctx.settings.subscribe`。** 桥接层刻意没做它（没有那条推送
  //     通道），所以这里只能：① 用 `bootstrap.settings` 这份**启动快照**做初值，
  //     ② 需要"用户刚在设置页改过"的时机就自己重新读一次（`refreshSettings`）。
  //   * **别的地方读设置必须走 `core.settings` 这个缓存**，不要每次调用去 await：
  //     剪贴板回调在 800 ms 一轮的节奏上，而每一次异步读都是一次 RPC。

  function readOne(id, fallback) {
    var value;
    try {
      value = ctx.settings.get(id, fallback);
    } catch (e) {
      // 未声明 storage 权限时 `get` 会抛。那种情况下整个插件已经退化了，
      // 这里只回落到清单里的缺省值。
      return Promise.resolve(fallback);
    }
    return Promise.resolve(value).then(function (resolved) {
      if (resolved === undefined || resolved === null) return fallback;
      // `select` 存回来的是字符串，`boolean` / `number` 存回来是它们自己。
      // 两种都要认，因此显式比较一次而不是依赖 `!!`。
      if (typeof fallback === 'boolean') {
        if (resolved === false || resolved === 'false') return false;
        if (resolved === true || resolved === 'true') return true;
        return fallback;
      }
      var n = Number(resolved);
      return isFinite(n) ? n : fallback;
    });
  }

  /** 从启动快照里取一个值。没有快照时返回 `undefined`，由调用方回落到缺省值。 */
  function fromSnapshot(snapshot, id) {
    if (!snapshot || typeof snapshot !== 'object') return undefined;
    return Object.prototype.hasOwnProperty.call(snapshot, id) ? snapshot[id] : undefined;
  }

  /**
   * 归一化成一个完整、可用的设置对象。
   *
   * **每一处夹取都有理由**，不是防御性编程：
   *   * `maxEntries` 为 `0` 会让"插入即删除"，看起来像插件坏了而不是配置错了；
   *   * `maxAgeDays` 为 `0` 会让**启动时那次裁剪**删光所有未置顶条目（用户以为是丢数据）；
   *   * `maxImageMb` 为负会让图片预算立刻为负，于是每一轮都摘图片。
   *
   * 这些值只可能来自"用户手输了清单没允许的值"或"存储里的旧数据"，但后果都
   * 不可逆，因此宁可在读的时候就夹一次。
   */
  function normalizeSettings(raw) {
    var source = raw && typeof raw === 'object' ? raw : {};
    function bool(id, fallback) {
      var value = source[id];
      if (value === undefined || value === null) return fallback;
      if (value === false || value === 'false') return false;
      if (value === true || value === 'true') return true;
      return fallback;
    }
    function number(id, fallback, min, max) {
      var n = Number(source[id]);
      if (!isFinite(n)) n = fallback;
      n = Math.round(n);
      return Math.max(min, Math.min(max, n));
    }
    return {
      captureEnabled: bool(SETTING_IDS.captureEnabled, FALLBACK.captureEnabled),
      maxEntries: number(SETTING_IDS.maxEntries, FALLBACK.maxEntries, 10, 50000),
      maxAgeDays: number(SETTING_IDS.maxAgeDays, FALLBACK.maxAgeDays, 1, 3650),
      captureImages: bool(SETTING_IDS.captureImages, FALLBACK.captureImages),
      maxImageMb: number(SETTING_IDS.maxImageMb, IMAGE_BUDGET_MB, 0, 1024),
    };
  }

  /** 这次读到的设置与缓存里的有没有实质差别。用它决定要不要重新裁剪与刷新界面。 */
  function settingsChanged(a, b) {
    return (
      a.captureEnabled !== b.captureEnabled ||
      a.maxEntries !== b.maxEntries ||
      a.maxAgeDays !== b.maxAgeDays ||
      a.captureImages !== b.captureImages ||
      a.maxImageMb !== b.maxImageMb
    );
  }

  /**
   * 重新读一遍设置并写回 `core.settings`。返回"有没有变"。
   *
   * 读的顺序是**先逐个 `get`，失败再退回 `getAll`** —— 其实只需要一个：六个设置项
   * 一次 `getAll()` 就够，而它在沙箱里就是一次 RPC（每个 `get` 在沙箱里也是一次
   * RPC，六次）。因此只调 `getAll`。
   */
  var allReaderSupported = true;

  function refreshSettings() {
    if (!ctx.settings || !allReaderSupported) return Promise.resolve(false);

    return Promise.resolve()
      .then(function () {
        return ctx.settings.getAll();
      })
      .then(
        function (all) {
          var next = normalizeSettings(all);
          var changed = settingsChanged(core.settings, next);
          core.settings = next;
          return changed;
        },
        function () {
          // `getAll` 不在（极旧的宿主）时退回逐项读。这个降级路径**只可能跑一次** ——
          // 之后 `allReaderSupported` 就是 false，不会每轮都去撞同一个错误。
          allReaderSupported = false;
          return refreshSettingsItemByItem();
        }
      );
  }

  function refreshSettingsItemByItem() {
    return Promise.all([
      readOne(SETTING_IDS.captureEnabled, FALLBACK.captureEnabled),
      readOne(SETTING_IDS.maxEntries, FALLBACK.maxEntries),
      readOne(SETTING_IDS.maxAgeDays, FALLBACK.maxAgeDays),
      readOne(SETTING_IDS.captureImages, FALLBACK.captureImages),
      readOne(SETTING_IDS.maxImageMb, IMAGE_BUDGET_MB),
    ]).then(function (values) {
      var next = normalizeSettings({
        captureEnabled: values[0],
        maxEntries: values[1],
        maxAgeDays: values[2],
        captureImages: values[3],
        maxImageMb: values[4],
      });
      var changed = settingsChanged(core.settings, next);
      core.settings = next;
      return changed;
    });
  }

  // ============================================================
  // 小工具
  // ============================================================

  function hashText(text) {
    // FNV-1a，32 位。**不是密码学哈希**，用途只有一个：在库里按内容找"刚刚是不是
    // 记过同一段文本"。碰撞的后果是"一次重复没被折叠"，而不是"数据错了"。
    var hash = 0x811c9dc5;
    for (var i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
    }
    return hash >>> 0;
  }

  function byteLength(text) {
    // `Blob` 在沙箱里有；没有时按 3 字节/字符保守估计（中文），宁可多算不可少算 ——
    // 少算的后果是往库里塞一份实际超过上限的文本。
    try {
      return new Blob([text]).size;
    } catch (e) {
      return text.length * 3;
    }
  }

  function textOf(value) {
    if (typeof value !== 'string') return '';
    // 首尾空白不作为内容的一部分：复制一行代码时最常带上的是尾部的换行，
    // 留着它会让列表里每一行都多出一格空白。
    return value.replace(/^\s+|\s+$/g, '');
  }

  function sameText(a, b) {
    return a === b;
  }

  function formatTagsOf(formats) {
    if (!Array.isArray(formats)) return [];
    var out = [];
    for (var i = 0; i < formats.length; i++) {
      var name = formats[i];
      // 格式名同样来自剪贴板，同样按不可信处理：只认已知的几个，其余丢弃。
      // 理由不是洁癖 —— 未知格式名会以原样显示在界面上。
      if (typeof name !== 'string') continue;
      if (
        name === 'text/plain' ||
        name === 'text/html' ||
        name === 'text/rtf' ||
        name === 'image/png' ||
        name === 'image/bmp' ||
        name === 'files'
      ) {
        if (out.indexOf(name) === -1) out.push(name);
      }
    }
    return out;
  }

  function pad2(n) {
    return n < 10 ? '0' + n : String(n);
  }

  /** 相对时间。绝对时间在工具提示里给（`title`），因为"3 分钟前"读起来快但查不到具体时刻。 */
  function relativeTime(ts) {
    if (!ts) return '';
    var delta = Date.now() - ts;
    if (delta < 0) return '刚刚';
    var seconds = Math.round(delta / 1000);
    if (seconds < 45) return '刚刚';
    var minutes = Math.round(seconds / 60);
    if (minutes < 60) return minutes + ' 分钟前';
    var hours = Math.round(minutes / 60);
    if (hours < 24) return hours + ' 小时前';
    var days = Math.round(hours / 24);
    if (days < 30) return days + ' 天前';
    var date = new Date(ts);
    return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
  }

  function absoluteTime(ts) {
    if (!ts) return '';
    var date = new Date(ts);
    return (
      date.getFullYear() +
      '-' +
      pad2(date.getMonth() + 1) +
      '-' +
      pad2(date.getDate()) +
      ' ' +
      pad2(date.getHours()) +
      ':' +
      pad2(date.getMinutes()) +
      ':' +
      pad2(date.getSeconds())
    );
  }

  function humanBytes(bytes) {
    var n = Number(bytes) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  function formatTagLabel(tag) {
    if (tag === 'text/plain') return '纯文本';
    if (tag === 'text/html') return 'HTML';
    if (tag === 'text/rtf') return 'RTF';
    if (tag === 'image/png') return '图片';
    if (tag === 'image/bmp') return '位图';
    if (tag === 'files') return '文件';
    return tag;
  }

  function dataUrlBytes(dataUrl) {
    // `data:image/png;base64,AAAA` —— 只算 base64 段。用它做"这张图多大"的显示与
    // 记账；真正占磁盘的是解码后的 PNG，两者差约 1/3，显示时按解码后算。
    var comma = dataUrl.indexOf(',');
    if (comma < 0) return 0;
    var encoded = dataUrl.length - comma - 1;
    return Math.floor((encoded * 3) / 4);
  }

  function decodeDataUrl(dataUrl) {
    var comma = dataUrl.indexOf(',');
    if (comma < 0) return null;
    var binary = atob(dataUrl.slice(comma + 1));
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  // ============================================================
  // 自我写入的回执  ← 这个插件最容易写错的地方
  // ============================================================
  //
  // 问题：`ctx.clipboard.writeText()` 改的是**系统剪贴板**，而宿主的监测线程看的
  // 也是系统剪贴板。因此"复制回去"之后，宿主必然交付一次变化事件，内容正是我们
  // 刚写出去的东西。把它当新条目记下来，就是一个重复条目；而重复条目本身又会让
  // 下一次复制多出更多的重复 —— 一个自我维持的回声。
  //
  // 做法：**写入成功后记一份回执（时间 + 我们写出去的那段文本），下一次观察到的
  // 变化如果与它匹配，就丢弃。每个回执只用一次。**
  //
  // 三个细节是刻意的，都不是随手写的：
  //
  //   * **按"下一次观察到的变化"去匹配，不按值去重。** 值去重（"等于上一条就不记"）
  //     看起来更简单，但它会把用户真实的重复复制也吃掉 —— 同一个人连续复制两次
  //     同一段文本是常事。两者必须分开。
  //
  //   * **每个回执只用一次（`consumed`）。** 用户可能正当地复制同一段文本两次
  //     （第二次是他自己的动作），那时第二次应当被记下来。因此回执在匹配一次之后
  //     立刻作废，而不是在有效期内一直生效。
  //
  //   * **观察到的文本是宿主的截断版（前 64 KiB）。** 比较时把我们写出去的那段也
  //     截到同一个上限，否则一段超过 64 KiB 的条目复制回去时永远匹配不上，回声就
  //     照样发生。这也是这一节唯一一处依赖 `HOST_TEXT_BYTES` 的地方。
  //
  // 边界（如实写下来）：宿主"一轮最多一条"，因此 800 ms 内既发生一次真实复制、
  // 又恰好有一次我们自己写入时，那一轮只会交付后一次。这种情况下回执着不会匹配，
  // 会安静地过期 —— 代价是"下一次真实复制的同一条内容被折叠"，不是数据错误。
  // 反过来（真实复制覆盖了我们的写入）则可能少记一条。两者都是这台机器上观测量
  // 本身的粒度，插件这一侧无法区分。

  /** @type {{text: string, at: number, consumed: boolean}[]} */
  var ownWrites = [];
  var ownWriteDirty = false;

  function rememberOwnWrite(text) {
    ownWrites.push({ text: text, at: Date.now(), consumed: false });
    while (ownWrites.length > OWN_WRITE_QUEUE) ownWrites.shift();
    ownWriteDirty = true;
  }

  /**
   * 这次观察是不是我们自己写出去的那一次？
   *
   * 匹配上就作废（只用一次），并且**顺带清掉过期的回执** —— 过期的那一份如果不删，
   * 一段内容在 6 秒后由用户真实复制时会被误当成回声丢掉。
   */
  function isOwnWrite(change) {
    if (ownWrites.length === 0) return false;

    var now = Date.now();
    for (var i = ownWrites.length - 1; i >= 0; i--) {
      var receipt = ownWrites[i];
      if (receipt.consumed || now - receipt.at > OWN_WRITE_TTL_MS) {
        ownWrites.splice(i, 1);
        ownWriteDirty = true;
      }
    }
    if (ownWrites.length === 0) return false;

    var observed = change.text === null ? null : textOf(change.text);
    // 没有文本的观察（只复制了一张图）不可能是我们的写入：`writeText` 写的一定是文本。
    if (observed === null) return false;

    for (var j = ownWrites.length - 1; j >= 0; j--) {
      var candidate = ownWrites[j];
      if (candidate.consumed) continue;
      var mine = textOf(candidate.text);
      var mineClipped = byteLength(mine) > HOST_TEXT_BYTES ? clipText(mine) : mine;
      if (sameText(mineClipped, observed)) {
        candidate.consumed = true;
        ownWriteDirty = true;
        return true;
      }
    }
    return false;
  }

  /**
   * 把一段文本截到宿主的交付上限之下。
   *
   * 逐字符累加字节数：`HOST_TEXT_BYTES` 是 UTF-8 字节数，而按字符切会在纯 ASCII 时
   * 切多、在中文时切少。切多了没有意义（宿主本来就会再切一次），切少了会让上一条
   * 比较失败 —— 所以这里按字符算一个**上界**，切得比宿主略保守。
   */
  function clipText(text) {
    var total = 0;
    for (var i = 0; i < text.length; i++) {
      var code = text.charCodeAt(i);
      total += code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
      if (total > HOST_TEXT_BYTES) return text.slice(0, i);
    }
    return text;
  }

  // ============================================================
  // 数据库
  // ============================================================
  //
  // 表结构与索引：
  //
  //   clipboard_entries
  //     id           INTEGER PRIMARY KEY     自增，同时是游标分页的第二排序键
  //     post_time    INTEGER NOT NULL        宿主观测到变化的毫秒时间戳
  //     last_seen_at INTEGER NOT NULL        同一条内容再次被复制时更新它（"最近复制"）
  //     cached_text  TEXT                    最近一条的完整文本（预览用，不参与查询）
  //     text_bytes   INTEGER NOT NULL        文本的 UTF-8 字节数，用于预算统计
  //     text_hash    INTEGER NOT NULL        FNV-1a，用于"刚记过同一段吗"
  //     formats      TEXT NOT NULL          友好格式名的 JSON 数组
  //     pinned       INTEGER NOT NULL        0/1，置顶的条目**不被任何裁剪规则删除**
  //     image_path   TEXT                    图片在 ctx.dataDir 下的相对路径
  //     image_bytes  INTEGER NOT NULL        图片字节数，0 表示没有图片
  //     note         TEXT                    宿主没给成图片时的原因（过大/读失败）
  //
  //   clipboard_bodies(id, body)  —— 预览与全文分开存，见 `BODY_PREVIEW_CHARS`
  //
  // 索引按**真实查询**建：
  //   * 列表是 `ORDER BY post_time DESC, id DESC` + 游标 → 复合索引 (post_time DESC, id DESC)
  //   * 搜索是 `text_hash`/`body` 上的 LIKE → 全文扫描（见下）
  //   * 裁剪按 `post_time` 升序取最旧的 → 同一个复合索引反过来用
  //   * 置顶条目的查询与计数 → 部分索引 (pinned) WHERE pinned = 1
  //
  // **为什么全文单独一张表**：列表一次性要取 200 行，而每条正文可能有 64 KiB ——
  // 200 × 64 KiB 就是 12 MB 一次性搬进 JS，只为渲染每行 2 行高的预览。把预览
  // （前 200 字符）与全文分开之后，列表页取的是小行，全文只在"复制这一条"时按 id
  // 取一行。这是这个插件在 1 万条下仍然可用的一半原因（另一半是游标分页）。

  var BODY_PREVIEW_CHARS = 200;

  var SCHEMA = [
    'CREATE TABLE IF NOT EXISTS clipboard_entries (' +
      'id INTEGER PRIMARY KEY, ' +
      'post_time INTEGER NOT NULL, ' +
      'last_seen_at INTEGER NOT NULL, ' +
      'cached_text TEXT, ' +
      'text_bytes INTEGER NOT NULL DEFAULT 0, ' +
      'text_hash INTEGER NOT NULL, ' +
      'formats TEXT NOT NULL DEFAULT \'[]\', ' +
      'pinned INTEGER NOT NULL DEFAULT 0, ' +
      'image_path TEXT, ' +
      'image_bytes INTEGER NOT NULL DEFAULT 0, ' +
      'note TEXT)',
    'CREATE TABLE IF NOT EXISTS clipboard_bodies (id INTEGER PRIMARY KEY, body TEXT NOT NULL)',
    'CREATE INDEX IF NOT EXISTS clipboard_entries_recency ON clipboard_entries (post_time DESC, id DESC)',
    'CREATE INDEX IF NOT EXISTS clipboard_entries_hash ON clipboard_entries (text_hash)',
    'CREATE INDEX IF NOT EXISTS clipboard_entries_pinned ON clipboard_entries (pinned) WHERE pinned = 1',
    'CREATE INDEX IF NOT EXISTS clipboard_entries_images ON clipboard_entries (post_time) WHERE image_bytes > 0',
  ];

  var IMAGES_DIR = 'images';

  function dbExec(sql, params) {
    return ctx.db.exec(sql, params);
  }

  function dbQuery(sql, params) {
    return ctx.db.query(sql, params);
  }

  // ============================================================
  // 图片落盘
  // ============================================================

  function imageFileName(id) {
    return IMAGES_DIR + '/' + id + '.png';
  }

  /**
   * 把一张 PNG 写进数据目录。
   *
   * 失败时**只记警告**（不带内容，只带字节数）：没有图片的历史条目仍然是一条可用的
   * 历史，而"因为写图片失败所以整条都没记"才是真丢数据。
   */
  function writeImage(id, bytes) {
    return ctx.dataDir
      .mkdir(IMAGES_DIR)
      .catch(function () {
        // 目录已存在时也走这里。`mkdir` 不保证幂等，这是它的语义之外的事。
      })
      .then(function () {
        return ctx.dataDir.write(imageFileName(id), bytes);
      });
  }

  function removeImage(path) {
    if (!path) return Promise.resolve();
    return ctx.dataDir.remove(path).catch(function (e) {
      console.warn('[clipboard-history] 删除图片失败（不影响条目本身的删除）：', e);
    });
  }

  function readImageBlob(entryId) {
    return ctx.dataDir.read(imageFileName(entryId)).then(function (bytes) {
      return new Blob([bytes], { type: 'image/png' });
    });
  }

  // ============================================================
  // 核心状态
  // ============================================================

  var core = {
    ready: false,
    /** 采集是否可用（权限 + 平台）。为假时界面必须**明确说出来**，见 UI 里的空态。 */
    canMonitor: false,
    /** 用户是否按下了暂停 */
    paused: false,
    /** 设置（每次变更重新读一遍） */
    settings: FALLBACK,
    /** 库里是否有置顶条目 —— 空态文案要据此说明"这一条删不掉"的原因 */
    hasPinned: false,
    /** 数据库不可用时的原因。非空表示整个插件退化为"只能用设置与说明" */
    dbError: '',
    /** 图片写盘失败一类的问题，显示一次即可 */
    notice: '',
  };

  var listeners = new Set();

  function emit() {
    listeners.forEach(function (fn) {
      try {
        fn();
      } catch (e) {
        console.error('[clipboard-history] 订阅者抛出异常，已隔离:', e);
      }
    });
  }

  function subscribeCore(fn) {
    listeners.add(fn);
    return function () {
      listeners.delete(fn);
    };
  }

  function setNotice(message) {
    if (core.notice === message) return;
    core.notice = message;
    emit();
  }

  // ============================================================
  // 写入 / 去重 / 裁剪
  // ============================================================

  /** 最近若干条"放到最前面"的文本。它挡的是**同一段内容在极短时间内被观察多次**。 */
  var recentTexts = [];

  function rememberRecent(text) {
    recentTexts.unshift(text);
    if (recentTexts.length > RECENT_TEXTS) recentTexts.length = RECENT_TEXTS;
  }

  function newEntryObject(change) {
    var text = textOf(change.text || '');
    var formats = formatTagsOf(change.formats);
    var at = typeof change.at === 'number' && change.at > 0 ? change.at : Date.now();

    /**
     * 条目的身份。
     *
     * **有文本时按内容取哈希** —— 下面的折叠与去重逻辑依赖"同一段文本哈希相等"。
     *
     * **没有文本时绝不能也这么做。** `hashText('')` 是一个**常量**，于是每一张截图都
     * 会撞上同一个 `text_hash`：第二张起被 `add()` 当成"这段之前记过"折叠进第一行，
     * 而 `captureImage` 只在结果是 `inserted` 时才跑 —— 图片因此**永远写不下去**。
     * 症状很有迷惑性：文字一切正常，只有截图记不下来，而且不报任何错。
     *
     * 无文本的观察改用「格式 + 本次观察时刻」做身份。时刻来自宿主（一轮 800 ms 只可能
     * 观察到一次变化），因此同一毫秒里出现两张截图这件事在真实路径上不会发生。
     * 前缀 `\u0000` 是为了与任何真实文本的哈希分开。
     */
    var hash = text ? hashText(text) : hashText('\u0000' + formats.join('|') + '@' + at);

    return {
      text: text,
      hash: hash,
      formats: formats,
      at: at,
      // 由调用方按需填：这条记录为什么要落到列表里（例如"有图但宿主交付不了"）
      note: null,
    };
  }

  /**
   * 记一条。返回 `'inserted'` / `'deduped'` / `'skipped'`。
   *
   * 两处去重，各挡一件事：
   *
   *   * **内存里最近出现过的文本**（`recentTexts`）：它挡的是"同一段内容在几毫秒里被
   *     观察到两次"。它是一次数组查找，因此比数据库往返便宜得多，而且它**必须**存在 ——
   *     宿主的监测是 800 ms 一轮，但订阅本身的建立、界面的重挂载都可能让同一份内容
   *     再走一次回调。
   *   * **库里的 `text_hash`**：它挡的是"这段文本之前记过"（可能是几小时前）。命中的
   *     那一条会被提到最前面并更新 `last_seen_at` —— 连续重复因此在列表里**合并成
   *     一条**，而不是每一份复制都占一行。
   *
   * 两者都不拿"值等于上一条"当判据：那样会把用户真实的重复复制也吃掉。区别在于
   * **是不是"同一次观察"**，而内存窗口与时间窗口是这一刻能拿到的最好的近似。
   */
  function add(entry) {
    return dbQuery('SELECT id, formats FROM clipboard_entries WHERE text_hash = ?1 LIMIT 1', [
      entry.hash,
    ]).then(function (rows) {
      if (rows.length > 0) {
        var existingId = rows[0].id;
        // 格式取并集：同一段文本这次复制时只带 `text/plain`、上次带了 `text/html`，
        // 覆盖式写会把"它曾经是富文本"这件事丢掉。
        var merged = mergeFormats(rows[0].formats, entry.formats);
        return dbExec(
          'UPDATE clipboard_entries SET last_seen_at = ?1, post_time = ?2, formats = ?3 WHERE id = ?4',
          [entry.at, entry.at, JSON.stringify(merged), existingId]
        ).then(function () {
          return 'deduped';
        });
      }
      return insertFresh(entry).then(function () {
        return 'inserted';
      });
    });
  }

  function mergeFormats(stored, incoming) {
    var out = [];
    var push = function (name) {
      if (typeof name === 'string' && name && out.indexOf(name) === -1) out.push(name);
    };
    try {
      var parsed = JSON.parse(stored);
      if (Array.isArray(parsed)) parsed.forEach(push);
    } catch (e) {
      // 存的那一份坏了：以这次观察到的为准，而不是让整条更新失败。
    }
    incoming.forEach(push);
    return out;
  }

  /**
   * 真实插一条。返回新行的 id。
   *
   * 正文分两处写：`clipboard_bodies` 存完整文本，`clipboard_entries.cached_text` 存
   * 预览。
   *
   * **为什么是两条 `exec` 而不是一次 `transaction`**：`transaction` 的参数是事先写好的、
   * 不能引用前一条语句的结果，而这里第二条要用第一条产生的行 id。宿主没有
   * `begin()`/`commit()`（跨调用的显式事务是它刻意不提供的），因此只能拆成两条，
   * 并**自己处理第二条失败的情况**：那会留下一条没有正文的条目（点"复制"只会得到
   * 预览），所以立刻把第一条删掉。
   */
  function insertFresh(entry) {
    var clipped = byteLength(entry.text) > HOST_TEXT_BYTES ? clipText(entry.text) : entry.text;
    var preview = clipped.slice(0, BODY_PREVIEW_CHARS);
    var bytes = byteLength(clipped);

    var insertion = dbExec(
      'INSERT INTO clipboard_entries ' +
        '(post_time, last_seen_at, cached_text, text_bytes, text_hash, formats, pinned, image_bytes, note) ' +
        // `note` 是参数而不是写死的 NULL：少数条目一落库就该带上一句解释
        // （"有图但宿主交付不了"），否则它在列表里是一条没有内容也没有原因的空条目。
        'VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, 0, ?7)',
      [entry.at, entry.at, preview, bytes, entry.hash, JSON.stringify(entry.formats), entry.note || null]
    );

    return insertion.then(function (meta) {
      return resolveInsertedId(meta).then(function (id) {
        if (!id) {
          // 拿不到行 id 时这条只能退化成"只有预览"的记录。**不静默**：那种条目点开
          // 是空的，而用户看到的只是"复制回去的内容少了一截"。
          console.warn('[clipboard-history] 插入后取不到行 id，这条记录只有预览');
          return 0;
        }
        return dbExec('INSERT INTO clipboard_bodies (id, body) VALUES (?1, ?2)', [id, clipped]).then(
          function () {
            return id;
          },
          function (error) {
            return dbExec('DELETE FROM clipboard_entries WHERE id = ?1', [id]).then(
              function () {
                throw error;
              },
              function () {
                throw error;
              }
            );
          }
        );
      });
    });
  }

  /**
   * 取刚插入那一行的 id。
   *
   * ⚠️ **两个键名都要认，这不是多余的防御。** 宿主的 `ExecResult` 用
   * `#[serde(rename_all = "camelCase")]` 序列化，于是走 Tauri 命令那条路（in-process）
   * 回来的是 `lastInsertRowId`；而沙箱走的是 RPC，`rpc.rs` 用 `serde_json::json!(result)`
   * 原样序列化 —— **同一个名字**，但类型包与桥接层的注释写的是 camelCase，两处
   * 一旦有一处与真实字节不一致，这里的 id 就会变成 `undefined`，而后果不是报错，
   * 是"每一条记录都没有正文"。
   *
   * 因此：两个键名都试，再不行就用 SQL 直接问一次（`db.exec` 的 id 本来就是
   * 从 `Connection::last_insert_rowid()` 来的，这条查询问的是同一件事）。
   */
  function resolveInsertedId(meta) {
    if (meta && typeof meta === 'object') {
      if (typeof meta.lastInsertRowId === 'number' && meta.lastInsertRowId > 0) {
        return Promise.resolve(meta.lastInsertRowId);
      }
      if (typeof meta.last_insert_row_id === 'number' && meta.last_insert_row_id > 0) {
        return Promise.resolve(meta.last_insert_row_id);
      }
    }
    return dbQuery('SELECT last_insert_rowid() AS id').then(
      function (rows) {
        if (rows.length === 0) return 0;
        var id = Number(rows[0].id);
        return isFinite(id) && id > 0 ? id : 0;
      },
      function () {
        return 0;
      }
    );
  }

  /**
   * 插入 + 可选的图片落盘 + 裁剪，串成一条链。
   *
   * 顺序是刻意的：先落行拿到 id（图片文件名要用它，因此不能用哈希当文件名 ——
   * 两条不同的文本可能在 32 位哈希上碰撞），再写图片、回填 `image_path`，
   * **最后**裁剪。裁剪放在最后是因为它要按"这一条已经落盘之后"的总量判断；
   * 先裁剪会在图片还没写下去时按旧的总量白扫一遍。
   */
  function record(change) {
    var entry = newEntryObject(change);
    // 没有文本的观察：只有图片采集开着、而且剪贴板上确实有图时才值得记一条。
    // 否则它会变成一条空条目（列表里显示"（这条只有图片）"却根本没有图）。
    if (!entry.text) {
      if (!core.settings.captureImages) return Promise.resolve('skipped');
      if (entry.formats.indexOf('image/png') === -1) {
        // 剪贴板上确实有图，但宿主给不出字节：`CF_BITMAP` 是**设备相关位图**，要经 GDI
        // 取像素才能编码，而宿主明确不提供这条路径（见 `clipboard.rs` 的格式表）。
        //
        // **不静默跳过**：那样用户只会看到"截图又没记下来"，而一个字的原因都没有 ——
        // 这正是这一类缺陷能活到被人手工发现的原因。这里照样落一条，把原因写进
        // `note` 让界面看得见；纯文本观察（没有任何图片格式）仍然按原来的方式跳过。
        if (entry.formats.indexOf('image/bmp') === -1) return Promise.resolve('skipped');
        entry.note = '剪贴板只提供了设备相关位图（CF_BITMAP），宿主无法把它编码成图片，因此这一条没有图';
      }
    }

    // 极短时间内的同一次观察：内存窗口挡住，不进数据库。
    if (entry.text && recentTexts.indexOf(entry.text) !== -1) return Promise.resolve('skipped');

    var chain = add(entry);

    if (core.settings.captureImages && entry.formats.indexOf('image/png') !== -1) {
      chain = chain.then(function (result) {
        if (result !== 'inserted') return result;
        return captureImage(entry);
      });
    }

    return chain.then(function (result) {
      rememberRecent(entry.text);
      // 裁剪**不阻塞**这条记录的成功：那一刻用户已经复制完了，条目已经写进去了，
      // 而裁剪失败（磁盘满、数据目录掉线）不该让用户看到"没记住"。
      return prune().then(function () {
        return result;
      });
    });
  }

  /**
   * 观察事件里带了 `image/png` 时把图片取回来。
   *
   * `readImage()` 的三种结果必须分开（宿主文档里写得很清楚，这里照做）：
   *   * 有图、在上限内 → data URL，解码后落盘；
   *   * 没有图 → `null`；
   *   * **有图但超限 → 抛错**。这一条**不能**当成 `null` 处理：那会让界面上什么都不
   *     显示，而用户明明复制了一张 4K 截图。这里把它记进 `note` 字段，界面上如实显示。
   *
   * 只在 `record()` 判定这次是**新插入**时调用。行 id 在这里单独查一次而不是由
   * `insertFresh` 传回来，是因为 `add()` 的两条路径（新插入 / 折叠进已有条目）返回的是
   * 同一个枚举，把 id 也算进返回值会让调用方多一层解构，而这次查询走的是
   * `clipboard_entries_hash` 索引，代价只有一次索引命中。
   */
  function captureImage(entry) {
    return dbQuery('SELECT id FROM clipboard_entries WHERE text_hash = ?1 LIMIT 1', [entry.hash]).then(
      function (rows) {
        if (rows.length === 0) return null;
        var id = rows[0].id;
        return ctx.clipboard.readImage().then(
          function (dataUrl) {
            if (!dataUrl) return null;
            var bytes = decodeDataUrl(dataUrl);
            if (!bytes) return null;
            if (bytes.length > HOST_IMAGE_BYTES) {
              return dbExec('UPDATE clipboard_entries SET note = ?1 WHERE id = ?2', [
                '图片超过宿主一次能交付的上限（8 MiB），没有保存',
                id,
              ]);
            }
            return writeImage(id, bytes)
              .then(function () {
                return dbExec(
                  'UPDATE clipboard_entries SET image_path = ?1, image_bytes = ?2, note = NULL WHERE id = ?3',
                  [imageFileName(id), bytes.length, id]
                );
              })
              .catch(function (e) {
                // 只记字节数与错误对象：**不带内容**。
                console.warn('[clipboard-history] 保存图片失败（条目本身仍然保留）：', bytes.length, e);
                setNotice('有一张图片没能存下来（数据目录不可写），条目本身仍然在。');
              });
          },
          function (error) {
            // 宿主在有图但超限、或内容被隐私标记挡住时会抛错。两者都不该被吞掉，
            // 但也都不该让整条记录失败 —— 文本部分仍然是有用的历史。
            var message = String((error && error.message) || error);
            var short =
              message.indexOf('超过本 API 的体积上限') !== -1 ? '图片过大，没有保存' : '图片没有取回来';
            console.warn('[clipboard-history] readImage 失败：' + short);
            return dbExec('UPDATE clipboard_entries SET note = ?1 WHERE id = ?2', [short, id]);
          }
        );
      }
    );
  }

  // ============================================================
  // 裁剪与预算  ← 必须真的跑，而且**绝不删置顶**
  // ============================================================
  //
  // 四条规则，按顺序执行：
  //
  //   1. **超龄**：`post_time` 早于 N 天的**未置顶**条目，连同它的 `clipboard_bodies`
  //      行与图片文件一起删掉。
  //   2. **超量**：未置顶条目从最旧的开始删，直到总数不超过上限。
  //      **置顶条目不计入上限、也不被删** —— 用户按下"置顶"就是在说"这一条别动"，
  //      而上限是一个自动维护的旋钮。因此设置里的上限说的是"未置顶部分保留多少条"。
  //   3. **图片预算**：图片字节总量（所有条目的 `image_bytes` 之和）超过上限时，从
  //      **最旧的未置顶**条目开始删图片（条目本身留着，只把图片摘掉）。
  //   4. **硬顶**：上一条跑完之后总量仍然超限，说明置顶条目自己就把预算吃满了。
  //      这时从最旧的**置顶**条目开始摘图片 —— 不删条目，只删字节，并记一条警告。
  //      为什么最后才动置顶：置顶表达的是"不要删我"，而图片是条目里最不值钱的部分
  //      （它已经不在剪贴板上了）。让用户因为预算失去一整条历史，比让他少一张缩略图糟。
  //
  // 另外两条**无论如何都要守住**的边界：
  //   * 每一轮裁剪都有**扫描上限**（`PRUNE_SCAN_LIMIT`）。1 万条时的裁剪不该把所有行
  //     拉进 JS —— 这里每一轮只取最旧的一小批，够删就停。
  //   * 删除是"先删行、后删文件"。反过来（先删文件、删行失败）会留下一条指向不存在的
  //     图片的条目，而那条条目点开会是一块空白。

  /** 一轮裁剪最多处理多少个条目。它挡住的是"库很大时一次裁剪扫全表"。 */
  var PRUNE_SCAN_LIMIT = 500;

  /** 数据库占用上限（MiB），含正文。超过时按上文第 3/4 条摘图片之外，还要删最旧的未置顶条目。 */
  var DB_BUDGET_MB = 64;

  function prune() {
    var settings = core.settings;
    var cutoff = Date.now() - settings.maxAgeDays * 24 * 60 * 60 * 1000;

    return deleteExpired(cutoff)
      .then(function () {
        return enforceEntryLimit(settings.maxEntries);
      })
      .then(function () {
        return enforceImageBudget(settings.maxImageMb);
      })
      .then(function () {
        return refreshPinnedFlag();
      })
      .catch(function (e) {
        // 裁剪失败**不能**让"记下这条"失败：那一刻用户已经复制完了，条目已经写进去了。
        console.warn('[clipboard-history] 裁剪历史失败（条目已经保存）：', e);
      });
  }

  function deleteExpired(cutoff) {
    return dbQuery(
      'SELECT id, image_path FROM clipboard_entries WHERE pinned = 0 AND post_time < ?1 ORDER BY post_time LIMIT ?2',
      [cutoff, PRUNE_SCAN_LIMIT]
    ).then(function (rows) {
      if (rows.length === 0) return null;
      var ids = rows.map(function (row) {
        return row.id;
      });
      var paths = rows
        .map(function (row) {
          return row.image_path;
        })
        .filter(Boolean);
      return deleteEntries(ids, paths);
    });
  }

  function enforceEntryLimit(limit) {
    return dbQuery('SELECT COUNT(*) AS total FROM clipboard_entries WHERE pinned = 0').then(function (rows) {
      var total = rows.length > 0 ? Number(rows[0].total) || 0 : 0;
      var excess = total - limit;
      if (excess <= 0) return null;

      return dbQuery(
        'SELECT id, image_path FROM clipboard_entries WHERE pinned = 0 ORDER BY post_time LIMIT ?1',
        [Math.min(excess, PRUNE_SCAN_LIMIT)]
      ).then(function (oldest) {
        if (oldest.length === 0) return null;
        return deleteEntries(
          oldest.map(function (row) {
            return row.id;
          }),
          oldest
            .map(function (row) {
              return row.image_path;
            })
            .filter(Boolean)
        );
      });
    });
  }

  function imageTotal() {
    return dbQuery('SELECT COALESCE(SUM(image_bytes), 0) AS total FROM clipboard_entries').then(function (rows) {
      return rows.length > 0 ? Number(rows[0].total) || 0 : 0;
    });
  }

  function databaseBytes() {
    // 页数 × 页大小。`PRAGMA` 的**读取**是被允许的（只有设值被宿主拒绝）。
    return dbQuery('PRAGMA page_count').then(function (rows) {
      var pages = rows.length > 0 ? Number(rows[0].page_count) || 0 : 0;
      return dbQuery('PRAGMA page_size').then(function (sizeRows) {
        var size = sizeRows.length > 0 ? Number(sizeRows[0].page_size) || 0 : 0;
        return pages * size;
      });
    });
  }

  function dropImages(whereClause, budget) {
    return dbQuery(
      'SELECT id, image_path, image_bytes FROM clipboard_entries WHERE image_bytes > 0 AND ' +
        whereClause +
        ' ORDER BY post_time LIMIT ?1',
      [PRUNE_SCAN_LIMIT]
    ).then(function (rows) {
      if (rows.length === 0) return budget;

      var remaining = budget;
      var drop = [];
      for (var i = 0; i < rows.length; i++) {
        var size = Number(rows[i].image_bytes) || 0;
        if (remaining - size >= 0) remaining -= size;
        else drop.push(rows[i]);
      }
      if (drop.length === 0) return remaining;

      var ids = drop.map(function (row) {
        return row.id;
      });
      // `?1, ?2, …` 逐个递增：宿主按**参数数组的顺序**绑定（见 `PluginDb` 的说明），
      // 全写 `?1` 会让第二条之后的参数都取到数组的第一个值 —— SQLite 对多余参数是
      // 宽容的，因此那种写法不会报错，只会安静地更新错误的那一行。
      var placeholders = ids
        .map(function (_, index) {
          return '?' + (index + 1);
        })
        .join(', ');
      return dbExec(
        'UPDATE clipboard_entries SET image_path = NULL, image_bytes = 0 WHERE id IN (' + placeholders + ')',
        ids
      ).then(function () {
        return Promise.all(
          drop.map(function (row) {
            return removeImage(row.image_path);
          })
        ).then(function () {
          return remaining;
        });
      });
    });
  }

  function enforceImageBudget(maxImageMb) {
    var budget = maxImageMb * 1024 * 1024;
    var dbBudget = DB_BUDGET_MB * 1024 * 1024;

    // 一条图片都没有时整段跳过：图片预算那几步里有一次 `SUM()` 与两条 `PRAGMA`，
    // 而绝大多数用户不会开图片采集。这个存在性判断走的是
    // `clipboard_entries_images` 这个部分索引，几乎不花代价。
    return dbQuery('SELECT id FROM clipboard_entries WHERE image_bytes > 0 LIMIT 1').then(function (rows) {
      if (rows.length === 0) return null;

      return imageTotal().then(function (total) {
        if (total <= budget) return null;
        // 先动未置顶的（最旧的先），剩下的额度留给置顶条目。
        return dropImages('pinned = 0', budget).then(function (remaining) {
          if (remaining >= 0) return null;
          console.warn('[clipboard-history] 置顶条目自己就超过了图片预算，开始摘它们最旧的图片');
          setNotice('置顶的图片已经超过设置的图片上限，最旧的那些图片被移除了（条目本身保留）。');
          return dropImages('pinned = 1', budget);
        });
      });
    }).then(function () {
      // 数据库本身也有预算。正文最多 64 KiB/条，1 万条的上限是 640 MB —— 那已经
      // 远超"一个剪贴板历史"该占的地方。超过 64 MB 时从最旧的未置顶条目删起。
      return databaseBytes().then(function (bytes) {
        if (bytes <= dbBudget) return null;
        return dbQuery('SELECT COUNT(*) AS total FROM clipboard_entries WHERE pinned = 0').then(function (rows) {
          var total = rows.length > 0 ? Number(rows[0].total) || 0 : 0;
          if (total === 0) return null;
          // 按比例删：超出多少就删多少，至少删 1 条 —— 否则"只超一点"时每一轮
          // 裁剪只删一条，而每一轮都要重扫一次数据库大小。
          var excess = Math.max(1, Math.ceil(total * (1 - dbBudget / bytes)));
          return dbQuery(
            'SELECT id, image_path FROM clipboard_entries WHERE pinned = 0 ORDER BY post_time LIMIT ?1',
            [Math.min(excess, PRUNE_SCAN_LIMIT)]
          ).then(function (oldest) {
            if (oldest.length === 0) return null;
            return deleteEntries(
              oldest.map(function (row) {
                return row.id;
              }),
              oldest
                .map(function (row) {
                  return row.image_path;
                })
                .filter(Boolean)
            );
          });
        });
      });
    });
  }

  function deleteEntries(ids, imagePaths) {
    if (ids.length === 0) return Promise.resolve();
    var placeholders = ids
      .map(function (_, index) {
        return '?' + (index + 1);
      })
      .join(', ');
    return ctx.db
      .transaction([
        { sql: 'DELETE FROM clipboard_entries WHERE id IN (' + placeholders + ')', params: ids },
        { sql: 'DELETE FROM clipboard_bodies WHERE id IN (' + placeholders + ')', params: ids },
      ])
      .then(function () {
        return Promise.all(
          imagePaths.map(function (path) {
            return removeImage(path);
          })
        );
      });
  }

  function refreshPinnedFlag() {
    return dbQuery('SELECT COUNT(*) AS total FROM clipboard_entries WHERE pinned = 1').then(function (rows) {
      var total = rows.length > 0 ? Number(rows[0].total) || 0 : 0;
      var hasPinned = total > 0;
      if (hasPinned !== core.hasPinned) {
        core.hasPinned = hasPinned;
        emit();
      }
    });
  }

  // ============================================================
  // 查询
  // ============================================================

  function escapeLike(value) {
    return value.replace(/[\\%_]/g, function (ch) {
      return '\\' + ch;
    });
  }

  function normalizeRow(row) {
    var formats = [];
    try {
      var parsed = JSON.parse(row.formats);
      if (Array.isArray(parsed)) formats = formatTagsOf(parsed);
    } catch (e) {
      // 格式是一行 JSON；解析失败时按"没有标签"处理，而不是让整页崩掉。
    }
    return {
      id: row.id,
      postTime: row.post_time,
      lastSeenAt: row.last_seen_at,
      preview: typeof row.cached_text === 'string' ? row.cached_text : '',
      textBytes: Number(row.text_bytes) || 0,
      formats: formats,
      pinned: Number(row.pinned) === 1,
      imagePath: row.image_path || null,
      imageBytes: Number(row.image_bytes) || 0,
      note: row.note || null,
    };
  }

  /**
   * 取一页。
   *
   * 用**游标**而不是 `OFFSET`：`OFFSET 9000` 仍然是让 SQLite 数过前 9000 行。
   * 游标是 `(post_time, id)` 的严格小于，配合复合索引就是一次范围扫描。
   * 排序键必须与索引一致（`post_time DESC, id DESC`），否则 SQLite 会退化成排序。
   */
  function fetchPage(query, cursor, limit) {
    var search = query ? query.trim() : '';
    var anchor = cursor && typeof cursor.postTime === 'number' ? cursor : null;
    // 一页取多少条。缺省就是 `PAGE_SIZE`；**刷新时调用方会传一个更大的值**，用的
    // 是"当前已经载入多少条" —— 理由见组件里那条取数 effect（一句话：刷新不应该
    // 把用户已经翻出来的后面几页丢掉）。上限兜住最坏情况的内存与 IPC 体积。
    var take =
      typeof limit === 'number' && limit > 0 ? Math.min(Math.floor(limit), MAX_FETCH_LIMIT) : PAGE_SIZE;

    if (search) {
      // 搜索在**正文全文**上做（`clipboard_bodies.body`），不在预览上 —— 否则
      // 只能搜到每条的前 200 个字符，那是一个"搜不到但确实存在"的陷阱。
      // `JOIN` 而不是先取一批 id 再 `IN`：这里两个条件（正文命中 + 时间游标）必须一起
      // 参与排序与 `LIMIT`，分开做就会先截断再过滤，得到"这一页少几条"。
      var like = '%' + escapeLike(search) + '%';
      var sql =
        'SELECT e.id, e.post_time, e.last_seen_at, e.cached_text, e.text_bytes, e.formats, ' +
        'e.pinned, e.image_path, e.image_bytes, e.note ' +
        'FROM clipboard_entries e JOIN clipboard_bodies b ON b.id = e.id ' +
        "WHERE b.body LIKE ?1 ESCAPE '\\'";
      // 参数一律按 `?N` 递增写，且**序号与出现顺序严格对应**：宿主按数组顺序绑定，
      // 序号写错不会报错，只会把值绑到另一个位置（比如此处会把 limit 当成游标）。
      var params = [like];
      if (anchor) {
        var anchorParam = params.length + 1;
        sql +=
          ' AND (e.post_time < ?' +
          anchorParam +
          ' OR (e.post_time = ?' +
          anchorParam +
          ' AND e.id < ?' +
          (anchorParam + 1) +
          '))';
        params.push(anchor.postTime, anchor.id);
      }
      sql += ' ORDER BY e.post_time DESC, e.id DESC LIMIT ?' + (params.length + 1);
      params.push(take);

      return dbQuery(sql, params).then(function (rows) {
        return { entries: rows.map(normalizeRow), hasMore: rows.length === take };
      });
    }

    var listSql =
      'SELECT id, post_time, last_seen_at, cached_text, text_bytes, formats, pinned, image_path, image_bytes, note ' +
      'FROM clipboard_entries';
    var listParams = [];
    if (anchor) {
      var listAnchor = listParams.length + 1;
      listSql +=
        ' WHERE post_time < ?' +
        listAnchor +
        ' OR (post_time = ?' +
        listAnchor +
        ' AND id < ?' +
        (listAnchor + 1) +
        ')';
      listParams.push(anchor.postTime, anchor.id);
    }
    listSql += ' ORDER BY post_time DESC, id DESC LIMIT ?' + (listParams.length + 1);
    listParams.push(take);

    return dbQuery(listSql, listParams).then(function (rows) {
      return { entries: rows.map(normalizeRow), hasMore: rows.length === take };
    });
  }

  function countAll() {
    return dbQuery('SELECT COUNT(*) AS total FROM clipboard_entries').then(function (rows) {
      return rows.length > 0 ? Number(rows[0].total) || 0 : 0;
    });
  }

  function usageSummary() {
    return Promise.all([
      countAll(),
      dbQuery('SELECT COUNT(*) AS total FROM clipboard_entries WHERE pinned = 1'),
      imageTotal(),
      databaseBytes(),
    ]).then(function (values) {
      return {
        entries: values[0],
        pinned: values[1].length > 0 ? Number(values[1][0].total) || 0 : 0,
        imageBytes: values[2],
        dbBytes: values[3],
      };
    });
  }

  function readBody(id) {
    return dbQuery('SELECT body FROM clipboard_bodies WHERE id = ?1', [id]).then(function (rows) {
      return rows.length > 0 && typeof rows[0].body === 'string' ? rows[0].body : '';
    });
  }

  /** 用户在界面上删除单条（置顶的也能手动删 —— 置顶挡的是自动清理，不是用户）。 */
  function removeEntry(id) {
    return dbQuery('SELECT image_path, pinned FROM clipboard_entries WHERE id = ?1', [id]).then(function (rows) {
      if (rows.length === 0) return false;
      var pinned = Number(rows[0].pinned) === 1;
      return deleteEntries([id], rows[0].image_path ? [rows[0].image_path] : []).then(function () {
        return pinned;
      });
    });
  }

  function clearAll(includePinned) {
    var sql = includePinned
      ? 'SELECT id, image_path FROM clipboard_entries'
      : 'SELECT id, image_path FROM clipboard_entries WHERE pinned = 0';
    return dbQuery(sql).then(function (rows) {
      if (rows.length === 0) return 0;
      var ids = rows.map(function (row) {
        return row.id;
      });
      var paths = rows
        .map(function (row) {
          return row.image_path;
        })
        .filter(Boolean);
      return deleteEntries(ids, paths).then(function () {
        return ids.length;
      });
    });
  }

  function togglePin(id, pinned) {
    return dbExec('UPDATE clipboard_entries SET pinned = ?1 WHERE id = ?2', [pinned ? 1 : 0, id]);
  }

  // ============================================================
  // 复制回去  ← 唯一会改系统剪贴板的地方
  // ============================================================
  //
  // 三步，缺一不可：
  //   1. **先决定要不要暂停采集。** 如果采集正开着，这一次写入会产生一次回声，
  //      而回声靠"回执"丢掉（见上）。这里刻意**不**为了复制而暂停采集 ——
  //      那会让"用户在这期间真实复制的东西"也丢掉，代价比回声大得多。
  //   2. 写入并**等待它成功**。失败时不记回执 —— 没写进去就没有回声，
  //      记了回执反而会把用户下一次真实的复制吃掉。
  //   3. 记回执。放在写入之后，因为写入可能被浏览器拒绝。

  function copyBack(text) {
    if (!ctx.clipboard.isAvailable()) {
      return Promise.reject(new Error('这个文档里没有剪贴板接口，无法复制回去'));
    }
    return ctx.clipboard.writeText(text).then(function () {
      rememberOwnWrite(text);
    });
  }

  // ============================================================
  // 订阅剪贴板变化
  // ============================================================

  var unsubscribeClipboard = null;

  function bumpRevision() {
    emit();
  }

  function handleChange(change) {
    if (!core.ready) return;
    if (core.paused) return;
    if (!core.settings.captureEnabled) return;
    if (!change || typeof change !== 'object') return;

    // ★ 回声的出口。放在所有分支之前：一个被丢弃的自己写入不该走到任何记录路径。
    if (isOwnWrite(change)) {
      console.debug('[clipboard-history] 这是插件自己写出去的那一次，已跳过');
      return;
    }

    // 空文本：有可能是"只复制了一张图"（`text` 为 `null`），也有可能是用户复制了
    // 一段空白。前者在图片采集开启时仍然值得记一条，因此这里只挡掉后者的空转。
    if (change.text === null) {
      if (!core.settings.captureImages) return;
      if (formatTagsOf(change.formats).indexOf('image/png') === -1) return;
    }

    record(change).then(
      function (result) {
        if (result === 'skipped') return;
        // 只有真的写进去了才通知界面刷新。`deduped` 也算 —— 那一条已经被移到最前面，
        // 列表顺序变了。
        bumpRevision();
      },
      function (e) {
        console.warn('[clipboard-history] 记录剪贴板变化失败：', e);
      }
    );
  }

  /**
   * 装上订阅。
   *
   * 采集的开启/关闭**不靠订阅的装卸**，而是靠 `core.paused` / 设置里的开关在回调里
   * 提前返回。理由：宿主的监测线程是"第一个订阅者拉起、最后一个离开时停掉"
   * （见 `clipboard.rs` 的生命周期一节）。为了暂停而退订，等于每次暂停都让那条
   * 线程退出、每次继续再拉起一条 —— 而线程的生命周期由宿主管理，插件不该用
   * "反复退订"去驱动它。真正在看的东西只有一个：回调里的那个提前返回。
   */
  function installMonitor() {
    core.canMonitor = ctx.clipboard.canMonitor();
    if (!core.canMonitor) return;
    unsubscribeClipboard = ctx.clipboard.subscribe(handleChange);
    ctx.disposables.add(function () {
      if (unsubscribeClipboard) unsubscribeClipboard();
    });
  }

  // ============================================================
  // 启动
  // ============================================================

  function ensureSchema() {
    // DDL 一条一条 `exec`：宿主一次调用只编译一条语句，而 `CREATE TABLE` 与
    // `CREATE INDEX` 之间没有原子性要求（重跑是幂等的）。
    var chain = Promise.resolve();
    SCHEMA.forEach(function (sql) {
      chain = chain.then(function () {
        return dbExec(sql);
      });
    });
    return chain;
  }

  function boot(startupSettings) {
    // 初值取**启动快照**：它是宿主在 bundle 执行之前就取好的，因此这里能同步拿到一份
    // 可用的设置，而不必等一次 RPC（等它意味着"采集开关"在头几百毫秒里只能是缺省值，
    // 而那几百毫秒里用户复制的第一件东西会被按错误的规则处理）。随后 `refreshSettings`
    // 会把它换成权威值。
    core.settings = normalizeSettings(startupSettings);

    if (!ctx.db || !ctx.dataDir) {
      core.dbError = '宿主没有提供数据库或数据目录（缺失 plugin-data 权限）';
      core.ready = true;
      emit();
      return Promise.resolve();
    }

    return refreshSettings()
      .then(function () {
        return ctx.dataDir.available();
      })
      .then(function (available) {
        if (!available) {
          // "数据目录不可用"是一个真实状态（外置盘没插、网络盘掉线），而它读起来
          // 与"还没有历史"一模一样。必须说出来，否则用户以为历史丢了。
          core.dbError = '插件数据目录当前不可用（外置盘或网络盘没有就绪）';
          return null;
        }
        return ensureSchema().then(function () {
          // 启动时跑一次裁剪：上一次退出前可能留下了超龄的条目（应用关着的时候
          // 天数是在走的，而那段时间里没有任何插入来触发裁剪）。
          return prune();
        });
      })
      .then(function () {
        // ⚠️ 数据库不可用时**不装订阅**。装了也没用（没有地方存），而且它会拉起
        // 宿主那条 800 ms 的轮询线程 —— 一个明确说了"不可用"的插件不该让宿主后台
        // 一直转。这一条此前漏了，症状只在数据目录掉线时才出现。
        if (!core.dbError) installMonitor();
        core.ready = true;
        bumpRevision();
        if (core.dbError) {
          console.warn('[clipboard-history] 数据库不可用：' + core.dbError);
        } else {
          console.info(
            '[clipboard-history] 已就绪：采集' +
              (core.canMonitor ? '可用' : '不可用') +
              '，采集开关 ' +
              (core.settings.captureEnabled ? '开' : '关') +
              '，图片采集 ' +
              (core.settings.captureImages ? '开' : '关')
          );
        }
      })
      .catch(function (e) {
        core.dbError = '打开插件数据库失败：' + ((e && e.message) || e);
        core.ready = true;
        emit();
        console.error('[clipboard-history] 启动失败：', e);
      });
  }

  // ============================================================
  // 界面
  // ============================================================
  //
  // 三条界面上的硬要求，先写在这里以免实现时忘掉：
  //
  //   1. **条目文本只作为文本渲染。** 它是别人程序放上剪贴板的字节，可以包含任何
  //      东西。React 的文本子节点会自动转义；这个文件里**没有一处**
  //      `dangerouslySetInnerHTML`，也没有把条目内容拼进 `href` / `src` / `style`。
  //      唯一进入 `src` 的是缩略图的 `blob:` 地址，而那个地址是我们自己从
  //      `ctx.dataDir.read()` 造出来的，与条目内容无关。
  //   2. **1 万条要能用。** 列表是窗口化的（只渲染视口附近的行），数据是游标分页的
  //      （一页 200 条），正文与预览分开存（列表只取预览）。三者缺一不可。
  //   3. **采集不可用时必须说出来。** `canMonitor()` 为假时显示原因与建议，
  //      而不是一个永远空着的列表 —— 空列表看起来像"还没复制过东西"。

  /**
   * 窗口化列表。
   *
   * 只渲染视口上下的若干行，其余用两个撑高的占位块顶着。行高是**测量出来的**
   * （`ResizeObserver`），不是估算的：条目长短差很大，估算出来的总高度会让滚动条
   * 一跳一跳。
   *
   * 为什么不用"固定行高 + 内部滚动"那种更简单的写法：那会强制每行一样高，
   * 而一条 200 字符的预览在一行里放不下 —— 要么截断（用户看不到自己复制的东西），
   * 要么把行撑开（固定行高就崩了）。
   */
  var OVERSCAN_PX = 600;

  function VirtualList(props) {
    var entries = props.entries;
    var containerRef = React.useRef(null);
    var listRef = React.useRef(null);
    var heightsRef = React.useRef({});
    var spacerPair = React.useState({ top: 0, bottom: 0, start: 0, end: 0 });
    var spacer = spacerPair[0];
    var setSpacer = spacerPair[1];

    // 事件回调与 `ResizeObserver` 里要读"最新一次渲染看到的东西"。放进 ref 是因为
    // 那些回调在挂载时创建一次，闭包住的只会是挂载那一刻的数据（原因见 `recompute`）。
    var latestRef = React.useRef({ entries: entries, spacer: spacer });
    var anchorRef = React.useRef(null);
    var recomputeRef = React.useRef(function () {});
    latestRef.current = { entries: entries, spacer: spacer };

    var ESTIMATED = 78;

    /**
     * 把当前数据摊成"每一行的内容偏移"。
     *
     * `offsets[i]` 是第 i 行**在滚动内容里的真实起始位置**，必须与 DOM 里的实际
     * 布局逐像素一致 —— `paddingTop` 用它算出"被移除的那些行一共多高"，算错了
     * 占位就与真实高度不等，视口里的内容会漂移。
     *
     * 这也是量 `.ch-row-wrap` 本身、而把行间距放在那一层的 `padding-bottom` 上的
     * 原因（见 `index.css`）：量的盒子与排版的盒子必须是同一个，算术才闭合。
     */
    function measureGeometry() {
      var list = latestRef.current.entries;
      var heights = heightsRef.current;
      var offsets = [0];
      var total = 0;
      for (var i = 0; i < list.length; i++) {
        total += heights[String(list[i].id)] || ESTIMATED;
        offsets.push(total);
      }
      return { offsets: offsets, total: total };
    }

    /**
     * 重新量一遍**当前真的挂在 DOM 里**的那些行。
     *
     * 行高不是一次定下来的：缩略图加载完、文字折行都会让它变。只观察滚动容器发现
     * 不了这件事（容器高度由我们自己的 padding 决定），而量不到新的行高，`offsets`
     * 就会一直用旧的，滚动条与内容逐渐对不上。
     */
    function remeasureRows() {
      var list = listRef.current;
      if (!list) return false;
      var changed = false;
      var children = list.children;
      for (var i = 0; i < children.length; i++) {
        var node = children[i];
        var id = node.getAttribute && node.getAttribute('data-entry-id');
        if (!id) continue;
        var height = node.getBoundingClientRect().height;
        if (height > 0 && heightsRef.current[id] !== height) {
          heightsRef.current[id] = height;
          changed = true;
        }
      }
      return changed;
    }

    /**
     * 按当前滚动位置决定渲染哪一段。
     *
     * **它绝不闭包任何一次渲染的 `entries` / `spacer`。** 这是这里最容易写错的一处：
     * 滚动监听与 `ResizeObserver` 都只在挂载时创建一次，闭包住的会是**挂载那一刻**
     * 的数组；而数据每来一条新记录就被整体换掉一次。拿旧数组算出来的 `start`/`end`
     * 去切新数组，切出来的片段与占位高度对不上，内容高度随之塌掉，浏览器把
     * `scrollTop` 夹回去 —— 表现就是"滚下去又被弹回原处"。
     */
    function recompute() {
      var container = containerRef.current;
      if (!container) return;
      var list = latestRef.current.entries;
      var rendered = latestRef.current.spacer;
      var geometry = measureGeometry();
      var offsets = geometry.offsets;
      var total = geometry.total;
      var scrollTop = container.scrollTop;
      var viewport = container.clientHeight || 600;
      var start = 0;
      while (start < list.length && offsets[start + 1] < scrollTop - OVERSCAN_PX) start++;
      var end = start;
      while (end < list.length && offsets[end] < scrollTop + viewport + OVERSCAN_PX) end++;

      // 记下"视口顶部正在看哪一条、被滚过去了多少"。数据变化之后靠这两个值把视口
      // 锚回同一条的同一个相对位置 —— 见下面那条锚定 effect。
      var anchorIndex = start;
      while (anchorIndex + 1 < list.length && offsets[anchorIndex + 1] <= scrollTop) anchorIndex++;
      if (list.length > 0) {
        anchorRef.current = { id: list[anchorIndex].id, delta: scrollTop - offsets[anchorIndex] };
      }

      var top = offsets[start];
      var bottom = total - offsets[end];
      if (
        rendered.top !== top ||
        rendered.bottom !== bottom ||
        rendered.start !== start ||
        rendered.end !== end
      ) {
        setSpacer({ top: top, bottom: bottom, start: start, end: end });
      }
    }
    recomputeRef.current = recompute;

    // 每次渲染之后重算一次。**没有依赖数组是有意的**：这一层要跟着"行高被测出来了"
    // 与"条目变了"两件事走，而后者可能是"长度相同但内容不同"（改了一条置顶）。
    // 用 `useLayoutEffect` 而不是 `useEffect`：占位高度要在浏览器绘制**之前**就调准，
    // 否则会先画一帧旧几何、再画一帧新几何，滚动时看着就是"抖一下"。
    React.useLayoutEffect(function () {
      remeasureRows();
      recomputeRef.current();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    });

    /**
     * 数据变化之后把视口锚回原处。
     *
     * 新记录是**插到最前面**的，它的高度会把下面所有内容整体推下去。没有这一步的
     * 表现很具体：一边翻旧记录一边复制东西，每复制一次列表就自己跳一下。
     *
     * 锚点找不到了（被删掉、被搜索过滤掉）就什么都不做 —— 那种情况下用户本来就在
     * 看别的东西了。
     */
    React.useLayoutEffect(
      function () {
        var container = containerRef.current;
        var anchor = anchorRef.current;
        if (!container || !anchor || anchor.id === undefined) return;
        var list = latestRef.current.entries;
        var index = -1;
        for (var i = 0; i < list.length; i++) {
          if (String(list[i].id) === String(anchor.id)) {
            index = i;
            break;
          }
        }
        if (index < 0) return;
        var target = measureGeometry().offsets[index] + anchor.delta;
        if (Math.abs(container.scrollTop - target) > 1) container.scrollTop = target;
        // eslint-disable-next-line react-hooks/exhaustive-deps
      },
      [props.entries]
    );

    // 换了搜索词或清空之后把滚动位置拉回顶部。
    // 不做这一步的表现很具体：滚到第 500 行、改成只匹配 3 条的搜索词，容器仍然停在
    // 原来的 scrollTop 上 —— 屏幕里是一片空白，看起来像"没有结果"。
    React.useEffect(
      function () {
        var container = containerRef.current;
        // 换了搜索词就不是同一次浏览了，锚点作废。
        anchorRef.current = null;
        if (container) container.scrollTop = 0;
      },
      [props.resetKey]
    );

    React.useEffect(function () {
      var container = containerRef.current;
      if (!container) return undefined;
      function onScroll() {
        recomputeRef.current();
      }
      container.addEventListener('scroll', onScroll, { passive: true });
      window.addEventListener('resize', onScroll);

      // 行高变化只有一个可靠信号：`.ch-list` 自己的高度变了（缩略图加载完、文字折行）。
      // 它也会被我们改占位的动作触发，因此回调里先"重新量一遍"，只有在**真的量到了
      // 新行高**时才继续重算 —— 否则会与自己的 `setSpacer` 来回触发。
      var observer = null;
      if (typeof ResizeObserver !== 'undefined') {
        observer = new ResizeObserver(function () {
          if (remeasureRows()) recomputeRef.current();
        });
        if (listRef.current) observer.observe(listRef.current);
      }

      return function () {
        container.removeEventListener('scroll', onScroll);
        window.removeEventListener('resize', onScroll);
        if (observer) observer.disconnect();
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    var slice = entries.slice(spacer.start, spacer.end);

    return h(
      'div',
      { className: 'ch-scroll', ref: containerRef },
      h('div', { className: 'ch-list', ref: listRef, style: { paddingTop: spacer.top, paddingBottom: spacer.bottom } },
        slice.map(function (entry) {
          return h(
            'div',
            {
              key: entry.id,
              className: 'ch-row-wrap',
              // 行高是**从 DOM 上量**的（`remeasureRows` 按这个属性认行），因此不再
              // 需要逐行挂 `ref` —— 那种写法每次渲染都要重新绑定一次回调。
              'data-entry-id': String(entry.id),
            },
            h(EntryRow, {
              entry: entry,
              query: props.query,
              onCopy: props.onCopy,
              onTogglePin: props.onTogglePin,
              onDelete: props.onDelete,
              onLoadImage: props.onLoadImage,
            })
          );
        }),
        // 还有下一页时，列表底部出现一个"载入更多"。它也是一个**可见的提示**：
        // 用户需要知道列表不是全部。
        entries.length > 0 && props.hasMore
          ? h(
              'div',
              { className: 'ch-more' },
              h(
                'button',
                {
                  className: 'ch-btn ch-btn-ghost',
                  type: 'button',
                  disabled: props.loadingMore,
                  onClick: props.onLoadMore,
                },
                props.loadingMore ? '载入中…' : '载入更多'
              ),
              h('span', { className: 'ch-more-note' }, '还有更早的记录没有显示')
            )
          : null
      )
    );
  }

  /** 缩略图。只有需要显示时才去读文件，读完登记 blob 地址并在卸载时释放。 */
  function Thumbnail(props) {
    var entry = props.entry;
    var pair = React.useState(null);
    var url = pair[0];
    var setUrl = pair[1];
    var failedPair = React.useState(false);
    var failed = failedPair[0];
    var setFailed = failedPair[1];

    React.useEffect(
      function () {
        var alive = true;
        var created = null;
        props
          .onLoadImage(entry.id)
          .then(function (blob) {
            if (!alive || !blob) return;
            created = URL.createObjectURL(blob);
            setUrl(created);
          })
          .catch(function () {
            if (alive) setFailed(true);
          });
        return function () {
          alive = false;
          // 必须释放：1 万条里滚过一遍会留下几百个 blob，每个都是几十 KB 到几 MB
          // 的内存，而它们不会被 GC 回收（`URL.createObjectURL` 的引用是显式的）。
          if (created) URL.revokeObjectURL(created);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      },
      [entry.id]
    );

    if (failed) {
      return h('span', { className: 'ch-thumb-missing' }, '缩略图不可读');
    }
    if (!url) {
      return h('span', { className: 'ch-thumb ch-thumb-loading' }, '载入缩略图…');
    }
    return h('img', {
      className: 'ch-thumb',
      src: url,
      // 图片来自用户自己的剪贴板，替代文本里**不放条目内容**（它可能是一段密码）。
      alt: '剪贴板图片',
      loading: 'lazy',
      draggable: false,
    });
  }

  function EntryRow(props) {
    var entry = props.entry;
    var copyPair = React.useState(false);
    var busy = copyPair[0];
    var setBusy = copyPair[1];

    function onCopy() {
      setBusy(true);
      // ⚠️ `.then` 必须在 `.catch` **之前**：反过来的话，复制失败时错误会被那个
      // `catch` 吞掉，于是后面的 `.then` 仍然跑（看起来没事），但一旦将来有人
      // 把恢复按钮的那一步挪进 `.then`，失败路径就会把它跳过 —— 按钮永远停在
      // 「复制中…」。错误本身由 `onCopy` 的上层显示，这里只负责恢复按钮。
      props
        .onCopy(entry)
        .then(function () {
          setBusy(false);
        })
        .catch(function () {
          setBusy(false);
        });
    }

    return h(
      'div',
      { className: 'ch-row' + (entry.pinned ? ' ch-row-pinned' : '') },
      entry.pinned ? h('span', { className: 'ch-pin-mark', title: '已置顶', 'aria-label': '已置顶' }, '置顶') : null,
      // ↓↓↓ 这一行里的 `entry.preview` 是**不可信文本**。它只作为文本子节点出现。 ↓↓↓
      h(
        'div',
        { className: 'ch-row-text', title: absoluteTime(entry.postTime) },
        entry.preview ? entry.preview : '（这条只有图片）'
      ),
      entry.imageBytes > 0 || entry.note
        ? h(
            'div',
            { className: 'ch-row-media' },
            entry.imageBytes > 0 ? h(Thumbnail, { entry: entry, onLoadImage: props.onLoadImage }) : null,
            entry.note ? h('span', { className: 'ch-row-note' }, entry.note) : null
          )
        : null,
      h(
        'div',
        { className: 'ch-row-foot' },
        h('span', { className: 'ch-row-time' }, relativeTime(entry.postTime)),
        entry.lastSeenAt && entry.lastSeenAt !== entry.postTime
          ? h('span', { className: 'ch-row-seen' }, '最近复制 ' + relativeTime(entry.lastSeenAt))
          : null,
        h(
          'div',
          { className: 'ch-tags' },
          entry.formats.map(function (tag) {
            return h('span', { key: tag, className: 'ch-tag' }, formatTagLabel(tag));
          })
        ),
        h('span', { className: 'ch-spacer' }),
        h(
          'div',
          { className: 'ch-row-actions' },
          h(
            'button',
            {
              className: 'ch-btn ch-btn-mini' + (entry.pinned ? ' ch-btn-active' : ''),
              type: 'button',
              title: entry.pinned ? '取消置顶（置顶的条目不会被自动清理）' : '置顶（这条不会被自动清理）',
              'aria-pressed': entry.pinned ? 'true' : 'false',
              onClick: function () {
                props.onTogglePin(entry);
              },
            },
            entry.pinned ? '取消置顶' : '置顶'
          ),
          h(
            'button',
            {
              className: 'ch-btn ch-btn-mini',
              type: 'button',
              disabled: busy,
              title: '把这条重新放回剪贴板',
              onClick: onCopy,
            },
            busy ? '复制中…' : '复制'
          ),
          h(
            'button',
            {
              className: 'ch-btn ch-btn-mini ch-btn-danger',
              type: 'button',
              title: entry.pinned ? '删除（置顶的条目也可以手动删除）' : '删除这条',
              onClick: function () {
                props.onDelete(entry);
              },
            },
            '删除'
          )
        )
      )
    );
  }

  function Toggle(props) {
    return h(
      'label',
      { className: 'ch-toggle' },
      h('input', {
        type: 'checkbox',
        checked: props.checked,
        disabled: props.disabled,
        onChange: function (e) {
          props.onChange(e.target.checked);
        },
      }),
      h(
        'span',
        { className: 'ch-toggle-text' },
        h('span', { className: 'ch-toggle-label' }, props.label),
        props.hint ? h('span', { className: 'ch-hint' }, props.hint) : null
      )
    );
  }

  function NumberField(props) {
    return h(
      'label',
      { className: 'ch-field' },
      h('span', { className: 'ch-field-label' }, props.label),
      h('input', {
        className: 'ch-input ch-input-num',
        type: 'number',
        min: props.min,
        max: props.max,
        step: props.step || 1,
        value: props.value,
        disabled: props.disabled,
        onChange: function (e) {
          props.onChange(e.target.value);
        },
      }),
      props.hint ? h('span', { className: 'ch-hint' }, props.hint) : null
    );
  }

  function SelectField(props) {
    return h(
      'label',
      { className: 'ch-field' },
      h('span', { className: 'ch-field-label' }, props.label),
      h(
        'select',
        {
          className: 'ch-input ch-select',
          value: String(props.value),
          disabled: props.disabled,
          onChange: function (e) {
            props.onChange(e.target.value);
          },
        },
        props.options.map(function (option) {
          return h('option', { key: String(option.value), value: String(option.value) }, option.label);
        })
      ),
      props.hint ? h('span', { className: 'ch-hint' }, props.hint) : null
    );
  }

  function ClipboardHistory() {
    var revisionPair = React.useState(0);
    var revision = revisionPair[0];
    var setRevisionState = revisionPair[1];

    var readyPair = React.useState(false);
    var ready = readyPair[0];
    var setReady = readyPair[1];

    var entriesPair = React.useState([]);
    var entries = entriesPair[0];
    var setEntries = entriesPair[1];

    var hasMorePair = React.useState(false);
    var hasMore = hasMorePair[0];
    var setHasMore = hasMorePair[1];

    var loadingPair = React.useState(false);
    var loading = loadingPair[0];
    var setLoading = loadingPair[1];

    var queryPair = React.useState('');
    var query = queryPair[0];
    var setQuery = queryPair[1];

    var usagePair = React.useState(null);
    var usage = usagePair[0];
    var setUsage = usagePair[1];

    var toastPair = React.useState('');
    var toast = toastPair[0];
    var setToast = toastPair[1];

    var errorPair = React.useState('');
    var error = errorPair[0];
    var setError = errorPair[1];

    // 最新的一页数据放 ref：`loadMore` 要读到它，而闭包捕获的会是旧数组
    // （notes 里记过同一个坑）。
    var entriesRef = React.useRef([]);
    // 搜索词也有两份：`query` 是输入框的值（每次按键都变，好让用户看到自己打的字），
    // `queryRef` 是"已经查过一次"的那个值（只在防抖到点之后才跟上）。两者分开是为了
    // 让取数 effect **不依赖 `query`** —— 依赖它的话每次按键都会立刻查一次 1 万行的
    // 全文匹配，防抖那一层就成了摆设。
    var queryRef = React.useRef('');
    // 上一次**真正查过**的搜索词。用来区分"这一趟是换了搜索词"还是"数据变了"：
    // 前者只能取一页（旧条数对新结果没有意义），后者要取够已经翻出来的那些条。
    var fetchedQueryRef = React.useRef(null);
    var toastTimer = React.useRef(null);
    var searchTimer = React.useRef(null);

    React.useEffect(function () {
      entriesRef.current = entries;
    }, [entries]);

    function flash(message) {
      setToast(message);
      if (toastTimer.current) clearTimeout(toastTimer.current);
      toastTimer.current = setTimeout(function () {
        setToast('');
      }, 1800);
    }

    React.useEffect(function () {
      return function () {
        if (toastTimer.current) clearTimeout(toastTimer.current);
        if (searchTimer.current) clearTimeout(searchTimer.current);
      };
    }, []);

    // 订阅核心：新条目、设置变化、启动完成都从这一条路上来。
    React.useEffect(function () {
      return subscribeCore(function () {
        setReady(core.ready);
        setRevisionState(function (n) {
          return n + 1;
        });
      });
    }, []);

    // 模块被切走时不再重取。宿主会把模块**保活**（切走不卸载），因此"别的地方在
    // 复制、这块界面看不见"时重取是白花的 —— 而重新可见时这条 effect 会做两件事：
    // 把 revision 推一次（补上期间积累的变化），以及**重新读一遍设置**（沙箱里没有
    // `settings.subscribe`，这是"用户刚在设置页改过"唯一能被发现的时机，见注册那一段）。
    var active = Modulith.useModuleActive();
    React.useEffect(
      function () {
        if (!active) return undefined;
        setRevisionState(function (n) {
          return n + 1;
        });
        refreshSettings()
          .then(function (changed) {
            if (!changed) return null;
            setRevisionState(function (n) {
              return n + 1;
            });
            return null;
          })
          .catch(function () {
            // 读设置失败不该让面板报错：缺省值仍然让插件可读可查，只是采集开关
            // 可能不是用户选的那一个。
          });
        return undefined;
      },
      [active]
    );

    // 取第一页 + 用量。
    //
    // **只用 revision 触发**，搜索词走 `queryRef`（见上面的说明）。这个 effect 用
    // `alive` 标志丢弃过期结果：用户连改两次搜索词时两次查询会并发返回，而后回来的
    // 那次可能是**旧**搜索词的结果 —— 界面上的表现是"搜索框里是 A，列表是 B 的结果"。
    React.useEffect(
      function () {
        if (!ready || core.dbError) return undefined;
        var alive = true;
        var searching = fetchedQueryRef.current !== queryRef.current;
        fetchedQueryRef.current = queryRef.current;

        // **取够用户已经翻出来的那些条。**
        //
        // 原来这里固定取第一页（200 条）。问题是「载入更多」会把后面几页并进列表，
        // 而这条 effect 每次数据变化都跑一遍（复制了新东西、置顶、删除）—— 一个
        // 只有 200 条的替换于是把用户翻出来的 1000 条全丢掉：内容高度塌掉，浏览器
        // 随即把 `scrollTop` 夹回它还能容纳的位置。用户看到的就是"滚到一半被弹回去，
        // 而且怎么滚都滚不下去"。
        //
        // 换成搜索词时不能这么做：旧条数对新结果没有意义，按一页取。
        var wanted = searching ? PAGE_SIZE : Math.max(PAGE_SIZE, entriesRef.current.length);
        fetchPage(queryRef.current, null, wanted)
          .then(function (page) {
            if (!alive) return;
            setEntries(page.entries);
            setHasMore(page.hasMore);
            return usageSummary().then(function (next) {
              if (alive) setUsage(next);
            });
          })
          .catch(function (e) {
            if (alive) setError('读取历史失败：' + ((e && e.message) || e));
          });
        return function () {
          alive = false;
        };
      },
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [ready, revision]
    );

    function loadMore() {
      if (loading) return;
      var current = entriesRef.current || [];
      if (current.length === 0) return;
      var last = current[current.length - 1];
      setLoading(true);
      fetchPage(queryRef.current, { postTime: last.postTime, id: last.id })
        .then(function (page) {
          setLoading(false);
          if (page.entries.length === 0) {
            setHasMore(false);
            return;
          }
          // 合并时按 id 去重：新条目会插到最前面，而游标是从"旧的第一页最后一条"
          // 往前的，两者之间可能有重叠。
          var seen = {};
          var merged = current.concat(page.entries).filter(function (entry) {
            if (seen[entry.id]) return false;
            seen[entry.id] = true;
            return true;
          });
          setEntries(merged);
          setHasMore(page.hasMore);
        })
        .catch(function (e) {
          setLoading(false);
          setError('载入更多失败：' + ((e && e.message) || e));
        });
    }

    function onQueryChange(value) {
      setQuery(value);
      // 防抖：每次按键都查一次没有意义，而 1 万行上做一次全文匹配是有成本的。
      if (searchTimer.current) clearTimeout(searchTimer.current);
      searchTimer.current = setTimeout(function () {
        searchTimer.current = null;
        queryRef.current = value;
        setRevisionState(function (n) {
          return n + 1;
        });
      }, 220);
    }

    // ---- 设置 ----
    //
    // 面板里也画一份设置：用户在"设置 → 插件设置"里能找到它们，但改动采集开关时
    // 更可能正在看着这个面板。两处写的是同一份值（`ctx.settings`），因此不会分叉。
    function updateSetting(id, value) {
      // 写完之后**必须重新读一遍**，不能就地改 `core.settings`：
      // `ctx.settings.set` 在沙箱里是异步的，而"以写代读"会让界面显示一个还没落盘的
      // 值 —— 落盘失败（没有 storage 权限、后端不在）时那个值看起来正常，直到重开。
      Promise.resolve()
        .then(function () {
          return ctx.settings.set(id, value);
        })
        .then(function () {
          return refreshSettings();
        })
        .then(function (changed) {
          if (changed && core.ready && !core.dbError) {
            // 改了上限/天数之后立刻按新规则裁剪一次。不这么做的话，"把上限从 1000
            // 改成 100"要等到下一次复制才生效，而用户改完就会回到这个面板看。
            return prune();
          }
          return null;
        })
        .then(function () {
          bumpRevision();
        })
        .catch(function (e) {
          setError('保存设置失败：' + ((e && e.message) || e));
        });
    }

    // ---- 操作 ----

    function onCopy(entry) {
      setError('');
      // 先把全文取回来再写。列表里只有预览，而"复制回去"必须复制**完整**内容 ——
      // 复制一份被截到 200 字符的文本是这个插件最糟糕的一种失败：它看起来成功了。
      return readBody(entry.id).then(function (body) {
        var payload = body || entry.preview;
        return copyBack(payload).then(function () {
          flash('已放回剪贴板');
        });
      });
    }

    function onTogglePin(entry) {
      setError('');
      togglePin(entry.id, !entry.pinned)
        .then(function () {
          return refreshPinnedFlag();
        })
        .then(function () {
          bumpRevision();
          flash(entry.pinned ? '已取消置顶' : '已置顶，不会被自动清理');
        })
        .catch(function (e) {
          setError('置顶失败：' + ((e && e.message) || e));
        });
    }

    function onDelete(entry) {
      var message = entry.pinned
        ? '删除这条置顶记录？置顶保护的是"自动清理"，手动删除仍然可以。'
        : '删除这条记录？';
      if (!window.confirm(message)) return;
      removeEntry(entry.id)
        .then(function () {
          bumpRevision();
          flash('已删除');
        })
        .catch(function (e) {
          setError('删除失败：' + ((e && e.message) || e));
        });
    }

    function onClearAll(includePinned) {
      var message = includePinned
        ? '清空全部历史（含置顶的条目）？这一步不可撤销。'
        : '清空历史（置顶的条目会保留）？这一步不可撤销。';
      if (!window.confirm(message)) return;
      clearAll(includePinned)
        .then(function (removed) {
          bumpRevision();
          flash(removed > 0 ? '已清空 ' + removed + ' 条' : '没有可清空的条目');
        })
        .catch(function (e) {
          setError('清空失败：' + ((e && e.message) || e));
        });
    }

    function onTogglePause() {
      core.paused = !core.paused;
      // **不落盘。** 暂停是一个"这一次"的状态：把它存下来，用户下次开机时
      // 会看到一个不知道为什么暂停的插件（而"忘了自己暂停过"正是这个插件最
      // 容易出现的一种状态）。持久关闭用设置里的"启用采集"。
      bumpRevision();
    }

    function onToggleCapture(enabled) {
      updateSetting(SETTING_IDS.captureEnabled, enabled);
      core.paused = false;
      flash(enabled ? '已开启采集' : '已关闭采集');
    }

    function onLoadImage(id) {
      return readImageBlob(id);
    }

    if (!ready) {
      return h('div', { className: 'ch-root' }, h('div', { className: 'ch-empty' }, '读取中…'));
    }

    // ---- 采集状态指示 ----
    //
    // **常驻**，不是只在暂停时才出现：用户需要一眼看出"它现在到底在不在记"。
    // 四种状态各有自己的措辞，因为它们的处置完全不同。
    var captureState;
    if (core.dbError) {
      captureState = { kind: 'error', label: '不可用', detail: core.dbError };
    } else if (!core.canMonitor) {
      captureState = {
        kind: 'error',
        label: '无法采集',
        detail: '这台机器上无法监测剪贴板变化（只在 Windows 上可用），因此下面的列表不会增长。',
      };
    } else if (!core.settings.captureEnabled) {
      captureState = {
        kind: 'off',
        label: '已关闭',
        detail: '采集已在设置里关闭。复制任何东西都不会被记录。',
      };
    } else if (core.paused) {
      captureState = { kind: 'paused', label: '已暂停', detail: '复制的内容不会被记录。点「继续」恢复。' };
    } else {
      captureState = { kind: 'live', label: '记录中', detail: '复制的内容会出现在下面。' };
    }

    var header = h(
      'div',
      { className: 'ch-head' },
      h(
        'div',
        { className: 'ch-head-main' },
        h('h1', { className: 'ch-title' }, '剪贴板历史'),
        h(
          'span',
          { className: 'ch-state ch-state-' + captureState.kind, role: 'status' },
          h('span', { className: 'ch-state-dot' }),
          captureState.label
        )
      ),
      h(
        'div',
        { className: 'ch-head-actions' },
        core.canMonitor && core.settings.captureEnabled
          ? h(
              'button',
              {
                className: 'ch-btn ch-btn-primary',
                type: 'button',
                onClick: onTogglePause,
                title: core.paused ? '恢复记录剪贴板变化' : '暂停记录（不影响已经存下来的条目）',
              },
              core.paused ? '继续' : '暂停'
            )
          : null,
        h(
          'button',
          {
            className: 'ch-btn ch-btn-ghost',
            type: 'button',
            disabled: entries.length === 0 && (!usage || usage.entries === 0),
            onClick: function () {
              onClearAll(false);
            },
          },
          '清空'
        ),
        core.hasPinned
          ? h(
              'button',
              {
                className: 'ch-btn ch-btn-ghost',
                type: 'button',
                title: '连置顶的条目一起清空',
                onClick: function () {
                  onClearAll(true);
                },
              },
              '全部清空'
            )
          : null
      )
    );

    var searchBar = h(
      'div',
      { className: 'ch-search' },
      h('input', {
        className: 'ch-input ch-search-input',
        type: 'search',
        placeholder: '在历史里搜索…',
        value: query,
        spellCheck: false,
        onChange: function (e) {
          onQueryChange(e.target.value);
        },
      }),
      usage
        ? h(
            'span',
            { className: 'ch-count' },
            query
              ? '搜索：' + entries.length + (hasMore ? '+' : '') + ' 条'
              : usage.entries + ' 条 · ' + usage.pinned + ' 条置顶 · 数据库 ' + humanBytes(usage.dbBytes) +
                (usage.imageBytes > 0 ? ' · 图片 ' + humanBytes(usage.imageBytes) : '')
          )
        : null
    );

    // ---- 隐私说明 ----
    //
    // 用 `<details>` 而不是一个可关闭的横幅：横幅会被关掉，而"这个插件把我的密码
    // 存在哪里"这件事应该在用户想看的时候**总能**看到。默认收起是为了不挡列表。
    //
    // 这里是纯文本（`h('li', {}, '…')`），因此**不能用 Markdown 的 `**` 加粗** ——
    // 那会原样显示成星号。要加粗就用 `h('strong')`。
    var privacy = h(
      'details',
      { className: 'ch-privacy' },
      h('summary', { className: 'ch-privacy-summary' }, '隐私：这个插件存了什么、存在哪里，以及怎么关掉'),
      h(
        'div',
        { className: 'ch-privacy-body' },
        h('p', {}, '它会记录你在这台电脑上复制的文本（以及可选的图片）。'),
        h(
          'ul',
          {},
          h(
            'li',
            {},
            '只存在',
            h('strong', {}, '本机'),
            '的插件数据目录里（Modulith 在 ',
            h('code', {}, '%LOCALAPPDATA%'),
            ' 下的插件目录），不上传到任何地方 —— 这个插件没有声明网络权限。'
          ),
          h(
            'li',
            {},
            h('strong', {}, '不加密。'),
            '它就是明文文件，任何能读你这台机器上这个账户的文件的人都能读到。'
          ),
          h(
            'li',
            {},
            '密码管理器一类程序主动标记为「不要监视」的内容会被宿主跳过，因此',
            h('strong', {}, '这个列表并不完整'),
            ' —— 反过来，也不能指望它挡住不合作的程序。'
          ),
          h(
            'li',
            {},
            '应用关掉之后监测就停了；「暂停」与设置里的「启用采集」都能让它停止记录，「清空」会删掉已经存下来的内容。'
          )
        ),
        h(
          'p',
          { className: 'ch-privacy-foot' },
          '想彻底不再记录：设置 → 插件设置 → 剪贴板历史 → 关掉「启用采集」。'
        )
      )
    );

    var announce = core.notice
      ? h(
          'div',
          { className: 'ch-banner ch-banner-info' },
          h('span', { className: 'ch-banner-text' }, core.notice),
          h(
            'button',
            {
              className: 'ch-banner-close',
              type: 'button',
              title: '关闭',
              onClick: function () {
                setNotice('');
              },
            },
            '×'
          )
        )
      : null;

    var errorNode = error
      ? h(
          'div',
          { className: 'ch-banner ch-banner-error', role: 'alert' },
          h('span', { className: 'ch-banner-text' }, error),
          h(
            'button',
            {
              className: 'ch-banner-close',
              type: 'button',
              title: '关闭',
              onClick: function () {
                setError('');
              },
            },
            '×'
          )
        )
      : null;

    // ---- 列表 / 空态 ----
    var body;
    if (core.dbError) {
      body = h('div', { className: 'ch-empty ch-empty-error' }, captureState.detail);
    } else if (entries.length === 0) {
      body = h(
        'div',
        { className: 'ch-empty' },
        query
          ? '没有匹配「' + query + '」的记录。'
          : !core.canMonitor
            ? '采集不可用，因此这里不会有内容。' + captureState.detail
            : !core.settings.captureEnabled
              ? '采集已关闭。在设置里重新打开「启用采集」之后，复制的内容会出现在这里。'
              : core.paused
                ? '采集已暂停。点右上角「继续」之后，复制的内容会出现在这里。'
                : '还没有记录。复制任何东西（Ctrl+C），它就会出现在这里。'
      );
    } else {
      body = h(VirtualList, {
        entries: entries,
        query: query,
        // 搜索词一变就把滚动位置拉回顶部（见 `VirtualList` 里那条说明）。
        resetKey: query,
        hasMore: hasMore,
        loadingMore: loading,
        onLoadMore: loadMore,
        onCopy: onCopy,
        onTogglePin: onTogglePin,
        onDelete: onDelete,
        onLoadImage: onLoadImage,
      });
    }

    // ---- 设置卡片 ----
    var settingsCard = h(
      'details',
      { className: 'ch-settings' },
      h('summary', { className: 'ch-settings-summary' }, '设置'),
      h(
        'div',
        { className: 'ch-settings-body' },
        h(Toggle, {
          label: '启用采集',
          hint: '关掉之后不再记录任何新的复制内容；已经存下来的仍在。',
          checked: core.settings.captureEnabled,
          disabled: !core.canMonitor || !!core.dbError,
          onChange: onToggleCapture,
        }),
        h(NumberField, {
          label: '最多保留多少条',
          min: 10,
          max: 50000,
          step: 10,
          value: core.settings.maxEntries,
          disabled: !!core.dbError,
          hint: '超出时从最旧的开始删。置顶的条目不计入这个数，也不会被删。',
          onChange: function (value) {
            var n = Math.max(10, Math.min(50000, Math.round(Number(value) || FALLBACK.maxEntries)));
            updateSetting(SETTING_IDS.maxEntries, n);
          },
        }),
        h(SelectField, {
          label: '最多保留多少天',
          value: core.settings.maxAgeDays,
          disabled: !!core.dbError,
          options: [
            { value: '1', label: '1 天' },
            { value: '3', label: '3 天' },
            { value: '7', label: '7 天' },
            { value: '30', label: '30 天' },
            { value: '90', label: '90 天' },
            { value: '365', label: '1 年' },
            { value: '3650', label: '永久' },
          ],
          hint: '超过这个天数的记录会被自动删除（置顶的除外）。',
          onChange: function (value) {
            updateSetting(SETTING_IDS.maxAgeDays, Math.round(Number(value) || FALLBACK.maxAgeDays));
          },
        }),
        h(Toggle, {
          label: '也记录图片',
          hint: '默认关闭。开启后每张图片最多 8 MB，会写进插件的明文数据目录。',
          checked: core.settings.captureImages,
          disabled: !core.canMonitor || !!core.dbError,
          onChange: function (value) {
            updateSetting(SETTING_IDS.captureImages, value);
          },
        }),
        h(NumberField, {
          label: '图片总量上限（MB）',
          min: 0,
          max: 1024,
          step: 16,
          value: core.settings.maxImageMb,
          disabled: !core.settings.captureImages || !!core.dbError,
          hint: '所有图片加起来超过它就删掉最旧的（先删未置顶的）。0 表示不留图片。',
          onChange: function (value) {
            var n = Math.max(0, Math.min(1024, Math.round(Number(value) || 0)));
            updateSetting(SETTING_IDS.maxImageMb, n);
          },
        })
      )
    );

    return h(
      'div',
      { className: 'ch-root' },
      h(
        'div',
        { className: 'ch-inner' },
        header,
        h('div', { className: 'ch-state-detail' }, captureState.detail),
        announce,
        errorNode,
        searchBar,
        privacy,
        body,
        settingsCard,
        h(
          'div',
          { className: 'ch-footnote' },
          '数据存在插件自己的数据目录中（未加密），卸载插件不会自动删除 —— 要清掉用上面的「清空」。'
        )
      ),
      toast ? h('div', { className: 'ch-toast' }, toast) : null
    );
  }

  // ============================================================
  // 注册
  // ============================================================

  Modulith.run(function (bootstrap) {
    ctx = bootstrap.ctx;

    // 设置变更**没有订阅可挂**：沙箱桥接层刻意没有 `ctx.settings.subscribe`（宿主
    // 没有那条"设置变了"的推送通道，见 `sandbox-bridge.js` 里 settings 上那段说明）。
    // 因此"用户在设置页改了值"这件事只能由插件自己去问。问题是**什么时候问**：
    //
    //   * 模块重新可见时问一次（`useModuleActive` 从假变真）—— 见组件里那条 effect。
    //     这是最贴近"用户刚改完设置就会回来看看"的时机，而它的触发频率天然有界。
    //   * 用户在本面板里改值之后问一次（`updateSetting`）。
    //
    // 刻意**不**挂一个定时轮询：那会让这个插件在后台一直发 RPC，而它能换来的只是在
    // 用户没有打开这个面板时更新一份用户看不见的缓存。
    Modulith.registerModule({
      id: 'clipboard-history',
      name: '剪贴板历史',
      description: '留下复制过的东西，随时贴回去',
      icon: 'ClipboardList',
      priority: 72,
      component: ClipboardHistory,
    });

    // `bootstrap.settings` 只在**这里**用一次（作为同步初值），之后一律经
    // `refreshSettings()` 读权威值 —— 快照不会跟着用户改动更新。
    boot(bootstrap.settings);
  });
})();
