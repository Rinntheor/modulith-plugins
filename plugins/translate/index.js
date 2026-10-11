// plugins/translate/index.js
//
// 划词翻译 —— 面板那一半。跑在**沙箱 iframe** 里，与 `background.js`
// （一个独立的 Node 进程）没有共享的 JS 上下文。
//
// ============================================================
// 这个文件为什么存在（后台那一半已经能翻译了）
// ============================================================
//
// 三条理由，各自独立：
//
//   1. **热键流程只在 Windows 上有**（`RegisterHotKey` / `SendInput`）。在别的
//      平台上，后台那条路一次都不会触发 —— 面板里的手动翻译是那里唯一可用的形态。
//   2. **配置要有个地方改。** 清单里的 `contributes.settings` 能让宿主画出通用
//      控件，但有两件事它做不到：API key 的写入（它是**密钥**，不进设置），以及
//      "从服务端读回它实际加载了哪些模型" —— 后者需要一个按钮与一段会变的列表。
//   3. **状态要看得见。** 热键注册失败、服务没启动、模型没加载，这三件事在后台
//      那一侧只能靠一张会自己消失的卡片说出来。面板要能**常驻**地显示它们。
//
// ============================================================
// 两个进程之间只有一条通道：宿主的存储与设置
// ============================================================
//
// 后台把运行状态写在 `ctx.storage` 的 `runtimeStatus` 里；面板读它。没有推送，
// 因此面板**不会自动更新** —— 只在打开 / 重新可见 / 用户点「刷新状态」时读一次。
// 刻意不挂定时轮询：那会让这个插件在后台一直发 RPC，换来的只是更新一份用户
// 多半没在看的缓存（与 `clipboard-history` 在设置那一节的取舍同一条理由）。
//
// 由此有一条**必须对用户说清楚**的限制：**热键翻出来的译文不会出现在下面的
// 历史里。** 那段文字是后台进程拿到的，面板根本没有途径看到它 —— 而"为了让面板
// 显示它就把译文写进存储"是这一版明确拒绝的做法（见下面隐私那一节）。
//
// ============================================================
// 隐私：这个文件里同样有一条不许破例的规矩
// ============================================================
//
// **用户输入的原文与译文一个字都不进 console、不进 ctx.logger、不进
// ctx.notifications、不进 ctx.storage。** 它们只出现在 DOM 里（用户自己面前的
// 这一屏）与剪贴板（用户自己按的按钮）。
//
// 尤其不许写进存储：`ctx.storage` 是明文 JSON，而且进「插件数据」备份类别 ——
// 用户可能选中的是一段密码或一段合同，那两样都不该躺在一个会被复制到别的机器上的
// 文件里。因此"这一轮的历史"只在内存里，面板一卸载就没了。
//
// 另有一条同样要紧的：**API key 绝不作为 `value` 渲染进 DOM**（那就等于把它写进
// 一个可以被截图、被开发者工具读出来的地方）。输入框永远是空的，只在旁边显示
// "已保存 / 未设置"，那份状态来自 `ctx.secrets.keys()` —— 它**只有键名，没有值**。
//
// ============================================================
// 一切来自外部的文本都按不可信处理
// ============================================================
//
// 原文（用户输入的 / 后台从剪贴板拿的）、译文、模型 id、服务端的错误响应体，
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
    targetLang: 'targetLang',
  };

  var DEFAULT_BASE_URL = 'http://127.0.0.1:5566/v1';
  var DEFAULT_ENDPOINT_KIND = 'chat';
  var DEFAULT_MODEL = 'Hy MT2 1.8B Q4_K_M.gguf';
  var DEFAULT_TARGET_LANG = '简体中文';
  var DEFAULT_TRIGGER_COMBO = 'Ctrl+Q';
  var DEFAULT_PROMPT_TEMPLATE =
    '把下面这段文本翻译成{target}。只输出译文本身，不要解释、不要加引号、不要重复原文。\n\n{text}';

  var SECRET_API_KEY = 'apiKey';
  var STATUS_KEY = 'runtimeStatus';
  var CACHE_KEY = 'modelsCache';

  var MAX_TOKENS = 1024;
  var ERROR_BODY_LIMIT = 600;

  /** 历史最多留多少条。**只在内存里**，因此这个数管的是这一屏的长度，不是磁盘。 */
  var HISTORY_LIMIT = 20;

  /** 手动翻译一次最多收多少字符。防止把一整本书粘进去 —— 那对本地小模型毫无意义。 */
  var INPUT_LIMIT = 8000;

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
      pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds())
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
      lines.push('（服务端拒绝了这次请求：检查下面的 API key 是否与服务端一致）');
    } else if (status === 404 || status === 405) {
      lines.push(
        '（这个地址上没有 OpenAI 兼容接口。llama.cpp 的 server 默认是 ' +
          DEFAULT_BASE_URL +
          '，而单数的 /completion 是它的原生接口）'
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
   * 请求一次并拿回 `{ status, body, json }`。
   *
   * `GET` 用于 `/models`：它不带请求体，也**不需要**任何用户内容 ——
   * 这是"探测"这件事能安全地把响应体显示给用户的前提。
   */
  function request(config, method, path, payload) {
    var url = joinUrl(config.baseUrl, path);
    var headers = {};
    var body = null;
    if (payload !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(payload);
    }
    if (config.apiKey) headers.authorization = 'Bearer ' + config.apiKey;

    return ctx.http
      .fetch(url, { method: method, headers: headers, body: body })
      .then(
        function (response) {
          return readResponse(response);
        },
        function (error) {
          // 传输层失败（服务没启动 / 被策略拒绝 / DNS）。宿主那句话是唯一知道
          // 原因的地方，因此原样带上。用 code 让调用方能分开处理 —— 那三种
          // 失败需要用户做的事完全不同。
          var wrapped = new Error(
            '连不上 ' + url + '\n' + messageOf(error)
          );
          wrapped.failureCode = 'refused';
          wrapped.url = url;
          throw wrapped;
        }
      )
      .then(function (result) {
        if (result.status < 200 || result.status >= 300) {
          var failure = httpError(url, result.status, result.body);
          failure.failureCode = result.status === 401 || result.status === 403 ? 'auth' : 'http';
          failure.status = result.status;
          failure.body = result.body;
          failure.url = url;
          throw failure;
        }
        if (result.readError) throw new Error('读响应体失败：' + result.readError);
        return { status: result.status, body: result.body, json: parseJson(url, result.body) };
      });
  }

  // ============================================================
  // 提示词 / 请求体 / 解析（与 background.js 同一套逻辑）
  // ============================================================

  function buildPrompt(config, text) {
    var template = config.promptTemplate;
    if (typeof template !== 'string' || template.trim() === '') template = DEFAULT_PROMPT_TEMPLATE;
    if (template.indexOf('{text}') === -1) template = DEFAULT_PROMPT_TEMPLATE;
    // `{text}` **最后**替换：插进去的原文后面不再被任何一次替换扫到，因此原文里
    // 字面上的 `{target}` 会原样保留（反过来写就会把用户没见过的文字送去翻译）。
    return template
      .split('{target}')
      .join(config.targetLang)
      .split('{source}')
      .join('原文的语言（由你判断）')
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
    if (trimmed === '') return { ok: false, reason: '服务端回了一个空内容（' + field + ' 是空串）' };
    return { ok: true, text: trimmed, field: field };
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
    return Promise.all([readSettings(), readKeyInfo(), readStored(STATUS_KEY, null), readStored(CACHE_KEY, null)]).then(
      function (values) {
        return {
          config: values[0],
          keyInfo: values[1],
          status: isObject(values[2]) ? values[2] : null,
          cache: isObject(values[3]) ? values[3] : null,
        };
      }
    );
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
          code: code === 'auth' ? 'auth' : 'http',
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

    var historyState = React.useState([]);
    var history = historyState[0];
    var setHistory = historyState[1];

    var busyState = React.useState(false);
    var busy = busyState[0];
    var setBusy = busyState[1];

    var syncingState = React.useState(false);
    var syncing = syncingState[0];
    var setSyncing = syncingState[1];

    var saveFlashState = React.useState('');
    var saveFlash = saveFlashState[0];
    var setSaveFlash = saveFlashState[1];

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

    function runSync() {
      if (syncing) return Promise.resolve();
      setSyncing(true);
      setNotice(null);
      var current = draft === null ? config : draft;
      var modelForRequest = normalizeConfig(current);
      // 同步要用**当前草稿里**的地址与形态（用户可能刚改完还没保存就想试一下），
      // 但密钥只从加密库里取 —— 它不在草稿里，也永远不会在。
      return readKeyInfo()
        .then(function () {
          if (!ctx.secrets || typeof ctx.secrets.get !== 'function') return null;
          return ctx.secrets.get(SECRET_API_KEY).then(
            function (value) {
              return typeof value === 'string' && value.length > 0 ? value : null;
            },
            function (error) {
              // 解不开的密文：原样说出来（那条消息里写着"密文仍然在磁盘上"）。
              setNotice({
                tone: 'error',
                title: 'API key 读不出来',
                body: messageOf(error) + '\n\nGET /models 会不带 Authorization 头继续发。',
              });
              return null;
            }
          );
        })
        .then(function (key) {
          modelForRequest.apiKey = key;
          return syncModels(modelForRequest);
        })
        .then(function (outcome) {
          if (!aliveRef.current) return outcome;
          // 缓存与展示分开：**缓存的永远是结果**（成功或失败都写），
          // 因为"上次探测是什么结果、什么时候"正是状态行要说的事。
          return readStored(CACHE_KEY, null)
            .then(function () {
              return ctx.storage ? ctx.storage.set(CACHE_KEY, outcome) : null;
            })
            .then(function () {
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

    function pushHistory(entry) {
      setHistory(function (current) {
        var next = [entry];
        for (var i = 0; i < current.length && next.length < HISTORY_LIMIT; i++) next.push(current[i]);
        return next;
      });
    }

    function translate(text, origin) {
      var trimmed = typeof text === 'string' ? text.trim() : '';
      if (trimmed === '') {
        setNotice({ tone: 'warning', title: '没有可翻译的内容', body: '先输入或粘贴一段文字。' });
        return Promise.resolve();
      }
      if (busy) return Promise.resolve();
      setBusy(true);
      setNotice(null);

      var current = normalizeConfig(draft === null ? config : draft);
      var keyPromise =
        ctx.secrets && typeof ctx.secrets.get === 'function'
          ? Promise.resolve(ctx.secrets.get(SECRET_API_KEY)).then(
              function (value) {
                return typeof value === 'string' && value.length > 0 ? value : null;
              },
              function (error) {
                setNotice({ tone: 'warning', title: 'API key 读不出来', body: messageOf(error) });
                return null;
              }
            )
          : Promise.resolve(null);

      return keyPromise
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
              '看不懂模型的返回（接口形态 ' + current.endpointKind + '）：\n' + parsed.reason +
                '\n\n两种常见原因：接口形态选错了（chat / completion 换一个试试），或者这个服务不是 OpenAI 兼容的。'
            );
          }
          if (!aliveRef.current) return;
          var entry = {
            at: Date.now(),
            origin: origin,
            target: current.targetLang,
            model: current.model,
            text: parsed.text,
          };
          setResult(entry);
          pushHistory(entry);
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

    if (snapshot === null) {
      return h('div', { className: 'tr-root' }, h('div', { className: 'tr-loading' }, '正在读取状态…'));
    }

    var view = draft === null ? config : draft;
    var status = snapshot.status;
    var cache = snapshot.cache;
    var keyInfo = snapshot.keyInfo;

    var hotkeyAvailable = !!(ctx.hotkey && ctx.hotkey.isAvailable && ctx.hotkey.isAvailable());
    var selectionAvailable = !!(ctx.selection && ctx.selection.isAvailable && ctx.selection.isAvailable());
    var clipboardAvailable = !!(ctx.clipboard && typeof ctx.clipboard.writeText === 'function');

    // 状态行的三件事。每一件都分开报，因为它们各自会以不同的方式坏掉。
    var hotkeyLine = describeHotkey(status, hotkeyAvailable, selectionAvailable);
    var endpointLine = describeEndpoint(cache, status);
    var modelLine = config.model ? config.model : '（没有配置模型）';

    return h(
      'div',
      { className: 'tr-root' },
      h(
        'div',
        { className: 'tr-inner' },
        // ---------- 标题与状态 ----------
        h(
          'div',
          { className: 'tr-head' },
          h('h2', { className: 'tr-title' }, '划词翻译'),
          h('div', { className: 'tr-head-actions' }, h('button', {
            type: 'button',
            className: 'tr-btn tr-btn-ghost tr-btn-mini',
            onClick: function () {
              refresh().then(function () {
                flash('状态已刷新');
              });
            },
          }, '刷新状态'))
        ),
        h('p', { className: 'tr-sub' }, '在别的程序里选中文字，按 ', h('kbd', null, config.triggerCombo), ' 就出译文。下面是手动的入口，以及配置。'),

        // ---------- 这一屏上最重要的一句 ----------
        //
        // 后台那一半的结果**到不了这里**（两个进程之间没有推送通道）。把这件事
        // 明说，而不是让用户对着一个空的历史猜"是不是没生效"。
        h(
          'div',
          { className: 'tr-hint' },
          '热键翻出来的译文只出现在那张贴在光标的卡片上，不会进下面的历史 —— 后台进程与这一屏之间没有通道，而把译文写进存储等于把它留给备份与别的机器。'
        ),

        // ---------- 状态行 ----------
        h(
          'div',
          { className: 'tr-status' },
          h(StatusRow, { label: '热键', value: hotkeyLine.value, tone: hotkeyLine.tone, detail: hotkeyLine.detail }),
          h(StatusRow, { label: '端点', value: endpointLine.value, tone: endpointLine.tone, detail: endpointLine.detail }),
          h(StatusRow, { label: '模型', value: modelLine, tone: config.model ? 'ok' : 'warn', detail: status && status.at ? '后台最后上报：' + formatTime(status.at) + '（' + formatAgo(status.at) + '）' : '后台还没有上报过状态' })
        ),

        // ---------- 平台降级 ----------
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
                  '。下面的手动翻译照样能用。'
              )
            )
          : null,

        // ---------- 提示 / 错误 ----------
        notice
          ? h(
              'div',
              { className: 'tr-banner tr-banner-' + notice.tone },
              h('strong', null, notice.title),
              notice.body ? h('pre', { className: 'tr-pre' }, notice.body) : null
            )
          : null,

        // ---------- 手动翻译 ----------
        h(
          'section',
          { className: 'tr-card' },
          h('div', { className: 'tr-card-head' }, h('h3', { className: 'tr-card-title' }, '手动翻译')),
          h('p', { className: 'tr-note' }, '没有热键，或者只是想翻一小段时用它。'),
          h('div', { className: 'tr-row' },
            h('span', { className: 'tr-chip' }, '源语言：自动检测'),
            h('span', { className: 'tr-chip-hint' }, '本插件不做语言检测（那需要另一个模型），源语言交给模型判断')
          ),
          h('textarea', {
            className: 'tr-textarea',
            value: input,
            rows: 5,
            maxLength: INPUT_LIMIT,
            placeholder: '把要翻译的文字粘贴或输入到这里（最多 ' + INPUT_LIMIT + ' 字符）',
            onChange: function (event) {
              setInput(event.target.value);
            },
          }),
          h('div', { className: 'tr-row tr-row-between' },
            h('span', { className: 'tr-count' }, input.length + ' / ' + INPUT_LIMIT),
            h('div', { className: 'tr-row' },
              h('button', {
                type: 'button',
                className: 'tr-btn tr-btn-ghost tr-btn-mini',
                disabled: busy || input.trim() === '',
                onClick: function () {
                  setInput('');
                },
              }, '清空'),
              h('button', {
                type: 'button',
                className: 'tr-btn tr-btn-primary',
                disabled: busy || input.trim() === '',
                onClick: function () {
                  translate(input, 'manual');
                },
              }, busy ? '翻译中…' : '翻译')
            )
          )
        ),

        // ---------- 结果 ----------
        result
          ? h(
              'section',
              { className: 'tr-card tr-card-result' },
              h('div', { className: 'tr-card-head' },
                h('h3', { className: 'tr-card-title' }, '译文 → ' + result.target),
                h('div', { className: 'tr-row' },
                  h('span', { className: 'tr-time' }, formatTime(result.at)),
                  h('button', {
                    type: 'button',
                    className: 'tr-btn tr-btn-ghost tr-btn-mini',
                    disabled: !clipboardAvailable,
                    title: clipboardAvailable ? '' : '这个运行位置没有剪贴板写入能力',
                    onClick: function () {
                      copyText(result.text);
                    },
                  }, '复制')
                )
              ),
              // **只作为文本渲染**：译文来自模型，模型可能把它拼成任何东西。
              h('div', { className: 'tr-result-text' }, result.text)
            )
          : null,

        // ---------- 模型同步 ----------
        h(
          'section',
          { className: 'tr-card' },
          h('div', { className: 'tr-card-head' },
            h('h3', { className: 'tr-card-title' }, '模型'),
            h('button', {
              type: 'button',
              className: 'tr-btn tr-btn-ghost tr-btn-mini',
              disabled: syncing,
              onClick: runSync,
            }, syncing ? '同步中…' : '同步模型')
          ),
          h('p', { className: 'tr-note' },
            '往 ', h('code', null, joinUrl(view.baseUrl, 'models')), ' 发一次 GET，把服务端实际加载的模型读回来。'
          ),
          cache
            ? h('div', { className: 'tr-cache' },
                h('div', { className: 'tr-cache-line' },
                  cache.ok
                    ? h('span', { className: 'tr-tag tr-tag-ok' }, '上次探测成功')
                    : h('span', { className: 'tr-tag tr-tag-error' }, '上次探测失败'),
                  h('span', { className: 'tr-time' }, formatTime(cache.at) + '（' + formatAgo(cache.at) + '）'),
                  cache.base ? h('span', { className: 'tr-time' }, ' · ' + cache.base) : null
                ),
                cache.ok && Array.isArray(cache.models) && cache.models.length > 0
                  ? h('div', { className: 'tr-models' },
                      cache.models.map(function (id) {
                        var selected = id === config.model;
                        return h('button', {
                          key: id,
                          type: 'button',
                          className: 'tr-model' + (selected ? ' tr-model-on' : ''),
                          onClick: function () {
                            commit(SETTING_IDS.model, id);
                          },
                        }, id);
                      })
                    )
                  : h('pre', { className: 'tr-pre' }, cache.error || '（没有可用的模型列表）')
              )
            : h('div', { className: 'tr-cache' },
                h('p', { className: 'tr-note' }, '还没有探测过。点一次「同步模型」—— 它同时也是"服务在不在"的测试。')
              ),
          h('p', { className: 'tr-note' },
            '当前设置的模型：', h('code', null, config.model || '（空）')
          )
        ),

        // ---------- 设置 ----------
        h(
          'section',
          { className: 'tr-card' },
          h('h3', { className: 'tr-card-title' }, '设置'),

          h(Field, { label: '模型服务地址（base URL）', hint: '结尾带不带斜杠都行。本机默认 ' + DEFAULT_BASE_URL + '。' + (view.baseUrl && !isLoopback(view.baseUrl) ? ' ⚠ 这不是本机回环地址 —— 除了 network 权限之外还要声明 network-external，否则请求会被宿主拒绝。' : '') },
            h('input', {
              className: 'tr-input',
              type: 'text',
              value: view.baseUrl,
              onChange: function (event) { editDraft(SETTING_IDS.baseUrl, event.target.value); },
              onBlur: function () { commit(SETTING_IDS.baseUrl, view.baseUrl.trim()); },
            })
          ),

          h(Field, { label: '接口形态', hint: 'chat 走 /chat/completions，completion 走 /completions。有些 llama.cpp 构建在 chat 那一侧不稳，换 completion 试试。' },
            h('select', {
              className: 'tr-select',
              value: view.endpointKind,
              onChange: function (event) { editDraft(SETTING_IDS.endpointKind, event.target.value); commit(SETTING_IDS.endpointKind, event.target.value); },
            },
              h('option', { value: 'chat' }, 'chat（/chat/completions）'),
              h('option', { value: 'completion' }, 'completion（/completions）')
            )
          ),

          h(Field, { label: '模型', hint: '请求体里的 model 字段，必须与服务端加载的那一个逐字一致。建议用上面的「同步模型」而不是手打。' },
            h('input', {
              className: 'tr-input',
              type: 'text',
              value: view.model,
              onChange: function (event) { editDraft(SETTING_IDS.model, event.target.value); },
              onBlur: function () { commit(SETTING_IDS.model, view.model.trim()); },
            })
          ),

          h(Field, { label: '触发组合键', hint: '语法是 mod+k / mod+shift+tab（mod 在 Windows 上是 Ctrl）。改完最多一分钟生效 —— 后台每 60 秒对一次账，因为那里没有设置变更回调。组合键在系统里是独占的，冲突时错误会点名是谁占着。' },
            h('input', {
              className: 'tr-input',
              type: 'text',
              value: view.triggerCombo,
              onChange: function (event) { editDraft(SETTING_IDS.triggerCombo, event.target.value); },
              onBlur: function () { commit(SETTING_IDS.triggerCombo, view.triggerCombo.trim()); },
            })
          ),

          h(Field, { label: '目标语言', hint: '会替换提示词模板里的 {target}。' },
            h('select', {
              className: 'tr-select',
              value: TARGET_LANGS.indexOf(view.targetLang) === -1 ? TARGET_LANGS[0] : view.targetLang,
              onChange: function (event) { editDraft(SETTING_IDS.targetLang, event.target.value); commit(SETTING_IDS.targetLang, event.target.value); },
            }, TARGET_LANGS.map(function (lang) {
              return h('option', { key: lang, value: lang }, lang);
            }))
          ),

          h(Field, { label: '提示词模板', hint: '占位符：{text}（必需）、{target}、{source}。本地小模型的译文质量对格式极其敏感，因此这里是可改的 —— 一个写死的模板等于"只在作者那一个模型上能用"。' },
            h('div', null,
              h('textarea', {
                className: 'tr-textarea tr-textarea-mono',
                value: view.promptTemplate,
                rows: 6,
                onChange: function (event) { editDraft(SETTING_IDS.promptTemplate, event.target.value); },
                onBlur: function () { commit(SETTING_IDS.promptTemplate, view.promptTemplate); },
              }),
              h('div', { className: 'tr-row' },
                h('button', {
                  type: 'button',
                  className: 'tr-btn tr-btn-ghost tr-btn-mini',
                  onClick: function () {
                    editDraft(SETTING_IDS.promptTemplate, DEFAULT_PROMPT_TEMPLATE);
                    commit(SETTING_IDS.promptTemplate, DEFAULT_PROMPT_TEMPLATE);
                  },
                }, '恢复缺省模板')
              ),
              h('p', { className: 'tr-note' }, '用通用小模型时把指令换成英文往往更稳，例如 Translate the following text into {target}. Output only the translation.')
            )
          )
        ),

        // ---------- API key ----------
        h(
          'section',
          { className: 'tr-card' },
          h('h3', { className: 'tr-card-title' }, 'API key'),
          h('p', { className: 'tr-note' },
            '它不存在设置里，也不存在插件的任何文件里：写进 ctx.secrets 之后，密文落在插件数据目录之外，由本机硬件指纹派生的密钥加密，而且不属于任何备份类别。代价写在这里：换机器（或换网卡、改主机名）之后解不开 —— 那时后台会原样告诉你"密文仍在磁盘上、没有被删除"，重新输入一次即可。'
          ),
          h('div', { className: 'tr-key-state' },
            keyInfo.known && keyInfo.present
              ? h('span', { className: 'tr-tag tr-tag-ok' }, '已保存（加密）')
              : h('span', { className: 'tr-tag tr-tag-muted' }, '未设置'),
            keyInfo.error ? h('span', { className: 'tr-tag tr-tag-error' }, keyInfo.error) : null,
            h('span', { className: 'tr-time' }, '本地 llama.cpp 的 server 默认不校验密钥，因此留空也能用')
          ),
          h('div', { className: 'tr-row' },
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
              onChange: function (event) { setKeyDraft(event.target.value); },
              onKeyDown: function (event) {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  commitKey();
                }
              },
            }),
            h('button', {
              type: 'button',
              className: 'tr-btn tr-btn-primary',
              disabled: keyDraft === '',
              onClick: commitKey,
            }, '保存密钥'),
            h('button', {
              type: 'button',
              className: 'tr-btn tr-btn-ghost',
              disabled: !keyInfo.present,
              onClick: function () {
                if (!ctx.secrets || typeof ctx.secrets.delete !== 'function') return;
                ctx.secrets.delete(SECRET_API_KEY).then(function () {
                  flash('API key 已删除');
                  return refresh();
                }, function (error) {
                  setNotice({ tone: 'error', title: '删除失败', body: messageOf(error) });
                });
              },
            }, '删除')
          )
        ),

        // ---------- 历史 ----------
        h(
          'section',
          { className: 'tr-card' },
          h('div', { className: 'tr-card-head' },
            h('h3', { className: 'tr-card-title' }, '本次面板里的翻译（' + history.length + '）'),
            h('button', {
              type: 'button',
              className: 'tr-btn tr-btn-ghost tr-btn-mini',
              disabled: history.length === 0,
              onClick: function () { setHistory([]); },
            }, '清空')
          ),
          h('p', { className: 'tr-note' }, '只在内存里，面板一卸载就没了 —— 它不写存储，因为存储是明文而且会进备份。热键翻出来的那些不在这里（见上面那句）。'),
          history.length === 0
            ? h('p', { className: 'tr-empty' }, '还没有手动翻译过。')
            : h('ul', { className: 'tr-history' }, history.map(function (entry, index) {
                return h('li', { key: entry.at + '-' + index, className: 'tr-history-item' },
                  h('div', { className: 'tr-history-head' },
                    h('span', { className: 'tr-time' }, formatTime(entry.at) + ' · → ' + entry.target),
                    h('button', {
                      type: 'button',
                      className: 'tr-btn tr-btn-ghost tr-btn-mini',
                      disabled: !clipboardAvailable,
                      onClick: function () { copyText(entry.text); },
                    }, '复制')
                  ),
                  h('div', { className: 'tr-history-text' }, clipText(entry.text, 300))
                );
              }))
        ),

        saveFlash ? h('div', { className: 'tr-flash' }, saveFlash) : null,

        h('p', { className: 'tr-footnote' },
          '权限：storage（设置）、network（只在 ' + DEFAULT_BASE_URL + ' 这类本机地址上，远端地址还需要 network-external）、notification（结果卡片）、clipboard（把译文放回剪贴板）、secrets（API key）、global-hotkey 与 read-selection（热键与读选中文本，都只有 Windows 上有）。'
        )
      )
    );
  }

  // ============================================================
  // 小组件
  // ============================================================

  function StatusRow(props) {
    return h('div', { className: 'tr-status-row' },
      h('span', { className: 'tr-status-label' }, props.label),
      h('span', { className: 'tr-status-value tr-status-' + props.tone }, props.value),
      props.detail ? h('span', { className: 'tr-status-detail' }, props.detail) : null
    );
  }

  function Field(props) {
    return h('div', { className: 'tr-field' },
      h('label', { className: 'tr-field-label' }, props.label),
      props.hint ? h('p', { className: 'tr-field-hint' }, props.hint) : null,
      props.children
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
      description: '选中文本按一下热键就出译文；也可以在这里手动翻译',
      icon: 'Languages',
      priority: 76,
      component: TranslatePanel,
    });
  });
})();
