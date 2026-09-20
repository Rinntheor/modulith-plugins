// 从 plugins/kanban/index.js 拆出 —— **逻辑原样搬运，未做任何改动**。
// 搬运是机械的：每块的位置与内容都没变，只是补上了 import / export。
import { nextRecurrenceDue, todayKey } from './dates';
import { DEFAULT_LANES, DRAFT_MAX, KEY_BOARD, KEY_DRAFT, KEY_PREFS, LANE_AUTO_DONE, NOTIFICATION_ID_MAX, SAVE_DEBOUNCE_MS, SCHEMA_VERSION, TOPIC_CHANGED, ctx } from './env';
import { cardsInLane, clone, laneById, laneIndexById, makeCard, makeLane, moveCardPure, moveLanePure, nextOrder, normalizeBoard, normalizePrefs, nowIso, touchBoard } from './model';

// ---------------------------------------------------------------------------
// 一个极小的外置状态容器
//
// 看板数据放在组件之外有两个理由：分屏的两个实例要能互相通知；读盘与写盘都是异步的，
// 状态放在外面可以避免组件重渲染时闭包里的值过期。
// ---------------------------------------------------------------------------

function createStore() {
  var state = {
    status: 'loading', // loading | ready | error
    errorMessage: null,
    notes: [],
    saveState: 'idle', // idle | saving | saved | error
    saveError: null,
    board: null,
    draft: '',
    prefs: { notify: true },
    conflict: false,
  };
  var listeners = new Set();

  return {
    subscribe: function (listener) {
      listeners.add(listener);
      return function () {
        listeners.delete(listener);
      };
    },
    getSnapshot: function () {
      return state;
    },
    set: function (patch) {
      state = Object.assign({}, state, patch);
      listeners.forEach(function (listener) {
        listener();
      });
    },
    patchBoard: function (board, extra) {
      this.set(Object.assign({ board: board }, extra || {}));
    },
  };
}

var store = createStore();

var internal = {
  alive: false,
  loaded: false,
  saving: false,
  timer: null,
  /** 已经成功落盘的版本号；磁盘上的 rev 比它新，说明这份数据是别的实例写的 */
  savedRev: 0,
  lastGood: null,
  writeBlocked: false,
  saveWaiters: [],
  draftTimer: null,
  notifiedIds: [],
  remindedDay: null,
};

function pushNote(message) {
  if (!message) return;
  var notes = store.getSnapshot().notes || [];
  if (notes.indexOf(message) >= 0) return;
  store.set({ notes: notes.concat([message]) });
}

function greeting() {
  var hour = new Date().getHours();
  if (hour < 5) return '夜深了';
  if (hour < 11) return '早上好';
  if (hour < 14) return '中午好';
  if (hour < 18) return '下午好';
  return '晚上好';
}

function load() {
  return ctx.storage
    .get(KEY_BOARD, null)
    .then(function (raw) {
      var result = normalizeBoard(raw);
      if (!internal.alive) return;
      internal.loaded = true;
      internal.savedRev = result.board.rev;
      internal.lastGood = clone(result.board);
      internal.writeBlocked = result.board.schemaVersion > SCHEMA_VERSION;
      store.set({
        status: 'ready',
        errorMessage: null,
        notes: result.notes,
        board: result.board,
      });
      if (internal.writeBlocked) {
        store.set({
          saveState: 'error',
          saveError: '磁盘上的数据来自更新版本的看板插件，本版本不会写入，以免覆盖它。',
        });
      }
    })
    .catch(function (err) {
      if (!internal.alive) return;
      ctx.logger.error('读取看板数据失败', err);
      store.set({
        status: 'error',
        errorMessage:
          '读取数据失败：' + ((err && err.message) || '未知原因') +
          '。磁盘上的数据没有被改动，修好原因后点「重新读取」再试。',
      });
    });
}

function loadDraft() {
  return ctx.storage
    .get(KEY_DRAFT, '')
    .then(function (value) {
      if (!internal.alive) return;
      store.set({ draft: typeof value === 'string' ? value.slice(0, DRAFT_MAX) : '' });
    })
    .catch(function (err) {
      if (!internal.alive) return;
      ctx.logger.warn('读取速记草稿失败', err);
      store.set({ draft: '' });
    });
}

function loadPrefs() {
  return ctx.storage
    .get(KEY_PREFS, null)
    .then(function (raw) {
      if (!internal.alive) return;
      store.set({ prefs: normalizePrefs(raw) });
    })
    .catch(function (err) {
      ctx.logger.warn('读取提醒设置失败，按默认（开启提醒）处理', err);
    });
}

function reload() {
  store.set({ status: 'loading', errorMessage: null });
  return load().then(loadDraft).then(loadPrefs);
}

