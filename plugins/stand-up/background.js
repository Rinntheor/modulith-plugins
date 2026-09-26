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
// 为什么无界面插件要单独有这条形态：一个只想"每隔一会儿做一件事"的插件，
// 不该为了执行几十行逻辑而让应用多一个渲染进程。界面插件那条路（跨源 iframe）
// 是给"用户要看着的东西"准备的。
//
// ============================================================
// 这个进程里有什么、没有什么
// ============================================================
//
// 有：`ctx` 与 `Modulith`（同一批函数）、`console`、几个定时器、`Date`。
//
// **没有**：`require` / `import`（不能加载别的模块）、`process`（读不到环境变量，
// 也起不了子进程）、`fetch` 之外的任何网络原语在权限模型之下也受版本影响 ——
// 见下面那条提醒。
//
// 所有数据都经过宿主：这个进程用 `--permission` 启动，文件读只放开**它自己的
// 代码目录**，因此 `ctx.storage.*` 不是"多一层检查"，而是它唯一能碰数据的路。
//
// ⚠️ **网络这一条要单独说**：清单里没有声明 `network`，而宿主也从不给这个进程
// 传 `--allow-net`。但"不授予"只有在那个权限项**存在**时才等于拒绝，而它**是
// 版本相关的** —— 较老的 Node（例如 24.x）根本没有这一项，那时网络是完全不受
// 管的。因此这个插件**不依赖**"我连不上网"这个假设，也不往任何地方发请求。

(function () {
  'use strict';

  /** 累计提醒次数。存在插件自己的键值存储里（需要 `storage` 权限）。 */
  var COUNT_KEY = 'reminded';

  /** 提醒之间的间隔，与清单里的 `interval` 保持一致（秒）。 */
  var INTERVAL_MINUTES = 45;

  /**
   * 读累计次数。
   *
   * `ctx.storage.get` 返回的是**反序列化之后**的值，第二个参数是缺失时的兜底 ——
   * 因此这里不需要自己判 `null`、也不需要 JSON.parse。
   */
  function readCount() {
    return ctx.storage.get(COUNT_KEY, 0).then(function (value) {
      return typeof value === 'number' && isFinite(value) ? value : 0;
    });
  }

  /** 提醒一次，并把累计次数加一。 */
  function remind() {
    return readCount().then(function (count) {
      var next = count + 1;

      return ctx.notifications
        .notify({
          title: '该起来动一下了',
          body:
            '你已经坐了大约 ' +
            INTERVAL_MINUTES +
            ' 分钟。这是第 ' +
            next +
            ' 次提醒。',
          level: 'info',
          // 去重键：同一次提醒重发时不会在通知中心里堆成两条。
          dedupeKey: 'stand-up',
        })
        .then(function () {
          return ctx.storage.set(COUNT_KEY, next);
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
  //
  // 这也是"插件想活着"与"空闲回收"之间的那个约定：插件不自己持有长活的计时器，
  // 只声明"我关心哪几件事"，宿主来决定什么时候把它叫醒。

  ctx.background.on('start', function () {
    return readCount().then(function (count) {
      ctx.logger.info(
        '久坐提醒已启动：每 ' + INTERVAL_MINUTES + ' 分钟一次，累计已提醒 ' + count + ' 次'
      );
    });
  });

  ctx.background.on('interval', function () {
    return remind();
  });

  // 卸载/停用时宿主会调这些。这个插件没有持有任何需要手动释放的东西
  // （没有自己 setInterval、也没有订阅外部事件），因此这里只需如实说明。
  ctx.disposables.add(function () {
    ctx.logger.debug('久坐提醒已停止');
  });
})();
