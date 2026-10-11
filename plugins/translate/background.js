// plugins/translate/background.js
//
// 划词翻译 —— 后台那一半。用户在**别的程序**里选中一段文字、按下组合键，
// 这里把那段文字送到本机的模型服务上，再把译文放进一张结果卡片。
//
// ============================================================
// 这个文件跑在哪：一个独立的 Node 进程，没有窗口
// ============================================================
//
// 由宿主按清单里的 `contributes.background` 拉起（`entry` 指的就是这个文件），
// 与 `index.js` —— 那个跑在沙箱 iframe 里的面板 —— **没有任何共享的 JS 上下文**。
// 两者唯一的公共面是宿主的键值存储与设置：一边写进去，另一边读出来。因此
// "面板上刚改的值后台怎么知道"这件事没有回调可用，只能靠**读**，见下面的
// `readConfig` 与 `syncHotkey`。
//
// 这个进程里有什么：`ctx` 与 `Modulith`（同一批函数）、`console`、几个定时器、
// `Date`。**没有** `require` / `import` / `process` / `fetch` —— 网络只能走
// `ctx.http`，文件只能走 `ctx.storage` / `ctx.dataDir`。
//
// ============================================================
// 隐私：这个插件能看到什么，以及它一条都不往哪里写
// ============================================================
//
// 它拿得到两样**别人看不到的东西**：用户在任意程序里选中的文字（`read-selection`），
// 以及那段文字的译文。因此整个文件里有一条不许破例的规矩：
//
//   **选中的原文与译文一个字都不进 console、不进 ctx.logger、不进
//   ctx.notifications、不进 ctx.storage。**
//
// 理由不是洁癖，是三件具体的事：
//   * `modulith.log` 是明文文件，用户会把它发给维护者排查问题 —— 而用户选中的
//     可能是他正在编辑的合同，也可能是复制失败之后留在剪贴板上的密码；
//   * 通知会留在通知中心里，重启之后还在；
//   * `ctx.storage` 进「插件数据」备份类别，会被复制到别的机器上。
//
// 因此**结果只在结果卡片里出现一次**（那是用户按键之后主动要看的，贴的是他自己
// 屏幕上的光标，不落盘），复制按钮写一次剪贴板（那也是用户按的）。运行状态里只记
// "发生了什么"这类**代码**与**时间**，不记内容。
//
// 唯一一处把外部文本带进用户可见消息的，是模型服务返回的 **HTTP 响应体**
// （非 2xx 时）：它被截断后放进卡片，因为"同步失败"这四个字对使用者毫无用处。
// 它**只**进卡片，不进上面那四个地方。服务端的错误体通常形如
// `{"error":{"message":"model not found"}}`，但这里仍然按不可信输入处理 ——
// 它可能回显提示词，而提示词里就是用户选中的原文。
//
// ============================================================
// API key：从 ctx.secrets 读，永远不从设置读
// ============================================================
//
// `ctx.settings` 是**明文**，而且与 `ctx.dataDir` 的根在同一个目录里（插件自己
// 拼得出路径），还会随备份一起被复制走。因此 key 只存在 `ctx.secrets` 里：
// 密文落在插件数据目录**之外**，由本机硬件指纹派生。
//
// 代价如实写下来，而且必须原样显示给用户：**换机器之后解不开**。那时
// `ctx.secrets.get` **抛错**（不是返回 `null`），因为返回 null 会被读成"用户还没
// 配置 key"，然后引导他重新输入一遍 —— 而密文其实还好端端地躺在磁盘上。
// 下面 `readApiKey` 把那条错误原样带上，一个字都不改写。
//
// ============================================================
// 关于 `ctx.settings.onChange`：它在这个运行位置上**不存在**
// ============================================================
//
// 宿主没有一条"设置变了"的推送通道给后台进程（与沙箱位置同一条理由，见
// `background-host.mjs` 里 `settings` 那一段）。因此**用户在应用运行期间改了地址、
// 模型或组合键，这个进程不会被通知**。这里的应对有两条，都不是权宜之计：
//
//   1. **每次触发都重新读一遍配置**（`handleTrigger` 第一件事就是 `readConfig`）。
//      于是改地址 / 模型 / 目标语言 / 提示词的效果是"下一次触发就生效" ——
//      对这几个值来说，那正是用户期待的行为，没有任何滞后可言。
//   2. **组合键只能靠对账。** 按键这件事的特性决定了它没法"下次生效"：用户把
//      `Ctrl+Q` 改成 `Ctrl+Shift+Q` 之后，如果他按的是新键，宿主那边根本没有这条
//      绑定，这个进程一次都不会被唤醒。因此必须有人**主动**把绑定换成新的 ——
//      那就是下面 `interval` 那一趟的**唯一**职责。
//
// 造一个永远不触发的 `onChange` 比没有它更坏：作者会写它、然后等一个永不到来的
// 回调，而那种缺陷不会报错。
//
// ============================================================
// 清单里的 `interval: 60` **不是心跳**
// ============================================================
//
// 翻译本身一次都不是它驱动的：触发是**宿主推过来**的（插件的 `hotkey` 处理器），
// 而空闲时这个进程什么都不做。那个 60 秒的定时唤醒只为一件事存在 ——
// 把注册的组合键收敛到设置里的那一条（也就是上面第 2 条）。因此：
//
//   * 它**不能**省掉（省掉之后改组合键要重启应用才生效，而那条路没有任何提示）；
//   * 它也**不必**更密：组合键是用户偶尔改一次的配置，一分钟的滞后完全够，
//     而 10 秒一跳意味着一年里多醒来一百多万次，换不到任何东西。
//
// 这个数值写死在清单里（不是设置项）：它是宿主与这个进程之间的约定，用户没有
// 任何理由需要调它。

