// plugins/translate/index.js
//
// 划词翻译 —— 面板那一半。跑在**沙箱 iframe** 里，与 `background.js`
// （一个独立的 Node 进程）没有共享的 JS 上下文。
//
// ============================================================
// 这个面板的**主次**：翻译工作台是主角，热键是其中一个入口
// ============================================================
//
// 这个插件的本体是**一个翻译工具**：输入一段文字、选两个语言、拿到译文、之后还能
// 找回来。热键只是"不用切窗口就能用同一个工具"的一条通道，而它在非 Windows 上
// 根本不存在。
//
// 3.0.0 的界面结构（两栏 + 一个抽屉）：
//
//   1. **顶栏**：端点探测状态、划词入口（组合键 + 划词目标语言）、设置按钮；
//   2. **左栏 · 翻译工作台**：语言行（含互换）、原文、动作、译文与复制；
//   3. **右栏 · 历史**：搜索、置顶筛选、分页，以及每行的复制 / 置顶 / 删除；
//   4. **设置抽屉**：连接、提示词、划词、数据四页 —— 配置与解释都在这里。
//
// 前两栏完全不需要热键、不需要 Node 运行时、不需要后台进程 —— 面板直接调
// `ctx.http`。
//
// 3.0.0 与 2.0.0 最要紧的两处行为变化：
//   * **划词有自己的目标语言**（`quickTargetLang`）。2.0.0 与工作台共用一个
//     `targetLang`，于是改工作台的语言会连带改掉热键翻译的语言；
//   * **不再弹 toast**。回执改成按钮内的短状态，错误留在它发生的那一栏里。
//
// ============================================================
// 两个进程之间只有一条通道：宿主的存储与设置
// ============================================================
//
// 后台把运行状态写在 `ctx.storage` 的 `runtimeStatus` 里；面板读它。没有推送，
// 因此面板**不会自动更新** —— 只在打开 / 重新可见 / 做了一次动作之后读一次。
// 刻意不挂定时轮询：那会让这个插件在后台一直发 RPC，换来的只是更新一份用户
// 多半没在看的缓存（与 `clipboard-history` 在设置那一节的取舍同一条理由）。
//
// 由此有一条**必须对用户说清楚**的限制：**热键翻出来的译文不会出现在下面的
// 历史里。** 那段文字是后台进程拿到的，而数据库由面板这一侧写 —— 后台那个进程
// 连 SQL 都不该发（它拿到的是一段用户选中、可能含密码的文字，把"要不要留档"的
// 决定权交给一次按键太轻率了）。面板里的翻译与热键翻译因此是两条**分开**的记录。
//
// ============================================================
// 隐私：这个文件里同样有一条不许破例的规矩
// ============================================================
//
// **原文与译文一个字都不进 console、不进 ctx.logger、不进 ctx.notifications。**
//
// 它们只出现在三个地方，而且每个地方都是用户自己要的：
//   * DOM（用户自己面前的这一屏）；
//   * 剪贴板（用户自己按的「复制」按钮）；
//   * `ctx.db` 的历史表 —— **只因为划词翻译工具必须能把刚才翻过的东西找回来**，
//     而"翻完就没了"是一个不可用的翻译工具。
//
// 第三处是这一版新增的，因此把它的代价与出口一并写清楚（面板上也有）：
//   * 它落在插件的**数据目录**里（`<data>/plugin.db`），进「插件数据」备份类别，
//     因此会随备份复制到别的机器上；
//   * 面板上有「清空」（可选连置顶一起），以及逐条删除；
//   * 历史**不提供导出**，也不写任何一份明文副本到别处。
//
// 另有一条同样要紧的：**API key 绝不作为 `value` 渲染进 DOM**（那就等于把它写进
// 一个可以被截图、被开发者工具读出来的地方）。输入框永远是空的，只在旁边显示
// "已保存 / 未设置"，那份状态来自 `ctx.secrets.keys()` —— 它**只有键名，没有值**。
//
// ============================================================
// 一切来自外部的文本都按不可信处理
// ============================================================
//
// 原文（用户输入的 / 历史里的）、译文、模型 id、服务端的错误响应体，
// 全都只作为 React 的**文本子节点**渲染：没有 `dangerouslySetInnerHTML`、
// 不拼进 `href` / `src` / `style`、不当成 class 名。模型 id 与错误体还可能
// 被服务端塞进奇怪的东西，因此连"看起来像 id 的才显示"这种过滤都不做 ——
// 显示成文本本来就是安全的，过滤只会丢掉用户需要看到的信息。