/**
 * 写盘。
 *
 * 冲突策略：写之前先读一次磁盘上的 rev。它比本实例「已知落盘的版本」新，就说明
 * 分屏的另一半或上一次会话写过数据 —— 此时不覆盖，把对方的版本装回界面并说明情况。
 */
function saveNow(reason) {
  if (internal.writeBlocked) {
    store.set({
      saveState: 'error',
      saveError: '磁盘上的数据来自更新版本的看板插件，本次没有写入，以免覆盖。',
    });
    return Promise.resolve();
  }
  // 冲突未决之前不再写盘：此时界面内容已经被换成磁盘上的那一份，
  // 再写一次只会把同一个版本反复写回去。用户下一次改动会经 commit() 清掉这个标志。
  if (store.getSnapshot().conflict) return Promise.resolve();

  if (internal.saving) {
    return new Promise(function (resolve) {
      internal.saveWaiters.push(resolve);
    });
  }

  var snapshot = clone(store.getSnapshot().board);
  if (!snapshot) return Promise.resolve();
  snapshot.schemaVersion = SCHEMA_VERSION;

  internal.saving = true;
  store.set({ saveState: 'saving', saveError: null });

  return ctx.storage
    .get(KEY_BOARD, null)
    .then(function (raw) {
      var disk = normalizeBoard(raw).board;
      if (disk.rev > internal.savedRev) {
        internal.savedRev = disk.rev;
        internal.lastGood = clone(disk);
        store.set({
          board: disk,
          conflict: true,
          saveState: 'error',
          saveError:
            '检测到另一处（分屏的另一半，或上一次会话）已经保存过更改，界面已切换成对方的版本，' +
            '本地这次的改动没有写入。请重新调整后再试。',
        });
        return false;
      }
      return ctx.storage.set(KEY_BOARD, snapshot).then(function () {
        return true;
      });
    })
    .then(function (written) {
      if (written !== true) return;
      internal.savedRev = snapshot.rev;
      internal.lastGood = clone(snapshot);
      store.set({ saveState: 'saved', saveError: null, conflict: false });
      // 通知另一个实例；没有 plugin-communicate 时这一步是空实现，不影响保存
      ctx.events.publish(TOPIC_CHANGED, { rev: snapshot.rev, at: Date.now() });
    })
    .catch(function (err) {
      ctx.logger.error('保存看板失败（' + reason + '）', err);
      store.set({
        saveState: 'error',
        saveError:
          '保存失败：' + ((err && err.message) || '未知原因') +
          '。改动还在界面上，可以点「重试保存」；若一直失败，多半是磁盘空间或数据目录权限的问题。',
      });
    })
    .then(function () {
      internal.saving = false;
      var waiters = internal.saveWaiters;
      internal.saveWaiters = [];
      for (var i = 0; i < waiters.length; i += 1) waiters[i]();
    });
}

function scheduleSave(reason) {
  if (internal.timer !== null) {
    clearTimeout(internal.timer);
    internal.timer = null;
  }
  internal.timer = setTimeout(function () {
    internal.timer = null;
    saveNow(reason);
  }, SAVE_DEBOUNCE_MS);
}

function savePrefsNow(prefs) {
  ctx.storage.set(KEY_PREFS, prefs).catch(function (err) {
    ctx.logger.warn('保存提醒设置失败', err);
  });
}

/** 所有改动都从这里走：先更新界面，再落盘。失败原因由顶部横幅给出，并带「重试保存」。 */
function commit(board, reason) {
  store.patchBoard(touchBoard(board), { conflict: false });
  scheduleSave(reason);
}

/** 标记提醒已发出。只保留最近若干条，避免长时间运行后无界增长。 */
function rememberNotification(id) {
  internal.notifiedIds.push(id);
  if (internal.notifiedIds.length > NOTIFICATION_ID_MAX) {
    internal.notifiedIds = internal.notifiedIds.slice(-NOTIFICATION_ID_MAX);
  }
}

function notify(title, body, dedupeKey) {
  if (!ctx.notifications.isAvailable || !ctx.notifications.isAvailable()) {
    ctx.logger.info('未声明 notification 权限，跳过通知：' + title);
    return;
  }
  try {
    ctx.notifications.info(title, body, dedupeKey);
  } catch (err) {
    ctx.logger.warn('发送通知失败', err);
  }
}

/**
 * 到期提醒。一天只在同一批内容上提醒一次：dedupeKey 带上日期与逾期状态，
 * 因此同一天内不会重复弹，第二天会重新提醒一次。
 */
