// plugins/stand-up/background.js
//
// ============================================================
// 这是一个**没有界面**的插件
// ============================================================
//
// 它的全部行为都在这个文件里，而这段代码跑在**一个独立的 Node 进程**中
// （由宿主按清单里的 `contributes.background` 拉起）—— 不是 webview，
// 也不占一个渲染进程。
//
// 它可以被用户配置，而**配置界面不在这个文件里**：清单的 `contributes.settings`
// 声明了两个设置项，宿主据此在「设置 → 插件设置」里画出控件，值存在插件自己的
// 存储里。这个文件只负责**读**它们。这样做的理由是"配置界面"与"配置的使用者"
// 不该各写一遍 —— 界面由宿主的通用渲染器画，插件只管按值行事。
//
// ============================================================
// 这个进程里有什么、没有什么
// ============================================================
//
// 有：`ctx` 与 `Modulith`（同一批函数）、`console`、几个定时器、`Date`。
//
// **没有**：`require` / `import`（不能加载别的模块）、`process`（读不到环境变量，
// 也起不了子进程）、网络在权限模型之下也受版本影响 —— 见下面那条提醒。
//
// 所有数据都经过宿主：这个进程用 `--permission` 启动，文件读只放开**它自己的
// 代码目录**，因此 `ctx.storage.*` / `ctx.settings.*` 不是"多一层检查"，
// 而是它唯一能碰数据的路。
//
// ⚠️ **网络这一条要单独说**：清单里没有声明 `network`，而宿主也从不给这个进程
// 传 `--allow-net`。但"不授予"只有在那个权限项**存在**时才等于拒绝，而它**是
// 版本相关的** —— 较老的 Node（例如 24.x）根本没有这一项，那时网络是完全不受
// 管的。因此这个插件**不依赖**"我连不上网"这个假设，也不往任何地方发请求。

(function () {
  'use strict';

  /** 累计提醒次数。存在插件自己的键值存储里（需要 `storage` 权限）。 */
  var COUNT_KEY = 'reminded';

  /** 上一次真的提醒的时刻（毫秒）。用来兑现"提醒间隔"那个设置。 */
  var LAST_AT_KEY = 'lastRemindedAt';

  /**
   * 缺省间隔（分钟）。与清单里那个设置项的 `default` 一致 ——
   * 设置项读不到时（没声明 storage、后端不可用）回落到它。
   */
  var DEFAULT_INTERVAL_MINUTES = 45;

  /**
   * ============================================================
   * 为什么提醒间隔是"由插件自己判"，而不是把它当成宿主的 tick
   * ============================================================
   *
   * 宿主唤醒这个进程的间隔来自**清单**（`contributes.background.interval`），
   * 那是静态的；而用户改的那个间隔是**运行期**的。两者不能混为一谈：
   * 清单里的 600 秒是"多久问一次"，用户的 45 分钟是"多久提醒一次"。
   *
   * 于是做法是：宿主每 10 分钟叫醒一次，插件自己看"距离上次提醒够不够久"。
   * 好处是插件**不持有长活的计时器** —— 那是清单与宿主之间的约定（插件只声明
   * "我关心哪几件事"，宿主决定什么时候叫醒它），插件自己 setInterval 就等于
   * 绕开它，也会让空闲回收失效。
   *
   * 代价如实写下来：实际间隔是"用户选的值向上取整到下一个 10 分钟" ——
   * 选 45 分钟会落在 50 分钟。设置项的说明里写了这一句。
   */
  function readIntervalMinutes() {
    return ctx.settings.get('intervalMinutes', String(DEFAULT_INTERVAL_MINUTES)).then(function (raw) {
      var value = parseInt(String(raw), 10);
      return isFinite(value) && value > 0 ? value : DEFAULT_INTERVAL_MINUTES;
    });
  }

  function readIncludeCount() {
    return ctx.settings.get('includeCount', true).then(function (value) {
      // 设置值可能以字符串形式存回来（select 就是），因此这里显式比较一次。
      return value === false || value === 'false' ? false : true;
    });
  }

  function readCount() {
    return ctx.storage.get(COUNT_KEY, 0).then(function (value) {
      return typeof value === 'number' && isFinite(value) ? value : 0;
    });
  }

  function readLastAt() {
    return ctx.storage.get(LAST_AT_KEY, 0).then(function (value) {
      return typeof value === 'number' && isFinite(value) ? value : 0;
    });
  }

  /**
   * 现在该不该提醒。
   *
   * 只读三个设置/存储值、不做任何写入 —— 因此它可以在每次 tick 上安全地跑。
   */
  function dueNow() {
    return Promise.all([readIntervalMinutes(), readLastAt()]).then(function (values) {
      var minutes = values[0];
      var lastAt = values[1];
      if (!lastAt) return true;
      return Date.now() - lastAt >= minutes * 60 * 1000;
    });
  }

  /** 提醒一次，并把累计次数与时刻记下来。 */
  function remind() {
    return Promise.all([readCount(), readIncludeCount()]).then(function (values) {
      var count = values[0];
      var includeCount = values[1];
      var next = count + 1;

      var body = includeCount
        ? '起来走两步、看看远处。这是第 ' + next + ' 次提醒。'
        : '起来走两步、看看远处。';

      return ctx.notifications
        .notify({
          title: '该起来动一下了',
          body: body,
          level: 'info',
          // 去重键：同一次提醒重发时不会在通知中心里堆成两条。
          dedupeKey: 'stand-up',
        })
        .then(function () {
          return ctx.storage.set(COUNT_KEY, next);
        })
        .then(function () {
          return ctx.storage.set(LAST_AT_KEY, Date.now());
        })
        .then(function () {
          ctx.logger.info('第 ' + next + ' 次久坐提醒已发出');
        });
    });
  }

  // ============================================================
  // 登记"被唤醒之后做什么"
  // ============================================================
  //
  // 后台插件**不能**自己决定什么时候被唤醒 —— 那是清单里 `contributes.background`
  // 的事（`onStartup` / `interval` / `events`）。这里登记的是唤醒之后的行为。

  ctx.background.on('start', function () {
    return Promise.all([readCount(), readIntervalMinutes(), readLastAt()]).then(function (values) {
      var count = values[0];
      var minutes = values[1];
      var lastAt = values[2];
      var waited = lastAt ? Math.round((Date.now() - lastAt) / 60000) : null;

      ctx.logger.info(
        '久坐提醒已启动：间隔 ' +
          minutes +
          ' 分钟，累计已提醒 ' +
          count +
          ' 次' +
          (waited === null ? '' : '，距上次 ' + waited + ' 分钟')
      );
    });
  });

  ctx.background.on('interval', function () {
    return dueNow().then(function (due) {
      if (!due) {
        // 还没到用户设的间隔。**记一条 debug 而不是什么都不做** ——
        // "它到底有没有在跑"这件事只能靠日志回答。
        ctx.logger.debug('距上次提醒还不够久，这次唤醒跳过');
        return;
      }
      return remind();
    });
  });

  // 卸载/停用时宿主会调这些。这个插件没有持有任何需要手动释放的东西
  // （没有自己 setInterval、也没有订阅外部事件），因此这里只需如实说明。
  ctx.disposables.add(function () {
    ctx.logger.debug('久坐提醒已停止');
  });
})();