(function () {
  'use strict';

  // ============================================================
  // 常量
  // ============================================================
  //
  // 缺省值与清单 `contributes.settings` 里那六项**逐字一致**：设置读不到时
  // （缺 storage 权限、后端不可用）这里回落到的，就是用户没改过时该拿到的值。
  // 两处不一致的后果是"没声明 storage 权限的机器上表现与别人不同"。

  var DEFAULT_BASE_URL = 'http://127.0.0.1:5566/v1';
  var DEFAULT_ENDPOINT_KIND = 'chat';
  var DEFAULT_MODEL = 'Hy MT2 1.8B Q4_K_M.gguf';
  var DEFAULT_SOURCE_LANG = 'auto';
  var DEFAULT_TARGET_LANG = '简体中文';
  var DEFAULT_TRIGGER_COMBO = 'Ctrl+Q';

  /**
   * 「自动」源语言替换成的那句话。
   *
   * **必须与 `index.js` 里的那一份逐字相同**：热键翻出来的与面板里翻出来的如果
   * 提示词不一样，同一个人会看到两种译文风格，而那种差异没有任何线索指向"两个
   * 文件里各写了一句"。
   *
   * 它是一句**说明**而不是一个语言名：这个插件不做语言检测（那需要另一个模型），
   * 把"自动"谎报成某个具体语言只会误导模型与用户。
   */
  var SOURCE_AUTO_HINT = '原文的语言（由你判断）';

  /**
   * 默认提示词模板。
   *
   * **它是可改的，而且这是一个功能，不是让步。** 本地小翻译模型对提示词的格式
   * 极其敏感：同一个模型换一种问法就从不翻译变成开始解释，而不同的模型
   * （Hunyuan-MT、NLLB、Qwen 的小尺寸版本、随便一个 GGUF……）各自认的格式又
   * 不一样。写死一个模板的后果是**这个插件只在作者那一个模型上能用**，使用者
   * 拿到一句"模型不听话"，而他能做的事只有放弃。
   *
   * 因此模板里留了三个占位符，缺省值是面向「翻译专用的小模型」写的：一句中文
   * 指令 + 空行 + 原文。用通用小模型（指令跟随较弱）时换英文往往更稳，例如：
   *
   *     Translate the following text into {target}.
   *     Output only the translation, without quotes or explanations.
   *
   *     {text}
   */
  var DEFAULT_PROMPT_TEMPLATE =
    '把下面这段文本翻译成{target}。只输出译文本身，不要解释、不要加引号、不要重复原文。\n\n{text}';

  /** 密钥名。名字本身不是秘密，但**值**只经 ctx.secrets 进出。 */
  var SECRET_API_KEY = 'apiKey';

  /** 运行状态的存储键。面板读的就是它 —— 两个进程之间没有别的通道。 */
  var STATUS_KEY = 'runtimeStatus';

  /**
   * 一次请求最多生成多少 token。
   *
   * 它是**上限而不是目标**：小模型的失控输出（复述原文、开始解释、循环）在
   * 没有上限时会一直跑到服务端的默认值，那既慢又容易把卡片塞满。1024 对
   * "用户选中的一段文字"足够，同时让译文很少撞上结果卡片 4000 字符的正文上限。
   */
  var MAX_TOKENS = 1024;

  /** 错误消息里带进来的服务端响应体最多留多少字符。 */
  var ERROR_BODY_LIMIT = 600;

  /** 结果卡片正文的上限。与 `rpc.rs` 的 `MAX_POPOVER_BODY_CHARS` 一致。 */
  var CARD_BODY_LIMIT = 4000;

  /**
   * 宿主实际绑定了的那一条组合键（规范化之后，`Ctrl+Q` 在这里是 `mod+q`）。
   *
   * 它只在这个进程里活着。进程被回收之后重新拉起时它是 null，而那时 `start`
   * 会重新注册一次 —— 宿主在插件被停用/卸载时会**自己**解绑（`hotkey.rs` 的
   * 四条释放路径，第二条正是"停用不一定经过插件的任何代码"）。因此这里**不**在
   * `disposables` 里再解一次：那条路管的正是"插件没机会跑代码"的情况，而在能跑
   * 代码的时候它已经由 `syncHotkey` 管着了。
   */
  var registeredCombo = null;

  /**
   * 上一次**按设置里的原样值**注册的是哪一条（也就是用户写的那串，`Ctrl+Q`）。
   *
   * 为什么需要第二个变量：`registeredCombo` 是**规范化之后**的形式，而设置里存的
   * 是用户写的原样形式，两者几乎永远不相等。只比 `registeredCombo` 的话，每一次
   * interval 对账都会认为"组合键变了"然后重新注册一遍 —— 宿主的重复注册是幂等的，
   * 因此它不会出错，但它会在**每一个**对账周期里白花一次 RPC，而且让日志里看不出
   * 到底有没有真的改过。要判断"要不要重新注册"，必须比的是**同一侧**的值。
   */
  var registeredDesired = null;

  /** 正在处理一次触发。这期间再按一次不做第二遍（见 `handleTrigger`）。 */
  var busy = false;

  /**
   * 这个运行位置有没有 `ctx.secrets`。
   *
   * `null` = 还没问过。**问一次之后就记住**：插件作者可能写在一个每小时的定时器
   * 里，而"每次都去探一下环境"没有任何意义。
   */
  var secretsProbed = null;

  // ============================================================
  // 小工具
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

  /**
   * 描述一个值的**结构**，绝不带上它的内容。
   *
   * 用途只有一个：模型服务返回了一个我们不认识的形状时，把"它长什么样"说出来。
   * 之所以只报结构：那个响应体里可能回显提示词，而提示词里就是用户选中的原文 ——
   * 这条消息会出现在卡片上，而卡片之外的任何一处都不该看到原文。字段名与类型
   * 已经足够让作者判断"这是 completion 的响应而不是 chat 的"。
   */
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

  /**
   * 把 `base` 与一段路径接起来。**结尾的斜杠要归一化**：用户在设置里填的
   * `http://127.0.0.1:5566/v1/` 与不带斜杠的是同一个地址，而直接拼会得到
   * `.../v1//chat/completions`（有的服务端认，有的直接 404）。
   */
  function joinUrl(base, path) {
    var trimmed = String(base === undefined || base === null ? '' : base).trim();
    while (trimmed.length > 0 && trimmed.charAt(trimmed.length - 1) === '/') {
      trimmed = trimmed.slice(0, -1);
    }
    return trimmed + '/' + path;
  }

  // ============================================================
  // 配置与状态
  // ============================================================

  function textOr(raw, fallback) {
    if (typeof raw !== 'string') return fallback;
    var trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : fallback;
  }

  /**
   * 把读到的一坨设置值归一化成一份完整、可用的配置。
   *
   * 归一化而不是直接信任：这些值可能来自"用户手输了清单没允许的值"，也可能是
   * 换版本之后残留的旧形状。`endpointKind` 尤其要紧 —— 一个认不出的取值会让请求
   * 打到错误的路由上，而那种失败看起来像"服务端坏了"。
   */
  function normalizeConfig(raw) {
    var source = isObject(raw) ? raw : {};
    return {
      baseUrl: textOr(source.baseUrl, DEFAULT_BASE_URL),
      // 白名单：认不出的取值落回 `chat`，而不是原样拼进 URL。
      endpointKind: source.endpointKind === 'completion' ? 'completion' : DEFAULT_ENDPOINT_KIND,
      // ============================================================
      // `model` 的缺省与另外几项**刻意不同**：它区分"没设置过"与"设成了空"
      // ============================================================
      //
      // 宿主的 `settings.all` 只返回**真的写进去过**的值 —— 清单里的 `default`
      // 不会被它注入（见 `rpc.rs` 的 `setting_values`）。因此"第一次运行"与
      // "用户把模型清空了"在这份输入里长得很像，而它们该有完全不同的处理：
      //
      //   * 没设置过 → 用清单里的缺省值（用户第一次按热键就该有东西可试）；
      //   * 设成了空串 → **就是空**，然后由 `handleTrigger` 明确告诉他去点
      //     「同步模型」。悄悄换回那个缺省模型名是错的：那个名字几乎一定不是
      //     他机器上加载的那个，于是他会得到一句 404，而真正的原因（他没填模型）
      //     被一个看起来合理的猜测盖住了。
      model: typeof source.model === 'string' ? source.model.trim() : DEFAULT_MODEL,
      promptTemplate: textOr(source.promptTemplate, DEFAULT_PROMPT_TEMPLATE),
      triggerCombo: textOr(source.triggerCombo, DEFAULT_TRIGGER_COMBO),
      sourceLang: textOr(source.sourceLang, DEFAULT_SOURCE_LANG),
      targetLang: textOr(source.targetLang, DEFAULT_TARGET_LANG),
    };
  }

  /**
   * 读一遍配置。
   *
   * **每次触发都会调它**，理由见文件头。它是这个进程里唯一读设置的地方 ——
   * 缓存住一份会在应用运行期间变旧，而"改动要重启插件才生效"不是使用者能猜到的。
   */
  function readConfig() {
    if (!ctx.settings || !ctx.settings.isAvailable()) {
      // 没声明 storage 时 `getAll` 会抛。这里不抛给调用方：缺省值仍然能让插件
      // 跑起来（本机默认地址 + 默认模型），而"用的是缺省值"会写进状态里。
      return Promise.resolve(normalizeConfig({}));
    }
    return ctx.settings.getAll().then(
      function (all) {
        return normalizeConfig(all);
      },
      function () {
        return normalizeConfig({});
      }
    );
  }

  /**
   * 合并一段运行状态，并盖上时间戳。
   *
   * **面板唯一的"后台现在怎么样"来源。** 它只装代码、时间与地址这类值：
   * 选中的原文与译文一个字都不许进来（见文件头）。写失败（缺 storage）不抛 ——
   * 那不该打断一次翻译，但要说出来。
   */
  function writeStatus(patch) {
    if (!ctx.storage) return Promise.resolve(null);
    return ctx.storage.get(STATUS_KEY, {}).then(function (current) {
      var next = {};
      var base = isObject(current) ? current : {};
      var key;
      for (key in base) {
        if (Object.prototype.hasOwnProperty.call(base, key)) next[key] = base[key];
      }
      for (key in patch) {
        if (Object.prototype.hasOwnProperty.call(patch, key)) next[key] = patch[key];
      }
      next.at = Date.now();
      return ctx.storage.set(STATUS_KEY, next).then(function () {
        return next;
      });
    }).catch(function (error) {
      ctx.logger.info('运行状态写不进存储：' + messageOf(error));
      return null;
    });
  }

  /** 记一次\"这次触发是什么结果\"。**只有代码，没有内容。** */
  function recordOutcome(code, detail) {
    var patch = { lastOutcome: code, lastOutcomeAt: Date.now() };
    // detail 只允许是**我们自己的**短句或宿主的错误（后者不含用户内容）。
    if (typeof detail === 'string' && detail) patch.lastOutcomeDetail = clipText(detail, 300);
    return writeStatus(patch);
  }

  // ============================================================
  // 组合键
  // ============================================================

  /**
   * 把绑定收敛到 `desired` 这一条上。幂等。
   *
   * 顺序是**先注册新的、成功了再解绑旧的**，而不是反过来。差别只在失败那条路上：
   * 反过来写的话，注册失败之后用户手里一条绑定都不剩 —— 而失败的原因常常是
   * "这个组合被别的程序占了"，那是他换个键就能解决的事，不该连原来那条也丢掉。
   *
   * 失败时**原样**把宿主的错误放进状态：它点名了是谁占着（宿主快捷键 / 另一个
   * 插件 / 系统里的别的程序）。那三种情况下用户能做的事完全不同，因此这里一个字
   * 都不改写、也不替换成"注册失败"。
   */
  function syncHotkey(desired) {
    if (!ctx.hotkey || typeof ctx.hotkey.register !== 'function') {
      return writeStatus({
        hotkeyState: 'unavailable',
        hotkeyError: '这个运行位置没有 ctx.hotkey',
        desiredCombo: desired,
        registeredCombo: registeredCombo,
      });
    }

    if (!ctx.hotkey.isAvailable()) {
      // 同步判据：清单里声明了 global-hotkey **且**这个平台支持（只有 Windows）。
      // 这里必须说出来 —— 在别的平台上静默什么都不做，用户会以为按键坏了。
      return writeStatus({
        hotkeyState: 'unavailable',
        hotkeyError: '全局热键只在 Windows 上可用（RegisterHotKey），这个平台没有对应实现',
        desiredCombo: desired,
        registeredCombo: registeredCombo,
      });
    }

    if (!desired) {
      // 用户把组合键清空了。不注册，而且要说清楚这与"注册失败"不是一件事。
      return ctx.hotkey.list().then(function (current) {
        var list = Array.isArray(current) ? current : [];
        return Promise.all(
          list.map(function (combo) {
            return ctx.hotkey.unregister(combo).catch(function () {});
          })
        ).then(function () {
          registeredCombo = null;
          registeredDesired = null;
          return writeStatus({
            hotkeyState: 'unset',
            hotkeyError: null,
            desiredCombo: '',
            registeredCombo: null,
          });
        });
      });
    }

    if (desired === registeredDesired && registeredCombo) {
      // 已经是对的。仍然写一次状态：面板要看到"现在绑定的是哪一条"。
      return writeStatus({
        hotkeyState: 'registered',
        hotkeyError: null,
        desiredCombo: desired,
        registeredCombo: registeredCombo,
      });
    }

    return ctx.hotkey.register(desired).then(
      function (normalized) {
        var previous = registeredCombo;
        // 宿主回的是**规范化之后**的那一条（`Ctrl+Q` 回来是 `mod+q`）。
        // 存它而不是存用户写的那串：对账要与宿主那边的表示逐字比。
        registeredCombo = typeof normalized === 'string' && normalized ? normalized : desired;
        registeredDesired = desired;

        var finish = function () {
          return writeStatus({
            hotkeyState: 'registered',
            hotkeyError: null,
            desiredCombo: desired,
            registeredCombo: registeredCombo,
          });
        };

        if (!previous || previous === registeredCombo) return finish();

        // 解绑失败只记不抛：旧的那一条绑着比解不掉更麻烦（它占着一个按键），
        // 但一次解绑失败不该让"新绑定已经生效"这件事变成一个错误。
        return ctx.hotkey.unregister(previous).catch(function (error) {
          ctx.logger.info('旧的组合键解绑失败（新的已经生效）：' + messageOf(error));
        }).then(finish);
      },
      function (error) {
        // 失败时**不**记 `registeredDesired`，因此下一次 interval 对账还会再试一遍。
        // 那是有意的：组合键被别人占着这件事会自己消失（用户关掉那个程序、停用那个
        // 插件），而重试是唯一能发现它消失的办法 —— 一分钟一次 `RegisterHotKey`
        // 的代价可以忽略。
        return writeStatus({
          hotkeyState: 'failed',
          hotkeyError: messageOf(error),
          hotkeyErrorAt: Date.now(),
          desiredCombo: desired,
          registeredCombo: registeredCombo,
        });
      }
    );
  }

  // ============================================================
  // 密钥
  // ============================================================

  /**
   * 读一次 API key。
   *
   * 三种结果**必须分开**，它们是三件不同的事：
   *
   *   * `string` —— 读到了；
   *   * `null` —— 从来没存过。这是**正常状态**：llama.cpp 的 server 默认不校验
   *     密钥，因此这里不报错、不带 Authorization 头继续；
   *   * **抛错** —— 读不到，而且原因是确定的：缺 `secrets` 权限，或者密文解不开
   *     （换过机器 / 网卡 / 主机名 / 文件被改过）。后者的措辞由宿主给出，里面
   *     写明了"密文仍然在磁盘上、没有被删除"，**必须原样显示** —— 把它改写成
   *     "没有配置密钥"会让用户重新输入一遍，而旧的那份其实还在。
   */
  function readApiKey() {
    if (secretsProbed === false) {
      return Promise.reject(new Error('这个运行位置没有 ctx.secrets，无法读取 API key'));
    }
    if (!ctx.secrets || typeof ctx.secrets.get !== 'function') {
      secretsProbed = false;
      return Promise.reject(new Error('这个运行位置没有 ctx.secrets，无法读取 API key'));
    }
    secretsProbed = true;

    if (!ctx.secrets.isAvailable()) {
      // 与另外两个运行位置逐字相同的降级：权限没声明时 `isAvailable()` 假、
      // `get()` 抛错。理由在 background-host.mjs 的 secrets 那一段。
      return Promise.reject(new Error('插件没有声明 "secrets" 权限，无法读取 API key'));
    }

    return ctx.secrets.get(SECRET_API_KEY).then(function (value) {
      if (typeof value === 'string' && value.length > 0) return value;
      return null;
    });
  }

  // ============================================================
  // HTTP
  // ============================================================

  /**
   * 把一次 `ctx.http.fetch` 的返回归一化成 `{ status, body }`。
   *
   * **三个运行位置的返回形状不一样**，这不是猜测：
   *   * in-process（`pluginRuntime.ts`）把宿主的 `{status,headers,body}` 重新包成
   *     了一个原生 `Response`；
   *   * 沙箱（`sandbox-bridge.js`）与后台（`background-host.mjs`）都直接把那条
   *     通道上的 JSON 原样交出来，也就是 `{ status, headers, body }` 这个纯对象。
   *
   * 类型声明与 `pluginBoundary.ts` 记的是 `Response`，也就是 in-process 那一种。
   * 这里两种都认：认不出形状时**报结构**，而不是把一个空字符串当成成功。
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
    return Promise.reject(
      new Error('宿主返回的响应形状不认识：' + describeShape(response))
    );
  }

  /**
   * 从一次非 2xx 里造一句**能照做**的错误。
   *
   * 四类失败的用户动作完全不同，因此必须分开点名：
   *   * 连不上（传输层抛错，见 `requestJson` 的第二个参数位）；
   *   * `401`/`403` —— 密钥；
   *   * `404`/`405` —— 这个地址上不是 OpenAI 兼容接口；
   *   * 别的非 2xx —— 把**服务端真实的响应体**带上（截断）。
   *
   * 最后一类正是"同步失败"这四个字最该被替换掉的地方：llama.cpp 在模型没加载时
   * 返回的是一句具体的 400/404 加一个说明，而那句话就是解决办法。
   */
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
    } else if (/model/i.test(trimmed)) {
      lines.push('（服务端提到了模型：到面板点「同步模型」，看它实际加载了哪几个，再挑一个）');
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
   * 发一次请求并拿回解析好的 JSON。
   *
   * `POST` 只走 `ctx.http.fetch`：它与另外两个运行位置逐字同名同形，
   * 而 `ctx.http.post` 在后台那一侧**不存在**（那里只有 `fetch`）。
   */
  function requestJson(config, path, payload) {
    var url = joinUrl(config.baseUrl, path);
    var headers = { 'content-type': 'application/json' };
    if (config.apiKey) {
      // key 只在这里出现一次，且只在请求头里。它绝不进日志、不进状态、不进卡片。
      headers.authorization = 'Bearer ' + config.apiKey;
    }

    var body = JSON.stringify(payload);

    return ctx.http.fetch(url, { method: 'POST', headers: headers, body: body }).then(
      function (response) {
        return readResponse(response).then(function (result) {
          if (result.status < 200 || result.status >= 300) {
            throw httpError(url, result.status, result.body);
          }
          if (result.readError) {
            throw new Error('读响应体失败：' + result.readError);
          }
          return parseJson(url, result.body);
        });
      },
      function (error) {
        // 传输层的失败：连接被拒绝（服务没启动）、DNS、超时、被策略拒绝。
        // 宿主那句话是唯一知道原因的地方，因此原样带上 —— 只加一句"连不上谁"。
        throw new Error(
          '连不上模型服务 ' +
            url +
            '\n' +
            messageOf(error) +
            '\n（最常见的一种是服务没启动：llama.cpp 的 server 要先用 llama-server -m <模型文件> 跑起来）'
        );
      }
    );
  }

  // ============================================================
  // 提示词与请求体
  // ============================================================

  /**
   * 把模板里的占位符替换掉。
   *
   * **`{text}` 必须最后替换。** 反过来的话，用户选中的文字里含有的 `{target}` 会被
   * 接着的那次替换命中 —— 一段讲模板语法的技术文档正好会这样，而那时他被翻译的是
   * 一段被替换过的、他自己都没见过的文字。`{text}` 放最后，插进去的内容后面不再被
   * 任何 `split/join` 扫到，原文因此逐字保留。
   *
   * `{source}` 在自动模式下替换成一句说明而不是猜一个语言名：这个插件**不做语言
   * 检测**（那需要另一个模型），把"自动"谎报成某个具体语言只会误导模型和用户。
   * 设置里的 `sourceLang` 由面板与宿主设置页写入，后台**每次触发都重读一遍**
   * （见文件头），因此改了源语言的效果是"下一次触发就生效"。
   */
  function buildPrompt(config, text) {
    var template = config.promptTemplate;
    if (typeof template !== 'string' || template.trim() === '') template = DEFAULT_PROMPT_TEMPLATE;

    // 没有 `{text}` 的模板会把原文整个丢掉，而那种失败看起来像"模型没反应"。
    // 因此回落到缺省模板，而不是发一个不含原文的请求。
    if (template.indexOf('{text}') === -1) template = DEFAULT_PROMPT_TEMPLATE;

    return template
      .split('{target}')
      .join(config.targetLang)
      .split('{source}')
      .join(config.sourceLang === 'auto' || !config.sourceLang ? SOURCE_AUTO_HINT : config.sourceLang)
      .split('{text}')
      .join(text);
  }

  /**
   * 两种接口形态的请求体。
   *
   * `chat` → `POST {base}/chat/completions`：模板整段作为**一条 user 消息**。
   * `completion` → `POST {base}/completions`：模板作为**一段纯文本**（`prompt`），
   * 模型从它后面接着写。
   *
   * 两点必须说清楚：
   *   * **模型名永远在请求体里，不在路径里。** OpenAI 兼容接口的路径与具体模型
   *     无关（llama.cpp 上没有 `/models/<名字>/...` 这种形式），把模型名拼进 URL
   *     会在换模型时得到一个 404 而不是一句有用的错误；
   *   * 两个路径都属于 **OpenAI 兼容层**（base URL 以 `/v1` 结尾时就是它们）。
   *     llama.cpp 还有一个**单数**的原生 `/completion`，它收的字段名与这里不同，
   *     不是这一项要表达的东西。
   */
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

  // ============================================================
  // 解析响应
  // ============================================================

  /**
   * 从响应里取出译文。**永远不返回空字符串。**
   *
   * 两个字段各对应一种形态：`choices[0].message.content`（chat）、
   * `choices[0].text`（completion）。先按本次配置的那一个取，取不到再试另一个 ——
   * 有些 llama.cpp 构建在 `/completions` 上回的是 message 形状，而那是它的实现
   * 细节，不该变成使用者面前的一句"没有译文"。
   *
   * 两个都没有时**报出 `choices[0]` 的字段结构**，而不是 `''`：空字符串会被上面
   * 的调用方当成一次成功的翻译，然后用户看到一张空卡片。
   */
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
        reason:
          'choices[0] 里既没有 text 也没有 message.content；它的字段是 ' + describeShape(first),
      };
    }

    var trimmed = chosen.trim();
    if (trimmed === '') {
      return { ok: false, reason: '服务端回了一个空内容（' + field + ' 是空串）' };
    }
    return { ok: true, text: trimmed, field: field };
  }

  // ============================================================
  // 结果卡片
  // ============================================================

  /**
   * 卡片正文的截断。**显示的上限就是复制的上限** —— 复制按的是一份比看到的
   * 更长的内容，是那种"过一会儿才发现复制少了半句"的缺陷。
   */
  function clipForCard(text) {
    if (text.length <= CARD_BODY_LIMIT - 40) return { text: text, clipped: false };
    return {
      text: text.slice(0, CARD_BODY_LIMIT - 40) + '\n\n…（译文超过卡片的长度上限，已截断）',
      clipped: true,
    };
  }

  /** 这个运行位置能不能写剪贴板。**同步**，因此卡片上的按钮可以据此决定给不给。 */
  function canWriteClipboard() {
    return !!(
      ctx.clipboard &&
      typeof ctx.clipboard.writeText === 'function' &&
      (typeof ctx.clipboard.isAvailable !== 'function' || ctx.clipboard.isAvailable())
    );
  }

  function showCard(input) {
    if (!ctx.ui || typeof ctx.ui.popover !== 'function') {
      // 卡片是后台插件唯一的界面出口。它没有的话，结果只能进日志 —— 而那是不行的。
      ctx.logger.warn('这个运行位置没有 ctx.ui.popover，译文无法显示给用户');
      return Promise.resolve(null);
    }
    return ctx.ui.popover(input).then(
      function (result) {
        return result && typeof result.action === 'string' ? result.action : null;
      },
      function (error) {
        // 真正的失败：没声明 notification 权限、浮层窗口起不来、body 为空。
        // 它必须说出来 —— 否则用户按了键之后什么都没发生。
        ctx.logger.warn('结果卡片没有显示出来：' + messageOf(error));
        return null;
      }
    );
  }

  /** 一次需要用户注意的失败。标题是我们自己的，正文里只有宿主/服务端的原话。 */
  function reportFailure(title, body) {
    return showCard({
      title: title,
      body: body,
      tone: 'error',
      timeoutMs: 20000,
    });
  }

  // ============================================================
  // 主流程
  // ============================================================

  /**
   * 把一次翻译的结果交给用户，并处理卡片上的动作。
   *
   * 卡片正文就是译文本身 —— 那是**唯一**会出现译文的地方。它没有第二个出口：
   * 不进日志、不进通知、不进存储。
   */
  function presentTranslation(config, text) {
    var clipped = clipForCard(text);
    var actions = [];
    if (canWriteClipboard()) {
      // id 只允许 [a-z0-9-]：形状不对时宿主会拒绝**整次调用**，而不是丢掉这个按钮。
      actions.push({ id: 'copy', label: '复制译文' });
    }

    return showCard({
      title: '译文 → ' + config.targetLang,
      body: clipped.text,
      tone: 'success',
      actions: actions,
      // 比缺省的 8 秒长：一段外文常常要读完再看下一段。上限是 30 秒。
      timeoutMs: 20000,
    }).then(function (action) {
      if (action !== 'copy') {
        // `null` = 到点收起 / Escape / 点别处，都是"用户没回答"，不是失败。
        return null;
      }

      var clip = ctx.clipboard;
      if (!clip || typeof clip.writeText !== 'function') {
        // 正常情况下走不到这里（按钮只在能写时才给）。真走到了要如实说，
        // 而不是静默无声 —— 用户按了"复制"然后什么都没发生是最坏的一种。
        return reportFailure(
          '复制不了',
          '这个运行位置没有 ctx.clipboard，无法写入剪贴板。译文仍然在面板里可以复制。'
        );
      }

      return Promise.resolve()
        .then(function () {
          return clip.writeText(clipped.text);
        })
        .then(function () {
          // 正文不重复译文：那会让译文在屏幕上出现两次，而且这一步的正文
          // 有可能被别的东西看到（比如录屏），因此只留一句固定的话。
          return showCard({
            body: clipped.clipped ? '已复制（注意：卡片上那份是截断过的）' : '译文已复制到剪贴板',
            tone: 'success',
            timeoutMs: 2500,
          });
        })
        .catch(function (error) {
          return reportFailure('复制失败', messageOf(error));
        });
    });
  }

  /**
   * 一次完整的"选中 → 翻译 → 交给用户"。
   *
   * 每一步的失败都**单独说清楚**，因为它们的用户动作完全不同：
   * 没选中（再选一次）、读不到（换一个程序 / 那个程序不响应 Ctrl+C）、
   * 配置或密钥有问题（去面板改）、服务端有话说（卡片上就是那句话）。
   */
  function handleTrigger() {
    if (busy) {
      // 不做防抖静默丢弃。理论上到不了这里（一次请求通常几百毫秒），
      // 但真到得了就说明上一个请求卡了 —— 那件事用户必须知道。
      return showCard({
        title: '上一次翻译还没结束',
        body: '等它出结果，或者把模型服务那边的队列清一下。',
        tone: 'warning',
        timeoutMs: 4000,
      });
    }
    busy = true;

    var config = null;

    return readConfig()
      .then(function (loaded) {
        config = loaded;
        // 顺手把组合键对一次账：用户可能就在刚才改了它（见文件头第 2 条）。
        // 失败不阻断这次翻译 —— 卡片上仍然会给译文。
        return syncHotkey(config.triggerCombo);
      })
      .then(function () {
        return readApiKey().then(
          function (key) {
            config.apiKey = key;
          },
          function (error) {
            // 密钥读不到是**配置问题**，不是翻译失败：直接告诉用户去做什么。
            config.apiKey = null;
            config.apiKeyError = messageOf(error);
          }
        );
      })
      .then(function () {
        if (config.apiKeyError) {
          return recordOutcome('secrets-error').then(function () {
            return reportFailure(
              '读不到 API key',
              config.apiKeyError +
                '\n\n（密钥存在加密的密钥库里，不在设置里。上面那句话说明的是它为什么读不到 —— ' +
                '最常见的一种是换了机器或网卡，那时旧密文解不开，重新输入一次即可。）'
            );
          });
        }

        if (!config.model.trim()) {
          return recordOutcome('no-model').then(function () {
            return reportFailure(
              '没有配置模型',
              '请求体里的 model 字段是空的。到插件面板点一次「同步模型」，从服务端实际加载的模型里挑一个。'
            );
          });
        }

        return ctx.selection.read().then(
          function (selected) {
            if (selected === null || selected === '') {
              // `null` 是"捕获成功了，但剪贴板上最终没有文本" —— 与抛错是两件事。
              return recordOutcome('no-selection').then(function () {
                return showCard({
                  title: '没有读到选中的文本',
                  body:
                    '先在别的程序里选中一段文字，再按 ' +
                    config.triggerCombo +
                    '。\n\n如果确实选中了还是没有，那个程序可能不支持合成的 Ctrl+C ' +
                    '（终端、部分游戏、以管理员权限运行的程序都会这样）。面板里可以直接手动翻译。',
                  tone: 'warning',
                  timeoutMs: 9000,
                });
              });
            }

            return requestJson(config, endpointPath(config), buildRequestBody(config, buildPrompt(config, selected)))
              .then(function (payload) {
                var parsed = extractTranslation(payload, config.endpointKind);
                if (!parsed.ok) {
                  // 服务端没有给我们认得的内容。报结构、不报内容（可能回显原文）。
                  return recordOutcome('bad-response').then(function () {
                    return reportFailure(
                      '看不懂模型的返回',
                      '接口形态是 ' +
                        config.endpointKind +
                        '，但响应里没有对应的字段。\n' +
                        parsed.reason +
                        '\n\n两种常见原因：接口形态选错了（chat / completion 换一个试试），' +
                        '或者这个服务不是 OpenAI 兼容的。'
                    );
                  });
                }

                return recordOutcome('ok').then(function () {
                  return presentTranslation(config, parsed.text);
                });
              })
              .catch(function (error) {
                return recordOutcome('http-failed').then(function () {
                  return reportFailure('翻译请求失败', messageOf(error));
                });
              });
          },
          function (error) {
            // 这次捕获**根本没成功**。宿主那句话已经说清是哪一种（前台窗口是本应用 /
            // 没有前台窗口 / 那个程序不响应 Ctrl+C / 上一次捕获还没结束），不能改写。
            return recordOutcome('read-failed').then(function () {
              return reportFailure(
                '读不到选中的文本',
                messageOf(error) +
                  '\n\n（挨个试：把焦点放回那个程序、别让本应用在最前面、或者换一个程序。' +
                  '合成 Ctrl+C 是这项能力唯一可行的实现，因此这是一条真实存在的限制。）'
              );
            });
          }
        );
      })
      .catch(function (error) {
        // 走到这里说明是上面某一环自己抛的（例如 readConfig 意外失败）。
        // 宁可说一句笼统的话，也不要让它变成一个没人处理的 Promise 拒绝。
        return recordOutcome('internal-error', messageOf(error)).then(function () {
          return reportFailure('翻译没有完成', messageOf(error));
        });
      })
      .then(function () {
        busy = false;
      });
  }

  // ============================================================
  // 登记
  // ============================================================
  //
  // 三件都在**顶层同步**登记。这不是风格问题：
  //   * `ctx.hotkey.subscribe` 除了登记处理器，还要告诉宿主"这个插件想收触发"
  //     （宿主那一侧的表决定按键时往哪几处投）。把它挪进异步回调会让启动之后
  //     有一小段窗口收不到按键 —— 而那段窗口恰好是用户刚看到应用起来、最可能
  //     去试一下热键的时候；
  //   * `ctx.background.on(...)` 是"被唤醒之后做什么"的登记，宿主投递 `start` /
  //     `interval` 时按类型查这张表，晚一步登记就等于丢掉那一次投递。

  ctx.hotkey.subscribe(function (fired) {
    // 一个插件最多能注册 4 条组合，因此处理器要能分辨是哪一条触发的。
    // 这里只据此记一句日志，翻译流程本身与按的是哪条无关。
    var combo = fired && typeof fired.combo === 'string' ? fired.combo : null;
    if (combo && registeredCombo && combo !== registeredCombo) {
      ctx.logger.debug('触发的组合键与当前登记的不一致（' + combo + ' vs ' + registeredCombo + '）');
    }
    handleTrigger();
  });

  ctx.background.on('start', function () {
    return readConfig().then(function (config) {
      return syncHotkey(config.triggerCombo).then(function () {
        return writeStatus({
          endpoint: config.baseUrl,
          endpointKind: config.endpointKind,
          model: config.model,
          sourceLang: config.sourceLang,
          targetLang: config.targetLang,
          secretsAvailable: !!(ctx.secrets && ctx.secrets.isAvailable && ctx.secrets.isAvailable()),
          settingsAvailable: !!(ctx.settings && ctx.settings.isAvailable && ctx.settings.isAvailable()),
          clipboardWritable: canWriteClipboard(),
        });
      });
    });
  });

  ctx.background.on('interval', function () {
    // **这一趟的唯一职责**是让注册的组合键跟上设置（见文件头）。它不做心跳、
    // 不做保活、也不预读任何与翻译有关的东西 —— 翻译是按键驱动的。
    return readConfig().then(function (config) {
      return syncHotkey(config.triggerCombo);
    });
  });

  ctx.disposables.add(function () {
    // 这里**刻意不再解绑热键**：插件被停用/卸载/应用退出时宿主会自己解绑
    // （`hotkey.rs` 的四条释放路径）。而"停用"这条路根本不会执行到这里 ——
    // 因此把清理放在这个回调里，反而是那个最容易漏的场合下唯一不会跑的一份代码。
    ctx.logger.debug('划词翻译后台已停止');
  });
})();