function dueReminder(board) {
  if (!board || store.getSnapshot().prefs.notify === false) return;
  if (!ctx.notifications.isAvailable || !ctx.notifications.isAvailable()) return;

  var today = todayKey();
  var overdue = [];
  var dueToday = [];
  var ids = Object.keys(board.cards);
  for (var i = 0; i < ids.length; i += 1) {
    var card = board.cards[ids[i]];
    if (card.done || !card.due) continue;
    if (card.due < today) overdue.push(card);
    else if (card.due === today) dueToday.push(card);
  }
  if (overdue.length === 0 && dueToday.length === 0) return;

  var signature =
    overdue.length + ':' + dueToday.length + ':' + (overdue[0] ? overdue[0].id : '-') + ':' + (dueToday[0] ? dueToday[0].id : '-');
  var key = 'kanban-due-' + today + '-' + signature;
  if (internal.notifiedIds.indexOf(key) >= 0) return;
  rememberNotification(key);

  function names(list) {
    var shown = list.slice(0, 3).map(function (card) {
      return card.title;
    });
    return shown.join('、') + (list.length > 3 ? ' 等 ' + list.length + ' 项' : '');
  }

  var title;
  var body;
  if (overdue.length > 0 && dueToday.length > 0) {
    title = '有 ' + overdue.length + ' 项已逾期、' + dueToday.length + ' 项今天到期';
    body = '逾期：' + names(overdue) + '；今天：' + names(dueToday);
  } else if (overdue.length > 0) {
    title = '有 ' + overdue.length + ' 项已经逾期';
    body = names(overdue);
  } else {
    title = '有 ' + dueToday.length + ' 项今天到期';
    body = names(dueToday);
  }
  notify(title, body, key);
}

/** 检查是否到了新的一天（应用长期开着时，需要在跨天后重新提醒一次）。 */
function dayChanged() {
  var today = todayKey();
  if (internal.remindedDay === today) return false;
  internal.remindedDay = today;
  return true;
}

function completeCard(board, card) {
  card.done = true;
  card.completedAt = nowIso();
  if (card.recurrence) {
    // 重复任务：滚动到下一次，而不是留一张永远完成的卡片
    card.due = nextRecurrenceDue(card.due, card.recurrence);
    card.done = false;
    card.completedAt = null;
  }
  card.updatedAt = nowIso();
  return board;
}