(function () {
  'use strict';

  var Modulith = window.Modulith;
  if (!Modulith) {
    // 宿主没注入时插件根本无从加载。这里不能静默返回 —— 那样面板会是一片空白，
    // 而没有任何线索。控制台是这一处唯一能说话的地方。
    console.error('[translate] 未找到 window.Modulith，插件无法加载');
    return;
  }

  var React = Modulith.React;
  var h = React.createElement;

  // ============================================================
  // ctx
  // ============================================================
  //
  // 两种入口都要能跑：`Modulith.run(fn)` 是显式引导入口，宿主把身份、设置快照与
  // `ctx` 作为**参数**交进来；`Modulith.createContext()` 返回的是**同一个对象**。
  // 这里用前者，因为它是跨进程也能成立的那一种 —— 它不依赖"当前正在加载哪个插件"
  // 这个隐式全局，而沙箱里的插件恰恰在另一个 realm 里。
  //
  // 声明成 `null` 再在引导回调里赋值：`'use strict'` 下给一个没声明的名字赋值会
  // 抛错，而这里的 IIFE 是严格模式。
  var ctx = null;

  // ============================================================
  // 与后台那一半共用的常量
  // ============================================================
  //
  // 两个文件都手写、都不允许 import（单文件 IIFE），因此这几个值只能抄两份。
  // 抄错的后果是"面板上显示的是 A、后台实际用的是 B"，因此**改动必须两处一起改**
  // —— 它们与清单里 `contributes.settings` 的缺省值也必须是同一批值（三处）。

  var SETTING_IDS = {
    baseUrl: 'baseUrl',
    endpointKind: 'endpointKind',
    model: 'model',
    promptTemplate: 'promptTemplate',
    triggerCombo: 'triggerCombo',
    sourceLang: 'sourceLang',
    targetLang: 'targetLang',
    quickTargetLang: 'quickTargetLang',
  };

  var DEFAULT_BASE_URL = 'http://127.0.0.1:5566/v1';
  var DEFAULT_ENDPOINT_KIND = 'chat';
  var DEFAULT_MODEL = 'Hy MT2 1.8B Q4_K_M.gguf';
  var DEFAULT_SOURCE_LANG = 'auto';
  var DEFAULT_TARGET_LANG = '简体中文';
  /**
   * 划词翻译的目标语言，与工作台那一项**分开存**。
   *
   * 这一项是 3.0.0 的主要变化：上一版两个入口共用一个 `targetLang`，于是
   * "把工作台改成英文读资料"会连带把热键翻译也改成英文 —— 而用户想要的恰恰是
   * 划词翻回中文。改回来之后工作台又变回中文，两边互相拉扯。
   */
  var DEFAULT_QUICK_TARGET_LANG = '简体中文';
  var DEFAULT_TRIGGER_COMBO = 'Ctrl+Q';
  var DEFAULT_PROMPT_TEMPLATE =
    '把下面这段文本翻译成{target}。只输出译文本身，不要解释、不要加引号、不要重复原文。\n\n{text}';

  var SECRET_API_KEY = 'apiKey';
  var STATUS_KEY = 'runtimeStatus';
  var CACHE_KEY = 'modelsCache';

  var MAX_TOKENS = 1024;
  var ERROR_BODY_LIMIT = 600;

  /** 手动翻译一次最多收多少字符。防止把一整本书粘进去 —— 那对本地小模型毫无意义。 */
  var INPUT_LIMIT = 8000;

  // ============================================================
  // 语言清单
  // ============================================================
  //
  // ============================================================
  // 源语言里的 `auto` 是**一句说明**，不是一个语言名
  // ============================================================
  //
  // 这个插件**不做语言检测** —— 那需要另一个模型，而本机通常只加载了一个翻译模型。
  // 把"自动"谎报成某个具体语言（或者干脆留一个空的 `{source}`）只会误导模型，
  // 而模型被误导的表现是译文里混进一句解释，用户完全看不出那是提示词的问题。
  //
  // 因此自动模式下 `{source}` 被替换成**一句让模型自己判断的话**，两个运行位置
  // 用的是同一句（见 `background.js` 的 `buildPrompt`）。
  var SOURCE_AUTO_HINT = '原文的语言（由你判断）';

  var SOURCE_LANGS = [
    { value: 'auto', label: '自动（由模型判断）' },
    { value: '简体中文', label: '简体中文' },
    { value: '繁體中文', label: '繁體中文' },
    { value: 'English', label: 'English' },
    { value: '日本語', label: '日本語' },
    { value: '한국어', label: '한국어' },
    { value: 'Русский', label: 'Русский' },
    { value: 'Français', label: 'Français' },
    { value: 'Deutsch', label: 'Deutsch' },
    { value: 'Español', label: 'Español' },
    { value: 'Italiano', label: 'Italiano' },
    { value: 'Português', label: 'Português' },
    { value: 'العربية', label: 'العربية' },
  ];

  var TARGET_LANGS = [
    '简体中文',
    '繁體中文',
    'English',
    '日本語',
    '한국어',
    'Русский',
    'Français',
    'Deutsch',
    'Español',
    'Italiano',
    'Português',
    'العربية',
  ];

  // ============================================================
  // 历史：表结构与裁剪策略
  // ============================================================
  //
  // ============================================================
  // 从 `plugins/clipboard-history/` 抄了什么、为什么
  // ============================================================
  //
  // 那个插件已经在真实使用里把"长文本历史"这件事的坑踩过一遍了，而这里的形状
  // 与它几乎一样（一堆"时间 + 一段可能很长的正文"、可搜索、可分页、可置顶）。
  // 逐条抄过来的是**设计**，不是代码：
  //
  //   1. **预览与全文分成两张表**（`translate_entries.body_preview` 只放前 200 个
  //      字符，全文在 `translate_bodies.body`）。列表一次要取 30 行，而一段译文
  //      可能上千字符 —— 只为渲染每行两行高的预览就把几百 KB 搬进 JS 是没必要的。
  //      全文只在"打开这一条"时按 id 取一行。
  //   2. **按真实查询建索引**：列表是 `ORDER BY at DESC, id DESC`，因此复合索引
  //      就是 `(at DESC, id DESC)`；置顶条目的计数用部分索引 `WHERE pinned = 1`。
  //   3. **游标分页，不用 OFFSET**。`OFFSET 2000` 仍然是让 SQLite 数过前 2000 行。
  //      游标是 `(at, id)` 的严格小于，配合复合索引就是一次范围扫描。
  //   4. **每一轮裁剪都有扫描上限**（`PRUNE_SCAN_LIMIT`），删除走一次
  //      `ctx.db.transaction`（两张表要么一起删，要么都不删）。
  //   5. **置顶条目不计入条数上限、也不被超龄删除**；但库体积的硬顶它们也躲不掉
  //      （那时只删最旧的几条并记一条警告），因为总量与库本身的大小是一件事。
  //
  // 与它**刻意不同**的两点：
  //
  //   * 没有图片。这里只有文本，因此没有图片预算、没有文件删除、没有目录操作
  //     —— `ctx.db` 一张库就装完了。
  //   * 搜索必须落在**全文**上（`translate_bodies.body`），与它一致；只在预览上
  //     搜会让"前 200 字符之后才出现的关键词"永远搜不到。
  //
  // 表结构：
  //
  //   translate_entries
  //     id            INTEGER PRIMARY KEY   自增，同时是游标分页的第二排序键
  //     at            INTEGER NOT NULL      翻译完成的毫秒时间戳
  //     source_lang   TEXT NOT NULL         这次用的源语言设置（'auto' 或语言名）
  //     target_lang   TEXT NOT NULL         这次用的目标语言
  //     model         TEXT NOT NULL         这次请求体里的 model
  //     src_chars     INTEGER NOT NULL      原文的字符数（统计用，不参与查询）
  //     body_preview  TEXT NOT NULL         译文的前 `BODY_PREVIEW_CHARS` 个字符
  //     body_chars    INTEGER NOT NULL      译文的字符数
  //     pinned        INTEGER NOT NULL      0/1，置顶的条目**不被任何自动裁剪删除**
  //
  //   translate_bodies(id, body)  —— 全文，只在打开某一条时取

  /** 预览取多少个字符。见上面第 1 条：列表页只为渲染两行预览。 */
  var BODY_PREVIEW_CHARS = 200;

  /** 一页多少条。30 行在 860px 宽的卡片里大约两屏，够"扫一眼又不用滚到底"。 */
  var PAGE_SIZE = 30;

  /** 一轮裁剪最多处理多少条。它挡住的是"库很大时一次裁剪扫全表"。 */
  var PRUNE_SCAN_LIMIT = 500;

  /** 未置顶条目最多留多少条。与 `clipboard-history` 的缺省值同一档次。 */
  var MAX_ENTRIES = 800;

  /** 超过这么多天的未置顶条目会被删掉。180 天：一个翻译工具的"回头找"通常远短于此。 */
  var MAX_AGE_DAYS = 180;

  /**
   * 译文总字符数的硬顶（约 4 M 字符）。
   *
   * 条数与体积是两件事：800 条译文如果每条都撞上 `BODY_CHARS_LIMIT`，那是 1600 万
   * 字符。这个数字兜住那种情况 —— 它管的是**库里到底有多少字节**，而条数上限管的是
   * "列表有多长"。
   */
  var MAX_BODY_CHARS = 4 * 1000 * 1000;

  /** 单条译文最多存多少字符。更长时截断并记下来 —— 而不是拒绝这次翻译。 */
  var BODY_CHARS_LIMIT = 20000;

  var SCHEMA = [
    'CREATE TABLE IF NOT EXISTS translate_entries (' +
      'id INTEGER PRIMARY KEY, ' +
      'at INTEGER NOT NULL, ' +
      'source_lang TEXT NOT NULL, ' +
      'target_lang TEXT NOT NULL, ' +
      'model TEXT NOT NULL, ' +
      'src_chars INTEGER NOT NULL DEFAULT 0, ' +
      'body_preview TEXT NOT NULL, ' +
      'body_chars INTEGER NOT NULL DEFAULT 0, ' +
      'pinned INTEGER NOT NULL DEFAULT 0)',
    'CREATE TABLE IF NOT EXISTS translate_bodies (id INTEGER PRIMARY KEY, body TEXT NOT NULL)',
    'CREATE INDEX IF NOT EXISTS translate_entries_recency ON translate_entries (at DESC, id DESC)',
    'CREATE INDEX IF NOT EXISTS translate_entries_pinned ON translate_entries (pinned) WHERE pinned = 1',
  ];

  // ============================================================
  // 小工具（与 background.js 里那几份逐字对应）
  // ============================================================

  function messageOf(error) {
    if (error === null || error === undefined) return '未知错误';
    if (typeof error === 'string') return error;
    if (typeof error.message === 'string' && error.message) return error.message;
    return String(error);
  }

  function isObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  function describeShape(value) {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (Array.isArray(value)) return 'Array(' + value.length + ')';
    var type = typeof value;
    if (type !== 'object') return type;
    var keys = Object.keys(value);
    if (keys.length === 0) return '空对象 {}';
    var shown = keys.slice(0, 12).join(', ');
    return '{ ' + shown + (keys.length > 12 ? ', …（共 ' + keys.length + ' 个键）' : ' }');
  }

  function clipText(text, limit) {
    var value = typeof text === 'string' ? text : String(text === undefined ? '' : text);
    if (value.length <= limit) return value;
    return value.slice(0, limit) + '…（已截断，原本 ' + value.length + ' 字符）';
  }

  function joinUrl(base, path) {
    var trimmed = String(base === undefined || base === null ? '' : base).trim();
    while (trimmed.length > 0 && trimmed.charAt(trimmed.length - 1) === '/') {
      trimmed = trimmed.slice(0, -1);
    }
    return trimmed + '/' + path;
  }

  function formatTime(at) {
    if (typeof at !== 'number' || !isFinite(at) || at <= 0) return '—';
    var date = new Date(at);
    var pad = function (n) {
      return n < 10 ? '0' + n : String(n);
    };
    return (
      pad(date.getFullYear()) +
      '-' +
      pad(date.getMonth() + 1) +
      '-' +
      pad(date.getDate()) +
      ' ' +
      pad(date.getHours()) +
      ':' +
      pad(date.getMinutes())
    );
  }

  /** "多久以前"。用于"上次探测是多久之前" —— 一个绝对时刻不会告诉用户它还算不算数。 */
  function formatAgo(at) {
    if (typeof at !== 'number' || !isFinite(at) || at <= 0) return '';
    var seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
    if (seconds < 60) return seconds + ' 秒前';
    if (seconds < 3600) return Math.round(seconds / 60) + ' 分钟前';
    if (seconds < 86400) return Math.round(seconds / 3600) + ' 小时前';
    return Math.round(seconds / 86400) + ' 天前';
  }

  function textOr(raw, fallback) {
    if (typeof raw !== 'string') return fallback;
    var trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : fallback;
  }

  function normalizeConfig(raw) {
    var source = isObject(raw) ? raw : {};
    return {
      baseUrl: textOr(source[SETTING_IDS.baseUrl], DEFAULT_BASE_URL),
      endpointKind:
        source[SETTING_IDS.endpointKind] === 'completion' ? 'completion' : DEFAULT_ENDPOINT_KIND,
      // 与 `background.js` 的那一份**必须同一条规矩**：宿主的 `settings.all` 只
      // 返回真的写进去过的值（清单里的 `default` 不注入），因此"没设置过"要用
      // 缺省值，而"被清成空串"要**保持为空** —— 后者由后台用一句"去同步模型"
      // 明确报出来，而不是被一个看起来合理的猜测盖住。
      model:
        typeof source[SETTING_IDS.model] === 'string'
          ? source[SETTING_IDS.model].trim()
          : DEFAULT_MODEL,
      promptTemplate: textOr(source[SETTING_IDS.promptTemplate], DEFAULT_PROMPT_TEMPLATE),
      triggerCombo: textOr(source[SETTING_IDS.triggerCombo], DEFAULT_TRIGGER_COMBO),
      sourceLang: textOr(source[SETTING_IDS.sourceLang], DEFAULT_SOURCE_LANG),
      targetLang: textOr(source[SETTING_IDS.targetLang], DEFAULT_TARGET_LANG),
      // 与 `background.js` 同一条回落链：没设置过 → 跟随工作台那一项 → 缺省值。
      // 旧版本只写过 targetLang，因此升级之后划词翻译仍然用用户原来选的语言。
      quickTargetLang: textOr(
        source[SETTING_IDS.quickTargetLang],
        textOr(source[SETTING_IDS.targetLang], DEFAULT_QUICK_TARGET_LANG)
      ),
    };
  }

  // ============================================================
  // HTTP（与 background.js 里那几份同一逻辑）
  // ============================================================

  /**
   * 把一次 `ctx.http.fetch` 的返回归一化成 `{ status, body }`。
   *
   * 沙箱这一侧与后台那一侧一样，拿到的是 `{ status, headers, body }` 这个**纯
   * 对象**（`sandbox-bridge.js` 把 RPC 的返回值原样交出来），而不是类型声明与
   * `pluginBoundary.ts` 里写的那个原生 `Response`（那是 in-process 那一份的包装）。
   * 两种都认，认不出时报结构。
   */
  function readResponse(response) {
    if (response && typeof response.text === 'function' && typeof response.status === 'number') {
      return Promise.resolve(response.text()).then(
        function (text) {
          return { status: response.status, body: typeof text === 'string' ? text : '' };
        },
        function (error) {
          return { status: response.status, body: '', readError: messageOf(error) };
        }
      );
    }
    if (isObject(response) && typeof response.status === 'number') {
      return Promise.resolve({
        status: response.status,
        body: typeof response.body === 'string' ? response.body : '',
      });
    }
    return Promise.reject(new Error('宿主返回的响应形状不认识：' + describeShape(response)));
  }

  function httpError(url, status, body) {
    var lines = ['HTTP ' + status + ' ← ' + url];
    var trimmed = typeof body === 'string' ? body.trim() : '';
    if (trimmed) lines.push(clipText(trimmed, ERROR_BODY_LIMIT));

    if (status === 401 || status === 403) {
      lines.push('（服务端拒绝了这次请求：检查面板里那个 API key 是否与服务端一致）');
    } else if (status === 404 || status === 405) {
      lines.push(
        '（这个地址上没有 OpenAI 兼容接口。llama.cpp 的 server 默认是 ' +
          DEFAULT_BASE_URL +
          '，而单数的 /completion 是它的原生接口、不是 OpenAI 兼容层）'
      );
    }
    return new Error(lines.join('\n'));
  }

  function parseJson(url, body) {
    try {
      return JSON.parse(body);
    } catch (error) {
      throw new Error(
        '这个地址返回的不是 JSON，因此它不是 OpenAI 兼容接口：' +
          url +
          '\n响应开头：' +
          clipText(String(body).trim(), 200)
      );
    }
  }

  /**
   * 发一次请求。
   *
   * 失败里带 `status` 与 `failureCode`，因为**三种失败要用户做的事完全不同**
   * （服务没启动 / 地址不是兼容层 / 服务端有话说），而调用方需要能分辨它们。
   * 传输层的失败带上宿主那句话 —— 它是唯一知道原因的地方。
   */
  function request(config, method, path, payload) {
    var url = joinUrl(config.baseUrl, path);
    var headers = {};
    var hasBody = payload !== undefined && payload !== null;
    if (hasBody) headers['content-type'] = 'application/json';
    if (config.apiKey) {
      // key 只在这里出现一次，且只在请求头里。它绝不进日志、不进状态、不进卡片。
      headers.authorization = 'Bearer ' + config.apiKey;
    }

    var init = { method: method, headers: headers };
    if (hasBody) init.body = JSON.stringify(payload);

    return ctx.http.fetch(url, init).then(
      function (response) {
        return readResponse(response).then(function (result) {
          if (result.status < 200 || result.status >= 300) {
            var error = httpError(url, result.status, result.body);
            error.status = result.status;
            error.failureCode = 'http';
            throw error;
          }
          if (result.readError) {
            throw new Error('读响应体失败：' + result.readError);
          }
          return { status: result.status, json: parseJson(url, result.body) };
        });
      },
      function (error) {
        // 传输层的失败：连接被拒绝（服务没启动）、DNS、超时、被策略拒绝。
        var wrapped = new Error(
          '连不上模型服务 ' +
            url +
            '\n' +
            messageOf(error) +
            '\n（最常见的一种是服务没启动：llama.cpp 的 server 要先用 llama-server -m <模型文件> 跑起来）'
        );
        wrapped.failureCode = 'refused';
        throw wrapped;
      }
    );
  }

  // ============================================================
  // 提示词与请求体（与 background.js 逐字对应）
  // ============================================================

  function buildPrompt(config, text) {
    var template = config.promptTemplate;
    if (typeof template !== 'string' || template.trim() === '') template = DEFAULT_PROMPT_TEMPLATE;
    if (template.indexOf('{text}') === -1) template = DEFAULT_PROMPT_TEMPLATE;

    var source = config.sourceLang === 'auto' || !config.sourceLang ? SOURCE_AUTO_HINT : config.sourceLang;
    return template
      .split('{target}')
      .join(config.targetLang)
      .split('{source}')
      .join(source)
      .split('{text}')
      .join(text);
  }

  function buildRequestBody(config, prompt) {
    if (config.endpointKind === 'completion') {
      return {
        model: config.model,
        prompt: prompt,
        temperature: 0,
        max_tokens: MAX_TOKENS,
        stream: false,
      };
    }
    return {
      model: config.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      max_tokens: MAX_TOKENS,
      stream: false,
    };
  }

  function endpointPath(config) {
    return config.endpointKind === 'completion' ? 'completions' : 'chat/completions';
  }

  function extractTranslation(payload, endpointKind) {
    if (!isObject(payload)) {
      return { ok: false, reason: '响应不是一个对象：' + describeShape(payload) };
    }
    if (!Array.isArray(payload.choices) || payload.choices.length === 0) {
      return { ok: false, reason: '响应里没有 choices：' + describeShape(payload) };
    }
    var first = payload.choices[0];
    if (!isObject(first)) {
      return { ok: false, reason: 'choices[0] 不是对象：' + describeShape(first) };
    }

    var chatText =
      isObject(first.message) && typeof first.message.content === 'string'
        ? first.message.content
        : null;
    var plainText = typeof first.text === 'string' ? first.text : null;

    var preferChat = endpointKind !== 'completion';
    var chosen = preferChat ? chatText : plainText;
    var field = preferChat ? 'choices[0].message.content' : 'choices[0].text';

    if (chosen === null) {
      var other = preferChat ? plainText : chatText;
      if (other !== null) {
        chosen = other;
        field = preferChat ? 'choices[0].text' : 'choices[0].message.content';
      }
    }

    if (chosen === null) {
      return {
        ok: false,
        reason: 'choices[0] 里既没有 text 也没有 message.content；它的字段是 ' + describeShape(first),
      };
    }

    var trimmed = chosen.trim();
    if (trimmed === '') {
      return { ok: false, reason: '服务端回了一个空内容（' + field + ' 是空串）' };
    }
    return { ok: true, text: trimmed, field: field };
  }

  // ============================================================
  // 历史：读写
  // ============================================================

  function dbExec(sql, params) {
    return ctx.db.exec(sql, params);
  }

  function dbQuery(sql, params) {
    return ctx.db.query(sql, params);
  }

  /**
   * 数据库在这个运行位置可用吗。
   *
   * `ctx.db` 需要清单里的 `plugin-data` 权限（与 `ctx.dataDir` 同一项）。缺它时
   * 宿主不会给出 `ctx.db`，而"没有 ctx.db"与"历史是空的"在界面上长得一样 ——
   * 因此这里如实分开报。
   */
  function databaseAvailable() {
    return !!(ctx.db && typeof ctx.db.query === 'function' && typeof ctx.db.exec === 'function');
  }

  /**
   * 建表。DDL 一条一条 `exec`（宿主一次调用只编译一条语句），重跑是幂等的
   * —— 与 `clipboard-history` 的 `ensureSchema` 同一条。
   */
  function ensureSchema() {
    var chain = Promise.resolve();
    SCHEMA.forEach(function (sql) {
      chain = chain.then(function () {
        return dbExec(sql);
      });
    });
    return chain;
  }

  /**
   * LIKE 里的 `%`、`_`、`\` 必须转义。
   *
   * 不转的话，用户搜 `100%` 会命中一切、搜 `a_b` 会命中 `axb` —— 而那种失败看起来
   * 像"搜索不精确"，没有人会想到是通配符。`ESCAPE '\'` 在 SQL 里声明，两者必须成对。
   */
  function escapeLike(value) {
    return String(value).replace(/[\\%_]/g, function (ch) {
      return '\\' + ch;
    });
  }

  function normalizeRow(row) {
    return {
      id: Number(row.id),
      at: Number(row.at) || 0,
      sourceLang: typeof row.source_lang === 'string' ? row.source_lang : '',
      targetLang: typeof row.target_lang === 'string' ? row.target_lang : '',
      model: typeof row.model === 'string' ? row.model : '',
      srcChars: Number(row.src_chars) || 0,
      preview: typeof row.body_preview === 'string' ? row.body_preview : '',
      bodyChars: Number(row.body_chars) || 0,
      pinned: Number(row.pinned) === 1,
    };
  }

  /**
   * 取一页历史。
   *
   * 搜索落在**全文**（`translate_bodies.body`）上，而不是预览 —— 否则只能搜到每条
   * 的前 200 个字符，那是一个"搜不到但确实存在"的陷阱。`JOIN` 而不是"先取一批 id
   * 再 IN"：两个条件（正文命中 + 时间游标）必须一起参与排序与 `LIMIT`，分开做会
   * 先截断再过滤，得到"这一页少几条"。
   *
   * 游标是 `(at, id)` 的严格小于 —— 与 `clipboard-history` 的 `fetchPage` 同一条
   * 设计（`OFFSET 2000` 仍然是让 SQLite 数过前 2000 行）。
   *
   * `pinnedOnly` 是 3.0.0 新增的筛选：历史栏的「置顶」页签用它。它必须参与 WHERE
   * 而不是查完之后在 JS 里过滤 —— 后者会让每页条数少于 `PAGE_SIZE`，分页也会错。
   */
  function fetchPage(query, cursor, pinnedOnly) {
    var search = typeof query === 'string' ? query.trim() : '';
    var anchor = cursor && typeof cursor.at === 'number' ? cursor : null;
    var params = [];

    function bind(value) {
      params.push(value);
      return '?' + params.length;
    }

    var where = [];
    if (search) where.push('b.body LIKE ' + bind('%' + escapeLike(search) + '%') + " ESCAPE '\\'");
    if (pinnedOnly) where.push('e.pinned = 1');
    if (anchor) {
      var atParam = bind(anchor.at);
      var idParam = bind(anchor.id);
      where.push('(e.at < ' + atParam + ' OR (e.at = ' + atParam + ' AND e.id < ' + idParam + '))');
    }

    var sql =
      'SELECT e.id, e.at, e.source_lang, e.target_lang, e.model, e.src_chars, ' +
      'e.body_preview, e.body_chars, e.pinned ' +
      'FROM translate_entries e' +
      (search ? ' JOIN translate_bodies b ON b.id = e.id' : '') +
      (where.length > 0 ? ' WHERE ' + where.join(' AND ') : '') +
      ' ORDER BY e.at DESC, e.id DESC LIMIT ' +
      bind(PAGE_SIZE);

    return dbQuery(sql, params).then(function (rows) {
      return { entries: rows.map(normalizeRow), hasMore: rows.length === PAGE_SIZE };
    });
  }

  function readBody(id) {
    return dbQuery('SELECT body FROM translate_bodies WHERE id = ?1', [id]).then(function (rows) {
      return rows.length > 0 && typeof rows[0].body === 'string' ? rows[0].body : '';
    });
  }

  function countAll() {
    return dbQuery('SELECT COUNT(*) AS total FROM translate_entries').then(function (rows) {
      return rows.length > 0 ? Number(rows[0].total) || 0 : 0;
    });
  }

  function countPinned() {
    return dbQuery('SELECT COUNT(*) AS total FROM translate_entries WHERE pinned = 1').then(
      function (rows) {
        return rows.length > 0 ? Number(rows[0].total) || 0 : 0;
      }
    );
  }

  function bodyCharsTotal() {
    return dbQuery('SELECT COALESCE(SUM(body_chars), 0) AS total FROM translate_entries').then(
      function (rows) {
        return rows.length > 0 ? Number(rows[0].total) || 0 : 0;
      }
    );
  }

  /**
   * 数据库文件现在的字节数：页数 × 页大小。
   *
   * **`PRAGMA` 的读取是被允许的**（宿主拒绝的是"设值"，见 `db.rs` 的保留名单），
   * 因此这不是猜的。它是这个插件能诚实报出来的唯一一个"占用"数字 —— `ctx.db`
   * 没有大小查询接口，而 `ctx.storage` 的用量与数据库无关（两个不同的存储）。
   */
  function databaseBytes() {
    return dbQuery('PRAGMA page_count').then(function (pages) {
      var count = pages.length > 0 ? Number(pages[0].page_count) || 0 : 0;
      return dbQuery('PRAGMA page_size').then(function (sizes) {
        var size = sizes.length > 0 ? Number(sizes[0].page_size) || 0 : 0;
        return count * size;
      });
    });
  }

  function formatBytes(bytes) {
    var value = Number(bytes) || 0;
    if (value < 1024) return value + ' B';
    if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KiB';
    return (value / 1024 / 1024).toFixed(2) + ' MiB';
  }

  /**
   * 删掉一批条目（两张表一起）。
   *
   * 走一次 `ctx.db.transaction`：只删 `translate_entries` 而留下 `translate_bodies`
   * 会把库越撑越大，而残留的正文既看不见、也搜不到（搜索是 JOIN）——那是最坏的一种
   * 隐私残留。反过来的话，留下一条没有正文的条目，点开是空白。
   */
  function deleteEntries(ids) {
    if (!ids || ids.length === 0) return Promise.resolve(0);
    var placeholders = ids
      .map(function (_, index) {
        return '?' + (index + 1);
      })
      .join(', ');
    return ctx.db
      .transaction([
        { sql: 'DELETE FROM translate_entries WHERE id IN (' + placeholders + ')', params: ids },
        { sql: 'DELETE FROM translate_bodies WHERE id IN (' + placeholders + ')', params: ids },
      ])
      .then(function () {
        return ids.length;
      });
  }

  /**
   * 一轮裁剪。
   *
   * ============================================================
   * 保留策略（面板上也写着同一份）
   * ============================================================
   *
   *   1. **超龄**：`at` 早于 `MAX_AGE_DAYS` 天的**未置顶**条目，连正文一起删。
   *   2. **超量**：未置顶条目从最旧的开始删，直到不超过 `MAX_ENTRIES`。
   *      **置顶条目不计入这个数、也不被这两条删** —— 用户按下"置顶"就是在说
   *      "这一条别动"。
   *   3. **体积硬顶**：译文总字符数超过 `MAX_BODY_CHARS` 时，从最旧的开始删
   *      （这一步**会删到置顶条目**，因为总量与库本身的大小是一件事）。删到置顶
   *      条目时会记一条警告 —— 用户能知道自己的置顶为什么没保住。
   *
   * 每一轮都有扫描上限：库很大时一次裁剪不该把所有行拉进 JS。
   *
   * 裁剪失败**不能**让"记下这条"失败 —— 那一刻译文已经在用户眼前了。与
   * `clipboard-history` 的 `prune` 同一条：只记警告。
   */
  function prune() {
    var cutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

    return deleteExpired(cutoff)
      .then(function () {
        return enforceEntryLimit();
      })
      .then(function () {
        return enforceBodyBudget();
      })
      .catch(function (error) {
        console.warn('[translate] 裁剪翻译历史失败（这一次翻译已经完成）：', messageOf(error));
      });
  }

  function deleteExpired(cutoff) {
    return dbQuery(
      'SELECT id FROM translate_entries WHERE pinned = 0 AND at < ?1 ORDER BY at LIMIT ?2',
      [cutoff, PRUNE_SCAN_LIMIT]
    ).then(function (rows) {
      if (rows.length === 0) return 0;
      return deleteEntries(
        rows.map(function (row) {
          return Number(row.id);
        })
      );
    });
  }

  function enforceEntryLimit() {
    return dbQuery('SELECT COUNT(*) AS total FROM translate_entries WHERE pinned = 0').then(
      function (rows) {
        var total = rows.length > 0 ? Number(rows[0].total) || 0 : 0;
        var excess = total - MAX_ENTRIES;
        if (excess <= 0) return 0;

        return dbQuery(
          'SELECT id FROM translate_entries WHERE pinned = 0 ORDER BY at LIMIT ?1',
          [Math.min(excess, PRUNE_SCAN_LIMIT)]
        ).then(function (oldest) {
          if (oldest.length === 0) return 0;
          return deleteEntries(
            oldest.map(function (row) {
              return Number(row.id);
            })
          );
        });
      }
    );
  }

  function enforceBodyBudget() {
    return bodyCharsTotal().then(function (total) {
      if (total <= MAX_BODY_CHARS) return 0;

      // 从最旧的开始，直到把超出部分删够。**包括置顶的** —— 见 `prune` 的第 3 条。
      return dbQuery('SELECT id, body_chars, pinned FROM translate_entries ORDER BY at LIMIT ?1', [
        PRUNE_SCAN_LIMIT,
      ]).then(function (rows) {
        var over = total - MAX_BODY_CHARS;
        var drop = [];
        var droppedPinned = 0;
        for (var i = 0; i < rows.length && over > 0; i += 1) {
          var chars = Number(rows[i].body_chars) || 0;
          drop.push(Number(rows[i].id));
          over -= chars;
          if (Number(rows[i].pinned) === 1) droppedPinned += 1;
        }
        if (drop.length === 0) return 0;
        if (droppedPinned > 0) {
          console.warn('[translate] 译文总量超过硬顶，删掉 ' + droppedPinned + ' 条置顶记录');
        }
        return deleteEntries(drop);
      });
    });
  }

  /**
   * 记一条历史。
   *
   * 全文超过 `BODY_CHARS_LIMIT` 时**截断后照常存**，而不是拒绝这次翻译：用户已经
   * 拿到译文了，而"因为太长所以没记"是一句他无法预料的解释。截断这件事写在
   * `body_chars` 里（它记的是**存下来的**长度）。
   */
  function recordEntry(entry) {
    if (!databaseAvailable()) return Promise.resolve(null);

    var body = typeof entry.body === 'string' ? entry.body : '';
    var stored = body.length > BODY_CHARS_LIMIT ? body.slice(0, BODY_CHARS_LIMIT) : body;
    var preview = stored.slice(0, BODY_PREVIEW_CHARS);

    return dbExec(
      'INSERT INTO translate_entries (at, source_lang, target_lang, model, src_chars, body_preview, body_chars, pinned) ' +
        'VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0)',
      [
        entry.at,
        entry.sourceLang || DEFAULT_SOURCE_LANG,
        entry.targetLang || DEFAULT_TARGET_LANG,
        entry.model || '',
        entry.srcChars || 0,
        preview,
        stored.length,
      ]
    ).then(function (result) {
      var id = result && result.lastInsertRowId ? Number(result.lastInsertRowId) : 0;
      if (id <= 0) {
        // 拿不到 id 就没法把正文挂上去（正文表的主键就是它）。此时宁可**留下一条
        // 只有预览的历史**，也不要写一条指向错误 id 的正文 —— 后者会让某一条别的
        // 记录显示成这一条的译文，而那是"历史串了"这种最难解释的现象。
        return null;
      }
      return dbExec('INSERT INTO translate_bodies (id, body) VALUES (?1, ?2)', [id, stored]).then(
        function () {
          return id;
        }
      );
    });
  }

  // ============================================================
  // 快照：把"后台现在怎么样"读出来
  // ============================================================

  /**
   * 读全部设置。沙箱里 `settings.getAll` 返回 Promise，而且它经一次 RPC ——
   * 因此这里只读一次，之后一切从这份快照里取。
   */
  function readSettings() {
    if (!ctx.settings || !ctx.settings.isAvailable()) {
      return Promise.resolve(normalizeConfig({}));
    }
    return Promise.resolve(ctx.settings.getAll()).then(
      function (all) {
        return normalizeConfig(all);
      },
      function () {
        return normalizeConfig({});
      }
    );
  }

  /**
   * 密钥的存在性。**只用 `keys()`** —— 它永远不返回值，因此这一次调用不会把
   * API key 读进内存、更不会读进 DOM。
   *
   * `get` 的失败（密文解不开）在 `keys` 上看不出来（键还在），因此这里只回答
   * "有没有存过"。真正的读取失败会在后台那一次翻译里以原话出现在卡片上。
   */
  function readKeyInfo() {
    if (!ctx.secrets || typeof ctx.secrets.keys !== 'function' || !ctx.secrets.isAvailable()) {
      return Promise.resolve({ known: true, present: false, error: '这个插件没有 secrets 权限' });
    }
    return ctx.secrets.keys().then(
      function (keys) {
        var list = Array.isArray(keys) ? keys : [];
        return { known: true, present: list.indexOf(SECRET_API_KEY) !== -1, error: '' };
      },
      function (error) {
        return { known: true, present: false, error: messageOf(error) };
      }
    );
  }

  function readStored(key, fallback) {
    if (!ctx.storage) return Promise.resolve(fallback);
    return ctx.storage.get(key, fallback).then(
      function (value) {
        return value === undefined || value === null ? fallback : value;
      },
      function () {
        return fallback;
      }
    );
  }

  function loadSnapshot() {
    return Promise.all([
      readSettings(),
      readKeyInfo(),
      readStored(STATUS_KEY, null),
      readStored(CACHE_KEY, null),
    ]).then(function (values) {
      return {
        config: values[0],
        keyInfo: values[1],
        status: isObject(values[2]) ? values[2] : null,
        cache: isObject(values[3]) ? values[3] : null,
      };
    });
  }

  // ============================================================
  // 组合键：把一次按键变成宿主认得的那种字符串
  // ============================================================
  //
  // ============================================================
  // 这个语法**已经有两份实现**，这里是第三份 —— 因此必须写清楚它在哪
  // ============================================================
  //
  //   1. `src/services/shortcutRegistry.ts` 的 `parseCombo` / `normalizeCombo`
  //      —— 语法的**起源**，宿主界面自己的快捷键表用它做冲突判定；
  //   2. `src-tauri/src/modules/plugins/hotkey.rs` 的 `parse_combo` /
  //      `normalize_combo` / `accelerator` —— 真正 `RegisterHotKey` 的那一侧。
  //      `check:plugin-runtime` 把 (1) 与 (2) 钉在一次断言里（共享语料
  //      `GRAMMAR_CASES`，两边逐条重算）。
  //
  // **这一份（面板里的录制器）排在第三条上，而且是唯一一份无法被门禁钉住的** ——
  // 插件是一个单文件 IIFE，不许 import，因此它抄不到上面任何一份。只能靠：
  //
  //   * 只**产出**符合语法的字符串，不去解析用户的自由输入（上一版那个输入框
  //     正是"让用户去写"才把这件事变得不可控：`Mod+K`、`ctrl + k`、
  //     `mod+shift+alt+k` 都会原样落进设置，而后台那一侧认不认只能等一分钟）；
  //   * 产出之后**交给宿主去判**：`ctx.hotkey.register` 返回的就是宿主按 (2)
  //     规范化之后的值，后台注册的正是它（见下面 `registerCombo` 的注释）。
  //
  // 规矩与那两份完全一致：
  //   · 全部小写；
  //   · 修饰符别名 `mod`/`ctrl`/`cmd`/`meta` → `mod`、`shift`、`alt`/`option` → `alt`；
  //   · 顺序固定 `mod+shift+alt+<主键>`（`shift+mod+tab` 与 `mod+shift+tab` 必须得到
  //     同一个字符串，否则"冲突"会有两种表示，同一个组合会被当成两条）；
  //   · **恰好一个主键**。

  /** `KeyboardEvent.key` 之外的那些键名 —— 按 `named_virtual_key` 认的那一批抄。 */
  var HOTKEY_NAMED_KEYS = {
    backspace: 'backspace',
    tab: 'tab',
    enter: 'enter',
    escape: 'escape',
    ' ': 'space',
    spacebar: 'space',
    pageup: 'pageup',
    pagedown: 'pagedown',
    end: 'end',
    home: 'home',
    arrowleft: 'left',
    arrowup: 'up',
    arrowright: 'right',
    arrowdown: 'down',
    insert: 'insert',
    delete: 'delete',
  };

  /**
   * 一次按键的 `event.key` → 宿主认的主键名；认不出来时返回 `''`。
   *
   * **认不出来就不产出**：把它当成别的键会让用户"按下了 A、绑定却变成了 B"，
   * 而那种错比一句「这个键不支持」难查得多（与 `named_virtual_key` 一条取舍）。
   */
  function hotkeyKeyName(key) {
    var raw = String(key || '');
    var lower = raw.toLowerCase();

    if (lower.length === 1 && ((lower >= 'a' && lower <= 'z') || (lower >= '0' && lower <= '9'))) {
      return lower;
    }
    // F1..F24：`f` 后面必须**全是数字**（`f` 与 `f24x` 不是功能键）。
    if (/^f\d{1,2}$/.test(lower)) {
      var number = Number(lower.slice(1));
      if (number >= 1 && number <= 24) return lower;
      return '';
    }
    return HOTKEY_NAMED_KEYS[lower] || '';
  }

  /** 主键是不是**可以单独占用**的功能键 —— 宿主 `accel` 的 `key_may_be_bare` 抄一份。 */
  function isFunctionKey(name) {
    return /^f([1-9]|1\d|2[0-4])$/.test(String(name || ''));
  }

  /**
   * 把一次 keydown 变成规范化之后的组合键；不构成一个可以注册的组合时返回 `null`。
   *
   * 判据与宿主 `accelerator` 的两条拒绝**逐条对应**：
   *   · 认不出主键 → `null`（宿主会说"没有对应的虚拟键码"）；
   *   · 一个修饰符都没有、而主键又不是 F1..F24 → `null`（宿主那句话是这个面板
   *     上最难自己想到的一条，因此界面必须**在保存之前**就把它说出来）。
   */
  function comboFromEvent(event) {
    var key = hotkeyKeyName(event.key);
    if (key === '') return null;

    var parts = [];
    if (event.ctrlKey || event.metaKey) parts.push('mod');
    if (event.shiftKey) parts.push('shift');
    if (event.altKey) parts.push('alt');

    if (parts.length === 0 && !isFunctionKey(key)) return null;
    parts.push(key);
    return parts.join('+');
  }

  /** 一次 keydown 是不是"只按下了修饰键"（这时录制必须继续等，不能就此结束）。 */
  function isLoneModifierKey(event) {
    return ['control', 'shift', 'alt', 'meta', 'os'].indexOf(String(event.key || '').toLowerCase()) !== -1;
  }

  /**
   * 键盘事件 → 给用户看的一行预览（`Ctrl+Shift+Tab` 这种）。
   *
   * 它**只影响显示**：真正落盘的永远是 `comboFromEvent` 的产物（见上面那一节）。
   * 不顺手从预览里拼字符串，是因为"给人看的写法"与"宿主认的写法"是两件事，
   * 混用它们正是 `Mod+K` 那类值能进设置的原因。
   */
  function comboPreview(event) {
    var key = hotkeyKeyName(event.key);
    var parts = [];
    if (event.ctrlKey || event.metaKey) parts.push('Ctrl');
    if (event.shiftKey) parts.push('Shift');
    if (event.altKey) parts.push('Alt');
    if (key === '') parts.push('…');
    else if (key === 'space') parts.push('Space');
    else if (key.length === 1) parts.push(key.toUpperCase());
    else if (isFunctionKey(key)) parts.push(key.toUpperCase());
    else parts.push(key.charAt(0).toUpperCase() + key.slice(1));
    return parts.join(' + ');
  }

  /**
   * 规范化一个**已经符合语法**的组合键字符串（`[mod+][shift+][alt+]<主键>`）。
   *
   * 存在理由只有一个：面板上的值可能来自别处（上一版那个自由输入框留下的旧值、
   * 或用户在设置页里手写的值），而渲染与比较都希望拿到稳定形态。
   *
   * 它**只重排与改写修饰符别名**，不认识的东西原样留着 —— 这不是一个校验器。
   * 校验发生在两处，都比这里严格：录制时由 `comboFromEvent` 挡掉不能注册的组合，
   * 落盘之后由宿主的 `accelerator()` 挡掉其余（它的错误信息是权威的）。
   */
  function canonicalCombo(combo) {
    var text = String(combo || '').trim();
    if (text === '') return '';

    var mod = false;
    var shift = false;
    var alt = false;
    var key = '';

    text
      .toLowerCase()
      .split('+')
      .forEach(function (part) {
        var name = part.trim();
        if (name === '') return;
        if (name === 'mod' || name === 'ctrl' || name === 'cmd' || name === 'meta') mod = true;
        else if (name === 'shift') shift = true;
        else if (name === 'alt' || name === 'option') alt = true;
        else if (key === '') key = name;
      });

    if (key === '') return '';

    var prefix = [];
    if (mod) prefix.push('mod');
    if (shift) prefix.push('shift');
    if (alt) prefix.push('alt');
    prefix.push(key);
    return prefix.join('+');
  }

  /**
   * 把规范化之后的组合键翻成**给人看的写法**（`mod+q` → `Ctrl + Q`）。
   *
   * 只用于显示。落盘与比较永远用 `canonicalCombo` 的结果 —— "给人看的写法"与
   * "宿主认的写法"是两件事，混用它们正是上一版 `Mod+K` 那类值能进设置的原因。
   */
  function friendlyCombo(combo) {
    var canonical = canonicalCombo(combo);
    if (canonical === '') return '';
    var mac = !!(window.Modulith && window.Modulith.platform === 'macos');
    return canonical
      .split('+')
      .map(function (part) {
        if (part === 'mod') return mac ? 'Cmd' : 'Ctrl';
        if (part === 'shift') return 'Shift';
        if (part === 'alt') return mac ? 'Option' : 'Alt';
        if (part === 'space') return 'Space';
        if (part.length === 1) return part.toUpperCase();
        return part.charAt(0).toUpperCase() + part.slice(1);
      })
      .join(' + ');
  }

  /** 写一个设置项。失败必须**说出来** —— 静默丢掉一次写入是这里最坏的一种。 */
  function saveSetting(id, value) {
    if (!ctx.settings || typeof ctx.settings.set !== 'function') {
      return Promise.reject(new Error('这个运行位置没有 ctx.settings.set'));
    }
    return Promise.resolve(ctx.settings.set(id, value));
  }

  // ============================================================
  // 模型同步
  // ============================================================

  /**
   * `GET {base}/models`，把服务端**实际加载**的模型读回来。
   *
   * ============================================================
   * 为什么要有这一件事
   * ============================================================
   *
   * `model` 这个字段必须与服务端加载的那一个逐字一致，否则请求会被拒 —— 而
   * llama.cpp 的 server 默认加载的是**文件名**（`Hy MT2 1.8B Q4_K_M.gguf` 这种），
   * 让人手打一个包含空格、点号和一个 1.8B 字样的名字是不合理的。因此让服务端
   * 自己报：这是它有的唯一一份权威清单。
   *
   * ============================================================
   * 三种失败必须分开，因为它们要用户做的事完全不同
   * ============================================================
   *
   *   * `refused` —— 连不上：**服务没启动**。去把 `llama-server` 跑起来；
   *   * `not-openai`（404 / 405）—— 服务在，但**这个地址不是 OpenAI 兼容层**。
   *     去改 base URL（多半是漏了结尾的 `/v1`，或者填成了单数的 `/completion`）；
   *   * `empty` —— 服务在、接口对，但它**一个模型都没加载**。去用 `-m` 指一个
   *     gguf，或者在服务端加载一个。
   *
   * 把这三件事混成一句"同步失败"会让用户把时间花在错的那一件上。
   */
  function syncModels(config) {
    var attemptedAt = Date.now();
    return request(config, 'GET', 'models', undefined).then(
      function (result) {
        var payload = result.json;
        var raw = payload && Array.isArray(payload.data) ? payload.data : null;
        var ids = [];
        if (raw) {
          for (var i = 0; i < raw.length; i++) {
            var entry = raw[i];
            // 只认字符串 id，其余（对象、null、数字）一律跳过 —— 它们会以原样
            // 显示在界面上，而显示一个 "[object Object]" 对用户没有任何用。
            if (entry && typeof entry.id === 'string' && entry.id.trim()) ids.push(entry.id.trim());
          }
        }
        if (ids.length === 0) {
          return {
            at: attemptedAt,
            base: config.baseUrl,
            ok: false,
            code: 'empty',
            error:
              '服务在跑，接口也对，但它没有加载任何模型。\n' +
              '（响应里的 data 是 ' +
              describeShape(payload && payload.data) +
              '）\n' +
              '去服务端那一边用 -m 指一个 gguf 文件，或者看它的启动日志。',
            models: [],
          };
        }
        return {
          at: attemptedAt,
          base: config.baseUrl,
          ok: true,
          code: 'ok',
          error: '',
          models: ids,
        };
      },
      function (error) {
        var code = error && error.failureCode ? error.failureCode : 'http';
        if (code === 'refused') {
          return {
            at: attemptedAt,
            base: config.baseUrl,
            ok: false,
            code: 'refused',
            error:
              messageOf(error) +
              '\n\n这是"服务没在跑"的样子。llama.cpp 的 server 要先用 ' +
              'llama-server -m <模型文件> --port 5566 这一类命令跑起来。',
            models: [],
          };
        }
        if (error && (error.status === 404 || error.status === 405)) {
          return {
            at: attemptedAt,
            base: config.baseUrl,
            ok: false,
            code: 'not-openai',
            error:
              messageOf(error) +
              '\n\n这个地址上没有 OpenAI 兼容层。检查 base URL：它应当是 ' +
              'http://主机:端口/v1 这种形状。',
            models: [],
          };
        }
        return {
          at: attemptedAt,
          base: config.baseUrl,
          ok: false,
          code: error && error.status === 401 ? 'auth' : 'http',
          error: messageOf(error),
          models: [],
        };
      }
    );
  }

  // ============================================================
  // 面板
  // ============================================================
  //
  // ============================================================
  // 这一版的结构：一个工具，而不是一叠配置卡片
  // ============================================================
  //
  // 上一版是单列滚动：标题 → 工作台 → 历史 → 统计 → 模型与端点 → 热键（默认收起）。
  // 每一节都带着一段"为什么这么设计"的长说明，整页读下来像一份文档，而不是一个工具。
  //
  // 这一版改成两栏 + 一个设置抽屉：
  //
  //   * **左栏**：翻译工作台。语言行、输入、动作、译文 —— 一眼能看全；
  //   * **右栏**：历史。搜索、筛选、行内动作，自己滚动；
  //   * **抽屉**：连接、提示词、划词、数据四页。配置与解释都在这里，主流程上只剩
  //     用户此刻要做的那件事。
  //
  // 三条与上一版不同的取舍：
  //
  //   1. **不做浮层提示。** "已保存""已复制""已刷新"这类回执改成按钮内的短状态
  //      （复制 → 已复制），错误则留在**它发生的那一栏**里。一个每点一下都弹一次
  //      的 toast，最后会被用户当作噪声无视，连真正的错误也一起无视掉。
  //   2. **不写长说明。** 每条说明压到一行，解释性的长文交给 README。界面上只留
  //      "这一项是干什么的"与"它失败时怎么办"。
  //   3. **工作台与划词各有自己的目标语言。** 见 `quickTargetLang`：改工作台的语言
  //      不再改动划词的语言（这是上一版最影响使用的一处耦合）。

  // ============================================================
  // 图标：16px 手写 SVG，与宿主的线宽同一档
  // ============================================================

  function svgIcon(children, options) {
    var opts = options || {};
    return h(
      'svg',
      {
        className: 'tr-icon' + (opts.className ? ' ' + opts.className : ''),
        width: opts.size || 16,
        height: opts.size || 16,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: opts.strokeWidth || 1.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
      },
      children
    );
  }

  function IconSettings() {
    return svgIcon([
      h('path', { key: 'a', d: 'M2 4.4h12' }),
      h('circle', { key: 'b', cx: 6, cy: 4.4, r: 1.7 }),
      h('path', { key: 'c', d: 'M2 11.6h12' }),
      h('circle', { key: 'd', cx: 10.4, cy: 11.6, r: 1.7 }),
    ]);
  }

  function IconSearch() {
    return svgIcon([
      h('circle', { key: 'a', cx: 7, cy: 7, r: 4.1 }),
      h('path', { key: 'b', d: 'M10.2 10.2 14 14' }),
    ]);
  }

  function IconSwap() {
    return svgIcon([
      h('path', { key: 'a', d: 'M2.6 5.4h9.2' }),
      h('path', { key: 'b', d: 'M9.4 3.2 11.6 5.4 9.4 7.6' }),
      h('path', { key: 'c', d: 'M13.4 10.6H4.2' }),
      h('path', { key: 'd', d: 'M6.6 8.4 4.4 10.6 6.6 12.8' }),
    ]);
  }

  function IconClose() {
    return svgIcon([
      h('path', { key: 'a', d: 'M4 4l8 8' }),
      h('path', { key: 'b', d: 'M12 4l-8 8' }),
    ]);
  }

  function IconCopy() {
    return svgIcon([
      h('rect', { key: 'a', x: 5.4, y: 5.4, width: 8, height: 8, rx: 1.6 }),
      h('path', { key: 'b', d: 'M10.6 5.4V4A1.5 1.5 0 0 0 9.1 2.5H4A1.5 1.5 0 0 0 2.5 4v5.1A1.5 1.5 0 0 0 4 10.6h1.4' }),
    ]);
  }

  function IconCheck() {
    return svgIcon([h('path', { key: 'a', d: 'M3 8.4 6.1 11.5 13 4.8' })]);
  }

  function IconPin() {
    return svgIcon([h('path', { key: 'a', d: 'M4.6 2.6h6.8v10.8L8 10.9l-3.4 2.5z' })]);
  }

  function IconTrash() {
    return svgIcon([
      h('path', { key: 'a', d: 'M2.8 4.4h10.4' }),
      h('path', { key: 'b', d: 'M6 4.4V3h4v1.4' }),
      h('path', { key: 'c', d: 'M4.4 4.4l.6 9h6l.6-9' }),
      h('path', { key: 'd', d: 'M6.6 7.2v4' }),
      h('path', { key: 'e', d: 'M9.4 7.2v4' }),
    ]);
  }

  function IconRefresh() {
    return svgIcon([
      h('path', { key: 'a', d: 'M13.2 8a5.2 5.2 0 1 1-1.7-3.9' }),
      h('path', { key: 'b', d: 'M13.2 2.6v3h-3' }),
    ]);
  }

  function IconArrow() {
    return svgIcon([
      h('path', { key: 'a', d: 'M3 8h9.4' }),
      h('path', { key: 'b', d: 'M9.6 5.2 12.4 8l-2.8 2.8' }),
    ], { size: 12 });
  }

  function IconEmpty() {
    return h(
      'svg',
      {
        className: 'tr-empty-art',
        width: 52,
        height: 52,
        viewBox: '0 0 52 52',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
      h('path', {
        d: 'M11 13h30a4.5 4.5 0 0 1 4.5 4.5v14A4.5 4.5 0 0 1 41 36H25l-9.5 7.5V36H11a4.5 4.5 0 0 1-4.5-4.5v-14A4.5 4.5 0 0 1 11 13z',
      }),
      h('path', { d: 'M15 21.5h18' }),
      h('path', { d: 'M15 27.5h11' })
    );
  }

  function IconSpinner() {
    return h('span', { className: 'tr-spinner', 'aria-hidden': 'true' });
  }

  // ============================================================
  // 小工具
  // ============================================================

  function formatCount(value) {
    var number = Math.round(Number(value) || 0);
    return String(number).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function formatDuration(ms) {
    if (typeof ms !== 'number' || !isFinite(ms) || ms <= 0) return '';
    return ms < 1000 ? Math.round(ms) + ' ms' : (ms / 1000).toFixed(1) + ' s';
  }

  /** 顶栏那个端点的短标签。长解释放在 `title` 里，不占版面。 */
  function endpointSummary(cache) {
    if (!cache) return { text: '未连接', tone: 'off', detail: '还没有探测过端点' };
    var when = '上次探测 ' + formatTime(cache.at) + '（' + formatAgo(cache.at) + '）';
    if (cache.ok) {
      var count = Array.isArray(cache.models) ? cache.models.length : 0;
      return {
        text: count > 1 ? count + ' 个模型' : '已连接',
        tone: 'ok',
        detail: when + '，读到 ' + count + ' 个模型',
      };
    }
    var text =
      cache.code === 'refused'
        ? '服务未启动'
        : cache.code === 'not-openai'
          ? '地址不对'
          : cache.code === 'empty'
            ? '没有模型'
            : cache.code === 'auth'
              ? '需要密钥'
              : '连接失败';
    return { text: text, tone: 'error', detail: when + (cache.error ? '\n' + cache.error : '') };
  }

  function Field(props) {
    return h(
      'div',
      { className: 'tr-field' },
      h('label', { className: 'tr-field-label', htmlFor: props.htmlFor }, props.label),
      props.hint ? h('p', { className: 'tr-field-hint' }, props.hint) : null,
      props.children
    );
  }

  function StatCell(props) {
    return h(
      'div',
      { className: 'tr-stat' },
      h('div', { className: 'tr-stat-value' }, props.value),
      h('div', { className: 'tr-stat-label' }, props.label)
    );
  }

  // ============================================================
  // 录制式组合键控件
  // ============================================================
  //
  // "按一下"而不是"打一行字"：上一版的自由输入框让用户去猜语法，而写错的代价是
  // 一分钟之后一次静默的注册失败。控件自己把按键变成合法字符串，并在不合法时就地
  // 说明原因（把宿主那句话抄过来，而不是等注册失败）。
  function HotkeyRecorder(props) {
    var recordingState = React.useState(false);
    var recording = recordingState[0];
    var setRecording = recordingState[1];

    var previewState = React.useState('');
    var preview = previewState[0];
    var setPreview = previewState[1];

    var messageState = React.useState('');
    var message = messageState[0];
    var setMessage = messageState[1];

    var bound = canonicalCombo(props.combo);
    var finishedRef = React.useRef(false);
    var sessionRef = React.useRef(0);

    function stopRecording() {
      setRecording(false);
      setPreview('');
    }

    function begin() {
      sessionRef.current += 1;
      finishedRef.current = false;
      setMessage('');
      setPreview('');
      setRecording(true);
    }

    /** Escape 取消：原值保留，**不弹提示** —— 控件回到静止态本身就是回执。 */
    function cancel() {
      sessionRef.current += 1;
      finishedRef.current = true;
      stopRecording();
      setMessage('');
    }

    function onKeyDown(event) {
      if (!recording || finishedRef.current) return;

      event.preventDefault();
      event.stopPropagation();

      if (isLoneModifierKey(event)) {
        setPreview(comboPreview(event));
        return;
      }

      if (event.key === 'Escape' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
        cancel();
        return;
      }

      var key = hotkeyKeyName(event.key);
      if (key === '') {
        setPreview(comboPreview(event));
        setMessage('这个键不能用作组合键。可用：字母 / 数字、F1..F24，以及 Backspace、Tab、Enter、Escape、Space、PageUp、PageDown、Home、End、方向键、Insert、Delete。');
        return;
      }

      var combo = comboFromEvent(event);
      if (combo === null) {
        setPreview(comboPreview(event));
        setMessage('单个普通键不能做全局热键 —— 它会从整台机器的所有程序里被拿走。请加上 Ctrl / Alt / Shift，或改用 F1..F24。');
        return;
      }

      finishedRef.current = true;
      setPreview(comboPreview(event));
      setMessage('正在保存 ' + friendlyCombo(combo) + '…');

      var session = sessionRef.current;
      var outcome = props.onCommit(combo);
      if (!outcome || typeof outcome.then !== 'function') {
        finishSuccess(session);
        return;
      }
      outcome.then(
        function () {
          finishSuccess(session);
        },
        function () {
          if (sessionRef.current !== session) return;
          finishedRef.current = false;
          setMessage('没有保存。请再按一个组合键，或者按 Esc 取消。');
        }
      );
    }

    function finishSuccess(session) {
      if (sessionRef.current !== session) return;
      finishedRef.current = true;
      stopRecording();
      setMessage('');
    }

    var label = bound === '' ? '未设置' : friendlyCombo(bound);
    var shown = recording ? '请按下组合键…' : label;

    return h(
      'div',
      { className: 'tr-recorder-row' },
      h(
        'button',
        {
          type: 'button',
          className: 'tr-recorder' + (recording ? ' tr-recorder-on' : ''),
          onBlur: function () {
            if (recording) cancel();
          },
          onClick: function () {
            if (recording) cancel();
            else begin();
          },
          onKeyDown: onKeyDown,
          'aria-label': '触发组合键：' + label,
          'aria-pressed': recording ? 'true' : 'false',
          disabled: props.disabled === true,
        },
        h(
          'span',
          { className: 'tr-recorder-value' + (bound === '' && !recording ? ' tr-recorder-empty' : '') },
          shown
        ),
        recording
          ? h('span', { className: 'tr-recorder-wait' }, preview ? preview : '等待按键…')
          : h('span', { className: 'tr-recorder-hint' }, '点击后按下组合键')
      ),
      h(
        'button',
        {
          type: 'button',
          className: 'tr-btn tr-btn-ghost tr-btn-sm',
          disabled: props.disabled === true || bound === '',
          onClick: function () {
            setMessage('');
            stopRecording();
            props.onClear();
          },
        },
        '清除'
      ),
      recording || message
        ? h(
            'p',
            { className: 'tr-recorder-msg' + (message ? ' tr-recorder-msg-warn' : '') },
            message || '按住 Ctrl / Alt / Shift 中的至少一个再按主键；只按 F1..F24 也可以。Esc 取消。'
          )
        : null
    );
  }

  // ============================================================
  // 面板主体
  // ============================================================

  function TranslatePanel() {
    // ---------- 快照与草稿 ----------
    var snapshotState = React.useState(null);
    var snapshot = snapshotState[0];
    var setSnapshot = snapshotState[1];

    var draftState = React.useState(null);
    var draft = draftState[0];
    var setDraft = draftState[1];

    // ---------- 工作台 ----------
    var inputState = React.useState('');
    var input = inputState[0];
    var setInput = inputState[1];

    var resultState = React.useState(null);
    var result = resultState[0];
    var setResult = resultState[1];

    var busyState = React.useState(false);
    var busy = busyState[0];
    var setBusy = busyState[1];

    var noticeState = React.useState(null);
    var notice = noticeState[0];
    var setNotice = noticeState[1];

    // ---------- 抽屉 ----------
    var drawerOpenState = React.useState(false);
    var drawerOpen = drawerOpenState[0];
    var setDrawerOpen = drawerOpenState[1];

    var drawerTabState = React.useState('connection');
    var drawerTab = drawerTabState[0];
    var setDrawerTab = drawerTabState[1];

    var settingsErrorState = React.useState('');
    var settingsError = settingsErrorState[0];
    var setSettingsError = settingsErrorState[1];

    var syncingState = React.useState(false);
    var syncing = syncingState[0];
    var setSyncing = syncingState[1];

    var keyDraftState = React.useState('');
    var keyDraft = keyDraftState[0];
    var setKeyDraft = keyDraftState[1];

    var keyBusyState = React.useState(false);
    var keyBusy = keyBusyState[0];
    var setKeyBusy = keyBusyState[1];

    // ---------- 历史 ----------
    var entriesState = React.useState([]);
    var entries = entriesState[0];
    var setEntries = entriesState[1];

    var cursorState = React.useState(null);
    var cursor = cursorState[0];
    var setCursor = cursorState[1];

    var hasMoreState = React.useState(false);
    var hasMore = hasMoreState[0];
    var setHasMore = hasMoreState[1];

    var searchState = React.useState('');
    var search = searchState[0];
    var setSearch = searchState[1];

    var filterState = React.useState('all');
    var filter = filterState[0];
    var setFilter = filterState[1];

    var historyBusyState = React.useState(false);
    var historyBusy = historyBusyState[0];
    var setHistoryBusy = historyBusyState[1];

    var dbErrorState = React.useState('');
    var dbError = dbErrorState[0];
    var setDbError = dbErrorState[1];

    var statsState = React.useState(null);
    var stats = statsState[0];
    var setStats = statsState[1];

    var selectedIdState = React.useState('');
    var selectedId = selectedIdState[0];
    var setSelectedId = selectedIdState[1];

    // ---------- 轻微交互状态 ----------
    var copiedState = React.useState('');
    var copied = copiedState[0];
    var setCopied = copiedState[1];

    var confirmState = React.useState('');
    var confirm = confirmState[0];
    var setConfirm = confirmState[1];

    var aliveRef = React.useRef(true);
    var copiedTimer = React.useRef(null);
    var confirmTimer = React.useRef(null);
    var historyMounted = React.useRef(false);
    // 最新一次生效的查询条件。`reloadHistory` 会在"切回本模块"这类由较早渲染
    // 产生的闭包里被调用，直接用闭包里的 search / filter 会读到旧值。
    var searchRef = React.useRef(search);
    var filterRef = React.useRef(filter);

    React.useEffect(function () {
      return function () {
        aliveRef.current = false;
        if (copiedTimer.current) clearTimeout(copiedTimer.current);
        if (confirmTimer.current) clearTimeout(confirmTimer.current);
      };
    }, []);

    var config = snapshot ? snapshot.config : normalizeConfig({});
    var view = draft === null ? config : draft;

    var status = snapshot ? snapshot.status : null;
    var cache = snapshot ? snapshot.cache : null;
    var keyInfo = snapshot ? snapshot.keyInfo : { known: true, present: false, error: '' };

    var hotkeyAvailable = !!(ctx.hotkey && ctx.hotkey.isAvailable && ctx.hotkey.isAvailable());
    var selectionAvailable = !!(
      ctx.selection &&
      ctx.selection.isAvailable &&
      ctx.selection.isAvailable()
    );
    var clipboardAvailable = !!(ctx.clipboard && typeof ctx.clipboard.writeText === 'function');
    var modelMissing = !String(view.model || '').trim();

    var effectiveSource = SOURCE_LANGS.some(function (item) {
      return item.value === view.sourceLang;
    })
      ? view.sourceLang
      : DEFAULT_SOURCE_LANG;
    var effectiveTarget = TARGET_LANGS.indexOf(view.targetLang) === -1 ? TARGET_LANGS[0] : view.targetLang;
    var effectiveQuickTarget =
      TARGET_LANGS.indexOf(view.quickTargetLang) === -1 ? DEFAULT_QUICK_TARGET_LANG : view.quickTargetLang;

    var hotkeyInfo = describeHotkey(status, hotkeyAvailable, selectionAvailable);
    var endpointInfo = endpointSummary(cache);

    // ----------------------------------------------------------
    // 快照
    // ----------------------------------------------------------

    function refresh() {
      return loadSnapshot().then(function (next) {
        if (!aliveRef.current) return next;
        setSnapshot(next);
        setDraft(function (current) {
          // 用户正在改的那份草稿**不覆盖**：一次后台刷新把输入抹掉，是最难复现的
          // "输入丢了"。
          return current === null ? next.config : current;
        });
        return next;
      });
    }

    function refreshStats() {
      return Promise.all([countAll(), countPinned(), bodyCharsTotal(), databaseBytes()]).then(
        function (values) {
          if (!aliveRef.current) return;
          setStats({
            entries: values[0],
            pinned: values[1],
            bodyChars: values[2],
            dbBytes: values[3],
          });
        },
        function (error) {
          if (!aliveRef.current) return;
          setDbError('读历史统计失败：' + messageOf(error));
        }
      );
    }

    // ----------------------------------------------------------
    // 历史
    // ----------------------------------------------------------

    function reloadHistory(term, filterValue) {
      if (!databaseAvailable()) {
        setDbError('这个运行位置没有 ctx.db（清单里缺 plugin-data 权限）');
        return Promise.resolve();
      }
      var query = term === undefined ? searchRef.current : term;
      var mode = filterValue === undefined ? filterRef.current : filterValue;
      setHistoryBusy(true);
      return fetchPage(query, null, mode === 'pinned')
        .then(function (page) {
          if (!aliveRef.current) return null;
          setEntries(page.entries);
          setCursor(page.entries.length > 0 ? page.entries[page.entries.length - 1] : null);
          setHasMore(page.hasMore);
          return refreshStats();
        })
        .catch(function (error) {
          if (!aliveRef.current) return;
          setDbError('读历史失败：' + messageOf(error));
        })
        .then(function () {
          if (aliveRef.current) setHistoryBusy(false);
        });
    }

    // 首次装载：建表 → 裁一次 → 读第一页。
    React.useEffect(function () {
      if (!databaseAvailable()) {
        setDbError('这个运行位置没有 ctx.db（清单里缺 plugin-data 权限）');
        return;
      }
      ensureSchema()
        .then(function () {
          return prune();
        })
        .then(function () {
          return reloadHistory('', 'all');
        })
        .catch(function (error) {
          if (aliveRef.current) setDbError('翻译历史不可用：' + messageOf(error));
        });
    }, []);

    React.useEffect(function () {
      refresh();
    }, []);

    /**
     * 搜索与筛选：输入停下 300ms 后再查。
     *
     * 首轮**跳过** —— 初次装载由上面那个 effect 负责（它要先建表、裁一次）。少了
     * 这个跳过，挂载瞬间会并发两次查询，而其中一次可能早于建表。
     */
    React.useEffect(
      function () {
        searchRef.current = search;
      },
      [search]
    );

    React.useEffect(
      function () {
        filterRef.current = filter;
      },
      [filter]
    );

    React.useEffect(
      function () {
        if (!historyMounted.current) {
          historyMounted.current = true;
          return;
        }
        var timer = setTimeout(function () {
          reloadHistory(search, filter);
        }, 300);
        return function () {
          clearTimeout(timer);
        };
      },
      [search, filter]
    );

    /**
     * 模块重新可见时刷新一次。没有推送通道，切回来是唯一能发现后台状态变化的机会。
     */
    var active = Modulith.useModuleActive();
    React.useEffect(
      function () {
        if (!active) return undefined;
        refresh();
        reloadHistory();
        return undefined;
      },
      [active]
    );

    // ----------------------------------------------------------
    // 设置
    // ----------------------------------------------------------

    function editDraft(id, value) {
      setDraft(function (current) {
        var base = current === null ? config : current;
        var next = {};
        for (var key in base) {
          if (Object.prototype.hasOwnProperty.call(base, key)) next[key] = base[key];
        }
        next[id] = value;
        return next;
      });
    }

    function saveSettingValue(id, value) {
      setSettingsError('');
      return saveSetting(id, value)
        .then(function () {
          return refresh();
        })
        .catch(function (error) {
          if (!aliveRef.current) return;
          setSettingsError('设置没有保存：' + messageOf(error));
        });
    }

    function commitField(id) {
      return saveSettingValue(id, view[id]);
    }

    /** 地址与模型名去掉首尾空白再落盘（从别处复制时常常带着空格）。 */
    function commitTrimmed(id) {
      var value = String(view[id] === undefined || view[id] === null ? '' : view[id]).trim();
      if (value !== view[id]) editDraft(id, value);
      return saveSettingValue(id, value);
    }

    function setQuickTarget(value) {
      editDraft(SETTING_IDS.quickTargetLang, value);
      return saveSettingValue(SETTING_IDS.quickTargetLang, value);
    }

    function swapLanguages() {
      if (effectiveSource === 'auto') return;
      var nextSource = effectiveTarget;
      var nextTarget = effectiveSource;
      editDraft(SETTING_IDS.sourceLang, nextSource);
      editDraft(SETTING_IDS.targetLang, nextTarget);
      return saveSettingValue(SETTING_IDS.sourceLang, nextSource).then(function () {
        return saveSettingValue(SETTING_IDS.targetLang, nextTarget);
      });
    }

    // ----------------------------------------------------------
    // 动作回执（不弹 toast）
    // ----------------------------------------------------------

    function markCopied(key) {
      setCopied(key);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(function () {
        setCopied('');
      }, 1500);
    }

    function askConfirm(key) {
      setConfirm(key);
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
      confirmTimer.current = setTimeout(function () {
        setConfirm('');
      }, 4000);
    }

    // ----------------------------------------------------------
    // 翻译
    // ----------------------------------------------------------

    function readSecretKey() {
      if (!ctx.secrets || typeof ctx.secrets.get !== 'function') return Promise.resolve(null);
      return Promise.resolve(ctx.secrets.get(SECRET_API_KEY)).then(
        function (value) {
          return typeof value === 'string' && value.length > 0 ? value : null;
        },
        function (error) {
          setNotice({
            title: 'API key 读不出来',
            body: messageOf(error) + '\n\n请求会不带 Authorization 头继续发。',
          });
          return null;
        }
      );
    }

    function translate(text) {
      var trimmed = typeof text === 'string' ? text.trim() : '';
      if (trimmed === '' || busy) return Promise.resolve();

      var current = normalizeConfig(draft === null ? config : draft);
      if (!current.model.trim()) {
        setNotice({
          title: '还没有选择模型',
          body: '到「设置 → 连接」点一次「同步模型」，从服务端实际加载的模型里选一个。',
          action: 'connection',
        });
        return Promise.resolve();
      }

      setBusy(true);
      setNotice(null);
      var startedAt = Date.now();

      return readSecretKey()
        .then(function (key) {
          current.apiKey = key;
          return request(
            current,
            'POST',
            endpointPath(current),
            buildRequestBody(current, buildPrompt(current, trimmed))
          );
        })
        .then(function (response) {
          var parsed = extractTranslation(response.json, current.endpointKind);
          if (!parsed.ok) {
            throw new Error(
              '看不懂模型的返回（接口形态 ' +
                current.endpointKind +
                '）：\n' +
                parsed.reason +
                '\n\n可以试试切换接口形态（chat / completion），或者确认这个服务真的提供 OpenAI 兼容层。'
            );
          }
          if (!aliveRef.current) return null;

          var at = Date.now();
          var elapsed = at - startedAt;
          setNotice(null);
          setResult({
            at: at,
            sourceLang: current.sourceLang,
            target: current.targetLang,
            model: current.model,
            text: parsed.text,
            elapsedMs: elapsed,
            fromHistory: false,
          });

          // 历史写失败不影响这次结果：译文已经在屏幕上了。
          return recordEntry({
            at: at,
            sourceLang: current.sourceLang,
            targetLang: current.targetLang,
            model: current.model,
            srcChars: trimmed.length,
            body: parsed.text,
          })
            .then(function (id) {
              if (id) setSelectedId(String(id));
              return prune();
            })
            .then(function () {
              return reloadHistory();
            })
            .catch(function (error) {
              if (!aliveRef.current) return;
              setDbError('这条译文没能存进历史：' + messageOf(error));
            });
        })
        .catch(function (error) {
          if (!aliveRef.current) return;
          setNotice({
            title: '翻译失败',
            body: messageOf(error),
            action: 'retry',
          });
        })
        .then(function () {
          if (aliveRef.current) setBusy(false);
        });
    }

    function copyText(text, key) {
      if (!clipboardAvailable) {
        setNotice({ title: '复制不了', body: '这个运行位置没有剪贴板写入能力。' });
        return Promise.resolve();
      }
      return Promise.resolve()
        .then(function () {
          return ctx.clipboard.writeText(text);
        })
        .then(function () {
          markCopied(key);
        })
        .catch(function (error) {
          setNotice({ title: '复制失败', body: messageOf(error) });
        });
    }

    // ----------------------------------------------------------
    // 历史动作
    // ----------------------------------------------------------

    function openEntry(entry) {
      return readBody(entry.id).then(
        function (body) {
          if (!aliveRef.current) return;
          setSelectedId(String(entry.id));
          setNotice(null);
          setResult({
            at: entry.at,
            sourceLang: entry.sourceLang,
            target: entry.targetLang,
            model: entry.model,
            text: body || entry.preview,
            elapsedMs: 0,
            fromHistory: true,
          });
        },
        function (error) {
          if (!aliveRef.current) return;
          setNotice({ title: '读这条历史失败', body: messageOf(error) });
        }
      );
    }

    function loadMore() {
      if (!cursor || historyBusy) return Promise.resolve();
      setHistoryBusy(true);
      return fetchPage(search, cursor, filter === 'pinned')
        .then(function (page) {
          if (!aliveRef.current) return;
          setEntries(function (current) {
            return current.concat(page.entries);
          });
          setCursor(page.entries.length > 0 ? page.entries[page.entries.length - 1] : cursor);
          setHasMore(page.hasMore);
        })
        .catch(function (error) {
          if (aliveRef.current) setDbError('加载下一页失败：' + messageOf(error));
        })
        .then(function () {
          if (aliveRef.current) setHistoryBusy(false);
        });
    }

    function removeEntry(id) {
      setConfirm('');
      return deleteEntries([id])
        .then(function () {
          return refreshStats();
        })
        .then(function () {
          return reloadHistory();
        })
        .catch(function (error) {
          setNotice({ title: '删除失败', body: messageOf(error) });
        });
    }

    function togglePin(entry) {
      return dbExec('UPDATE translate_entries SET pinned = ?1 WHERE id = ?2', [
        entry.pinned ? 0 : 1,
        entry.id,
      ])
        .then(function () {
          return reloadHistory();
        })
        .catch(function (error) {
          setNotice({ title: '置顶状态没有保存', body: messageOf(error) });
        });
    }

    function clearHistory(includePinned) {
      setConfirm('');
      var sql = includePinned
        ? 'SELECT id FROM translate_entries'
        : 'SELECT id FROM translate_entries WHERE pinned = 0';
      return dbQuery(sql)
        .then(function (rows) {
          if (rows.length === 0) return 0;
          return deleteEntries(
            rows.map(function (row) {
              return Number(row.id);
            })
          );
        })
        .then(function () {
          return reloadHistory();
        })
        .catch(function (error) {
          setNotice({ title: '清空失败', body: messageOf(error) });
        });
    }

    // ----------------------------------------------------------
    // 模型同步与密钥
    // ----------------------------------------------------------

    function runSync() {
      if (syncing) return Promise.resolve();
      setSyncing(true);
      setSettingsError('');
      var current = normalizeConfig(draft === null ? config : draft);
      return readSecretKey()
        .then(function (key) {
          current.apiKey = key;
          return syncModels(current);
        })
        .then(function (outcome) {
          if (!aliveRef.current) return outcome;
          var save = ctx.storage ? ctx.storage.set(CACHE_KEY, outcome) : Promise.resolve();
          return Promise.resolve(save).then(function () {
            if (!outcome.ok) {
              setSettingsError(outcome.error);
              return refresh();
            }
            if (outcome.models.length === 1) {
              // 单模型是 llama.cpp 的常态：直接选中它，省掉一次"从一项清单里点一下"。
              return saveSettingValue(SETTING_IDS.model, outcome.models[0]);
            }
            return refresh();
          });
        })
        .catch(function (error) {
          setSettingsError('同步模型失败：' + messageOf(error));
        })
        .then(function () {
          if (aliveRef.current) setSyncing(false);
        });
    }

    function commitKey() {
      if (!ctx.secrets || typeof ctx.secrets.set !== 'function') {
        setSettingsError('这个运行位置没有 ctx.secrets');
        return Promise.resolve();
      }
      setKeyBusy(true);
      setSettingsError('');
      var value = keyDraft;
      return Promise.resolve()
        .then(function () {
          if (value === '') {
            return ctx.secrets.delete(SECRET_API_KEY).then(function () {
              setKeyDraft('');
            });
          }
          return ctx.secrets.set(SECRET_API_KEY, value).then(function () {
            // 值已经进加密库，立刻清空输入框 —— 留在 DOM 里没有意义，只会多一处可能
            // 被截图或读走的地方。
            setKeyDraft('');
          });
        })
        .then(function () {
          return refresh();
        })
        .catch(function (error) {
          setSettingsError('API key 没有保存：' + messageOf(error));
        })
        .then(function () {
          if (aliveRef.current) setKeyBusy(false);
        });
    }

    // ----------------------------------------------------------
    // 抽屉开关
    // ----------------------------------------------------------

    function openSettings(tab) {
      setSettingsError('');
      setDrawerTab(tab || 'connection');
      setDrawerOpen(true);
    }

    React.useEffect(
      function () {
        if (!drawerOpen) return undefined;
        function onKeyDown(event) {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          setDrawerOpen(false);
        }
        window.addEventListener('keydown', onKeyDown);
        return function () {
          window.removeEventListener('keydown', onKeyDown);
        };
      },
      [drawerOpen]
    );

    // ----------------------------------------------------------
    // 渲染零件
    // ----------------------------------------------------------

    function renderPill(options) {
      return h(
        'button',
        {
          type: 'button',
          className: 'tr-pill',
          title: options.title || '',
          onClick: options.onClick,
        },
        options.dot
          ? h('span', { className: 'tr-dot tr-dot-' + options.dot, 'aria-hidden': 'true' })
          : null,
        options.children
      );
    }

    function renderTopbar() {
      return h(
        'header',
        { className: 'tr-topbar' },
        h(
          'div',
          { className: 'tr-brand' },
          h('h1', { className: 'tr-title' }, '划词翻译'),
          h('span', { className: 'tr-subtitle' }, '本机模型')
        ),
        h(
          'div',
          { className: 'tr-topbar-actions' },
          renderPill({
            dot: endpointInfo.tone,
            title: endpointInfo.detail,
            onClick: function () {
              openSettings('connection');
            },
            children: h('span', { className: 'tr-pill-text' }, '端点 · ' + endpointInfo.text),
          }),
          hotkeyAvailable
            ? renderPill({
                dot: hotkeyInfo.tone,
                title: hotkeyInfo.detail || '划词翻译：在别的程序里选中文字后按组合键',
                onClick: function () {
                  openSettings('quick');
                },
                children: [
                  h('kbd', { key: 'k', className: 'tr-pill-kbd' }, view.triggerCombo || '未设置'),
                  h('span', { key: 'a', className: 'tr-pill-arrow' }, h(IconArrow)),
                  h('span', { key: 't', className: 'tr-pill-text' }, effectiveQuickTarget),
                ],
              })
            : null,
          h(
            'button',
            {
              type: 'button',
              className: 'tr-iconbtn',
              onClick: function () {
                openSettings('connection');
              },
              title: '设置',
              'aria-label': '打开设置',
            },
            h(IconSettings)
          )
        )
      );
    }

    function renderLangbar() {
      return h(
        'div',
        { className: 'tr-langbar' },
        h(
          'label',
          { className: 'tr-lang' },
          h('span', { className: 'tr-lang-label' }, '源语言'),
          h(
            'select',
            {
              className: 'tr-select',
              value: effectiveSource,
              onChange: function (event) {
                editDraft(SETTING_IDS.sourceLang, event.target.value);
                saveSettingValue(SETTING_IDS.sourceLang, event.target.value);
              },
            },
            SOURCE_LANGS.map(function (item) {
              return h('option', { key: item.value, value: item.value }, item.label);
            })
          )
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'tr-swap',
            disabled: effectiveSource === 'auto',
            title:
              effectiveSource === 'auto'
                ? '源语言是「自动」时无法交换（目标语言不能是「自动」）'
                : '交换源语言与目标语言',
            'aria-label': '交换源语言与目标语言',
            onClick: swapLanguages,
          },
          h(IconSwap)
        ),
        h(
          'label',
          { className: 'tr-lang' },
          h('span', { className: 'tr-lang-label' }, '目标语言'),
          h(
            'select',
            {
              className: 'tr-select',
              value: effectiveTarget,
              onChange: function (event) {
                editDraft(SETTING_IDS.targetLang, event.target.value);
                saveSettingValue(SETTING_IDS.targetLang, event.target.value);
              },
            },
            TARGET_LANGS.map(function (lang) {
              return h('option', { key: lang, value: lang }, lang);
            })
          )
        )
      );
    }

    function renderNotice() {
      if (!notice) return null;
      return h(
        'div',
        { className: 'tr-alert', role: 'alert' },
        h(
          'div',
          { className: 'tr-alert-head' },
          h('span', { className: 'tr-alert-title' }, notice.title),
          h(
            'button',
            {
              type: 'button',
              className: 'tr-iconbtn tr-iconbtn-sm',
              'aria-label': '关闭这条错误',
              onClick: function () {
                setNotice(null);
              },
            },
            h(IconClose)
          )
        ),
        h('pre', { className: 'tr-pre' }, notice.body),
        notice.action === 'connection'
          ? h(
              'button',
              {
                type: 'button',
                className: 'tr-btn tr-btn-sm tr-alert-action',
                onClick: function () {
                  openSettings('connection');
                },
              },
              '打开连接设置'
            )
          : notice.action === 'retry'
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'tr-btn tr-btn-sm tr-alert-action',
                  disabled: busy,
                  onClick: function () {
                    translate(input);
                  },
                },
                '重试'
              )
            : null
      );
    }

    function renderEmptyResult() {
      return h(
        'div',
        { className: 'tr-result-empty' },
        h(IconEmpty),
        h('p', { className: 'tr-empty-title' }, modelMissing ? '还没有选择模型' : '还没有译文'),
        h(
          'p',
          { className: 'tr-empty-hint' },
          modelMissing
            ? '先连接本机的模型服务，再同步一下模型。'
            : '把要翻译的文字粘贴到上面，按 Ctrl + Enter，或者点「翻译」。'
        ),
        modelMissing
          ? h(
              'button',
              {
                type: 'button',
                className: 'tr-btn tr-btn-sm',
                onClick: function () {
                  openSettings('connection');
                },
              },
              '去连接'
            )
          : null
      );
    }

    function renderResult() {
      if (busy && !result) {
        return h(
          'div',
          { className: 'tr-result-empty' },
          h(IconSpinner),
          h('p', { className: 'tr-empty-hint' }, '正在翻译…')
        );
      }
      if (!result) return renderEmptyResult();

      var metaParts = [];
      if (result.model) metaParts.push(result.model);
      if (result.at) metaParts.push(formatTime(result.at));
      if (result.text) metaParts.push(formatCount(result.text.length) + ' 字符');
      if (result.elapsedMs) metaParts.push(formatDuration(result.elapsedMs));

      var copiedResult = copied === 'result';

      return h(
        'div',
        { className: 'tr-result' },
        h(
          'div',
          { className: 'tr-result-head' },
          h(
            'div',
            { className: 'tr-result-heading' },
            h(
              'div',
              { className: 'tr-result-title-row' },
              h('span', { className: 'tr-result-title' }, '译文'),
              h('span', { className: 'tr-chip tr-chip-lang' }, result.target || effectiveTarget),
              result.fromHistory ? h('span', { className: 'tr-chip' }, '历史') : null
            ),
            h('span', { className: 'tr-result-meta', title: metaParts.join(' · ') }, metaParts.join(' · '))
          ),
          h(
            'div',
            { className: 'tr-result-actions' },
            h(
              'button',
              {
                type: 'button',
                className: 'tr-btn tr-btn-ghost tr-btn-sm',
                disabled: !clipboardAvailable,
                onClick: function () {
                  copyText(result.text, 'result');
                },
              },
              copiedResult ? h(IconCheck) : h(IconCopy),
              copiedResult ? '已复制' : '复制'
            ),
            result.fromHistory
              ? null
              : h(
                  'button',
                  {
                    type: 'button',
                    className: 'tr-btn tr-btn-ghost tr-btn-sm',
                    disabled: busy || input.trim() === '',
                    onClick: function () {
                      translate(input);
                    },
                  },
                  h(IconRefresh),
                  '重新翻译'
                )
          )
        ),
        h('div', { className: 'tr-result-body' }, result.text)
      );
    }

    function renderWork() {
      return h(
        'section',
        { className: 'tr-work', 'aria-label': '翻译工作台' },
        renderLangbar(),
        h(
          'div',
          { className: 'tr-editor' },
          h('textarea', {
            className: 'tr-textarea',
            value: input,
            rows: 6,
            maxLength: INPUT_LIMIT,
            placeholder: '粘贴或输入要翻译的文字…',
            onChange: function (event) {
              setInput(event.target.value);
            },
            onKeyDown: function (event) {
              if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                event.preventDefault();
                translate(input);
              }
            },
          }),
          h(
            'div',
            { className: 'tr-editor-foot' },
            h(
              'span',
              { className: 'tr-counter' },
              formatCount(input.length) + ' / ' + formatCount(INPUT_LIMIT)
            ),
            h('span', { className: 'tr-kbd-hint' }, 'Ctrl + Enter 翻译')
          )
        ),
        h(
          'div',
          { className: 'tr-toolbar' },
          h(
            'div',
            { className: 'tr-toolbar-left' },
            h(
              'button',
              {
                type: 'button',
                className: 'tr-btn tr-btn-ghost tr-btn-sm',
                disabled: busy || input === '',
                onClick: function () {
                  setInput('');
                  setResult(null);
                  setNotice(null);
                },
              },
              '清空'
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'tr-btn tr-btn-ghost tr-btn-sm',
                disabled: busy || !result,
                onClick: function () {
                  setResult(null);
                },
              },
              '收起译文'
            )
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'tr-btn tr-btn-primary',
              disabled: busy || input.trim() === '',
              onClick: function () {
                translate(input);
              },
            },
            busy ? IconSpinner() : null,
            busy ? '翻译中…' : '翻译'
          )
        ),
        renderNotice(),
        renderResult()
      );
    }

    function renderHistoryItem(entry) {
      var key = String(entry.id);
      var active = selectedId === key;
      var copiedKey = 'hist-' + key;
      var deleteKey = 'delete-' + key;
      var deleting = confirm === deleteKey;

      return h(
        'article',
        {
          key: key,
          className: 'tr-hist-item' + (active ? ' tr-hist-item-on' : ''),
          role: 'button',
          tabIndex: 0,
          'aria-label': '打开这条译文',
          onClick: function () {
            openEntry(entry);
          },
          onKeyDown: function (event) {
            if (event.target !== event.currentTarget) return;
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              openEntry(entry);
            }
          },
        },
        h(
          'div',
          { className: 'tr-hist-meta' },
          entry.pinned ? h('span', { className: 'tr-pin', title: '已置顶' }, h(IconPin)) : null,
          h('span', { className: 'tr-hist-time' }, formatTime(entry.at)),
          h(
            'span',
            { className: 'tr-hist-lang' },
            (entry.sourceLang && entry.sourceLang !== 'auto' ? entry.sourceLang + ' → ' : '') +
              entry.targetLang
          ),
          h('span', { className: 'tr-hist-chars' }, formatCount(entry.bodyChars) + ' 字')
        ),
        h('p', { className: 'tr-hist-preview' }, entry.preview),
        h(
          'div',
          {
            className: 'tr-hist-actions',
            onClick: function (event) {
              event.stopPropagation();
            },
            onKeyDown: function (event) {
              event.stopPropagation();
            },
          },
          h(
            'button',
            {
              type: 'button',
              className: 'tr-iconbtn tr-iconbtn-sm',
              title: '复制这条译文',
              'aria-label': '复制这条译文',
              onClick: function () {
                readBody(entry.id).then(
                  function (body) {
                    copyText(body || entry.preview, copiedKey);
                  },
                  function (error) {
                    setNotice({ title: '读这条历史失败', body: messageOf(error) });
                  }
                );
              },
            },
            copied === copiedKey ? h(IconCheck) : h(IconCopy)
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'tr-iconbtn tr-iconbtn-sm' + (entry.pinned ? ' tr-iconbtn-on' : ''),
              title: entry.pinned ? '取消置顶' : '置顶（不被自动清理）',
              'aria-label': entry.pinned ? '取消置顶' : '置顶',
              onClick: function () {
                togglePin(entry);
              },
            },
            h(IconPin)
          ),
          h(
            'button',
            {
              type: 'button',
              className:
                'tr-iconbtn tr-iconbtn-sm' + (deleting ? ' tr-iconbtn-danger' : ''),
              title: deleting ? '再点一次确认删除' : '删除',
              'aria-label': deleting ? '确认删除这条历史' : '删除这条历史',
              onClick: function () {
                if (deleting) removeEntry(entry.id);
                else askConfirm(deleteKey);
              },
            },
            h(IconTrash)
          )
        )
      );
    }

    function renderHistory() {
      var query = search.trim();
      return h(
        'aside',
        { className: 'tr-hist', 'aria-label': '翻译历史' },
        h(
          'div',
          { className: 'tr-hist-head' },
          h(
            'div',
            { className: 'tr-hist-title-row' },
            h('h2', { className: 'tr-hist-title' }, '历史'),
            h(
              'div',
              { className: 'tr-chips', role: 'group', 'aria-label': '筛选历史' },
              [
                { id: 'all', label: '全部' },
                { id: 'pinned', label: '置顶' },
              ].map(function (item) {
                var on = filter === item.id;
                return h(
                  'button',
                  {
                    key: item.id,
                    type: 'button',
                    className: 'tr-chip tr-chip-btn' + (on ? ' tr-chip-on' : ''),
                    'aria-pressed': on,
                    onClick: function () {
                      if (filter === item.id) return;
                      setFilter(item.id);
                    },
                  },
                  item.label
                );
              })
            )
          ),
          h(
            'div',
            { className: 'tr-search' },
            h('span', { className: 'tr-search-icon' }, h(IconSearch)),
            h('input', {
              className: 'tr-search-input',
              type: 'search',
              value: search,
              placeholder: '搜索译文',
              'aria-label': '搜索译文',
              onChange: function (event) {
                setSearch(event.target.value);
              },
            }),
            search
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'tr-search-clear',
                    'aria-label': '清除搜索',
                    onClick: function () {
                      setSearch('');
                    },
                  },
                  h(IconClose)
                )
              : null
          )
        ),
        h(
          'div',
          { className: 'tr-hist-list' },
          dbError
            ? h(
                'div',
                { className: 'tr-hist-error', role: 'alert' },
                h('span', null, dbError),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'tr-iconbtn tr-iconbtn-sm',
                    'aria-label': '关闭这条提示',
                    onClick: function () {
                      setDbError('');
                    },
                  },
                  h(IconClose)
                )
              )
            : null,
          historyBusy && entries.length === 0
            ? h('p', { className: 'tr-hist-empty' }, '读取中…')
            : entries.length === 0
              ? h(
                  'p',
                  { className: 'tr-hist-empty' },
                  query
                    ? '没有匹配「' + query + '」的译文'
                    : filter === 'pinned'
                      ? '还没有置顶的译文'
                      : '翻一段，这里就会留下记录'
                )
              : entries.map(renderHistoryItem)
        ),
        h(
          'div',
          { className: 'tr-hist-foot' },
          h(
            'span',
            { className: 'tr-hist-stat' },
            stats
              ? formatCount(stats.entries) +
                  ' 条' +
                  (stats.pinned > 0 ? ' · 置顶 ' + formatCount(stats.pinned) : '') +
                  ' · ' +
                  formatBytes(stats.dbBytes)
              : ''
          ),
          hasMore
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'tr-btn tr-btn-ghost tr-btn-sm',
                  disabled: historyBusy,
                  onClick: loadMore,
                },
                historyBusy ? '加载中…' : '加载更多'
              )
            : null
        )
      );
    }

    // ---------- 抽屉 ----------

    function renderDrawerTabs() {
      var tabs = [
        { id: 'connection', label: '连接' },
        { id: 'prompt', label: '提示词' },
        { id: 'quick', label: '划词' },
        { id: 'data', label: '数据' },
      ];
      return h(
        'div',
        { className: 'tr-tabs', role: 'tablist', 'aria-label': '设置分类' },
        tabs.map(function (tab) {
          var on = drawerTab === tab.id;
          return h(
            'button',
            {
              key: tab.id,
              type: 'button',
              role: 'tab',
              'aria-selected': on,
              className: 'tr-tab' + (on ? ' tr-tab-on' : ''),
              onClick: function () {
                setDrawerTab(tab.id);
              },
            },
            tab.label
          );
        })
      );
    }

    function renderConnectionSection() {
      var models = cache && cache.ok && Array.isArray(cache.models) ? cache.models : [];
      var probe = describeEndpoint(cache, status);

      return h(
        'section',
        { className: 'tr-sect' },
        h(
          'div',
          { className: 'tr-sect-head' },
          h('h3', { className: 'tr-sect-title' }, '模型服务'),
          h(
            'button',
            {
              type: 'button',
              className: 'tr-btn tr-btn-ghost tr-btn-sm',
              disabled: syncing,
              onClick: runSync,
            },
            syncing ? IconSpinner() : h(IconRefresh),
            syncing ? '同步中…' : '同步模型'
          )
        ),
        h(
          'p',
          { className: 'tr-sect-note' },
          'OpenAI 兼容接口。同步会向 ',
          h('code', null, joinUrl(view.baseUrl, 'models')),
          ' 发一次 GET，读回服务端实际加载的模型。'
        ),
        h(
          Field,
          {
            htmlFor: 'tr-base-url',
            label: '服务地址',
            hint: '本机默认 ' + DEFAULT_BASE_URL + '。结尾带不带斜杠都行。',
          },
          h('input', {
            id: 'tr-base-url',
            className: 'tr-input',
            type: 'text',
            value: view.baseUrl,
            spellCheck: false,
            onChange: function (event) {
              editDraft(SETTING_IDS.baseUrl, event.target.value);
            },
            onBlur: function () {
              commitTrimmed(SETTING_IDS.baseUrl);
            },
          })
        ),
        view.baseUrl && !isLoopback(view.baseUrl)
          ? h(
              'p',
              { className: 'tr-warn-line' },
              '这不是本机回环地址。除了 network 权限，还需要在清单里声明 network-external，否则宿主会拒绝请求。'
            )
          : null,
        h(
          Field,
          {
            htmlFor: 'tr-endpoint-kind',
            label: '接口形态',
            hint: 'chat 走 /chat/completions，completion 走 /completions。chat 不稳时换后者。',
          },
          h(
            'select',
            {
              id: 'tr-endpoint-kind',
              className: 'tr-select tr-select-block',
              value: view.endpointKind,
              onChange: function (event) {
                editDraft(SETTING_IDS.endpointKind, event.target.value);
                saveSettingValue(SETTING_IDS.endpointKind, event.target.value);
              },
            },
            h('option', { value: 'chat' }, 'chat（/chat/completions）'),
            h('option', { value: 'completion' }, 'completion（/completions）')
          )
        ),
        h(
          Field,
          {
            htmlFor: 'tr-model',
            label: '模型',
            hint: '请求体里的 model 字段，必须与服务端加载的那一个逐字一致。',
          },
          h('input', {
            id: 'tr-model',
            className: 'tr-input',
            type: 'text',
            value: view.model,
            spellCheck: false,
            onChange: function (event) {
              editDraft(SETTING_IDS.model, event.target.value);
            },
            onBlur: function () {
              commitTrimmed(SETTING_IDS.model);
            },
          })
        ),
        h(
          'div',
          { className: 'tr-status-line' },
          h(
            'span',
            { className: 'tr-dot tr-dot-' + probe.tone, 'aria-hidden': 'true' }
          ),
          h('span', { className: 'tr-status-text' }, probe.value),
          probe.detail ? h('span', { className: 'tr-status-detail' }, probe.detail) : null
        ),
        models.length > 0
          ? h(
              'div',
              { className: 'tr-models' },
              models.map(function (id) {
                var selected = id === view.model;
                return h(
                  'button',
                  {
                    key: id,
                    type: 'button',
                    className: 'tr-model' + (selected ? ' tr-model-on' : ''),
                    title: id,
                    onClick: function () {
                      editDraft(SETTING_IDS.model, id);
                      saveSettingValue(SETTING_IDS.model, id);
                    },
                  },
                  id
                );
              })
            )
          : null,
        cache && !cache.ok && cache.error
          ? h('pre', { className: 'tr-pre tr-probe-error' }, cache.error)
          : null
      );
    }

    function renderPromptSection() {
      var sourceReplacement = effectiveSource === 'auto' ? SOURCE_AUTO_HINT : effectiveSource;
      return h(
        'section',
        { className: 'tr-sect' },
        h('h3', { className: 'tr-sect-title' }, '提示词模板'),
        h(
          'p',
          { className: 'tr-sect-note' },
          '占位符：{text}（必需，最后替换）、{target}、{source}。本地小模型对格式很敏感，这一项值得按模型调。'
        ),
        h('textarea', {
          className: 'tr-textarea tr-textarea-mono',
          value: view.promptTemplate,
          rows: 8,
          spellCheck: false,
          onChange: function (event) {
            editDraft(SETTING_IDS.promptTemplate, event.target.value);
          },
          onBlur: function () {
            commitField(SETTING_IDS.promptTemplate);
          },
        }),
        h(
          'div',
          { className: 'tr-inline-row' },
          h(
            'button',
            {
              type: 'button',
              className: 'tr-btn tr-btn-ghost tr-btn-sm',
              onClick: function () {
                editDraft(SETTING_IDS.promptTemplate, DEFAULT_PROMPT_TEMPLATE);
                saveSettingValue(SETTING_IDS.promptTemplate, DEFAULT_PROMPT_TEMPLATE);
              },
            },
            '恢复缺省'
          ),
          h('span', { className: 'tr-muted' }, '当前 {source} = ' + sourceReplacement)
        ),
        h(
          'p',
          { className: 'tr-sect-note' },
          '用通用小模型时，把指令换成英文通常更稳：Translate the following text into {target}. Output only the translation.'
        )
      );
    }

    function renderQuickSection() {
      return h(
        'section',
        { className: 'tr-sect' },
        h('h3', { className: 'tr-sect-title' }, '划词翻译'),
        h(
          'p',
          { className: 'tr-sect-note' },
          '在别的程序里选中文字，按组合键，光标旁出现译文卡片。译文只进卡片，不进下面的历史。'
        ),
        h(
          Field,
          {
            htmlFor: 'tr-quick-target',
            label: '划词目标语言',
            hint: '它与工作台的目标语言是两项独立设置，互不影响。',
          },
          h(
            'select',
            {
              id: 'tr-quick-target',
              className: 'tr-select tr-select-block',
              value: effectiveQuickTarget,
              onChange: function (event) {
                setQuickTarget(event.target.value);
              },
            },
            TARGET_LANGS.map(function (lang) {
              return h('option', { key: lang, value: lang }, lang);
            })
          )
        ),
        h(
          'div',
          { className: 'tr-subsection' },
          h('h4', { className: 'tr-sub-title' }, '触发组合键'),
          h(
            'p',
            { className: 'tr-sect-note' },
            '点方框后按下组合键；改完最多一分钟生效（后台每分钟对一次账）。全局热键在系统里是独占的。'
          ),
          h(HotkeyRecorder, {
            combo: view.triggerCombo,
            onCommit: function (combo) {
              editDraft(SETTING_IDS.triggerCombo, combo);
              return saveSettingValue(SETTING_IDS.triggerCombo, combo);
            },
            onClear: function () {
              editDraft(SETTING_IDS.triggerCombo, '');
              return saveSettingValue(SETTING_IDS.triggerCombo, '');
            },
          }),
          h(
            'div',
            { className: 'tr-status-line' },
            h('span', { className: 'tr-dot tr-dot-' + hotkeyInfo.tone, 'aria-hidden': 'true' }),
            h('span', { className: 'tr-status-text' }, hotkeyInfo.value),
            hotkeyInfo.detail ? h('span', { className: 'tr-status-detail' }, hotkeyInfo.detail) : null
          ),
          !hotkeyAvailable || !selectionAvailable
            ? h(
                'p',
                { className: 'tr-warn-line' },
                '这个平台没有全局热键或读取选中文本的能力（两者都只在 Windows 上提供），上面的工作台照常可用。'
              )
            : null,
          status && status.at
            ? h('p', { className: 'tr-sect-note' }, '后台最近一次上报：' + formatAgo(status.at))
            : null
        ),
        h(
          'div',
          { className: 'tr-subsection' },
          h('h4', { className: 'tr-sub-title' }, 'API key'),
          h(
            'p',
            { className: 'tr-sect-note' },
            '存在加密密钥库（ctx.secrets），不在设置里；换机器或网卡后需要重新输入。本机 llama.cpp 默认不校验密钥。'
          ),
          h(
            'div',
            { className: 'tr-key-state' },
            keyInfo.present
              ? h('span', { className: 'tr-tag tr-tag-ok' }, '已保存')
              : h('span', { className: 'tr-tag tr-tag-muted' }, '未设置'),
            keyInfo.error ? h('span', { className: 'tr-tag tr-tag-error' }, keyInfo.error) : null
          ),
          h(
            'div',
            { className: 'tr-inline-row' },
            h('input', {
              className: 'tr-input',
              type: 'password',
              value: keyDraft,
              autoComplete: 'off',
              spellCheck: false,
              placeholder: keyInfo.present
                ? '已保存 —— 留空并点「删除」可清除'
                : '留空也能用（本机服务通常随便填）',
              'aria-label': 'API key',
              onChange: function (event) {
                setKeyDraft(event.target.value);
              },
              onKeyDown: function (event) {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  commitKey();
                }
              },
            }),
            // 空输入在"已有密钥"时是**删除**，在"没有密钥"时什么都不做。按钮文案跟着
            // 变，避免"点一下保存把密钥删了"这种不可预料的后果。
            keyDraft === '' && keyInfo.present
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'tr-btn tr-btn-danger tr-btn-sm',
                    disabled: keyBusy,
                    onClick: commitKey,
                  },
                  keyBusy ? '删除中…' : '删除'
                )
              : h(
                  'button',
                  {
                    type: 'button',
                    className: 'tr-btn tr-btn-primary tr-btn-sm',
                    disabled: keyBusy || keyDraft === '',
                    onClick: commitKey,
                  },
                  keyBusy ? '保存中…' : '保存'
                )
          )
        )
      );
    }

    function renderDataSection() {
      return h(
        'section',
        { className: 'tr-sect' },
        h('h3', { className: 'tr-sect-title' }, '数据与隐私'),
        stats
          ? h(
              'div',
              { className: 'tr-stats' },
              h(StatCell, { label: '条目', value: formatCount(stats.entries) }),
              h(StatCell, { label: '置顶', value: formatCount(stats.pinned) }),
              h(StatCell, { label: '译文总量', value: formatCount(stats.bodyChars) + ' 字' }),
              h(StatCell, { label: '数据库', value: formatBytes(stats.dbBytes) })
            )
          : h('p', { className: 'tr-sect-note' }, '还没有读到统计数据。'),
        h(
          'p',
          { className: 'tr-sect-note' },
          '保留策略：未置顶最多 800 条 / 180 天；置顶不计入这两项。译文总量超过约 400 万字符时，从最旧的开始删（会删到置顶）。'
        ),
        h(
          'div',
          { className: 'tr-inline-row' },
          h(
            'button',
            {
              type: 'button',
              className: 'tr-btn tr-btn-sm' + (confirm === 'clear-unpinned' ? ' tr-btn-danger' : ''),
              disabled: !databaseAvailable() || (stats && stats.entries === 0),
              onClick: function () {
                if (confirm === 'clear-unpinned') clearHistory(false);
                else askConfirm('clear-unpinned');
              },
            },
            confirm === 'clear-unpinned' ? '确认清空未置顶？' : '清空未置顶'
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'tr-btn tr-btn-sm' + (confirm === 'clear-all' ? ' tr-btn-danger' : ''),
              disabled: !databaseAvailable() || (stats && stats.entries === 0),
              onClick: function () {
                if (confirm === 'clear-all') clearHistory(true);
                else askConfirm('clear-all');
              },
            },
            confirm === 'clear-all' ? '确认全部清空？' : '全部清空'
          )
        ),
        h(
          'p',
          { className: 'tr-sect-note' },
          '历史只保存译文与原文的字符数，原文不进库；库在插件数据目录的 plugin.db 里，会随「插件数据」备份复制到别的机器。'
        )
      );
    }

    function renderDrawer() {
      if (!drawerOpen) return null;

      return h(
        'div',
        {
          className: 'tr-overlay',
          onMouseDown: function (event) {
            if (event.target === event.currentTarget) setDrawerOpen(false);
          },
        },
        h(
          'aside',
          {
            className: 'tr-drawer',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': '划词翻译设置',
          },
          h(
            'div',
            { className: 'tr-drawer-head' },
            h('h2', { className: 'tr-drawer-title' }, '设置'),
            h(
              'button',
              {
                type: 'button',
                className: 'tr-iconbtn',
                'aria-label': '关闭设置',
                onClick: function () {
                  setDrawerOpen(false);
                },
              },
              h(IconClose)
            )
          ),
          renderDrawerTabs(),
          h(
            'div',
            { className: 'tr-drawer-body', role: 'tabpanel' },
            settingsError
              ? h(
                  'div',
                  { className: 'tr-alert tr-alert-inline', role: 'alert' },
                  h(
                    'div',
                    { className: 'tr-alert-head' },
                    h('span', { className: 'tr-alert-title' }, '设置'),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'tr-iconbtn tr-iconbtn-sm',
                        'aria-label': '关闭这条错误',
                        onClick: function () {
                          setSettingsError('');
                        },
                      },
                      h(IconClose)
                    )
                  ),
                  h('pre', { className: 'tr-pre' }, settingsError)
                )
              : null,
            drawerTab === 'connection'
              ? renderConnectionSection()
              : drawerTab === 'prompt'
                ? renderPromptSection()
                : drawerTab === 'quick'
                  ? renderQuickSection()
                  : renderDataSection()
          )
        )
      );
    }

    // ----------------------------------------------------------
    // 顶层
    // ----------------------------------------------------------

    if (snapshot === null) {
      return h('div', { className: 'tr-root' }, h('div', { className: 'tr-loading' }, '正在读取状态…'));
    }

    return h(
      'div',
      { className: 'tr-root' + (drawerOpen ? ' tr-root-locked' : '') },
      h(
        'div',
        { className: 'tr-shell' },
        renderTopbar(),
        h('main', { className: 'tr-main' }, renderWork(), renderHistory())
      ),
      renderDrawer()
    );
  }

  // ============================================================
  // 描述后台状态（顶栏与抽屉共用）
  // ============================================================

  /**
   * 热键那一行的措辞。
   *
   * 后台写下的状态是**权威**（它记的是"宿主真的绑上了没有"）；`ctx.hotkey.isAvailable()`
   * 只回答"这件事在这个平台上可不可能"。两者不是一回事 —— 组合键可能被别人占着。
   */
  function describeHotkey(status, hotkeyAvailable, selectionAvailable) {
    if (!hotkeyAvailable) {
      return { value: '这个平台不支持', tone: 'off', detail: '只有 Windows 有 RegisterHotKey / SendInput' };
    }
    if (!status || !status.hotkeyState) {
      return {
        value: '等待后台上报',
        tone: 'warn',
        detail: '后台插件需要 Node 运行时；它可能还没启动',
      };
    }
    if (status.hotkeyState === 'registered') {
      return {
        value: '已注册 ' + friendlyCombo(status.registeredCombo || status.desiredCombo || ''),
        tone: 'ok',
        detail: '',
      };
    }
    if (status.hotkeyState === 'failed') {
      return { value: '注册失败', tone: 'error', detail: status.hotkeyError || '' };
    }
    if (status.hotkeyState === 'unset') {
      return { value: '没有设置', tone: 'warn', detail: '触发组合键是空的' };
    }
    return { value: '不可用', tone: 'error', detail: status.hotkeyError || '' };
  }

  /** 端点那一行：**只**能来自上一次探测 —— 没有探测就没有事实可说。 */
  function describeEndpoint(cache, status) {
    if (!cache) {
      return {
        value: '还没有探测过',
        tone: 'off',
        detail: status && status.endpoint ? '后台当前配置：' + status.endpoint : '',
      };
    }
    var when = formatTime(cache.at) + '（' + formatAgo(cache.at) + '）';
    if (cache.ok) {
      return {
        value: '可达 · ' + (Array.isArray(cache.models) ? cache.models.length : 0) + ' 个模型',
        tone: 'ok',
        detail: '上次探测 ' + when,
      };
    }
    var label =
      cache.code === 'refused'
        ? '连不上（服务没在跑）'
        : cache.code === 'not-openai'
          ? '不是 OpenAI 兼容接口'
          : cache.code === 'empty'
            ? '服务在跑，但一个模型都没加载'
            : cache.code === 'auth'
              ? '服务端要求密钥（401）'
              : '探测失败';
    return { value: label, tone: 'error', detail: '上次探测 ' + when };
  }

  /** 只做一件事：判断一个地址是不是本机回环。用来提示"还需要 network-external"。 */
  function isLoopback(url) {
    var value = String(url || '');
    return (
      /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]|::1)([:/]|$)/i.test(value) ||
      value.indexOf('//127.0.0.1') !== -1
    );
  }

  // ============================================================
  // 注册
  // ============================================================

  Modulith.run(function (bootstrap) {
    ctx = bootstrap.ctx;
    Modulith.registerModule({
      id: 'translate',
      name: '划词翻译',
      description: '本机翻译工具：手动翻译、历史、语言配置，以及可选的划词热键',
      icon: 'icon.svg',
      priority: 76,
      component: TranslatePanel,
    });
  });
})();
