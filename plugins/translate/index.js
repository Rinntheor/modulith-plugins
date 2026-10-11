// plugins/translate/index.js
//
// 划词翻译 —— 面板那一半。跑在**沙箱 iframe** 里，与 `background.js`
// （一个独立的 Node 进程）没有共享的 JS 上下文。
//
// ============================================================
// 这个面板的**主次**：翻译工作台是主角，热键是其中一个入口
// ============================================================
//
// 上一版把这一页做成了"热键流程的配置页" —— 主体是状态行加上一堆地址、模型、
// 组合键的输入框。那反了。这个插件的本体是**一个翻译工具**：输入一段文字、选两个
// 语言、拿到译文、之后还能找回来。热键只是"不用切窗口就能用同一个工具"的一条通道，
// 而它在非 Windows 上根本不存在。
//
// 因此这一版的面板结构是：
//
//   1. **翻译工作台**（主视图）：原文输入、源/目标语言、翻译、译文与复制；
//   2. **历史**：持久化在 `ctx.db` 里，可搜索、可分页、可置顶、可删、可清空；
//   3. **语言配置**：源语言与目标语言，记住上一次的选择；
//   4. **模型与端点**：地址、接口形态、模型、提示词模板；
//   5. **热键流程**（单独一节，默认收起）：组合键、API key、注册状态；
//   6. **统计与权限说明**。
//
// 前三节完全不需要热键、不需要 Node 运行时、不需要后台进程 —— 面板直接调
// `ctx.http`。
//
// ============================================================
// 两个进程之间只有一条通道：宿主的存储与设置
// ============================================================
//
// 后台把运行状态写在 `ctx.storage` 的 `runtimeStatus` 里；面板读它。没有推送，
// 因此面板**不会自动更新** —— 只在打开 / 重新可见 / 用户点「刷新」时读一次。
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
  };

  var DEFAULT_BASE_URL = 'http://127.0.0.1:5566/v1';
  var DEFAULT_ENDPOINT_KIND = 'chat';
  var DEFAULT_MODEL = 'Hy MT2 1.8B Q4_K_M.gguf';
  var DEFAULT_SOURCE_LANG = 'auto';
  var DEFAULT_TARGET_LANG = '简体中文';
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

  var ENTRY_COLUMNS =
    'id, at, source_lang, target_lang, model, src_chars, body_preview, body_chars, pinned';

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
   */
  function fetchPage(query, cursor) {
    var search = typeof query === 'string' ? query.trim() : '';
    var anchor = cursor && typeof cursor.at === 'number' ? cursor : null;

    if (search) {
      var sql =
        'SELECT e.id, e.at, e.source_lang, e.target_lang, e.model, e.src_chars, ' +
        'e.body_preview, e.body_chars, e.pinned ' +
        'FROM translate_entries e JOIN translate_bodies b ON b.id = e.id ' +
        "WHERE b.body LIKE ?1 ESCAPE '\\'";
      // 参数一律按 `?N` 递增写，且**序号与出现顺序严格对应**：宿主按数组顺序绑定，
      // 序号写错不会报错，只会把值绑到另一个位置。
      var params = ['%' + escapeLike(search) + '%'];
      if (anchor) {
        var atParam = params.length + 1;
        sql +=
          ' AND (e.at < ?' + atParam + ' OR (e.at = ?' + atParam + ' AND e.id < ?' + (atParam + 1) + '))';
        params.push(anchor.at, anchor.id);
      }
      sql += ' ORDER BY e.at DESC, e.id DESC LIMIT ?' + (params.length + 1);
      params.push(PAGE_SIZE);

      return dbQuery(sql, params).then(function (rows) {
        return { entries: rows.map(normalizeRow), hasMore: rows.length === PAGE_SIZE };
      });
    }

    var listSql = 'SELECT ' + ENTRY_COLUMNS + ' FROM translate_entries';
    var listParams = [];
    if (anchor) {
      var listAt = listParams.length + 1;
      listSql +=
        ' WHERE at < ?' + listAt + ' OR (at = ?' + listAt + ' AND id < ?' + (listAt + 1) + ')';
      listParams.push(anchor.at, anchor.id);
    }
    listSql += ' ORDER BY at DESC, id DESC LIMIT ?' + (listParams.length + 1);
    listParams.push(PAGE_SIZE);

    return dbQuery(listSql, listParams).then(function (rows) {
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

  function TranslatePanel() {
    var snapshotState = React.useState(null);
    var snapshot = snapshotState[0];
    var setSnapshot = snapshotState[1];

    var noticeState = React.useState(null);
    var notice = noticeState[0];
    var setNotice = noticeState[1];

    var draftState = React.useState(null);
    var draft = draftState[0];
    var setDraft = draftState[1];

    var keyDraftState = React.useState('');
    var keyDraft = keyDraftState[0];
    var setKeyDraft = keyDraftState[1];

    var inputState = React.useState('');
    var input = inputState[0];
    var setInput = inputState[1];

    var resultState = React.useState(null);
    var result = resultState[0];
    var setResult = resultState[1];

    var busyState = React.useState(false);
    var busy = busyState[0];
    var setBusy = busyState[1];

    var syncingState = React.useState(false);
    var syncing = syncingState[0];
    var setSyncing = syncingState[1];

    var saveFlashState = React.useState('');
    var saveFlash = saveFlashState[0];
    var setSaveFlash = saveFlashState[1];

    // ---------- 历史的状态 ----------

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

    var historyBusyState = React.useState(false);
    var historyBusy = historyBusyState[0];
    var setHistoryBusy = historyBusyState[1];

    var dbErrorState = React.useState('');
    var dbError = dbErrorState[0];
    var setDbError = dbErrorState[1];

    var statsState = React.useState(null);
    var stats = statsState[0];
    var setStats = statsState[1];

    var openEntryState = React.useState(null);
    var openEntry = openEntryState[0];
    var setOpenEntry = openEntryState[1];

    // 热键那一节默认**收起**：它是这个工具的一条入口，不是它的主体。
    var hotkeyOpenState = React.useState(false);
    var hotkeyOpen = hotkeyOpenState[0];
    var setHotkeyOpen = hotkeyOpenState[1];

    var aliveRef = React.useRef(true);
    React.useEffect(function () {
      return function () {
        aliveRef.current = false;
      };
    }, []);

    var flashTimer = React.useRef(null);
    function flash(message) {
      setSaveFlash(message);
      if (flashTimer.current) clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(function () {
        setSaveFlash('');
      }, 2200);
    }
    React.useEffect(function () {
      return function () {
        if (flashTimer.current) clearTimeout(flashTimer.current);
      };
    }, []);

    /** 重新读一遍快照。**不轮询** —— 只在需要时调（见文件头）。 */
    function refresh() {
      return loadSnapshot().then(function (next) {
        if (!aliveRef.current) return next;
        setSnapshot(next);
        setDraft(function (current) {
          // 已经有一份草稿（用户正在改）时**不覆盖它**：用户改到一半时后台/别处
          // 触发的一次刷新会把他的输入抹掉，那是很难再复现的一类"输入丢了"。
          return current === null ? next.config : current;
        });
        return next;
      });
    }

    /** 重新读第一页历史与统计。搜索词变了、删了一条、清空之后都要走它。 */
    function reloadHistory(term) {
      if (!databaseAvailable()) {
        setDbError('这个运行位置没有 ctx.db（清单里缺 plugin-data 权限）');
        return Promise.resolve();
      }
      setHistoryBusy(true);
      var query = term === undefined ? search : term;
      return fetchPage(query, null)
        .then(function (page) {
          if (!aliveRef.current) return null;
          setEntries(page.entries);
          setCursor(page.entries.length > 0 ? page.entries[page.entries.length - 1] : null);
          setHasMore(page.hasMore);
          setOpenEntry(null);
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

    /** 首次装载：建表 → 裁一次 → 读第一页。 */
    React.useEffect(function () {
      if (!databaseAvailable()) {
        setDbError('这个运行位置没有 ctx.db（清单里缺 plugin-data 权限）');
        return;
      }
      ensureSchema()
        .then(function () {
          // 启动时裁一次：应用关着的时候天数照常在走，而那段里没有任何插入来触发裁剪。
          return prune();
        })
        .then(function () {
          return reloadHistory('');
        })
        .catch(function (error) {
          if (!aliveRef.current) return;
          setDbError('翻译历史不可用：' + messageOf(error));
        });
    }, []);

    React.useEffect(function () {
      refresh();
    }, []);

    /**
     * 模块重新可见时刷新一次。
     *
     * 这是"面板看不见的时候后台发生了什么"唯一能被发现的时机 —— 没有推送通道
     * （见文件头）。它的触发频率天然有界（用户切标签），因此不需要再做节流。
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

    var config = snapshot ? snapshot.config : normalizeConfig({});

    /** 草稿上改一个字段（不落盘）。 */
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

    /** 落盘一个字段并按服务端实际值回读一次（`settings.set` 不回传，读回来最稳）。 */
    function commit(id, value) {
      return saveSetting(id, value)
        .then(function () {
          return refresh();
        })
        .then(function () {
          flash('已保存：' + id);
        })
        .catch(function (error) {
          // 写入失败必须说出来：静默丢掉会让用户以为设置生效了。
          setNotice({ tone: 'error', title: '设置没有保存', body: messageOf(error) });
        });
    }

    function commitKey() {
      var value = keyDraft;
      if (!ctx.secrets || typeof ctx.secrets.set !== 'function') {
        setNotice({ tone: 'error', title: '无法保存 API key', body: '这个运行位置没有 ctx.secrets' });
        return Promise.resolve();
      }
      return Promise.resolve()
        .then(function () {
          if (value === '') {
            // 空输入 = 删除。这是"我不想再用密钥"唯一需要的操作，而把空串写进去
            // 会让服务端收到一个 `Authorization: Bearer `（畸形的头）。
            return ctx.secrets.delete(SECRET_API_KEY).then(function () {
              setKeyDraft('');
              flash('API key 已删除');
            });
          }
          return ctx.secrets.set(SECRET_API_KEY, value).then(function () {
            // **立刻清空输入框**：值已经进了加密库，留在 DOM 里没有意义，
            // 而它留在那儿就多一处可能被截图或读走的地方。
            setKeyDraft('');
            flash('API key 已保存到加密密钥库');
          });
        })
        .then(function () {
          return refresh();
        })
        .catch(function (error) {
          setNotice({ tone: 'error', title: 'API key 没有保存', body: messageOf(error) });
        });
    }

    /** 从加密库取一次密钥。取不到时**如实记一条提示**并返回 null（不带 Authorization 继续）。 */
    function readSecretKey() {
      if (!ctx.secrets || typeof ctx.secrets.get !== 'function') return Promise.resolve(null);
      return Promise.resolve(ctx.secrets.get(SECRET_API_KEY)).then(
        function (value) {
          return typeof value === 'string' && value.length > 0 ? value : null;
        },
        function (error) {
          setNotice({
            tone: 'warning',
            title: 'API key 读不出来',
            body: messageOf(error) + '\n\n请求会不带 Authorization 头继续发。',
          });
          return null;
        }
      );
    }

    function runSync() {
      if (syncing) return Promise.resolve();
      setSyncing(true);
      setNotice(null);
      var current = draft === null ? config : draft;
      var modelForRequest = normalizeConfig(current);
      // 同步要用**当前草稿里**的地址与形态（用户可能刚改完还没保存就想试一下），
      // 但密钥只从加密库里取 —— 它不在草稿里，也永远不会在。
      return readSecretKey()
        .then(function (key) {
          modelForRequest.apiKey = key;
          return syncModels(modelForRequest);
        })
        .then(function (outcome) {
          if (!aliveRef.current) return outcome;
          // 缓存与展示分开：**缓存的永远是结果**（成功或失败都写），
          // 因为"上次探测是什么结果、什么时候"正是状态行要说的事。
          var save = ctx.storage ? ctx.storage.set(CACHE_KEY, outcome) : Promise.resolve();
          return Promise.resolve(save).then(function () {
            if (!outcome.ok) {
              setNotice({ tone: 'error', title: '同步模型失败', body: outcome.error });
              return refresh();
            }

            if (outcome.models.length === 1) {
              // ============================================================
              // 只有一个模型时**自动选中** —— 这是 llama.cpp 最常见的形态
              // ============================================================
              //
              // 一台机器上跑一个翻译模型是本插件的典型用法，那时"让用户从一份
              // 只有一个元素的清单里点一下"纯粹是浪费。多模型时**不猜**：
              // 猜错的后果是拿一个生成的模型去翻译，而错误信息会指向别处。
              var only = outcome.models[0];
              setNotice({
                tone: 'success',
                title: '已选中 ' + only,
                body:
                  '服务端只有这一个模型，已经把它写进设置。探测时刻：' + formatTime(outcome.at) + '。',
              });
              return saveSetting(SETTING_IDS.model, only).then(function () {
                return refresh();
              });
            }

            setNotice({
              tone: 'info',
              title: '读到 ' + outcome.models.length + ' 个模型',
              body: '在下面点一个作为默认模型。探测时刻：' + formatTime(outcome.at) + '。',
            });
            return refresh();
          });
        })
        .catch(function (error) {
          setNotice({ tone: 'error', title: '同步模型失败', body: messageOf(error) });
        })
        .then(function () {
          if (aliveRef.current) setSyncing(false);
        });
    }

    /**
     * 翻一段文字。
     *
     * 顺序是刻意的：**先翻译、成功了再写历史**。反过来的话，一次失败的翻译
     * （服务没起、模型名写错）也会在历史里留下一条空记录，而用户无法区分"我翻过
     * 这个但失败了"与"历史坏了"。
     */
    function translate(text) {
      var trimmed = typeof text === 'string' ? text.trim() : '';
      if (trimmed === '') {
        setNotice({ tone: 'warning', title: '没有可翻译的内容', body: '先输入或粘贴一段文字。' });
        return Promise.resolve();
      }
      if (busy) return Promise.resolve();
      setBusy(true);
      setNotice(null);

      var current = normalizeConfig(draft === null ? config : draft);
      if (!current.model.trim()) {
        setBusy(false);
        setNotice({
          tone: 'warning',
          title: '还没有配置模型',
          body: '到下面「模型与端点」那一节点一次「同步模型」，从服务端实际加载的模型里挑一个。',
        });
        return Promise.resolve();
      }

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
                '\n\n两种常见原因：接口形态选错了（chat / completion 换一个试试），或者这个服务不是 OpenAI 兼容的。'
            );
          }
          if (!aliveRef.current) return null;

          var at = Date.now();
          setResult({
            at: at,
            sourceLang: current.sourceLang,
            target: current.targetLang,
            model: current.model,
            text: parsed.text,
          });

          // 历史写失败**不影响这次结果**：译文已经在屏幕上了。与 `prune` 同一条取向。
          return recordEntry({
            at: at,
            sourceLang: current.sourceLang,
            targetLang: current.targetLang,
            model: current.model,
            srcChars: trimmed.length,
            body: parsed.text,
          })
            .then(function () {
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
          setNotice({ tone: 'error', title: '翻译失败', body: messageOf(error) });
        })
        .then(function () {
          if (aliveRef.current) setBusy(false);
        });
    }

    function copyText(text) {
      if (!ctx.clipboard || typeof ctx.clipboard.writeText !== 'function') {
        setNotice({
          tone: 'error',
          title: '复制不了',
          body: '这个运行位置没有 ctx.clipboard.writeText。',
        });
        return Promise.resolve();
      }
      return Promise.resolve()
        .then(function () {
          return ctx.clipboard.writeText(text);
        })
        .then(function () {
          flash('已复制到剪贴板');
        })
        .catch(function (error) {
          // 浏览器会拒绝未聚焦页面上的剪贴板写入 —— 那是拒绝，不是缺陷。
          setNotice({ tone: 'error', title: '复制失败', body: messageOf(error) });
        });
    }

    // ---------- 历史上的动作 ----------

    function loadMore() {
      if (!cursor || historyBusy) return;
      setHistoryBusy(true);
      return fetchPage(search, cursor)
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

    /**
     * 打开一条：把**全文**取回来（列表里只有预览），并放进结果区。
     *
     * 「打开」与 `clipboard-history` 那一处同一个含义 —— 把这一条送回主界面。
     * 这里只是把译文放进结果区（于是「复制译文」那一套动作立刻可用）。
     *
     * ⚠️ **原文没有被存下来，因此工作台的输入框不会被填上。** 这一版的历史只存
     * 译文与原文的**字符数**：存原文意味着把用户粘进来的每一段话都落一次盘，而
     * 一段被翻译的文字里出现密码、密钥、合同条款的概率一点也不低。要让"打开之后
     * 再翻一次"可用就得付那个代价，而这一版明确不付。
     */
    function openHistoryEntry(entry) {
      return readBody(entry.id).then(
        function (body) {
          if (!aliveRef.current) return;
          var text = body || entry.preview;
          setOpenEntry({ id: entry.id, text: text });
          setResult({
            at: entry.at,
            sourceLang: entry.sourceLang,
            target: entry.targetLang,
            model: entry.model,
            text: text,
          });
          setNotice({
            tone: 'info',
            title: '已打开这一条',
            body:
              '译文在下面的结果区，可以复制。原文没有存进历史（见历史那一节的说明），' +
              '因此输入框保持原样 —— 想再翻一次就把它重新粘进去。',
          });
        },
        function (error) {
          setNotice({ tone: 'error', title: '读这条历史失败', body: messageOf(error) });
        }
      );
    }

    function removeHistoryEntry(id) {
      return deleteEntries([id])
        .then(function () {
          return refreshStats();
        })
        .then(function () {
          return reloadHistory();
        })
        .catch(function (error) {
          setNotice({ tone: 'error', title: '删除失败', body: messageOf(error) });
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
          setNotice({ tone: 'error', title: '置顶状态没有保存', body: messageOf(error) });
        });
    }

    function clearHistory(includePinned) {
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
        .then(function (count) {
          flash(count > 0 ? '已删除 ' + count + ' 条历史' : '没有可删除的条目');
          return reloadHistory();
        })
        .catch(function (error) {
          setNotice({ tone: 'error', title: '清空失败', body: messageOf(error) });
        });
    }

    if (snapshot === null) {
      return h('div', { className: 'tr-root' }, h('div', { className: 'tr-loading' }, '正在读取状态…'));
    }

    var view = draft === null ? config : draft;
    var status = snapshot.status;
    var cache = snapshot.cache;
    var keyInfo = snapshot.keyInfo;

    var hotkeyAvailable = !!(ctx.hotkey && ctx.hotkey.isAvailable && ctx.hotkey.isAvailable());
    var selectionAvailable = !!(
      ctx.selection &&
      ctx.selection.isAvailable &&
      ctx.selection.isAvailable()
    );
    var clipboardAvailable = !!(ctx.clipboard && typeof ctx.clipboard.writeText === 'function');

    var hotkeyLine = describeHotkey(status, hotkeyAvailable, selectionAvailable);
    var endpointLine = describeEndpoint(cache, status);

    // 语言选择：草稿里优先（用户可能刚改完还没保存，但"翻译"用的是草稿值）。
    var effectiveSource = SOURCE_LANGS.some(function (item) {
      return item.value === view.sourceLang;
    })
      ? view.sourceLang
      : DEFAULT_SOURCE_LANG;
    var effectiveTarget = TARGET_LANGS.indexOf(view.targetLang) === -1 ? TARGET_LANGS[0] : view.targetLang;

    return h(
      'div',
      { className: 'tr-root' },
      h(
        'div',
        { className: 'tr-inner' },
        // ============================================================
        // 标题
        // ============================================================
        h(
          'div',
          { className: 'tr-head' },
          h('h2', { className: 'tr-title' }, '划词翻译'),
          h(
            'div',
            { className: 'tr-head-actions' },
            h(
              'button',
              {
                type: 'button',
                className: 'tr-btn tr-btn-ghost tr-btn-mini',
                onClick: function () {
                  refresh().then(function () {
                    return reloadHistory();
                  }).then(function () {
                    flash('已刷新');
                  });
                },
              },
              '刷新状态与历史'
            )
          )
        ),
        h(
          'p',
          { className: 'tr-sub' },
          '一个本机翻译工具：贴一段文字、选两个语言、拿到译文，翻过的东西会留在下面的历史里。',
          hotkeyAvailable
            ? h(
                'span',
                null,
                ' 在别的程序里选中文字按 ',
                h('kbd', null, config.triggerCombo),
                ' 也能翻（见最下面那一节）。'
              )
            : null
        ),

        // ============================================================
        // 翻译工作台（主视图）
        // ============================================================
        h(
          'section',
          { className: 'tr-card tr-card-workspace' },
          h(
            'div',
            { className: 'tr-card-head' },
            h('h3', { className: 'tr-card-title' }, '翻译'),
            h(
              'div',
              { className: 'tr-row' },
              h('span', { className: 'tr-count' }, input.length + ' / ' + INPUT_LIMIT),
              h(
                'button',
                {
                  type: 'button',
                  className: 'tr-btn tr-btn-ghost tr-btn-mini',
                  disabled: busy || input === '',
                  onClick: function () {
                    setInput('');
                    setResult(null);
                  },
                },
                '清空'
              )
            )
          ),

          // ---------- 语言 ----------
          h(
            'div',
            { className: 'tr-row tr-row-lang' },
            h(
              'label',
              { className: 'tr-lang' },
              h('span', { className: 'tr-lang-label' }, '源语言'),
              h(
                'select',
                {
                  className: 'tr-select tr-select-sm',
                  value: effectiveSource,
                  onChange: function (event) {
                    editDraft(SETTING_IDS.sourceLang, event.target.value);
                    commit(SETTING_IDS.sourceLang, event.target.value);
                  },
                },
                SOURCE_LANGS.map(function (item) {
                  return h('option', { key: item.value, value: item.value }, item.label);
                })
              )
            ),
            h('span', { className: 'tr-arrow' }, '→'),
            h(
              'label',
              { className: 'tr-lang' },
              h('span', { className: 'tr-lang-label' }, '目标语言'),
              h(
                'select',
                {
                  className: 'tr-select tr-select-sm',
                  value: effectiveTarget,
                  onChange: function (event) {
                    editDraft(SETTING_IDS.targetLang, event.target.value);
                    commit(SETTING_IDS.targetLang, event.target.value);
                  },
                },
                TARGET_LANGS.map(function (lang) {
                  return h('option', { key: lang, value: lang }, lang);
                })
              )
            ),
            h('span', { className: 'tr-chip-hint' }, '这两项会被记住，下次打开还是它们')
          ),

          // ---------- 原文 ----------
          h('textarea', {
            className: 'tr-textarea',
            value: input,
            rows: 6,
            maxLength: INPUT_LIMIT,
            placeholder: '把要翻译的文字粘贴或输入到这里（最多 ' + INPUT_LIMIT + ' 字符）',
            onChange: function (event) {
              setInput(event.target.value);
            },
            onKeyDown: function (event) {
              // Ctrl/Cmd + Enter 直接翻 —— 这是工作台里最常用的一条动作，
              // 而它在多行输入框里不会与"换行"冲突。
              if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                event.preventDefault();
                translate(input);
              }
            },
          }),

          h(
            'div',
            { className: 'tr-row tr-row-between' },
            h(
              'span',
              { className: 'tr-count' },
              'Ctrl + Enter 直接翻译 · 模型 ',
              h('code', null, config.model || '（空）')
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'tr-btn tr-btn-primary tr-btn-lg',
                disabled: busy || input.trim() === '',
                onClick: function () {
                  translate(input);
                },
              },
              busy ? '翻译中…' : '翻译'
            )
          ),

          // ---------- 译文 ----------
          result
            ? h(
                'div',
                { className: 'tr-workspace-result' },
                h(
                  'div',
                  { className: 'tr-card-head' },
                  h(
                    'h3',
                    { className: 'tr-card-title' },
                    '译文 → ' + result.target + (result.sourceLang && result.sourceLang !== 'auto' ? '（从 ' + result.sourceLang + '）' : '')
                  ),
                  h(
                    'div',
                    { className: 'tr-row' },
                    h('span', { className: 'tr-time' }, formatTime(result.at)),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'tr-btn tr-btn-ghost tr-btn-mini',
                        disabled: !clipboardAvailable,
                        title: clipboardAvailable ? '' : '这个运行位置没有剪贴板写入能力',
                        onClick: function () {
                          copyText(result.text);
                        },
                      },
                      '复制译文'
                    )
                  )
                ),
                // **只作为文本渲染**：译文来自模型，模型可能把它拼成任何东西。
                h('div', { className: 'tr-result-text' }, result.text)
              )
            : h(
                'div',
                { className: 'tr-empty' },
                '还没有译文。输入一段文字，然后点「翻译」或者按 Ctrl + Enter。'
              )
        ),

        // ============================================================
        // 提示 / 错误
        // ============================================================
        notice
          ? h(
              'div',
              { className: 'tr-banner tr-banner-' + notice.tone },
              h('strong', null, notice.title),
              notice.body ? h('pre', { className: 'tr-pre' }, notice.body) : null
            )
          : null,

        dbError
          ? h(
              'div',
              { className: 'tr-banner tr-banner-warn' },
              h('strong', null, '翻译历史'),
              h('span', null, ' ' + dbError)
            )
          : null,

        // ============================================================
        // 历史
        // ============================================================
        h(
          'section',
          { className: 'tr-card' },
          h(
            'div',
            { className: 'tr-card-head' },
            h('h3', { className: 'tr-card-title' }, '翻译历史'),
            h(
              'div',
              { className: 'tr-row' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'tr-btn tr-btn-ghost tr-btn-mini',
                  disabled: historyBusy || !databaseAvailable(),
                  onClick: function () {
                    reloadHistory();
                  },
                },
                historyBusy ? '读取中…' : '刷新'
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'tr-btn tr-btn-ghost tr-btn-mini',
                  disabled: !databaseAvailable() || (stats && stats.entries === 0),
                  title: '只删未置顶的条目',
                  onClick: function () {
                    clearHistory(false);
                  },
                },
                '清空未置顶'
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'tr-btn tr-btn-ghost tr-btn-mini',
                  disabled: !databaseAvailable() || (stats && stats.entries === 0),
                  title: '连置顶的条目一起删',
                  onClick: function () {
                    clearHistory(true);
                  },
                },
                '全部清空'
              )
            )
          ),

          h(
            'div',
            { className: 'tr-row' },
            h('input', {
              className: 'tr-input tr-input-flex',
              type: 'search',
              value: search,
              placeholder: '搜索译文全文（不是只搜预览的前 200 字符）',
              onChange: function (event) {
                setSearch(event.target.value);
              },
              onKeyDown: function (event) {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  reloadHistory();
                }
              },
            }),
            h(
              'button',
              {
                type: 'button',
                className: 'tr-btn tr-btn-ghost',
                disabled: historyBusy || !databaseAvailable(),
                onClick: function () {
                  reloadHistory();
                },
              },
              '搜索'
            ),
            search
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'tr-btn tr-btn-ghost tr-btn-mini',
                    onClick: function () {
                      setSearch('');
                      reloadHistory('');
                    },
                  },
                  '清除搜索'
                )
              : null
          ),

          h(
            'p',
            { className: 'tr-note' },
            '保留策略：未置顶的条目最多 ' +
              MAX_ENTRIES +
              ' 条、最多 ' +
              MAX_AGE_DAYS +
              ' 天（超出之后从最旧的开始删）；**置顶的条目不计入这两个数、也不会被它们删掉**，但译文总量超过 ' +
              Math.round(MAX_BODY_CHARS / 10000) +
              ' 万字符的硬顶时，最旧的条目（包括置顶的）会被删。'
          ),

          entries.length === 0
            ? h(
                'p',
                { className: 'tr-empty' },
                search ? '没有匹配的条目。' : '还没有翻译记录。上面翻一段就会出现在这里。'
              )
            : h(
                'ul',
                { className: 'tr-history' },
                entries.map(function (entry) {
                  return h(
                    'li',
                    { key: String(entry.id), className: 'tr-history-item' },
                    h(
                      'div',
                      { className: 'tr-history-head' },
                      entry.pinned
                        ? h('span', { className: 'tr-tag tr-tag-pin' }, '置顶')
                        : null,
                      h(
                        'span',
                        { className: 'tr-time' },
                        formatTime(entry.at) +
                          ' · ' +
                          (entry.sourceLang && entry.sourceLang !== 'auto' ? entry.sourceLang + ' → ' : '') +
                          entry.targetLang
                      ),
                      h(
                        'div',
                        { className: 'tr-history-actions' },
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'tr-btn tr-btn-ghost tr-btn-mini',
                            onClick: function () {
                              openHistoryEntry(entry);
                            },
                          },
                          '打开'
                        ),
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'tr-btn tr-btn-ghost tr-btn-mini',
                            onClick: function () {
                              readBody(entry.id).then(
                                function (body) {
                                  copyText(body || entry.preview);
                                },
                                function (error) {
                                  setNotice({ tone: 'error', title: '读这条历史失败', body: messageOf(error) });
                                }
                              );
                            },
                          },
                          '复制'
                        ),
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'tr-btn tr-btn-ghost tr-btn-mini',
                            title: '置顶的条目不会被自动清理（除非总量撞上硬顶）',
                            onClick: function () {
                              togglePin(entry);
                            },
                          },
                          entry.pinned ? '取消置顶' : '置顶'
                        ),
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'tr-btn tr-btn-ghost tr-btn-mini',
                            onClick: function () {
                              removeHistoryEntry(entry.id);
                            },
                          },
                          '删除'
                        )
                      )
                    ),
                    // **只作为文本渲染**。预览来自模型，绝不拼进标记。
                    h('div', { className: 'tr-history-text' }, entry.preview),
                    openEntry && openEntry.id === entry.id
                      ? h('div', { className: 'tr-open' }, h('div', { className: 'tr-history-text' }, openEntry.text))
                      : null,
                    h(
                      'div',
                      { className: 'tr-history-foot' },
                      h('span', { className: 'tr-time' }, entry.model),
                      h(
                        'span',
                        { className: 'tr-time' },
                        '原文 ' + entry.srcChars + ' 字符 · 译文 ' + entry.bodyChars + ' 字符'
                      )
                    )
                  );
                })
              ),

          hasMore
            ? h(
                'div',
                { className: 'tr-row' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'tr-btn tr-btn-ghost',
                    disabled: historyBusy,
                    onClick: loadMore,
                  },
                  historyBusy ? '加载中…' : '加载更多'
                )
              )
            : null,

          h(
            'p',
            { className: 'tr-note' },
            '⚠️ 热键翻出来的译文**不会**出现在这里：那一半跑在另一个进程里，而数据库由这一屏写（把"要不要留档"的决定交给一次按键太轻率）。'
          )
        ),

        // ============================================================
        // 统计
        // ============================================================
        h(
          'section',
          { className: 'tr-card' },
          h('h3', { className: 'tr-card-title' }, '统计'),
          stats
            ? h(
                'div',
                { className: 'tr-stats' },
                h(StatCell, { label: '条目', value: String(stats.entries) }),
                h(StatCell, { label: '置顶', value: String(stats.pinned) }),
                h(StatCell, { label: '译文总量', value: stats.bodyChars + ' 字符' }),
                h(StatCell, { label: '数据库文件', value: formatBytes(stats.dbBytes) })
              )
            : h('p', { className: 'tr-empty' }, '还没有读到统计数据。'),
          h(
            'p',
            { className: 'tr-note' },
            '「数据库文件」是 `PRAGMA page_count × page_size` 的结果 —— `ctx.db` 没有大小查询接口，而宿主给这个数据库的**页数上限**是插件数据配额的一半（' +
              '见宿主 `plugins/db.rs`）。它包含索引本身，因此略大于译文总量。'
          )
        ),

        // ============================================================
        // 模型与端点
        // ============================================================
        h(
          'section',
          { className: 'tr-card' },
          h(
            'div',
            { className: 'tr-card-head' },
            h('h3', { className: 'tr-card-title' }, '模型与端点'),
            h(
              'button',
              {
                type: 'button',
                className: 'tr-btn tr-btn-ghost tr-btn-mini',
                disabled: syncing,
                onClick: runSync,
              },
              syncing ? '同步中…' : '同步模型'
            )
          ),
          h(
            'p',
            { className: 'tr-note' },
            '往 ',
            h('code', null, joinUrl(view.baseUrl, 'models')),
            ' 发一次 GET，把服务端实际加载的模型读回来。'
          ),
          cache
            ? h(
                'div',
                { className: 'tr-cache' },
                h(
                  'div',
                  { className: 'tr-cache-line' },
                  cache.ok
                    ? h('span', { className: 'tr-tag tr-tag-ok' }, '上次探测成功')
                    : h('span', { className: 'tr-tag tr-tag-error' }, '上次探测失败'),
                  h(
                    'span',
                    { className: 'tr-time' },
                    formatTime(cache.at) + '（' + formatAgo(cache.at) + '）'
                  ),
                  cache.base ? h('span', { className: 'tr-time' }, ' · ' + cache.base) : null
                ),
                cache.ok && Array.isArray(cache.models) && cache.models.length > 0
                  ? h(
                      'div',
                      { className: 'tr-models' },
                      cache.models.map(function (id) {
                        var selected = id === config.model;
                        return h(
                          'button',
                          {
                            key: id,
                            type: 'button',
                            className: 'tr-model' + (selected ? ' tr-model-on' : ''),
                            onClick: function () {
                              commit(SETTING_IDS.model, id);
                            },
                          },
                          id
                        );
                      })
                    )
                  : h('pre', { className: 'tr-pre' }, cache.error || '（没有可用的模型列表）')
              )
            : h(
                'div',
                { className: 'tr-cache' },
                h(
                  'p',
                  { className: 'tr-note' },
                  '还没有探测过。点一次「同步模型」—— 它同时也是"服务在不在"的测试。'
                )
              ),

          h(
            Field,
            {
              label: '模型服务地址（base URL）',
              hint:
                '结尾带不带斜杠都行。本机默认 ' +
                DEFAULT_BASE_URL +
                '。' +
                (view.baseUrl && !isLoopback(view.baseUrl)
                  ? ' ⚠ 这不是本机回环地址 —— 除了 network 权限之外还要声明 network-external，否则请求会被宿主拒绝。'
                  : ''),
            },
            h('input', {
              className: 'tr-input',
              type: 'text',
              value: view.baseUrl,
              onChange: function (event) {
                editDraft(SETTING_IDS.baseUrl, event.target.value);
              },
              onBlur: function () {
                commit(SETTING_IDS.baseUrl, view.baseUrl.trim());
              },
            })
          ),

          h(
            Field,
            {
              label: '接口形态',
              hint:
                'chat 走 /chat/completions，completion 走 /completions。有些 llama.cpp 构建在 chat 那一侧不稳，换 completion 试试。',
            },
            h(
              'select',
              {
                className: 'tr-select',
                value: view.endpointKind,
                onChange: function (event) {
                  editDraft(SETTING_IDS.endpointKind, event.target.value);
                  commit(SETTING_IDS.endpointKind, event.target.value);
                },
              },
              h('option', { value: 'chat' }, 'chat（/chat/completions）'),
              h('option', { value: 'completion' }, 'completion（/completions）')
            )
          ),

          h(
            Field,
            {
              label: '模型',
              hint: '请求体里的 model 字段，必须与服务端加载的那一个逐字一致。建议用上面的「同步模型」而不是手打。',
            },
            h('input', {
              className: 'tr-input',
              type: 'text',
              value: view.model,
              onChange: function (event) {
                editDraft(SETTING_IDS.model, event.target.value);
              },
              onBlur: function () {
                commit(SETTING_IDS.model, view.model.trim());
              },
            })
          ),

          h(
            Field,
            {
              label: '提示词模板',
              hint:
                '占位符：{text}（必需、**最后**替换）、{target}、{source}。本地小模型的译文质量对格式极其敏感，因此这里是可改的 —— 一个写死的模板等于"只在作者那一个模型上能用"。',
            },
            h(
              'div',
              null,
              h('textarea', {
                className: 'tr-textarea tr-textarea-mono',
                value: view.promptTemplate,
                rows: 6,
                onChange: function (event) {
                  editDraft(SETTING_IDS.promptTemplate, event.target.value);
                },
                onBlur: function () {
                  commit(SETTING_IDS.promptTemplate, view.promptTemplate);
                },
              }),
              h(
                'div',
                { className: 'tr-row' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'tr-btn tr-btn-ghost tr-btn-mini',
                    onClick: function () {
                      editDraft(SETTING_IDS.promptTemplate, DEFAULT_PROMPT_TEMPLATE);
                      commit(SETTING_IDS.promptTemplate, DEFAULT_PROMPT_TEMPLATE);
                    },
                  },
                  '恢复缺省模板'
                ),
                h('span', { className: 'tr-chip-hint' }, '当前源语言替换后的 {source} 是：' + (effectiveSource === 'auto' ? SOURCE_AUTO_HINT : effectiveSource))
              ),
              h(
                'p',
                { className: 'tr-note' },
                '用通用小模型时把指令换成英文往往更稳，例如 Translate the following text into {target}. Output only the translation.'
              )
            )
          )
        ),

        // ============================================================
        // 热键流程（单独一节，默认收起）
        // ============================================================
        h(
          'section',
          { className: 'tr-card' },
          h(
            'div',
            { className: 'tr-card-head' },
            h('h3', { className: 'tr-card-title' }, '划词热键流程'),
            h(
              'button',
              {
                type: 'button',
                className: 'tr-btn tr-btn-ghost tr-btn-mini',
                onClick: function () {
                  setHotkeyOpen(!hotkeyOpen);
                },
              },
              hotkeyOpen ? '收起' : '展开'
            )
          ),
          h(
            'p',
            { className: 'tr-note' },
            '这一节是**可选**的：在别的程序里选中文字，按一下组合键，光标旁边弹出一张译文卡片。它需要 Node 运行时（后台进程）与 Windows，而上面的翻译工作台两样都不需要。'
          ),

          // 状态行：热键与端点。收起来时也显示 —— 它是"这一节能不能用"的答案。
          h(
            'div',
            { className: 'tr-status' },
            h(StatusRow, {
              label: '热键',
              value: hotkeyLine.value,
              tone: hotkeyLine.tone,
              detail: hotkeyLine.detail,
            }),
            h(StatusRow, {
              label: '端点',
              value: endpointLine.value,
              tone: endpointLine.tone,
              detail: endpointLine.detail,
            }),
            h(StatusRow, {
              label: '后台',
              value: status && status.at ? '上报于 ' + formatAgo(status.at) : '还没有上报',
              tone: status && status.at ? 'ok' : 'warn',
              detail: '后台进程写状态、这一屏读它。没有推送通道，因此它可能是上一次打开时的快照',
            })
          ),

          !hotkeyAvailable || !selectionAvailable
            ? h(
                'div',
                { className: 'tr-banner tr-banner-warn' },
                h('strong', null, '热键流程在这个平台上不可用。'),
                h(
                  'span',
                  null,
                  ' 全局热键（RegisterHotKey）与读取选中文本（SendInput）都只在 Windows 上存在' +
                    (hotkeyAvailable ? '' : '；这里 ctx.hotkey.isAvailable() 是 false') +
                    (selectionAvailable ? '' : '；这里 ctx.selection.isAvailable() 是 false') +
                    '。上面的翻译工作台照常能用。'
                )
              )
            : null,

          hotkeyOpen
            ? h(
                'div',
                { className: 'tr-hotkey-body' },
                h(Field, {
                  label: '触发组合键',
                  hint:
                    '点一下右边的方框，然后按下你要的组合键（不用手写）。只按功能键（F1..F24）或按住 Ctrl / Alt / Shift 中的至少一个 —— 单个普通键在这里会被拒绝，因为全局热键是独占的，它会把这个键从整台机器上所有程序里拿走。改完最多一分钟生效 —— 后台每 60 秒对一次账，因为那里没有设置变更回调。组合键在系统里是独占的，冲突时错误会点名是谁占着。',
                }, h(HotkeyRecorder, {
                  combo: view.triggerCombo,
                  onCommit: function (combo) {
                    // 先写草稿再落盘：`commit` 会按服务端实际值回读一次，而回读
                    // 发生在它内部，因此这里必须先把草稿改成新的值（与上面那些
                    // 输入框同一条路径，不另开一套保存逻辑）。
                    editDraft(SETTING_IDS.triggerCombo, combo);
                    return commit(SETTING_IDS.triggerCombo, combo);
                  },
                  onClear: function () {
                    editDraft(SETTING_IDS.triggerCombo, '');
                    return commit(SETTING_IDS.triggerCombo, '');
                  },
                  onNotice: setNotice,
                })),

                h(
                  'div',
                  { className: 'tr-sub-card' },
                  h('h4', { className: 'tr-sub-title' }, 'API key'),
                  h(
                    'p',
                    { className: 'tr-note' },
                    '它不存在设置里，也不存在插件的任何文件里：写进 ctx.secrets 之后，密文落在插件数据目录之外，由本机硬件指纹派生的密钥加密，而且不属于任何备份类别。代价写在这里：换机器（或换网卡、改主机名）之后解不开 —— 那时后台会原样告诉你"密文仍在磁盘上、没有被删除"，重新输入一次即可。'
                  ),
                  h(
                    'div',
                    { className: 'tr-key-state' },
                    keyInfo.known && keyInfo.present
                      ? h('span', { className: 'tr-tag tr-tag-ok' }, '已保存（加密）')
                      : h('span', { className: 'tr-tag tr-tag-muted' }, '未设置'),
                    keyInfo.error ? h('span', { className: 'tr-tag tr-tag-error' }, keyInfo.error) : null,
                    h('span', { className: 'tr-time' }, '本地 llama.cpp 的 server 默认不校验密钥，因此留空也能用')
                  ),
                  h(
                    'div',
                    { className: 'tr-row' },
                    h('input', {
                      className: 'tr-input tr-input-flex',
                      // **`type="password"`，而且 `value` 永远是空的**：把已保存的密钥
                      // 作为 value 渲染等于把它放进一个可以被截图、被开发者工具读出来的
                      // 地方。输入框只负责**写入**，从不负责回显。
                      type: 'password',
                      value: keyDraft,
                      autoComplete: 'off',
                      spellCheck: false,
                      placeholder: keyInfo.present ? '已保存（留空并点删除可清除）' : 'sk-local 一类（本机服务通常随便填）',
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
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'tr-btn tr-btn-primary',
                        disabled: keyDraft === '',
                        onClick: commitKey,
                      },
                      '保存密钥'
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'tr-btn tr-btn-ghost',
                        disabled: !keyInfo.present,
                        onClick: function () {
                          if (!ctx.secrets || typeof ctx.secrets.delete !== 'function') return;
                          ctx.secrets.delete(SECRET_API_KEY).then(
                            function () {
                              flash('API key 已删除');
                              return refresh();
                            },
                            function (error) {
                              setNotice({ tone: 'error', title: '删除失败', body: messageOf(error) });
                            }
                          );
                        },
                      },
                      '删除'
                    )
                  )
                )
              )
            : null
        ),

        saveFlash ? h('div', { className: 'tr-flash' }, saveFlash) : null,

        h(
          'p',
          { className: 'tr-footnote' },
          '权限：storage（设置与后台状态）、plugin-data（翻译历史，也就是下面的 ctx.db）、network（只在 ' +
            DEFAULT_BASE_URL +
            ' 这类本机地址上，远端地址还需要 network-external）、notification（结果卡片）、clipboard（把译文放回剪贴板）、secrets（API key）、global-hotkey 与 read-selection（热键与读选中文本，都只有 Windows 上有）。'
        )
      )
    );
  }

  // ============================================================
  // 小组件
  // ============================================================

  function StatusRow(props) {
    return h(
      'div',
      { className: 'tr-status-row' },
      h('span', { className: 'tr-status-label' }, props.label),
      h('span', { className: 'tr-status-value tr-status-' + props.tone }, props.value),
      props.detail ? h('span', { className: 'tr-status-detail' }, props.detail) : null
    );
  }

  function Field(props) {
    return h(
      'div',
      { className: 'tr-field' },
      h('label', { className: 'tr-field-label' }, props.label),
      props.hint ? h('p', { className: 'tr-field-hint' }, props.hint) : null,
      props.children
    );
  }

  // ============================================================
  // 录制式组合键控件
  // ============================================================
  //
  // ============================================================
  // 为什么是"按一下"而不是"打一行字"
  // ============================================================
  //
  // 上一版这里是一个 `type="text"` 输入框，让用户**手写** `mod+k` 这一串。那有三个
  // 具体的问题，而且都不是美观问题：
  //
  //   1. **用户要猜。** 语法只存在于文档与代码里（见上面"组合键"那一节），而输入框
  //      没有任何东西告诉他 `Ctrl+K` 与 `mod+k` 是同一个键、`shift+mod+tab` 与
  //      `mod+shift+tab` 也一样。写错的代价不是一句报错，而是"改完最多一分钟生效"
  //      之后一次静默的注册失败。
  //   2. **写出来的是字符串，按下去的是键。** 用户以为他填的是"我按的那个组合"，
  //      实际填的是一个需要与后台解析器逐字对上的字符串 —— 这两者之间每一处不一致
  //      都表现为"这个热键没反应"。
  //   3. **边界全都要靠他记住。** 宿主拒绝裸的非功能键（那会把那个键从整台机器上
  //      拿走，见 `hotkey.rs::key_may_be_bare`）。输入框对此一无所知，只能等注册失败。
  //
  // 录制控件把这三件事都收回到控件自己身上：用户**按**他要的组合，控件负责把它
  // 变成合法字符串，并在它不合法时立刻说清为什么。
  //
  // ============================================================
  // 录制期间必须**吃掉**这次按键
  // ============================================================
  //
  // `preventDefault()` + `stopPropagation()` 不是可选的：少一个都可能让这次按键
  // 顺着宿主界面跑下去（宿主自己有一批 `Ctrl+K` 一类的快捷键），而那会变成
  // "我按组合键时面板里别的东西也动了"。这里连 `keyCode` 都不去动 —— 只读。
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

    // 组合键在设置里归一化之后的形态（空 = 没有绑定）。
    var bound = canonicalCombo(props.combo);
    // 保存一次之后就不再收键。少了它，`commit` 是异步的，用户在等的时候再按一下
    // 就会叠上第二次保存（并且第二次是对着一个还没刷新的值）。
    var finishedRef = React.useRef(false);
    // 第几次录制。保存是异步的，而用户可能在它回来之前就取消了（Esc / 点别处 /
    // 点了「清除绑定」）—— 那一次保存的成功回调**不许**再回来把控件改回静止态，
    // 否则界面上显示的会是"已经录好了"，而用户刚刚明确说了不要它。
    var sessionRef = React.useRef(0);

    function stopRecording() {
      setRecording(false);
      setPreview('');
    }

    /** 开始录制。**清掉上一次的提示**：它是上一次的事实，留着会误导。 */
    function begin() {
      sessionRef.current += 1;
      finishedRef.current = false;
      setMessage('');
      setPreview('');
      setRecording(true);
    }

    /** Escape（不带修饰符）取消录制并把原来的值原样留着 —— 不落盘任何东西。 */
    function cancel() {
      sessionRef.current += 1;
      finishedRef.current = true;
      stopRecording();
      setMessage('');
      props.onNotice({
        tone: 'info',
        title: '已取消录制',
        body: '组合键没有被改动（还是「' + (bound || '未设置') + '」）。',
      });
    }

    function onKeyDown(event) {
      if (!recording || finishedRef.current) return;

      // 录制期间**任何**按键都不许再往下走：宿主界面上挂着自己的快捷键，
      // 而用户此刻的意图是"在这个控件里按一个组合"。
      event.preventDefault();
      event.stopPropagation();

      // 只按下修饰键时继续等：`Ctrl` 本身不是一个绑定，而把它当成"录好了"
      // 会让用户永远录不出 `Ctrl+K`（他按下 Ctrl 的那一刻录制就结束了）。
      if (isLoneModifierKey(event)) {
        setPreview(comboPreview(event));
        return;
      }

      // 不带修饰符的 Escape = 取消。带修饰符的 Escape 是一个**合法**的组合
      // （`accelerator` 认 `escape`），因此它照常被录下来。
      if (event.key === 'Escape' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
        cancel();
        return;
      }

      var key = hotkeyKeyName(event.key);
      if (key === '') {
        // 认不出的键**不猜**：把它记成别的键会让用户"按了 A、绑成了 B"。
        setPreview(comboPreview(event));
        setMessage('这个键不能用作组合键。可用的是单个字母 / 数字、F1..F24，以及 ' +
          'Backspace / Tab / Enter / Escape / Space / PageUp / PageDown / Home / End / ' +
          '方向键 / Insert / Delete。');
        return;
      }

      var combo = comboFromEvent(event);
      if (combo === null) {
        // 到这里只可能是"一个修饰符都没有、而主键又不是功能键"。把宿主那句话
        // 抄给用户 —— 这是他在保存之前唯一能改主意的时刻。
        setPreview(comboPreview(event));
        setMessage('单个普通键不能做全局热键：那会把这个键从「整台机器」上所有程序里' +
          '拿走（用户在任何一个程序里都打不出它）。请按住 Ctrl / Alt / Shift 中的至少一个' +
          '再按这个键，或者改用 F1..F24。');
        return;
      }

      finishedRef.current = true;
      setPreview(comboPreview(event));

      // 从这里起，"这一下按键算不算数"由保存的结果回答。**因此在结果回来之前
      // 不收尾**：立刻把控件切回静止态会让用户以为录好了，而设置其实没写成。
      setMessage('正在保存 ' + combo + '…');

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
          // 失败（或这个运行位置没有 ctx.settings）时留在录制态，并把刚才那一下
          // 显示出来：用户再按一次就是重录。**不接受这个组合**，因为宿主也没接受。
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

    var label = bound === '' ? '未设置' : bound;
    var shown = recording ? '请按下组合键…' : label;

    var button = h(
      'button',
      {
        type: 'button',
        className: 'tr-recorder' + (recording ? ' tr-recorder-on' : ''),
        // 录制时把焦点留在自己身上：失焦会走到下面的 onBlur 分支，而用户点一下
        // 别处本来也确实该取消 —— 两种情况语义一致。
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
    );

    return h(
      'div',
      { className: 'tr-recorder-row' },
      button,
      h(
        'button',
        {
          type: 'button',
          className: 'tr-btn tr-btn-ghost tr-btn-mini',
          // 已经"未设置"时再清一次没有意义 —— 禁用比一个点了什么都不发生的按钮诚实。
          disabled: props.disabled === true || bound === '',
          onClick: function () {
            setMessage('');
            stopRecording();
            props.onClear();
          },
        },
        '清除绑定'
      ),
      recording || message
        ? h('p', { className: 'tr-recorder-msg' + (message ? ' tr-recorder-msg-warn' : '') },
            message || '按住 Ctrl / Alt / Shift 中的至少一个再按主键；只按功能键（F1..F24）也可以。Esc 取消。')
        : null
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

  /**
   * 热键那一行的措辞。
   *
   * 后台写下的状态是**权威**：它记的是"宿主真的绑上了没有"。`ctx.hotkey.isAvailable()`
   * 只回答"这件事在这个平台上可不可能"，两者不是一回事（组合键可能被别人占着）。
   * 状态还没有（后台没跑起来 / 没装 Node）时也要如实说，而不是显示一个看起来
   * 正常的默认值。
   */
  function describeHotkey(status, hotkeyAvailable, selectionAvailable) {
    if (!hotkeyAvailable) {
      return { value: '这个平台不支持', tone: 'off', detail: '只有 Windows 有 RegisterHotKey / SendInput' };
    }
    if (!status || !status.hotkeyState) {
      return {
        value: '后台还没有上报',
        tone: 'warn',
        detail: '后台插件可能没在跑（它需要 Node 运行时），或者刚刚启动',
      };
    }
    if (status.hotkeyState === 'registered') {
      return { value: '已注册 ' + (status.registeredCombo || status.desiredCombo || ''), tone: 'ok', detail: '' };
    }
    if (status.hotkeyState === 'failed') {
      return { value: '注册失败', tone: 'error', detail: status.hotkeyError || '' };
    }
    if (status.hotkeyState === 'unset') {
      return { value: '没有设置', tone: 'warn', detail: '设置里的触发组合键是空的' };
    }
    return { value: '不可用', tone: 'error', detail: status.hotkeyError || '' };
  }

  /** 端点那一行：**只**能来自上一次探测 —— 没有探测就没有事实可说。 */
  function describeEndpoint(cache, status) {
    if (!cache) {
      return {
        value: '还没有探测过',
        tone: 'warn',
        detail: status && status.endpoint ? '后台当前配置：' + status.endpoint : '',
      };
    }
    var when = formatTime(cache.at) + '（' + formatAgo(cache.at) + '）';
    if (cache.ok) {
      return {
        value: '可达（' + (Array.isArray(cache.models) ? cache.models.length : 0) + ' 个模型）',
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
      icon: 'Languages',
      priority: 76,
      component: TranslatePanel,
    });
  });
})();