var boardActions = {
  addCard: function (laneId, title, priority, due, recurrence) {
    var board = clone(store.getSnapshot().board);
    if (!board) return null;
    var card = makeCard(laneId, title, nextOrder(board, laneId));
    card.priority = priority || 'normal';
    card.due = due || null;
    card.recurrence = recurrence || null;
    board.cards[card.id] = card;
    commit(board, '新增卡片');
    return card.id;
  },

  updateCard: function (cardId, patch) {
    var board = clone(store.getSnapshot().board);
    if (!board || !board.cards[cardId]) return;
    var card = board.cards[cardId];
    if (patch.title !== undefined) card.title = patch.title;
    if (patch.note !== undefined) card.note = patch.note;
    if (patch.priority !== undefined) card.priority = patch.priority;
    if (patch.due !== undefined) card.due = patch.due;
    if (patch.recurrence !== undefined) card.recurrence = patch.recurrence;
    if (patch.done !== undefined) {
      if (patch.done) completeCard(board, card);
      else {
        card.done = false;
        card.completedAt = null;
      }
    }
    card.updatedAt = nowIso();
    commit(board, '编辑卡片');
  },

  toggleDone: function (cardId, done) {
    var board = clone(store.getSnapshot().board);
    if (!board || !board.cards[cardId]) return;
    var card = board.cards[cardId];
    if (done) completeCard(board, card);
    else {
      card.done = false;
      card.completedAt = null;
    }
    card.updatedAt = nowIso();
    commit(board, '切换完成状态');
  },

  moveCard: function (cardId, targetLaneId, beforeId, afterId) {
    var board = store.getSnapshot().board;
    if (!board || !board.cards[cardId]) return;
    var next = moveCardPure(board, cardId, targetLaneId, beforeId, afterId);
    if (next === board) return;
    commit(next, '移动卡片');
  },

  deleteCard: function (cardId) {
    var board = clone(store.getSnapshot().board);
    if (!board || !board.cards[cardId]) return null;
    var title = board.cards[cardId].title;
    delete board.cards[cardId];
    commit(board, '删除卡片');
    return title;
  },

  restoreCard: function (card) {
    var board = clone(store.getSnapshot().board);
    if (!board) return;
    board.cards[card.id] = clone(card);
    commit(board, '撤销删除');
  },

  clearDone: function () {
    var board = clone(store.getSnapshot().board);
    if (!board) return 0;
    var removed = 0;
    var ids = Object.keys(board.cards);
    for (var i = 0; i < ids.length; i += 1) {
      if (board.cards[ids[i]].done) {
        delete board.cards[ids[i]];
        removed += 1;
      }
    }
    if (removed > 0) commit(board, '清除已完成');
    return removed;
  },

  addLane: function (name) {
    var board = clone(store.getSnapshot().board);
    if (!board) return;
    board.lanes.push(makeLane(name));
    commit(board, '新增列表');
  },

  renameLane: function (laneId, name) {
    var board = clone(store.getSnapshot().board);
    if (!board) return;
    var target = laneById(board, laneId);
    if (!target) return;
    target.name = name;
    commit(board, '重命名列表');
  },

  toggleLaneCollapsed: function (laneId) {
    var board = clone(store.getSnapshot().board);
    if (!board) return;
    var target = laneById(board, laneId);
    if (!target) return;
    target.collapsed = !target.collapsed;
    commit(board, '折叠列表');
  },

  moveLane: function (laneId, targetIndex) {
    var board = store.getSnapshot().board;
    if (!board) return;
    var next = moveLanePure(board, laneId, targetIndex);
    if (next === board) return;
    commit(next, '调整列表顺序');
  },

  /** 删除列表，返回可以撤销的数据（列表本身 + 它里面的卡片）。 */
  deleteLane: function (laneId) {
    var board = clone(store.getSnapshot().board);
    if (!board) return null;
    if (board.lanes.length <= 1) return null; // 至少留一个列表，否则界面会变成一个没法用的空壳
    var index = laneIndexById(board, laneId);
    if (index < 0) return null;
    var removedLane = board.lanes[index];
    var removedCards = cardsInLane(board, laneId);
    board.lanes = board.lanes.filter(function (item) {
      return item.id !== laneId;
    });
    var ids = Object.keys(board.cards);
    for (var i = 0; i < ids.length; i += 1) {
      if (board.cards[ids[i]].laneId === laneId) delete board.cards[ids[i]];
    }
    commit(board, '删除列表');
    return { lane: removedLane, index: index, cards: removedCards, name: removedLane.name };
  },

  restoreLane: function (snapshot) {
    var board = clone(store.getSnapshot().board);
    if (!board || !snapshot) return;
    var at = Math.max(0, Math.min(snapshot.index, board.lanes.length));
    board.lanes.splice(at, 0, clone(snapshot.lane));
    for (var i = 0; i < snapshot.cards.length; i += 1) {
      board.cards[snapshot.cards[i].id] = clone(snapshot.cards[i]);
    }
    commit(board, '撤销删除列表');
  },

  /**
   * 恢复默认的三栏。
   *
   * 默认三栏的名字已经存在就复用（只把它挪到该在的位置），不重复造一栏；
   * 卡片按所在栏与完成状态归位：已完成或原本在「完成」栏的进「已完成」，
   * 原本在「进行中」的进「进行中」，其余进「待处理」。**一张卡片都不会被删。**
   */
  resetLanes: function () {
    var board = clone(store.getSnapshot().board);
    if (!board) return false;

    // 先记下每张卡原来的列表名 —— 替换 lanes 之后就查不到了
    var sourceNameByLane = {};
    for (var a = 0; a < board.lanes.length; a += 1) {
      sourceNameByLane[board.lanes[a].id] = board.lanes[a].name;
    }

    var byName = {};
    for (var i = 0; i < board.lanes.length; i += 1) {
      if (!byName[board.lanes[i].name]) byName[board.lanes[i].name] = board.lanes[i];
    }
    var target = {};
    var order = [];
    for (var n = 0; n < DEFAULT_LANES.length; n += 1) {
      var name = DEFAULT_LANES[n];
      if (byName[name]) {
        byName[name].collapsed = false;
        target[name] = byName[name];
      } else {
        target[name] = makeLane(name);
      }
      order.push(target[name]);
    }
    board.lanes = order;

    var ids = Object.keys(board.cards);
    for (var j = 0; j < ids.length; j += 1) {
      var card = board.cards[ids[j]];
      var sourceName = sourceNameByLane[card.laneId] || '';
      var toDone = card.done || sourceName.indexOf(LANE_AUTO_DONE) >= 0;
      var toDoing = !toDone && sourceName === DEFAULT_LANES[1];
      card.laneId = toDone
        ? target[DEFAULT_LANES[2]].id
        : toDoing
        ? target[DEFAULT_LANES[1]].id
        : target[DEFAULT_LANES[0]].id;
      card.updatedAt = nowIso();
    }

    commit(board, '恢复默认列表');
    return true;
  },
};

export { boardActions, commit, completeCard, createStore, dayChanged, dueReminder, greeting, internal, load, loadDraft, loadPrefs, notify, pushNote, reload, rememberNotification, saveNow, savePrefsNow, scheduleSave, store };
