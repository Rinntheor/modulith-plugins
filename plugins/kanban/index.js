/* 生成物，请勿手改。源码在 src/<插件>/，改完跑 `pnpm build` */
"use strict";
var require = function (id) {
  if (id === 'react') return globalThis.Modulith.React;
  if (id === 'react/jsx-runtime') return globalThis.Modulith;
  throw new Error('插件不允许引入外部依赖（react 与 react/jsx-runtime 除外）: ' + id);
};
"use strict";
(() => {
  // src/kanban/env.ts
  var Modulith = globalThis.Modulith;
  if (!Modulith) {
    throw new Error("[kanban] 未找到 window.Modulith，插件无法加载");
  }
  var React = Modulith.React;
  var h = React.createElement;
  var useEffect = React.useEffect;
  var useMemo = React.useMemo;
  var useRef = React.useRef;
  var useState = React.useState;
  var useSyncExternalStore = React.useSyncExternalStore;
  var ctx = Modulith.createContext();
  var KEY_BOARD = "board";
  var KEY_DRAFT = "draft";
  var KEY_PREFS = "prefs";
  var SCHEMA_VERSION = 1;
  var TOPIC_CHANGED = "kanban.board.changed";
  var DEFAULT_LANES = ["待处理", "进行中", "已完成"];
  var LANE_NAME_MAX = 18;
  var CARD_TITLE_MAX = 120;
  var CARD_NOTE_MAX = 500;
  var DRAFT_MAX = 4e3;
  var LANE_AUTO_DONE = "完成";
  var UNDO_MS = 8e3;
  var DRAFT_DEBOUNCE_MS = 400;
  var SAVE_DEBOUNCE_MS = 400;
  var DRAG_THRESHOLD = 6;
  var NOTIFICATION_ID_MAX = 200;
  var PRIORITY_LABEL = { low: "低", normal: "中", high: "高" };
  var PRIORITY_ORDER = { high: 0, normal: 1, low: 2 };
  var RECURRENCE_LABEL = { daily: "每天", weekly: "每周", monthly: "每月" };
  var PRIORITY_CLASS = {
    low: "kanban__pill--low",
    normal: "kanban__pill--normal",
    high: "kanban__pill--high"
  };
  var DUE_CLASS = {
    normal: "kanban__due--normal",
    soon: "kanban__due--soon",
    today: "kanban__due--today",
    overdue: "kanban__due--overdue",
    done: "kanban__due--done"
  };

  // src/kanban/store.js
  function createStore() {
    var state = {
      status: "loading",
      // loading | ready | error
      errorMessage: null,
      notes: [],
      saveState: "idle",
      // idle | saving | saved | error
      saveError: null,
      board: null,
      draft: "",
      prefs: { notify: true },
      conflict: false
    };
    var listeners = /* @__PURE__ */ new Set();
    return {
      subscribe: function(listener) {
        listeners.add(listener);
        return function() {
          listeners.delete(listener);
        };
      },
      getSnapshot: function() {
        return state;
      },
      set: function(patch) {
        state = Object.assign({}, state, patch);
        listeners.forEach(function(listener) {
          listener();
        });
      },
      patchBoard: function(board, extra) {
        this.set(Object.assign({ board }, extra || {}));
      }
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
    remindedDay: null
  };
  function pushNote(message) {
    if (!message) return;
    var notes = store.getSnapshot().notes || [];
    if (notes.indexOf(message) >= 0) return;
    store.set({ notes: notes.concat([message]) });
  }
  function greeting() {
    var hour = (/* @__PURE__ */ new Date()).getHours();
    if (hour < 5) return "夜深了";
    if (hour < 11) return "早上好";
    if (hour < 14) return "中午好";
    if (hour < 18) return "下午好";
    return "晚上好";
  }
  function load() {
    return ctx.storage.get(KEY_BOARD, null).then(function(raw) {
      var result = normalizeBoard(raw);
      if (!internal.alive) return;
      internal.loaded = true;
      internal.savedRev = result.board.rev;
      internal.lastGood = clone(result.board);
      internal.writeBlocked = result.board.schemaVersion > SCHEMA_VERSION;
      store.set({
        status: "ready",
        errorMessage: null,
        notes: result.notes,
        board: result.board
      });
      if (internal.writeBlocked) {
        store.set({
          saveState: "error",
          saveError: "磁盘上的数据来自更新版本的看板插件，本版本不会写入，以免覆盖它。"
        });
      }
    }).catch(function(err) {
      if (!internal.alive) return;
      ctx.logger.error("读取看板数据失败", err);
      store.set({
        status: "error",
        errorMessage: "读取数据失败：" + (err && err.message || "未知原因") + "。磁盘上的数据没有被改动，修好原因后点「重新读取」再试。"
      });
    });
  }
  function loadDraft() {
    return ctx.storage.get(KEY_DRAFT, "").then(function(value) {
      if (!internal.alive) return;
      store.set({ draft: typeof value === "string" ? value.slice(0, DRAFT_MAX) : "" });
    }).catch(function(err) {
      if (!internal.alive) return;
      ctx.logger.warn("读取速记草稿失败", err);
      store.set({ draft: "" });
    });
  }
  function loadPrefs() {
    return ctx.storage.get(KEY_PREFS, null).then(function(raw) {
      if (!internal.alive) return;
      store.set({ prefs: normalizePrefs(raw) });
    }).catch(function(err) {
      ctx.logger.warn("读取提醒设置失败，按默认（开启提醒）处理", err);
    });
  }
  function reload() {
    store.set({ status: "loading", errorMessage: null });
    return load().then(loadDraft).then(loadPrefs);
  }
  function saveNow(reason) {
    if (internal.writeBlocked) {
      store.set({
        saveState: "error",
        saveError: "磁盘上的数据来自更新版本的看板插件，本次没有写入，以免覆盖。"
      });
      return Promise.resolve();
    }
    if (store.getSnapshot().conflict) return Promise.resolve();
    if (internal.saving) {
      return new Promise(function(resolve) {
        internal.saveWaiters.push(resolve);
      });
    }
    var snapshot = clone(store.getSnapshot().board);
    if (!snapshot) return Promise.resolve();
    snapshot.schemaVersion = SCHEMA_VERSION;
    internal.saving = true;
    store.set({ saveState: "saving", saveError: null });
    return ctx.storage.get(KEY_BOARD, null).then(function(raw) {
      var disk = normalizeBoard(raw).board;
      if (disk.rev > internal.savedRev) {
        internal.savedRev = disk.rev;
        internal.lastGood = clone(disk);
        store.set({
          board: disk,
          conflict: true,
          saveState: "error",
          saveError: "检测到另一处（分屏的另一半，或上一次会话）已经保存过更改，界面已切换成对方的版本，本地这次的改动没有写入。请重新调整后再试。"
        });
        return false;
      }
      return ctx.storage.set(KEY_BOARD, snapshot).then(function() {
        return true;
      });
    }).then(function(written) {
      if (written !== true) return;
      internal.savedRev = snapshot.rev;
      internal.lastGood = clone(snapshot);
      store.set({ saveState: "saved", saveError: null, conflict: false });
      ctx.events.publish(TOPIC_CHANGED, { rev: snapshot.rev, at: Date.now() });
    }).catch(function(err) {
      ctx.logger.error("保存看板失败（" + reason + "）", err);
      store.set({
        saveState: "error",
        saveError: "保存失败：" + (err && err.message || "未知原因") + "。改动还在界面上，可以点「重试保存」；若一直失败，多半是磁盘空间或数据目录权限的问题。"
      });
    }).then(function() {
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
    internal.timer = setTimeout(function() {
      internal.timer = null;
      saveNow(reason);
    }, SAVE_DEBOUNCE_MS);
  }
  function savePrefsNow(prefs) {
    ctx.storage.set(KEY_PREFS, prefs).catch(function(err) {
      ctx.logger.warn("保存提醒设置失败", err);
    });
  }
  function commit(board, reason) {
    store.patchBoard(touchBoard(board), { conflict: false });
    scheduleSave(reason);
  }
  function rememberNotification(id) {
    internal.notifiedIds.push(id);
    if (internal.notifiedIds.length > NOTIFICATION_ID_MAX) {
      internal.notifiedIds = internal.notifiedIds.slice(-NOTIFICATION_ID_MAX);
    }
  }
  function notify(title, body, dedupeKey) {
    if (!ctx.notifications.isAvailable || !ctx.notifications.isAvailable()) {
      ctx.logger.info("未声明 notification 权限，跳过通知：" + title);
      return;
    }
    try {
      ctx.notifications.info(title, body, dedupeKey);
    } catch (err) {
      ctx.logger.warn("发送通知失败", err);
    }
  }
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
    var signature = overdue.length + ":" + dueToday.length + ":" + (overdue[0] ? overdue[0].id : "-") + ":" + (dueToday[0] ? dueToday[0].id : "-");
    var key = "kanban-due-" + today + "-" + signature;
    if (internal.notifiedIds.indexOf(key) >= 0) return;
    rememberNotification(key);
    function names(list) {
      var shown = list.slice(0, 3).map(function(card2) {
        return card2.title;
      });
      return shown.join("、") + (list.length > 3 ? " 等 " + list.length + " 项" : "");
    }
    var title;
    var body;
    if (overdue.length > 0 && dueToday.length > 0) {
      title = "有 " + overdue.length + " 项已逾期、" + dueToday.length + " 项今天到期";
      body = "逾期：" + names(overdue) + "；今天：" + names(dueToday);
    } else if (overdue.length > 0) {
      title = "有 " + overdue.length + " 项已经逾期";
      body = names(overdue);
    } else {
      title = "有 " + dueToday.length + " 项今天到期";
      body = names(dueToday);
    }
    notify(title, body, key);
  }
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
      card.due = nextRecurrenceDue(card.due, card.recurrence);
      card.done = false;
      card.completedAt = null;
    }
    card.updatedAt = nowIso();
    return board;
  }
  var boardActions = {
    addCard: function(laneId, title, priority, due, recurrence) {
      var board = clone(store.getSnapshot().board);
      if (!board) return null;
      var card = makeCard(laneId, title, nextOrder(board, laneId));
      card.priority = priority || "normal";
      card.due = due || null;
      card.recurrence = recurrence || null;
      board.cards[card.id] = card;
      commit(board, "新增卡片");
      return card.id;
    },
    updateCard: function(cardId, patch) {
      var board = clone(store.getSnapshot().board);
      if (!board || !board.cards[cardId]) return;
      var card = board.cards[cardId];
      if (patch.title !== void 0) card.title = patch.title;
      if (patch.note !== void 0) card.note = patch.note;
      if (patch.priority !== void 0) card.priority = patch.priority;
      if (patch.due !== void 0) card.due = patch.due;
      if (patch.recurrence !== void 0) card.recurrence = patch.recurrence;
      if (patch.done !== void 0) {
        if (patch.done) completeCard(board, card);
        else {
          card.done = false;
          card.completedAt = null;
        }
      }
      card.updatedAt = nowIso();
      commit(board, "编辑卡片");
    },
    toggleDone: function(cardId, done) {
      var board = clone(store.getSnapshot().board);
      if (!board || !board.cards[cardId]) return;
      var card = board.cards[cardId];
      if (done) completeCard(board, card);
      else {
        card.done = false;
        card.completedAt = null;
      }
      card.updatedAt = nowIso();
      commit(board, "切换完成状态");
    },
    moveCard: function(cardId, targetLaneId, beforeId, afterId) {
      var board = store.getSnapshot().board;
      if (!board || !board.cards[cardId]) return;
      var next = moveCardPure(board, cardId, targetLaneId, beforeId, afterId);
      if (next === board) return;
      commit(next, "移动卡片");
    },
    deleteCard: function(cardId) {
      var board = clone(store.getSnapshot().board);
      if (!board || !board.cards[cardId]) return null;
      var title = board.cards[cardId].title;
      delete board.cards[cardId];
      commit(board, "删除卡片");
      return title;
    },
    restoreCard: function(card) {
      var board = clone(store.getSnapshot().board);
      if (!board) return;
      board.cards[card.id] = clone(card);
      commit(board, "撤销删除");
    },
    clearDone: function() {
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
      if (removed > 0) commit(board, "清除已完成");
      return removed;
    },
    addLane: function(name) {
      var board = clone(store.getSnapshot().board);
      if (!board) return;
      board.lanes.push(makeLane(name));
      commit(board, "新增列表");
    },
    renameLane: function(laneId, name) {
      var board = clone(store.getSnapshot().board);
      if (!board) return;
      var target = laneById(board, laneId);
      if (!target) return;
      target.name = name;
      commit(board, "重命名列表");
    },
    toggleLaneCollapsed: function(laneId) {
      var board = clone(store.getSnapshot().board);
      if (!board) return;
      var target = laneById(board, laneId);
      if (!target) return;
      target.collapsed = !target.collapsed;
      commit(board, "折叠列表");
    },
    moveLane: function(laneId, targetIndex) {
      var board = store.getSnapshot().board;
      if (!board) return;
      var next = moveLanePure(board, laneId, targetIndex);
      if (next === board) return;
      commit(next, "调整列表顺序");
    },
    /** 删除列表，返回可以撤销的数据（列表本身 + 它里面的卡片）。 */
    deleteLane: function(laneId) {
      var board = clone(store.getSnapshot().board);
      if (!board) return null;
      if (board.lanes.length <= 1) return null;
      var index = laneIndexById(board, laneId);
      if (index < 0) return null;
      var removedLane = board.lanes[index];
      var removedCards = cardsInLane(board, laneId);
      board.lanes = board.lanes.filter(function(item) {
        return item.id !== laneId;
      });
      var ids = Object.keys(board.cards);
      for (var i = 0; i < ids.length; i += 1) {
        if (board.cards[ids[i]].laneId === laneId) delete board.cards[ids[i]];
      }
      commit(board, "删除列表");
      return { lane: removedLane, index, cards: removedCards, name: removedLane.name };
    },
    restoreLane: function(snapshot) {
      var board = clone(store.getSnapshot().board);
      if (!board || !snapshot) return;
      var at = Math.max(0, Math.min(snapshot.index, board.lanes.length));
      board.lanes.splice(at, 0, clone(snapshot.lane));
      for (var i = 0; i < snapshot.cards.length; i += 1) {
        board.cards[snapshot.cards[i].id] = clone(snapshot.cards[i]);
      }
      commit(board, "撤销删除列表");
    },
    /**
     * 恢复默认的三栏。
     *
     * 默认三栏的名字已经存在就复用（只把它挪到该在的位置），不重复造一栏；
     * 卡片按所在栏与完成状态归位：已完成或原本在「完成」栏的进「已完成」，
     * 原本在「进行中」的进「进行中」，其余进「待处理」。**一张卡片都不会被删。**
     */
    resetLanes: function() {
      var board = clone(store.getSnapshot().board);
      if (!board) return false;
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
        var sourceName = sourceNameByLane[card.laneId] || "";
        var toDone = card.done || sourceName.indexOf(LANE_AUTO_DONE) >= 0;
        var toDoing = !toDone && sourceName === DEFAULT_LANES[1];
        card.laneId = toDone ? target[DEFAULT_LANES[2]].id : toDoing ? target[DEFAULT_LANES[1]].id : target[DEFAULT_LANES[0]].id;
        card.updatedAt = nowIso();
      }
      commit(board, "恢复默认列表");
      return true;
    }
  };

  // src/kanban/model.js
  function clone(value) {
    return value === void 0 ? value : JSON.parse(JSON.stringify(value));
  }
  function nowIso() {
    return (/* @__PURE__ */ new Date()).toISOString();
  }
  function uid() {
    try {
      if (typeof crypto !== "undefined" && crypto && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
      }
    } catch (err) {
    }
    return "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }
  function makeLane(name) {
    return { id: uid(), name, collapsed: false, createdAt: nowIso() };
  }
  function defaultLanes() {
    var lanes = [];
    for (var i = 0; i < DEFAULT_LANES.length; i += 1) lanes.push(makeLane(DEFAULT_LANES[i]));
    return lanes;
  }
  function defaultBoard() {
    return {
      schemaVersion: SCHEMA_VERSION,
      rev: 0,
      updatedAt: nowIso(),
      lanes: defaultLanes(),
      cards: {}
    };
  }
  function isPlainObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
  }
  function text(value) {
    return typeof value === "string" ? value : "";
  }
  function isDateKey(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(value);
  }
  function makeCard(laneId, title, order) {
    var id = uid();
    return {
      id,
      laneId,
      title,
      note: "",
      priority: "normal",
      due: null,
      recurrence: null,
      done: false,
      order: typeof order === "number" ? order : 1,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      completedAt: null
    };
  }
  function normalizeBoard(raw) {
    if (!isPlainObject(raw)) return { board: defaultBoard(), notes: [] };
    var notes = [];
    var version = typeof raw.schemaVersion === "number" ? raw.schemaVersion : SCHEMA_VERSION;
    if (version > SCHEMA_VERSION) {
      notes.push("这份数据来自更新版本的看板插件，本版本只读取、不写入，以免覆盖。");
    }
    var laneIds = {};
    var rawLanes = Array.isArray(raw.lanes) ? raw.lanes : [];
    var lanes = [];
    for (var i = 0; i < rawLanes.length; i += 1) {
      var item = rawLanes[i];
      if (!isPlainObject(item) || !text(item.id) || laneIds[item.id]) continue;
      laneIds[item.id] = true;
      lanes.push({
        id: item.id,
        name: text(item.name).slice(0, LANE_NAME_MAX) || "未命名列表",
        collapsed: !!item.collapsed,
        createdAt: text(item.createdAt) || nowIso()
      });
    }
    if (lanes.length === 0) {
      lanes = defaultLanes();
      laneIds = {};
      for (var k = 0; k < lanes.length; k += 1) laneIds[lanes[k].id] = true;
      if (rawLanes.length > 0) notes.push("列表结构无法识别，已重置为默认的三个列表。");
    }
    var rawCards = isPlainObject(raw.cards) ? raw.cards : {};
    var cards = {};
    var dropped = 0;
    var ids = Object.keys(rawCards);
    for (var j = 0; j < ids.length; j += 1) {
      var id = ids[j];
      var card = rawCards[id];
      if (!isPlainObject(card)) {
        dropped += 1;
        continue;
      }
      var cardId = text(card.id) || id;
      if (cardId !== id) dropped += 0;
      if (!laneIds[card.laneId]) {
        dropped += 1;
        continue;
      }
      var done = !!card.done;
      var recurrence = card.recurrence === "daily" || card.recurrence === "weekly" || card.recurrence === "monthly" ? card.recurrence : null;
      cards[id] = {
        id,
        laneId: card.laneId,
        title: text(card.title).slice(0, CARD_TITLE_MAX) || "未命名卡片",
        note: text(card.note).slice(0, CARD_NOTE_MAX),
        priority: card.priority === "low" || card.priority === "high" ? card.priority : "normal",
        due: isDateKey(text(card.due)) ? card.due : null,
        recurrence,
        done,
        order: typeof card.order === "number" && isFinite(card.order) ? card.order : 0,
        createdAt: text(card.createdAt) || nowIso(),
        updatedAt: text(card.updatedAt) || nowIso(),
        completedAt: done ? text(card.completedAt) || nowIso() : null
      };
    }
    if (dropped > 0) notes.push("有 " + dropped + " 张卡片的数据不完整，已跳过。");
    return {
      board: {
        schemaVersion: Math.max(version, SCHEMA_VERSION),
        rev: typeof raw.rev === "number" && isFinite(raw.rev) ? raw.rev : 0,
        updatedAt: text(raw.updatedAt) || nowIso(),
        lanes,
        cards
      },
      notes
    };
  }
  function normalizePrefs(raw) {
    if (!isPlainObject(raw)) return { notify: true };
    return { notify: raw.notify !== false };
  }
  function cardsInLane(board, laneId) {
    var result = [];
    var ids = Object.keys(board.cards);
    for (var i = 0; i < ids.length; i += 1) {
      if (board.cards[ids[i]].laneId === laneId) result.push(board.cards[ids[i]]);
    }
    result.sort(function(a, b) {
      var byOrder = a.order - b.order;
      if (byOrder !== 0) return byOrder;
      if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
      return a.id < b.id ? -1 : 1;
    });
    return result;
  }
  function nextOrder(board, laneId) {
    var list = cardsInLane(board, laneId);
    return list.length === 0 ? 1 : list[list.length - 1].order + 1;
  }
  function laneById(board, laneId) {
    for (var i = 0; i < board.lanes.length; i += 1) {
      if (board.lanes[i].id === laneId) return board.lanes[i];
    }
    return null;
  }
  function laneIndexById(board, laneId) {
    for (var i = 0; i < board.lanes.length; i += 1) {
      if (board.lanes[i].id === laneId) return i;
    }
    return -1;
  }
  function laneNameOf(board, laneId) {
    var found = laneById(board, laneId);
    return found ? found.name : "已删除的列表";
  }
  function touchBoard(board) {
    board.rev = (typeof board.rev === "number" ? board.rev : 0) + 1;
    board.updatedAt = nowIso();
    return board;
  }
  function moveCardPure(board, cardId, targetLaneId, beforeId, afterId) {
    var card = board.cards[cardId];
    if (!card || !laneById(board, targetLaneId)) return board;
    var next = clone(board);
    var source = next.cards[cardId];
    var target = laneById(next, targetLaneId);
    var before = beforeId && beforeId !== cardId ? next.cards[beforeId] : null;
    var after = afterId && afterId !== cardId ? next.cards[afterId] : null;
    var order;
    if (before) order = before.order + 1;
    else if (after) order = after.order - 1;
    else order = nextOrder(next, targetLaneId);
    if (before && after && order >= after.order) order = (before.order + after.order) / 2;
    var laneChanged = source.laneId !== targetLaneId;
    source.order = order;
    source.laneId = targetLaneId;
    source.updatedAt = nowIso();
    if (laneChanged && target && target.name.indexOf(LANE_AUTO_DONE) >= 0 && !source.done) {
      source.done = true;
      source.completedAt = nowIso();
    }
    return touchBoard(next);
  }
  function moveLanePure(board, laneId, targetIndex) {
    var from = laneIndexById(board, laneId);
    if (from < 0) return board;
    var to = typeof targetIndex === "number" ? targetIndex : from;
    if (to < 0) to = 0;
    if (to > board.lanes.length - 1) to = board.lanes.length - 1;
    if (to === from) return board;
    var next = clone(board);
    var moved = next.lanes.splice(from, 1)[0];
    next.lanes.splice(to, 0, moved);
    return touchBoard(next);
  }

  // src/kanban/dates.js
  function pad2(value) {
    return (value < 10 ? "0" : "") + value;
  }
  function dateKey(date) {
    return date.getFullYear() + "-" + pad2(date.getMonth() + 1) + "-" + pad2(date.getDate());
  }
  function parseDateKey(key) {
    var parts = text(key).split("-");
    if (parts.length !== 3) return null;
    var date = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    return isNaN(date.getTime()) ? null : date;
  }
  function todayKey() {
    return dateKey(/* @__PURE__ */ new Date());
  }
  function addDays(key, days) {
    var date = parseDateKey(key) || /* @__PURE__ */ new Date();
    date.setDate(date.getDate() + days);
    return dateKey(date);
  }
  function nextWeekendKey() {
    var date = /* @__PURE__ */ new Date();
    var day = date.getDay();
    date.setDate(date.getDate() + (6 - day + 7) % 7);
    return dateKey(date);
  }
  function nextMondayKey() {
    var date = /* @__PURE__ */ new Date();
    var day = date.getDay();
    date.setDate(date.getDate() + ((8 - day) % 7 || 7));
    return dateKey(date);
  }
  function nextRecurrenceDue(currentDue, recurrence) {
    var base = parseDateKey(currentDue);
    var today = /* @__PURE__ */ new Date();
    if (!base || base.getTime() < new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) {
      base = today;
    }
    var next = new Date(base.getFullYear(), base.getMonth(), base.getDate());
    if (recurrence === "daily") {
      next.setDate(next.getDate() + 1);
    } else if (recurrence === "weekly") {
      next.setDate(next.getDate() + 7);
    } else if (recurrence === "monthly") {
      var anchor = parseDateKey(currentDue) || today;
      var day = anchor.getDate();
      var year = base.getFullYear();
      var month = base.getMonth() + 1;
      if (month > 11) {
        month = 0;
        year += 1;
      }
      var lastDay = new Date(year, month + 1, 0).getDate();
      next = new Date(year, month, Math.min(day, lastDay));
    }
    return dateKey(next);
  }
  function dueInfo(due, done) {
    if (!due) return null;
    if (done) return { text: due, tone: "done" };
    var today = todayKey();
    if (due === today) return { text: "今天到期", tone: "today" };
    var days = Math.round(
      ((parseDateKey(due) || /* @__PURE__ */ new Date()).getTime() - (parseDateKey(today) || /* @__PURE__ */ new Date()).getTime()) / 864e5
    );
    if (days < 0) return { text: "逾期 " + Math.abs(days) + " 天", tone: "overdue" };
    if (days === 1) return { text: "明天到期", tone: "soon" };
    if (days <= 6) return { text: days + " 天后", tone: "soon" };
    return { text: "截止 " + due.slice(5), tone: "normal" };
  }
  function formatDateTime(iso) {
    if (!iso) return "";
    var value = new Date(iso);
    if (isNaN(value.getTime())) return "";
    return value.getFullYear() + "-" + pad2(value.getMonth() + 1) + "-" + pad2(value.getDate()) + " " + pad2(value.getHours()) + ":" + pad2(value.getMinutes());
  }
  function isOverdue(card, today) {
    return !!card.due && !card.done && card.due < today;
  }
  function matchesQuery(card, query) {
    if (!query) return true;
    var needle = query.toLowerCase();
    return card.title.toLowerCase().indexOf(needle) >= 0 || card.note.toLowerCase().indexOf(needle) >= 0;
  }
  function sortCards(list) {
    return list.slice().sort(function(a, b) {
      if (a.done !== b.done) return a.done ? 1 : -1;
      var byPriority = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
      if (byPriority !== 0) return byPriority;
      if (a.due && b.due) {
        if (a.due !== b.due) return a.due < b.due ? -1 : 1;
      } else if (a.due || b.due) {
        return a.due ? -1 : 1;
      }
      if (a.order !== b.order) return a.order - b.order;
      if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
      return a.id < b.id ? -1 : 1;
    });
  }

  // src/kanban/icons.js
  function icon(size, children) {
    return h(
      "svg",
      {
        viewBox: "0 0 24 24",
        width: size,
        height: size,
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 1.8,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        "aria-hidden": "true",
        focusable: "false"
      },
      children
    );
  }
  var icons = {
    plus: function(size) {
      return icon(size || 16, [h("path", { key: "a", d: "M12 5v14" }), h("path", { key: "b", d: "M5 12h14" })]);
    },
    search: function() {
      return icon(15, [
        h("circle", { key: "a", cx: 11, cy: 11, r: 7 }),
        h("path", { key: "b", d: "M20 20l-3.6-3.6" })
      ]);
    },
    grip: function(size) {
      return icon(size || 14, [h("path", { key: "a", d: "M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01" })]);
    },
    pencil: function() {
      return icon(14, [h("path", { key: "a", d: "M4 20h4L18 10l-4-4L4 16v4z" }), h("path", { key: "b", d: "M13.5 6.5l4 4" })]);
    },
    arrowRight: function() {
      return icon(14, [h("path", { key: "a", d: "M5 12h14" }), h("path", { key: "b", d: "M13 6l6 6-6 6" })]);
    },
    arrowLeft: function() {
      return icon(14, [h("path", { key: "a", d: "M19 12H5" }), h("path", { key: "b", d: "M11 6l-6 6 6 6" })]);
    },
    trash: function() {
      return icon(14, [
        h("path", { key: "a", d: "M4 7h16" }),
        h("path", { key: "b", d: "M7 7l1 13h8l1-13" }),
        h("path", { key: "c", d: "M9 7V4h6v3" })
      ]);
    },
    check: function() {
      return icon(14, [h("path", { key: "a", d: "M5 13l4 4L19 7" })]);
    },
    undo: function() {
      return icon(14, [h("path", { key: "a", d: "M9 14L4 9l5-5" }), h("path", { key: "b", d: "M4 9h10a6 6 0 0 1 0 12h-3" })]);
    },
    calendar: function(size) {
      return icon(size || 13, [
        h("rect", { key: "a", x: 3.5, y: 5, width: 17, height: 15, rx: 2 }),
        h("path", { key: "b", d: "M8 3v4M16 3v4M3.5 10h17" })
      ]);
    },
    repeat: function(size) {
      return icon(size || 13, [
        h("path", { key: "a", d: "M4 9h11a4 4 0 0 1 0 8H7" }),
        h("path", { key: "b", d: "M7 5L3 9l4 4" })
      ]);
    },
    note: function(size) {
      return icon(size || 13, [h("path", { key: "a", d: "M5 5h14M5 10h14M5 15h9" })]);
    },
    bell: function(size) {
      return icon(size || 14, [
        h("path", { key: "a", d: "M6 9a6 6 0 1 1 12 0c0 4 1.5 5.5 2 6H4c.5-.5 2-2 2-6z" }),
        h("path", { key: "b", d: "M10 19a2 2 0 0 0 4 0" })
      ]);
    },
    bellOff: function(size) {
      return icon(size || 14, [
        h("path", { key: "a", d: "M8 6.3A6 6 0 0 1 18 9c0 1.6.3 2.8.7 3.7" }),
        h("path", { key: "b", d: "M6 9.6C5.8 12.4 4.6 14 4 15h11" }),
        h("path", { key: "c", d: "M4 4l16 16" })
      ]);
    },
    close: function() {
      return icon(16, [h("path", { key: "a", d: "M6 6l12 12" }), h("path", { key: "b", d: "M18 6L6 18" })]);
    },
    inbox: function(size) {
      return icon(size || 14, [
        h("path", { key: "a", d: "M4 13l2-7h12l2 7v6H4z" }),
        h("path", { key: "b", d: "M4 13h5l1 2h4l1-2h5" })
      ]);
    },
    columns: function(size) {
      return icon(size || 14, [
        h("rect", { key: "a", x: 3, y: 5, width: 7, height: 14, rx: 1.6 }),
        h("rect", { key: "b", x: 14, y: 5, width: 7, height: 14, rx: 1.6 })
      ]);
    },
    more: function(size) {
      return icon(size || 14, [
        h("path", { key: "a", d: "M12 6h.01M12 12h.01M12 18h.01" })
      ]);
    }
  };

  // src/kanban/ui.js
  function IconButton(props) {
    return h(
      "button",
      {
        type: "button",
        className: "kanban__icon-btn" + (props.tone === "danger" ? " kanban__icon-btn--danger" : "") + (props.active ? " is-active" : "") + (props.grip ? " kanban__icon-btn--grip" : ""),
        "aria-label": props.label,
        title: props.title || props.label,
        "aria-pressed": props.pressed,
        disabled: props.disabled,
        onClick: props.onClick,
        onPointerDown: props.onPointerDown
      },
      props.children
    );
  }
  function Menu(props) {
    var openState = useState(false);
    var open = openState[0];
    var setOpen = openState[1];
    var wrapRef = useRef(null);
    useEffect(function() {
      if (!open) return void 0;
      function onPointerDown(event) {
        if (wrapRef.current && wrapRef.current.contains(event.target)) return;
        setOpen(false);
      }
      function onKeyDown(event) {
        if (event.key === "Escape") setOpen(false);
      }
      var timer = setTimeout(function() {
        window.addEventListener("pointerdown", onPointerDown);
        window.addEventListener("keydown", onKeyDown);
      }, 0);
      return function() {
        clearTimeout(timer);
        window.removeEventListener("pointerdown", onPointerDown);
        window.removeEventListener("keydown", onKeyDown);
      };
    }, [open]);
    return h(
      "div",
      { className: "kanban__menu-wrap", ref: wrapRef },
      h(
        "button",
        {
          type: "button",
          className: props.triggerClass || "kanban__icon-btn",
          "aria-haspopup": "menu",
          "aria-expanded": open,
          "aria-label": props.label,
          title: props.title || props.label,
          onClick: function() {
            setOpen(!open);
          }
        },
        props.trigger
      ),
      open ? h(
        "div",
        { className: "kanban__menu", role: "menu", "aria-label": props.label },
        typeof props.children === "function" ? props.children(function() {
          setOpen(false);
        }) : props.children
      ) : null
    );
  }
  function MenuItem(props) {
    return h(
      "button",
      {
        type: "button",
        role: "menuitem",
        className: "kanban__menu-item" + (props.danger ? " kanban__menu-item--danger" : ""),
        disabled: props.disabled,
        onClick: props.onClick
      },
      props.children
    );
  }
  function ErrorBanner() {
    var state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    if (state.status === "error") {
      return h(
        "div",
        { className: "kanban__banner kanban__banner--error", role: "alert" },
        h("span", { className: "kanban__banner-text" }, state.errorMessage),
        h("button", { type: "button", className: "kanban__btn kanban__btn--ghost", onClick: reload }, "重新读取")
      );
    }
    if (state.status === "ready" && state.saveState === "error") {
      return h(
        "div",
        { className: "kanban__banner kanban__banner--error", role: "alert" },
        h("span", { className: "kanban__banner-text" }, state.saveError),
        h(
          "button",
          {
            type: "button",
            className: "kanban__btn kanban__btn--ghost",
            onClick: function() {
              saveNow("手动重试");
            }
          },
          "重试保存"
        )
      );
    }
    if (state.status === "ready" && state.notes.length > 0) {
      return h(
        "div",
        { className: "kanban__banner kanban__banner--warn", role: "status" },
        h("span", { className: "kanban__banner-text" }, state.notes.join(" "))
      );
    }
    return null;
  }
  function SaveIndicator(props) {
    var state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    if (state.status !== "ready") return null;
    var label = "自动保存";
    var tone = "is-muted";
    if (props.draftState === "error" || state.saveState === "error") {
      label = "有改动没保存";
      tone = "is-danger";
    } else if (props.draftState === "saving" || state.saveState === "saving") {
      label = "正在保存…";
    } else if (props.draftState === "saved" || state.saveState === "saved") {
      label = "已保存";
      tone = "is-ok";
    }
    return h(
      "span",
      { className: "kanban__save " + tone, role: "status", "aria-live": "polite" },
      tone === "is-ok" ? icons.check() : null,
      label
    );
  }
  function DatePicker(props) {
    var quick = [
      { label: "今天", value: todayKey() },
      { label: "明天", value: addDays(todayKey(), 1) },
      { label: "本周末", value: nextWeekendKey() },
      { label: "下周一", value: nextMondayKey() }
    ];
    var current = props.value || "";
    return h(
      "div",
      { className: "kanban__datepick" },
      h(
        "div",
        { className: "kanban__quick" },
        quick.map(function(item) {
          return h(
            "button",
            {
              key: item.label,
              type: "button",
              className: "kanban__quick-btn" + (current === item.value ? " is-active" : ""),
              "aria-pressed": current === item.value,
              onClick: function() {
                props.onChange(current === item.value ? null : item.value);
              }
            },
            item.label
          );
        }),
        h(
          "button",
          {
            type: "button",
            className: "kanban__quick-btn" + (props.value ? "" : " is-active"),
            onClick: function() {
              props.onChange(null);
            }
          },
          "不设"
        )
      ),
      h(
        "div",
        { className: "kanban__datepick-row" },
        h("span", { className: "kanban__datepick-icon", "aria-hidden": "true" }, icons.calendar(14)),
        h("input", {
          type: "date",
          className: "kanban__input kanban__input--date",
          value: current,
          "aria-label": "自选截止日",
          onChange: function(event) {
            props.onChange(event.target.value || null);
          }
        }),
        current ? h(
          "button",
          {
            type: "button",
            className: "kanban__btn kanban__btn--ghost kanban__btn--tight",
            onClick: function() {
              props.onChange(addDays(current, 1));
            }
          },
          "顺延一天"
        ) : null
      )
    );
  }
  function RecurrenceSelect(props) {
    return h(
      "select",
      {
        className: "kanban__select",
        value: props.value || "",
        "aria-label": "重复",
        onChange: function(event) {
          props.onChange(event.target.value || null);
        }
      },
      h("option", { value: "" }, "不重复"),
      h("option", { value: "daily" }, "每天"),
      h("option", { value: "weekly" }, "每周"),
      h("option", { value: "monthly" }, "每月")
    );
  }

  // src/kanban/editor.js
  function CardEditor(props) {
    var card = props.card;
    var titleState = useState(card.title);
    var title = titleState[0];
    var setTitle = titleState[1];
    var noteState = useState(card.note);
    var note = noteState[0];
    var setNote = noteState[1];
    var priorityState = useState(card.priority);
    var priority = priorityState[0];
    var setPriority = priorityState[1];
    var dueState = useState(card.due || null);
    var due = dueState[0];
    var setDue = dueState[1];
    var recurrenceState = useState(card.recurrence || null);
    var recurrence = recurrenceState[0];
    var setRecurrence = recurrenceState[1];
    var laneState = useState(card.laneId);
    var laneId = laneState[0];
    var setLaneId = laneState[1];
    var confirmState = useState(false);
    var confirming = confirmState[0];
    var setConfirming = confirmState[1];
    var panelRef = useRef(null);
    useEffect(function() {
      if (panelRef.current && panelRef.current.focus) panelRef.current.focus();
    }, []);
    function onKeyDown(event) {
      if (event.key === "Escape") {
        event.stopPropagation();
        props.onClose();
      }
    }
    function submit(event) {
      if (event) event.preventDefault();
      var value = title.trim();
      props.onSave({
        title: value.length > 0 ? value.slice(0, CARD_TITLE_MAX) : card.title,
        note: note.slice(0, CARD_NOTE_MAX),
        priority,
        due: due || null,
        recurrence,
        laneId
      });
    }
    var dueHint = dueInfo(due, false);
    return h(
      "div",
      {
        className: "kanban__overlay",
        onPointerDown: function(event) {
          if (event.target === event.currentTarget) props.onClose();
        }
      },
      h(
        "form",
        {
          ref: panelRef,
          className: "kanban__dialog",
          tabIndex: -1,
          role: "dialog",
          "aria-modal": "true",
          "aria-label": "编辑卡片",
          onSubmit: submit,
          onKeyDown
        },
        h(
          "div",
          { className: "kanban__dialog-head" },
          h("h3", { className: "kanban__dialog-title" }, "编辑卡片"),
          dueHint ? h("span", { className: "kanban__due " + DUE_CLASS[dueHint.tone] }, dueHint.text) : null,
          h("span", { className: "kanban__card-spacer" }),
          h(IconButton, { label: "关闭编辑器", title: "关闭（Esc）", onClick: props.onClose }, icons.close())
        ),
        h(
          "label",
          { className: "kanban__field" },
          h("span", { className: "kanban__label" }, "要做什么"),
          h("input", {
            className: "kanban__input",
            value: title,
            maxLength: CARD_TITLE_MAX,
            autoFocus: true,
            onChange: function(event) {
              setTitle(event.target.value);
            }
          })
        ),
        h(
          "label",
          { className: "kanban__field" },
          h("span", { className: "kanban__label" }, "补充说明（可留空）"),
          h("textarea", {
            className: "kanban__textarea",
            value: note,
            maxLength: CARD_NOTE_MAX,
            rows: 3,
            placeholder: "细节、链接、下一步……",
            onChange: function(event) {
              setNote(event.target.value);
            }
          }),
          h("span", { className: "kanban__hint" }, note.length + " / " + CARD_NOTE_MAX)
        ),
        h(
          "div",
          { className: "kanban__field" },
          h("span", { className: "kanban__label" }, "截止日"),
          h(DatePicker, { value: due, onChange: setDue })
        ),
        h(
          "div",
          { className: "kanban__field-row" },
          h(
            "label",
            { className: "kanban__field" },
            h("span", { className: "kanban__label" }, "优先级"),
            h(
              "select",
              {
                className: "kanban__select",
                value: priority,
                onChange: function(event) {
                  setPriority(event.target.value);
                }
              },
              h("option", { value: "low" }, "低"),
              h("option", { value: "normal" }, "中"),
              h("option", { value: "high" }, "高")
            )
          ),
          h(
            "label",
            { className: "kanban__field" },
            h("span", { className: "kanban__label" }, "重复"),
            h(RecurrenceSelect, { value: recurrence, onChange: setRecurrence })
          ),
          h(
            "label",
            { className: "kanban__field" },
            h("span", { className: "kanban__label" }, "所在列表"),
            h(
              "select",
              {
                className: "kanban__select",
                value: laneId,
                onChange: function(event) {
                  setLaneId(event.target.value);
                }
              },
              props.lanes.map(function(item) {
                return h("option", { key: item.id, value: item.id }, item.name);
              })
            )
          )
        ),
        recurrence ? h(
          "p",
          { className: "kanban__hint" },
          "勾选完成时这张卡片不会停在这里，而是自动把截止日推到下一次（" + RECURRENCE_LABEL[recurrence] + "）。"
        ) : null,
        h(
          "div",
          { className: "kanban__dialog-foot" },
          h("button", { type: "submit", className: "kanban__btn kanban__btn--primary" }, "保存"),
          h("button", { type: "button", className: "kanban__btn kanban__btn--ghost", onClick: props.onClose }, "取消"),
          h("span", { className: "kanban__card-spacer" }),
          h("span", { className: "kanban__hint kanban__hint--meta" }, "创建于 " + formatDateTime(card.createdAt)),
          confirming ? h("button", { type: "button", className: "kanban__btn kanban__btn--danger", onClick: props.onDelete }, "确认删除") : h(
            "button",
            {
              type: "button",
              className: "kanban__btn kanban__btn--danger-ghost",
              onClick: function() {
                setConfirming(true);
              }
            },
            "删除卡片"
          )
        )
      )
    );
  }

  // src/kanban/card.js
  function TaskCard(props) {
    var card = props.card;
    var due = dueInfo(card.due, card.done);
    var nodeRef = useRef(null);
    function isEditingText() {
      var node = nodeRef.current;
      if (!node || !node.tagName) return false;
      var tag = node.tagName.toLowerCase();
      return tag === "input" || tag === "textarea" || tag === "select";
    }
    function onKeyDown(event) {
      if (isEditingText()) return;
      var forward = event.altKey && event.key === "ArrowRight" || event.ctrlKey && event.key === "ArrowDown";
      var backward = event.altKey && event.key === "ArrowLeft" || event.ctrlKey && event.key === "ArrowUp";
      if (forward || backward) {
        event.preventDefault();
        var next = forward ? props.laneIndex + 1 : props.laneIndex - 1;
        if (next < 0 || next >= props.laneCount) return;
        props.onMoveToLane(next);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        props.onEdit(card.id);
        return;
      }
      if (event.key === "m" || event.key === "M") {
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        event.preventDefault();
        props.onShiftDue(card.id, 1);
      }
    }
    function onPointerDown(event) {
      if (props.dragging) return;
      if (event.button !== 0) return;
      var target = event.target;
      var interactive = target && target.closest ? target.closest("button, input, textarea, select, a, summary") : null;
      if (interactive) return;
      props.onDragStart(card.id, event);
    }
    return h(
      "article",
      {
        ref: nodeRef,
        className: "kanban__card" + (card.done ? " is-done" : "") + (isOverdue(card, todayKey()) ? " is-overdue" : "") + (props.justMoved ? " is-just-moved" : ""),
        tabIndex: 0,
        role: "group",
        "aria-label": card.title + "，位于「" + laneNameOf(props.board, card.laneId) + "」列表" + (card.done ? "，已完成" : "") + (due ? "，" + due.text : "") + "。按回车打开编辑器，按 Alt 加左右方向键移动到相邻列表，按 M 顺延一天。",
        "data-card-id": card.id,
        "data-lane-id": card.laneId,
        onPointerDown,
        onKeyDown,
        onDoubleClick: function() {
          props.onEdit(card.id);
        }
      },
      h("h3", { className: "kanban__card-title" }, card.title),
      card.note ? h("p", { className: "kanban__card-note" }, card.note) : null,
      h(
        "div",
        { className: "kanban__card-meta" },
        h(
          "button",
          {
            type: "button",
            className: "kanban__pill " + PRIORITY_CLASS[card.priority],
            title: "优先级：" + PRIORITY_LABEL[card.priority] + "（点击切换）",
            "aria-label": "优先级：" + PRIORITY_LABEL[card.priority] + "，点击切换",
            onClick: function() {
              var order = ["normal", "high", "low"];
              props.onSetPriority(card.id, order[(order.indexOf(card.priority) + 1) % order.length]);
            }
          },
          PRIORITY_LABEL[card.priority]
        ),
        due ? h(
          "button",
          {
            type: "button",
            className: "kanban__due " + DUE_CLASS[due.tone],
            title: "截止日：" + (card.due || "无") + "（点击顺延一天）",
            "aria-label": "截止日 " + (card.due || "未设置") + "，点击顺延一天",
            onClick: function() {
              props.onShiftDue(card.id, 1);
            }
          },
          icons.calendar(12),
          due.text
        ) : h(
          "button",
          {
            type: "button",
            className: "kanban__due kanban__due--empty",
            title: "设置截止日：今天",
            "aria-label": "未设截止日，点击设为今天",
            onClick: function() {
              props.onSetDue(card.id, todayKey());
            }
          },
          icons.calendar(12),
          "未设日期"
        ),
        card.recurrence ? h(
          "span",
          { className: "kanban__tag kanban__tag--repeat", title: "重复：" + RECURRENCE_LABEL[card.recurrence] },
          icons.repeat(12),
          RECURRENCE_LABEL[card.recurrence]
        ) : null,
        card.note ? h("span", { className: "kanban__tag", title: card.note }, icons.note(12)) : null,
        h("span", { className: "kanban__card-spacer" }),
        h(
          "div",
          { className: "kanban__card-actions" },
          h(
            "button",
            {
              type: "button",
              className: "kanban__mini" + (card.done ? " is-active" : ""),
              "aria-label": card.done ? "标记为未完成：" + card.title : "标记为已完成：" + card.title,
              "aria-pressed": card.done,
              title: card.done ? "标记为未完成" : "标记为已完成",
              onClick: function() {
                props.onToggleDone(card.id, !card.done);
              }
            },
            icons.check()
          ),
          h(
            "button",
            {
              type: "button",
              className: "kanban__mini",
              "aria-label": "编辑：" + card.title,
              title: "编辑",
              onClick: function() {
                props.onEdit(card.id);
              }
            },
            icons.pencil()
          ),
          h(
            "button",
            {
              type: "button",
              className: "kanban__mini",
              "aria-label": "把「" + card.title + "」移到下一个列表",
              title: "移到下一个列表（Alt + →）",
              disabled: props.laneIndex >= props.laneCount - 1,
              onClick: function() {
                props.onMoveToLane(props.laneIndex + 1);
              }
            },
            icons.arrowRight()
          ),
          h(
            "button",
            {
              type: "button",
              className: "kanban__mini kanban__mini--danger",
              "aria-label": "删除：" + card.title,
              title: "删除",
              onClick: function() {
                props.onDelete(card.id);
              }
            },
            icons.trash()
          )
        )
      )
    );
  }

  // src/kanban/lane.js
  function Lane(props) {
    var lane = props.lane;
    var composerState = useState(false);
    var composing = composerState[0];
    var setComposing = composerState[1];
    var formState = useState({ title: "", priority: "normal", due: null, recurrence: null });
    var form = formState[0];
    var setForm = formState[1];
    var renameState = useState(false);
    var renaming = renameState[0];
    var setRenaming = renameState[1];
    var confirmState = useState(false);
    var confirming = confirmState[0];
    var setConfirming = confirmState[1];
    var inputRef = useRef(null);
    useEffect(function() {
      if (composing && inputRef.current && inputRef.current.focus) inputRef.current.focus();
    }, [composing]);
    useEffect(function() {
      if (!confirming) return void 0;
      var timer = setTimeout(function() {
        setConfirming(false);
      }, 5e3);
      return function() {
        clearTimeout(timer);
      };
    }, [confirming]);
    function resetComposer() {
      setForm({ title: "", priority: "normal", due: null, recurrence: null });
      setComposing(false);
    }
    function submit(event) {
      if (event) event.preventDefault();
      var title = form.title.trim();
      if (!title) return;
      props.onAddCard(title.slice(0, CARD_TITLE_MAX), form.priority, form.due, form.recurrence);
      setForm({ title: "", priority: form.priority, due: null, recurrence: null });
      if (inputRef.current && inputRef.current.focus) inputRef.current.focus();
    }
    function onComposerKeyDown(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        resetComposer();
      }
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        submit(event);
      }
    }
    var cards = props.cards;
    var isDropLane = props.dragging && props.laneDropBeforeId === lane.id;
    var isDropLaneAfter = props.dragging && props.laneDropAfterId === lane.id;
    if (lane.collapsed) {
      return h(
        "section",
        {
          className: "kanban__lane kanban__lane--collapsed" + (isDropLane ? " is-drop-before" : "") + (isDropLaneAfter ? " is-drop-after" : ""),
          "data-lane-id": lane.id,
          "aria-label": lane.name + "列表，已折叠，共 " + cards.length + " 张卡片"
        },
        h(
          "button",
          {
            type: "button",
            className: "kanban__lane-collapsed-btn",
            "aria-label": "展开列表：" + lane.name,
            title: "展开列表",
            onClick: function() {
              props.onToggleCollapsed(lane.id);
            }
          },
          icons.arrowRight(),
          h("span", { className: "kanban__lane-name" }, lane.name),
          h("span", { className: "kanban__lane-count" }, String(cards.length))
        )
      );
    }
    return h(
      "section",
      {
        className: "kanban__lane" + (props.dropLaneId === lane.id && props.dragging === "card" ? " is-drop-target" : "") + (isDropLane ? " is-drop-before" : "") + (isDropLaneAfter ? " is-drop-after" : ""),
        "data-lane-id": lane.id,
        "aria-label": lane.name + "列表，共 " + cards.length + " 张卡片"
      },
      h(
        "header",
        { className: "kanban__lane-head" },
        h(
          IconButton,
          {
            label: "拖动调整「" + lane.name + "」的位置",
            title: "按住拖动可调整列表顺序",
            grip: true,
            onPointerDown: function(event) {
              props.onLaneDragStart(lane.id, event);
            }
          },
          icons.grip()
        ),
        renaming ? h("input", {
          className: "kanban__input kanban__input--inline",
          defaultValue: lane.name,
          autoFocus: true,
          maxLength: LANE_NAME_MAX,
          "aria-label": "列表名称",
          onBlur: function(event) {
            var value = event.target.value.trim();
            if (value && value !== lane.name) props.onRenameLane(lane.id, value.slice(0, LANE_NAME_MAX));
            setRenaming(false);
          },
          onKeyDown: function(event) {
            if (event.key === "Enter") {
              event.preventDefault();
              event.target.blur();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              setRenaming(false);
            }
          }
        }) : h("h2", { className: "kanban__lane-name" }, lane.name),
        h("span", { className: "kanban__lane-count" }, String(cards.length)),
        h("span", { className: "kanban__card-spacer" }),
        h(
          Menu,
          {
            label: "列表「" + lane.name + "」的更多操作",
            title: "列表操作",
            trigger: icons.more()
          },
          function(close) {
            return [
              h(
                MenuItem,
                {
                  key: "rename",
                  onClick: function() {
                    close();
                    setRenaming(true);
                  }
                },
                "重命名"
              ),
              h(
                MenuItem,
                {
                  key: "left",
                  disabled: props.laneIndex === 0,
                  onClick: function() {
                    close();
                    props.onMoveLane(lane.id, props.laneIndex - 1);
                  }
                },
                "左移一栏"
              ),
              h(
                MenuItem,
                {
                  key: "right",
                  disabled: props.laneIndex >= props.laneCount - 1,
                  onClick: function() {
                    close();
                    props.onMoveLane(lane.id, props.laneIndex + 1);
                  }
                },
                "右移一栏"
              ),
              h(
                MenuItem,
                {
                  key: "collapse",
                  onClick: function() {
                    close();
                    props.onToggleCollapsed(lane.id);
                  }
                },
                "折叠列表"
              ),
              h(
                MenuItem,
                {
                  key: "remove",
                  danger: true,
                  disabled: props.laneCount <= 1,
                  onClick: function() {
                    close();
                    setConfirming(true);
                  }
                },
                "删除列表…"
              )
            ];
          }
        )
      ),
      confirming ? h(
        "p",
        { className: "kanban__lane-warn", role: "alert" },
        h("span", null, "删除「" + lane.name + "」，里面 " + cards.length + " 张卡片会一起移除。"),
        h(
          "button",
          {
            type: "button",
            className: "kanban__btn kanban__btn--danger kanban__btn--tight",
            onClick: function() {
              props.onRemoveLane(lane.id);
            }
          },
          "确认删除"
        ),
        h(
          "button",
          {
            type: "button",
            className: "kanban__btn kanban__btn--ghost kanban__btn--tight",
            onClick: function() {
              setConfirming(false);
            }
          },
          "取消"
        )
      ) : null,
      h(
        "div",
        { className: "kanban__lane-body", "data-lane-body": "1", "data-lane-id": lane.id },
        cards.length === 0 ? h(
          "p",
          { className: "kanban__lane-empty" },
          props.hasQuery ? "这个列表里没有匹配的卡片。" : "这个列表还是空的。点下面的「添加卡片」写下第一件事。"
        ) : null,
        cards.map(function(card, index) {
          var showLine = props.dragging === "card" && props.dropLaneId === lane.id && props.dropIndex === index;
          return h(
            "div",
            { key: card.id, className: "kanban__card-slot" },
            showLine ? h("div", { className: "kanban__drop-hint", "aria-hidden": "true" }) : null,
            h(TaskCard, {
              card,
              board: props.board,
              laneIndex: props.laneIndex,
              laneCount: props.laneCount,
              dragging: !!props.dragging,
              justMoved: props.justMovedId === card.id,
              onDragStart: props.onDragStart,
              onEdit: props.onEdit,
              onDelete: props.onDelete,
              onToggleDone: props.onToggleDone,
              onSetPriority: props.onSetPriority,
              onSetDue: props.onSetDue,
              onShiftDue: props.onShiftDue,
              onMoveToLane: function(targetIndex) {
                props.onMoveCardToLane(card.id, targetIndex);
              }
            })
          );
        }),
        props.dragging === "card" && props.dropLaneId === lane.id && props.dropIndex >= cards.length ? h("div", { className: "kanban__drop-hint", "aria-hidden": "true" }) : null
      ),
      composing ? h(
        "form",
        { className: "kanban__composer", onSubmit: submit },
        h("input", {
          ref: inputRef,
          className: "kanban__input",
          value: form.title,
          maxLength: CARD_TITLE_MAX,
          placeholder: "这张卡片要做什么？",
          "aria-label": "新卡片标题",
          onChange: function(event) {
            setForm(Object.assign({}, form, { title: event.target.value }));
          },
          onKeyDown: onComposerKeyDown
        }),
        h(
          "div",
          { className: "kanban__composer-row" },
          h(
            "select",
            {
              className: "kanban__select",
              value: form.priority,
              "aria-label": "优先级",
              onChange: function(event) {
                setForm(Object.assign({}, form, { priority: event.target.value }));
              }
            },
            h("option", { value: "normal" }, "优先级：中"),
            h("option", { value: "high" }, "优先级：高"),
            h("option", { value: "low" }, "优先级：低")
          ),
          h(
            "span",
            { className: "kanban__composer-recur" },
            h(RecurrenceSelect, {
              value: form.recurrence,
              onChange: function(value) {
                setForm(Object.assign({}, form, { recurrence: value }));
              }
            })
          )
        ),
        h(DatePicker, {
          value: form.due,
          onChange: function(value) {
            setForm(Object.assign({}, form, { due: value }));
          }
        }),
        h(
          "div",
          { className: "kanban__composer-row" },
          h(
            "button",
            {
              type: "submit",
              className: "kanban__btn kanban__btn--primary",
              disabled: form.title.trim().length === 0
            },
            "添加卡片"
          ),
          h("button", { type: "button", className: "kanban__btn kanban__btn--ghost", onClick: resetComposer }, "取消"),
          h("span", { className: "kanban__hint" }, "Ctrl + Enter 也可以添加")
        )
      ) : h(
        "button",
        {
          type: "button",
          className: "kanban__add",
          onClick: function() {
            setComposing(true);
          }
        },
        icons.plus(14),
        "添加卡片"
      )
    );
  }

  // src/kanban/memo.js
  function Memo(props) {
    var text2 = props.text;
    var sendState = useState(false);
    var sending = sendState[0];
    var setSending = sendState[1];
    var laneState = useState(props.lanes[0] ? props.lanes[0].id : "");
    var laneId = laneState[0];
    var setLaneId = laneState[1];
    var draftText = text2.trim();
    if (draftText.length === 0) return h("div", { className: "kanban__preview-gap" });
    var clean = draftText.replace(/^([-*+•]|\d+[.)]|\[\s?\]|\[x\])\s*/i, "").slice(0, CARD_TITLE_MAX);
    return h(
      "div",
      { className: "kanban__memo" + (sending ? " is-sending" : "") },
      h("p", { className: "kanban__preview-line" }, text2),
      h(
        "div",
        { className: "kanban__memo-actions" },
        h(
          "button",
          {
            type: "button",
            className: "kanban__mini",
            "aria-label": "把这一行加入看板：" + clean,
            title: "加入看板",
            onClick: function() {
              setSending(!sending);
            }
          },
          icons.inbox()
        ),
        h(
          "button",
          {
            type: "button",
            className: "kanban__mini",
            "aria-label": "把这一行复制到剪贴板",
            title: "复制这一行",
            onClick: function() {
              props.onCopyLine(clean);
            }
          },
          icons.note(13)
        )
      ),
      sending ? h(
        "div",
        { className: "kanban__memo-send" },
        h(
          "select",
          {
            className: "kanban__select",
            value: laneId,
            "aria-label": "选择要加入的列表",
            onChange: function(event) {
              setLaneId(event.target.value);
            }
          },
          props.lanes.map(function(item) {
            return h("option", { key: item.id, value: item.id }, item.name);
          })
        ),
        h(
          "button",
          {
            type: "button",
            className: "kanban__btn kanban__btn--primary kanban__btn--tight",
            onClick: function() {
              props.onSendToBoard(laneId, clean);
              setSending(false);
            }
          },
          "加入"
        ),
        h(
          "button",
          {
            type: "button",
            className: "kanban__btn kanban__btn--ghost kanban__btn--tight",
            onClick: function() {
              setSending(false);
            }
          },
          "取消"
        )
      ) : null
    );
  }
  function DraftView(props) {
    var draft = props.draft;
    var moreState = useState(false);
    var showMore = moreState[0];
    var setShowMore = moreState[1];
    var toastState = useState(null);
    var toast = toastState[0];
    var setToast = toastState[1];
    var preview = draft.length > 1200 && !showMore ? draft.slice(0, 1200) : draft;
    var hidden = draft.length - preview.length;
    var lines = useMemo(
      function() {
        return preview.split("\n");
      },
      [preview]
    );
    useEffect(function() {
      if (!toast) return void 0;
      var timer = setTimeout(function() {
        setToast(null);
      }, 2500);
      return function() {
        clearTimeout(timer);
      };
    }, [toast]);
    function copyText(value, label) {
      function failed() {
        setToast("浏览器没有允许写入剪贴板，请手动选中文字复制。");
      }
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(value).then(function() {
            setToast(label + "已复制");
          }, failed);
        } else {
          failed();
        }
      } catch (err) {
        failed();
      }
    }
    var itemCount = draft.split("\n").filter(function(line) {
      return line.trim().length > 0;
    }).length;
    return h(
      "div",
      { className: "kanban__draft" },
      h(
        "div",
        { className: "kanban__draft-main" },
        h(
          "label",
          { className: "kanban__field" },
          h(
            "span",
            { className: "kanban__label" },
            "随手记",
            h("span", { className: "kanban__label-hint" }, "一行一件事，右边可以逐条加入看板")
          ),
          h("textarea", {
            className: "kanban__textarea kanban__textarea--draft",
            value: draft,
            maxLength: DRAFT_MAX,
            placeholder: "想到什么先写在这里。\n一行一件事，写完去右边把有用的几条加进看板。",
            "aria-label": "随手记草稿",
            onChange: function(event) {
              props.onChange(event.target.value.slice(0, DRAFT_MAX));
            }
          })
        ),
        h(
          "div",
          { className: "kanban__draft-actions" },
          h(
            "button",
            {
              type: "button",
              className: "kanban__btn kanban__btn--ghost",
              disabled: draft.length === 0,
              onClick: function() {
                copyText(draft, "全部文字");
              }
            },
            "复制全部"
          ),
          h(
            "button",
            {
              type: "button",
              className: "kanban__btn kanban__btn--ghost",
              disabled: draft.length === 0,
              onClick: function() {
                props.onChange("");
              }
            },
            "清空"
          ),
          h(
            "span",
            { className: "kanban__hint" },
            draft.length + " / " + DRAFT_MAX + "，共 " + itemCount + " 条，边写边保存"
          ),
          toast ? h("span", { className: "kanban__draft-toast", role: "status" }, toast) : null
        )
      ),
      h(
        "aside",
        { className: "kanban__preview" },
        h(
          "div",
          { className: "kanban__preview-head" },
          h("h3", { className: "kanban__preview-title" }, "整理"),
          itemCount > 0 ? h("span", { className: "kanban__hint" }, itemCount + " 条") : null
        ),
        draft.length === 0 ? h(
          "p",
          { className: "kanban__lane-empty" },
          "左边写点什么，这里会把每一行列出来。每行右侧的按钮可以把它直接加进某个列表 —— 不必再复制一遍。"
        ) : h(
          "div",
          { className: "kanban__preview-body" },
          lines.map(function(line, index) {
            return h(Memo, {
              key: "line-" + index,
              text: line,
              lanes: props.lanes,
              onSendToBoard: props.onSendToBoard,
              onCopyLine: function(value) {
                copyText(value, "这一行");
              }
            });
          }),
          hidden > 0 ? h(
            "button",
            {
              type: "button",
              className: "kanban__btn kanban__btn--ghost",
              onClick: function() {
                setShowMore(true);
              }
            },
            "还有 " + hidden + " 个字，展开查看"
          ) : null
        )
      )
    );
  }

  // src/kanban/board.js
  function KanbanBoard() {
    var state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    var active = Modulith.useModuleActive();
    var viewState = useState("board");
    var view = viewState[0];
    var setView = viewState[1];
    var queryState = useState("");
    var query = queryState[0];
    var setQuery = queryState[1];
    var filterState = useState("all");
    var filter = filterState[0];
    var setFilter = filterState[1];
    var showDoneState = useState(true);
    var showDone = showDoneState[0];
    var setShowDone = showDoneState[1];
    var editingState = useState(null);
    var editingId = editingState[0];
    var setEditingId = editingState[1];
    var undoState = useState(null);
    var undo = undoState[0];
    var setUndo = undoState[1];
    var dragState = useState(null);
    var dragPreview = dragState[0];
    var setDragPreview = dragState[1];
    var dropState = useState(null);
    var drop = dropState[0];
    var setDrop = dropState[1];
    var laneDropState = useState(null);
    var laneDrop = laneDropState[0];
    var setLaneDrop = laneDropState[1];
    var addLaneState = useState(false);
    var addingLane = addLaneState[0];
    var setAddingLane = addLaneState[1];
    var announceState = useState("");
    var announce = announceState[0];
    var setAnnounce = announceState[1];
    var justMovedState = useState(null);
    var justMovedId = justMovedState[0];
    var setJustMovedId = justMovedState[1];
    var draftSaveState = useState("idle");
    var draftSave = draftSaveState[0];
    var setDraftSave = draftSaveState[1];
    var firstCardState = useState("");
    var firstCard = firstCardState[0];
    var setFirstCard = firstCardState[1];
    var draggingRef = useRef(null);
    var geometryRef = useRef(null);
    var laneBoxesRef = useRef(null);
    var modeRef = useRef(view);
    var undoTimerRef = useRef(null);
    var moveFlashRef = useRef(null);
    modeRef.current = view;
    useEffect(function() {
      internal.alive = true;
      reload().then(function() {
        dueReminder(store.getSnapshot().board);
      });
      var unsubscribe = ctx.events.subscribe(TOPIC_CHANGED, function(event) {
        if (!internal.alive || !internal.loaded) return;
        var rev = event && event.payload && typeof event.payload.rev === "number" ? event.payload.rev : 0;
        if (rev > 0 && rev <= internal.savedRev) return;
        store.set({ conflict: false });
        load().then(function() {
          if (modeRef.current === "draft") loadDraft();
        });
      });
      return function() {
        internal.alive = false;
        if (internal.timer !== null) {
          clearTimeout(internal.timer);
          internal.timer = null;
        }
        if (internal.draftTimer !== null) {
          clearTimeout(internal.draftTimer);
          internal.draftTimer = null;
        }
        if (undoTimerRef.current !== null) {
          clearTimeout(undoTimerRef.current);
          undoTimerRef.current = null;
        }
        if (moveFlashRef.current !== null) {
          clearTimeout(moveFlashRef.current);
          moveFlashRef.current = null;
        }
        unsubscribe();
      };
    }, []);
    useEffect(function() {
      if (!active || !internal.loaded) return void 0;
      if (internal.timer !== null || internal.saving || store.getSnapshot().conflict) return void 0;
      load().then(function() {
        if (modeRef.current === "draft") loadDraft();
        if (dayChanged()) dueReminder(store.getSnapshot().board);
      });
      return void 0;
    }, [active]);
    useEffect(function() {
      if (!undo) return void 0;
      var timer = setTimeout(function() {
        setUndo(null);
      }, UNDO_MS);
      return function() {
        clearTimeout(timer);
      };
    }, [undo]);
    useEffect(function() {
      if (!announce) return void 0;
      var timer = setTimeout(function() {
        setAnnounce("");
      }, 4e3);
      return function() {
        clearTimeout(timer);
      };
    }, [announce]);
    var board = state.board;
    var lanes = board ? board.lanes : [];
    var cards = board ? board.cards : {};
    var today = todayKey();
    var matches = useMemo(
      function() {
        var map = {};
        var ids2 = Object.keys(cards);
        for (var i2 = 0; i2 < ids2.length; i2 += 1) {
          var card = cards[ids2[i2]];
          var visible = true;
          if (card.done && !showDone) visible = false;
          if (visible && filter === "overdue" && !isOverdue(card, today)) visible = false;
          if (visible && filter === "high" && card.priority !== "high") visible = false;
          if (visible && !matchesQuery(card, query)) visible = false;
          map[card.id] = visible;
        }
        return map;
      },
      [cards, query, showDone, filter, today]
    );
    var ids = Object.keys(cards);
    var countAll = ids.length;
    var countDone = 0;
    var countOverdue = 0;
    var countToday = 0;
    var countMatched = 0;
    for (var i = 0; i < ids.length; i += 1) {
      var item = cards[ids[i]];
      if (item.done) countDone += 1;
      else {
        if (isOverdue(item, today)) countOverdue += 1;
        else if (item.due === today) countToday += 1;
      }
      if (matches[item.id]) countMatched += 1;
    }
    var activeDrag = dragPreview ? dragPreview.kind : null;
    function measureLaneBodies() {
      var bodyNodes = document.querySelectorAll('[data-lane-body="1"]');
      var geometry = [];
      for (var i2 = 0; i2 < bodyNodes.length; i2 += 1) {
        var node = bodyNodes[i2];
        var box = node.getBoundingClientRect();
        var cardNodes = node.querySelectorAll("[data-card-id]");
        var entries = [];
        for (var j = 0; j < cardNodes.length; j += 1) {
          var cardBox = cardNodes[j].getBoundingClientRect();
          entries.push({ id: cardNodes[j].getAttribute("data-card-id"), top: cardBox.top, height: cardBox.height });
        }
        geometry.push({
          laneId: node.getAttribute("data-lane-id"),
          top: box.top,
          bottom: box.bottom,
          left: box.left,
          right: box.right,
          cards: entries
        });
      }
      return geometry;
    }
    function measureLanes() {
      var nodes = document.querySelectorAll(".kanban__lane[data-lane-id]");
      var boxes = [];
      for (var i2 = 0; i2 < nodes.length; i2 += 1) {
        var box = nodes[i2].getBoundingClientRect();
        boxes.push({
          laneId: nodes[i2].getAttribute("data-lane-id"),
          left: box.left,
          right: box.right,
          center: box.left + box.width / 2
        });
      }
      return boxes;
    }
    function computeCardDrop(clientX, clientY) {
      var geometry = geometryRef.current;
      if (!geometry || geometry.length === 0) return null;
      var target = null;
      for (var i2 = 0; i2 < geometry.length; i2 += 1) {
        if (clientY >= geometry[i2].top && clientY <= geometry[i2].bottom) {
          target = geometry[i2];
          break;
        }
      }
      if (!target) {
        var best = null;
        var bestDistance = Infinity;
        for (var j = 0; j < geometry.length; j += 1) {
          var center = (geometry[j].left + geometry[j].right) / 2;
          var distance = Math.abs(clientX - center);
          if (distance < bestDistance) {
            bestDistance = distance;
            best = geometry[j];
          }
        }
        target = best;
      }
      if (!target) return null;
      var index = target.cards.length;
      for (var k = 0; k < target.cards.length; k += 1) {
        var entry = target.cards[k];
        if (clientY < entry.top + entry.height / 2) {
          index = k;
          break;
        }
      }
      var prev = index > 0 ? target.cards[index - 1] : null;
      var next = index < target.cards.length ? target.cards[index] : null;
      return {
        laneId: target.laneId,
        index,
        beforeId: prev ? prev.id : null,
        afterId: next ? next.id : null
      };
    }
    function computeLaneDrop(clientX) {
      var boxes = laneBoxesRef.current;
      if (!boxes || boxes.length === 0) return null;
      var nearest = null;
      var bestDistance = Infinity;
      for (var i2 = 0; i2 < boxes.length; i2 += 1) {
        var distance = Math.abs(clientX - boxes[i2].center);
        if (distance < bestDistance) {
          bestDistance = distance;
          nearest = boxes[i2];
        }
      }
      if (!nearest) return null;
      var after = clientX > nearest.center;
      var index = -1;
      for (var j = 0; j < boxes.length; j += 1) {
        if (boxes[j].laneId === nearest.laneId) {
          index = j;
          break;
        }
      }
      if (index < 0) return null;
      var targetIndex = after ? index + 1 : index;
      var beforeLane = targetIndex > 0 ? boxes[targetIndex - 1] : null;
      var afterLane = targetIndex < boxes.length ? boxes[targetIndex] : null;
      return {
        targetIndex,
        beforeId: beforeLane ? beforeLane.laneId : null,
        afterId: afterLane ? afterLane.laneId : null
      };
    }
    function clearDrag() {
      draggingRef.current = null;
      geometryRef.current = null;
      laneBoxesRef.current = null;
      setDragPreview(null);
      setDrop(null);
      setLaneDrop(null);
    }
    function flashMoved(cardId) {
      setJustMovedId(cardId);
      if (moveFlashRef.current !== null) clearTimeout(moveFlashRef.current);
      moveFlashRef.current = setTimeout(function() {
        moveFlashRef.current = null;
        setJustMovedId(null);
      }, 1200);
    }
    function startDrag(kind, targetId, event) {
      if (draggingRef.current) return;
      var currentBoard = store.getSnapshot().board;
      if (!currentBoard) return;
      var anchor = document.querySelector(
        (kind === "card" ? '[data-card-id="' : '.kanban__lane[data-lane-id="') + targetId + '"]'
      );
      if (!anchor) return;
      if (kind === "card") {
        if (!currentBoard.cards[targetId]) return;
        geometryRef.current = measureLaneBodies();
      } else {
        if (!laneById(currentBoard, targetId)) return;
        laneBoxesRef.current = measureLanes();
      }
      var box = anchor.getBoundingClientRect();
      var drag = {
        kind,
        targetId,
        width: box.width,
        height: box.height,
        offsetX: event.clientX - box.left,
        offsetY: event.clientY - box.top,
        moved: false
      };
      draggingRef.current = drag;
      var origin = { x: event.clientX, y: event.clientY };
      function onMove(moveEvent) {
        var current = draggingRef.current;
        if (!current) return;
        if (!current.moved) {
          var dx = moveEvent.clientX - origin.x;
          var dy = moveEvent.clientY - origin.y;
          if (dx * dx + dy * dy < DRAG_THRESHOLD * DRAG_THRESHOLD) return;
          current.moved = true;
          document.body.classList.add("kanban-dragging");
        }
        moveEvent.preventDefault();
        if (kind === "card") {
          var card = store.getSnapshot().board.cards[targetId];
          if (!card) return;
          var next = computeCardDrop(moveEvent.clientX, moveEvent.clientY);
          if (next) {
            setDrop(next);
            setDragPreview({
              kind: "card",
              title: card.title,
              laneName: laneNameOf(store.getSnapshot().board, next.laneId),
              overLane: next.laneId !== card.laneId,
              x: moveEvent.clientX - current.offsetX,
              y: moveEvent.clientY - current.offsetY,
              width: current.width
            });
          } else {
            setDragPreview({
              kind: "card",
              title: card.title,
              laneName: null,
              overLane: false,
              x: moveEvent.clientX - current.offsetX,
              y: moveEvent.clientY - current.offsetY,
              width: current.width
            });
          }
          return;
        }
        var lane = laneById(store.getSnapshot().board, targetId);
        if (!lane) return;
        var laneNext = computeLaneDrop(moveEvent.clientX);
        if (laneNext) setLaneDrop(laneNext);
        setDragPreview({
          kind: "lane",
          title: lane.name,
          laneName: laneNext ? "放到第 " + (laneNext.targetIndex + 1) + " 栏" : null,
          overLane: false,
          x: moveEvent.clientX - current.offsetX,
          y: moveEvent.clientY - current.offsetY,
          width: current.width
        });
      }
      function detach() {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        window.removeEventListener("keydown", onKey);
        document.body.classList.remove("kanban-dragging");
      }
      function onUp(upEvent) {
        detach();
        var current = draggingRef.current;
        if (!current) return;
        if (!current.moved) {
          clearDrag();
          return;
        }
        if (kind === "card") {
          var target = computeCardDrop(upEvent.clientX, upEvent.clientY);
          var sourceLaneId = store.getSnapshot().board.cards[targetId].laneId;
          clearDrag();
          if (!target) return;
          boardActions.moveCard(targetId, target.laneId, target.beforeId, target.afterId);
          var name = laneNameOf(store.getSnapshot().board, target.laneId);
          flashMoved(targetId);
          setAnnounce(
            target.laneId === sourceLaneId ? "已在「" + name + "」内调整顺序" : "已移动到「" + name + "」"
          );
          return;
        }
        var laneTarget = computeLaneDrop(upEvent.clientX);
        var laneName = laneNameOf(store.getSnapshot().board, targetId);
        clearDrag();
        if (!laneTarget) return;
        boardActions.moveLane(targetId, laneTarget.targetIndex);
        setAnnounce("列表「" + laneName + "」已放到第 " + (laneTarget.targetIndex + 1) + " 栏");
      }
      function onCancel() {
        detach();
        clearDrag();
      }
      function onKey(keyEvent) {
        if (keyEvent.key !== "Escape") return;
        keyEvent.preventDefault();
        onCancel();
      }
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
      window.addEventListener("keydown", onKey);
    }
    function moveCardToLane(cardId, laneIndex) {
      var target = board && board.lanes[laneIndex];
      if (!target) return;
      boardActions.moveCard(cardId, target.id, null, null);
      flashMoved(cardId);
      setAnnounce("已移动到「" + target.name + "」");
    }
    function removeCard(cardId) {
      var current = store.getSnapshot().board;
      if (!current || !current.cards[cardId]) return;
      var snapshot = clone(current.cards[cardId]);
      var title = boardActions.deleteCard(cardId);
      setEditingId(null);
      setUndo({ kind: "card", card: snapshot, title });
      setAnnounce("已删除「" + (title || "卡片") + "」，可以撤销");
    }
    function removeLane(laneId) {
      var removed = boardActions.deleteLane(laneId);
      if (!removed) {
        setAnnounce("至少要保留一个列表");
        return;
      }
      setUndo({ kind: "lane", lane: removed });
      setAnnounce("已删除列表「" + removed.name + "」，可以撤销");
      notify(
        "列表「" + removed.name + "」已删除",
        removed.cards.length > 0 ? "其中的 " + removed.cards.length + " 张卡片也一起移除了。" : "该列表原本是空的。",
        "kanban-lane-removed"
      );
    }
    function sendLineToBoard(laneId, title) {
      var cardId = boardActions.addCard(laneId, title, "normal", null, null);
      if (!cardId) return;
      setAnnounce("已把「" + title + "」加入「" + laneNameOf(store.getSnapshot().board, laneId) + "」");
    }
    function toggleNotify() {
      var prefs2 = store.getSnapshot().prefs || { notify: true };
      var next = { notify: prefs2.notify === false };
      store.set({ prefs: next });
      savePrefsNow(next);
      if (next.notify) {
        dueReminder(store.getSnapshot().board);
        notify("到期提醒已开启", "有卡片到期或逾期时，我会在这个应用里提醒你一次。", "kanban-notify-on");
      }
    }
    function onRootKeyDown(event) {
      var modifier = event.ctrlKey || event.metaKey;
      if (modifier && (event.key === "n" || event.key === "N")) {
        if (view !== "board") setView("board");
        event.preventDefault();
        var first = board && board.lanes[0];
        if (!first) return;
        var existing = document.querySelector('[data-lane-id="' + first.id + '"] .kanban__composer input');
        if (existing) {
          existing.focus();
          return;
        }
        var addButton = document.querySelector('[data-lane-id="' + first.id + '"] .kanban__add');
        if (addButton) addButton.click();
        requestAnimationFrame(function() {
          var later = document.querySelector('[data-lane-id="' + first.id + '"] .kanban__composer input');
          if (later) later.focus();
        });
        return;
      }
      if (modifier && (event.key === "f" || event.key === "F")) {
        event.preventDefault();
        var search = document.querySelector(".kanban__search input");
        if (search) search.focus();
      }
    }
    var editing = editingId && board ? board.cards[editingId] : null;
    var prefs = state.prefs || { notify: true };
    var header = h(
      "header",
      { className: "kanban__header" },
      h(
        "div",
        { className: "kanban__header-top" },
        h(
          "div",
          { className: "kanban__title-block" },
          h("h1", { className: "kanban__title" }, "看板"),
          h(
            "p",
            { className: "kanban__subtitle" },
            greeting() + "。" + (countAll === 0 ? "还没有卡片。" : countOverdue > 0 ? "有 " + countOverdue + " 项已经逾期。" : countToday > 0 ? "今天有 " + countToday + " 项到期。" : "共 " + countAll + " 项，其中 " + countDone + " 项已完成。")
          )
        ),
        h(
          "div",
          { className: "kanban__tabs", role: "tablist", "aria-label": "视图切换" },
          h(
            "button",
            {
              type: "button",
              role: "tab",
              className: "kanban__tab" + (view === "board" ? " is-active" : ""),
              "aria-selected": view === "board",
              onClick: function() {
                setView("board");
              }
            },
            "看板"
          ),
          h(
            "button",
            {
              type: "button",
              role: "tab",
              className: "kanban__tab" + (view === "draft" ? " is-active" : ""),
              "aria-selected": view === "draft",
              onClick: function() {
                setView("draft");
              }
            },
            "速记"
          )
        ),
        h("span", { className: "kanban__card-spacer" }),
        h(SaveIndicator, { draftState: draftSave })
      ),
      h(
        "div",
        { className: "kanban__toolbar" },
        view === "board" ? h(
          "div",
          { className: "kanban__search" },
          h("span", { className: "kanban__search-icon", "aria-hidden": "true" }, icons.search()),
          h("input", {
            className: "kanban__input",
            type: "search",
            value: query,
            placeholder: "搜索（Ctrl + F）",
            "aria-label": "搜索卡片",
            onChange: function(event) {
              setQuery(event.target.value);
            }
          })
        ) : null,
        view === "board" ? h(
          "div",
          { className: "kanban__filters", role: "group", "aria-label": "筛选" },
          h(
            "button",
            {
              type: "button",
              className: "kanban__filter" + (filter === "all" ? " is-active" : ""),
              "aria-pressed": filter === "all",
              onClick: function() {
                setFilter("all");
              }
            },
            "全部"
          ),
          h(
            "button",
            {
              type: "button",
              className: "kanban__filter" + (filter === "overdue" ? " is-active is-warn" : ""),
              "aria-pressed": filter === "overdue",
              disabled: countOverdue === 0,
              onClick: function() {
                setFilter(filter === "overdue" ? "all" : "overdue");
              }
            },
            "已逾期",
            countOverdue > 0 ? h("span", { className: "kanban__filter-count" }, String(countOverdue)) : null
          ),
          h(
            "button",
            {
              type: "button",
              className: "kanban__filter" + (filter === "high" ? " is-active" : ""),
              "aria-pressed": filter === "high",
              onClick: function() {
                setFilter(filter === "high" ? "all" : "high");
              }
            },
            "高优先级"
          )
        ) : null,
        h("span", { className: "kanban__card-spacer" }),
        view === "board" ? h(
          "span",
          { className: "kanban__stats" },
          query || filter !== "all" ? "显示 " + countMatched + " / " + countAll + " 张" : countAll + " 张卡片"
        ) : null,
        h(
          "button",
          {
            type: "button",
            className: "kanban__icon-btn" + (prefs.notify ? "" : " is-off"),
            "aria-label": prefs.notify ? "到期提醒已开启，点击关闭" : "到期提醒已关闭，点击开启",
            "aria-pressed": !!prefs.notify,
            title: prefs.notify ? "到期提醒已开启" : "到期提醒已关闭",
            onClick: toggleNotify
          },
          prefs.notify ? icons.bell() : icons.bellOff()
        ),
        view === "board" ? h(
          Menu,
          {
            label: "列表操作",
            title: "列表",
            triggerClass: "kanban__icon-btn",
            trigger: icons.columns()
          },
          function(close) {
            return [
              h(
                MenuItem,
                {
                  key: "add",
                  onClick: function() {
                    close();
                    setAddingLane(true);
                  }
                },
                "添加列表…"
              ),
              h(
                MenuItem,
                {
                  key: "reset",
                  disabled: countAll > 0 && board.lanes.map(function(l) {
                    return l.name;
                  }).join("|") === DEFAULT_LANES.join("|"),
                  onClick: function() {
                    close();
                    var moved = boardActions.resetLanes();
                    if (moved) {
                      setAnnounce("已恢复默认列表；卡片按所在栏与完成状态归位，一张都没有删。");
                      notify(
                        "已恢复默认列表",
                        "「" + DEFAULT_LANES.join("」「") + "」三栏已就绪，卡片按原状态归入，没有删除任何卡片。",
                        "kanban-lanes-reset"
                      );
                    }
                  }
                },
                "恢复默认列表"
              )
            ];
          }
        ) : null,
        view === "board" && countDone > 0 ? h(
          Menu,
          {
            label: "已完成卡片",
            title: "已完成",
            triggerClass: "kanban__btn kanban__btn--ghost kanban__btn--tight",
            trigger: [
              "已完成 " + countDone,
              showDone ? null : h("span", { key: "hint", className: "kanban__hint" }, "（已隐藏）")
            ]
          },
          function(close) {
            return [
              h(
                MenuItem,
                {
                  key: "toggle",
                  onClick: function() {
                    close();
                    setShowDone(!showDone);
                  }
                },
                showDone ? "隐藏已完成卡片" : "显示已完成卡片"
              ),
              h(
                MenuItem,
                {
                  key: "clear",
                  danger: true,
                  onClick: function() {
                    close();
                    var removed = boardActions.clearDone();
                    if (removed > 0) {
                      setAnnounce("已清除 " + removed + " 张已完成卡片");
                      notify("已清除 " + removed + " 张已完成卡片", "清除掉的卡片无法找回。", "kanban-clear-done");
                    }
                  }
                },
                "清除这 " + countDone + " 张卡片"
              )
            ];
          }
        ) : null
      )
    );
    var body;
    if (state.status === "loading") {
      body = h("p", { className: "kanban__placeholder" }, "正在读取你的看板…");
    } else if (state.status === "error") {
      body = h(
        "p",
        { className: "kanban__placeholder" },
        "数据没能读出来。上面的提示里写了原因；磁盘上的数据没有被改动，修好之后点「重新读取」即可。"
      );
    } else if (view === "draft") {
      body = h(DraftView, {
        draft: state.draft,
        lanes,
        onSendToBoard: sendLineToBoard,
        onChange: function(value) {
          store.set({ draft: value });
          setDraftSave("saving");
          if (internal.draftTimer !== null) clearTimeout(internal.draftTimer);
          internal.draftTimer = setTimeout(function() {
            internal.draftTimer = null;
            ctx.storage.set(KEY_DRAFT, store.getSnapshot().draft).then(function() {
              setDraftSave("saved");
            }).catch(function(err) {
              ctx.logger.warn("保存速记草稿失败", err);
              setDraftSave("error");
              pushNote("速记草稿没能写进存储，下次打开可能看不到它。");
            });
          }, DRAFT_DEBOUNCE_MS);
        }
      });
    } else if (countAll === 0 && !query && filter === "all") {
      body = h(
        "div",
        { className: "kanban__empty" },
        h("h2", { className: "kanban__empty-title" }, "从第一件事开始"),
        h(
          "p",
          { className: "kanban__empty-text" },
          "写下来，它会落在「待处理」里。之后可以拖动卡片换栏，Alt + 左右方向键也可以；按回车打开编辑器补充说明、优先级与截止日。截止日到了会有提醒。"
        ),
        h(
          "div",
          { className: "kanban__empty-actions" },
          h("input", {
            className: "kanban__input kanban__empty-input",
            value: firstCard,
            maxLength: CARD_TITLE_MAX,
            placeholder: "例如：把周报写完",
            "aria-label": "第一张卡片的标题",
            onChange: function(event) {
              setFirstCard(event.target.value);
            },
            onKeyDown: function(event) {
              if (event.key !== "Enter") return;
              event.preventDefault();
              if (!firstCard.trim()) return;
              boardActions.addCard(board.lanes[0].id, firstCard.trim().slice(0, CARD_TITLE_MAX), "normal", null, null);
              setFirstCard("");
            }
          }),
          h(
            "button",
            {
              type: "button",
              className: "kanban__btn kanban__btn--primary",
              disabled: firstCard.trim().length === 0,
              onClick: function() {
                boardActions.addCard(board.lanes[0].id, firstCard.trim().slice(0, CARD_TITLE_MAX), "normal", null, null);
                setFirstCard("");
              }
            },
            "添加这张卡片"
          )
        ),
        h(
          "p",
          { className: "kanban__hint kanban__empty-foot" },
          "已经在别处记了？切到「速记」把每一行逐个加进来。"
        )
      );
    } else {
      var laneNodes = lanes.map(function(lane, index) {
        var list = [];
        var all = cardsInLane(board, lane.id);
        for (var n = 0; n < all.length; n += 1) {
          if (matches[all[n].id]) list.push(all[n]);
        }
        list = sortCards(list);
        return h(Lane, {
          key: lane.id,
          lane,
          board,
          cards: list,
          laneIndex: index,
          laneCount: lanes.length,
          dragging: activeDrag,
          dropLaneId: drop ? drop.laneId : null,
          dropIndex: drop ? drop.index : 0,
          laneDropBeforeId: laneDrop ? laneDrop.beforeId : null,
          laneDropAfterId: laneDrop ? laneDrop.afterId : null,
          justMovedId,
          hasQuery: query.length > 0 || filter !== "all",
          onDragStart: function(cardId, event) {
            startDrag("card", cardId, event);
          },
          onLaneDragStart: function(laneId, event) {
            startDrag("lane", laneId, event);
          },
          onAddCard: function(title, priority, due, recurrence) {
            boardActions.addCard(lane.id, title, priority, due, recurrence);
          },
          onRenameLane: function(laneId, name) {
            boardActions.renameLane(laneId, name);
          },
          onToggleCollapsed: function(laneId) {
            boardActions.toggleLaneCollapsed(laneId);
          },
          onMoveLane: function(laneId, targetIndex) {
            boardActions.moveLane(laneId, targetIndex);
            setAnnounce("列表已移动到第 " + (targetIndex + 1) + " 栏");
          },
          onRemoveLane: removeLane,
          onEdit: function(cardId) {
            setEditingId(cardId);
          },
          onDelete: removeCard,
          onToggleDone: function(cardId, done) {
            boardActions.toggleDone(cardId, done);
          },
          onSetPriority: function(cardId, priority) {
            boardActions.updateCard(cardId, { priority });
          },
          onSetDue: function(cardId, due) {
            boardActions.updateCard(cardId, { due });
            setAnnounce(due ? "截止日已设为 " + due : "已清除截止日");
          },
          onShiftDue: function(cardId, days) {
            var card = store.getSnapshot().board.cards[cardId];
            if (!card) return;
            var next = addDays(card.due || todayKey(), days);
            boardActions.updateCard(cardId, { due: next });
            setAnnounce("截止日改为 " + next);
          },
          onMoveCardToLane: moveCardToLane
        });
      });
      body = h(
        "div",
        { className: "kanban__board" },
        laneNodes,
        addingLane ? h(
          "form",
          {
            className: "kanban__lane kanban__lane--new",
            onSubmit: function(event) {
              event.preventDefault();
              var value = event.target.elements.laneName.value.trim();
              if (value) boardActions.addLane(value.slice(0, LANE_NAME_MAX));
              setAddingLane(false);
            }
          },
          h("input", {
            className: "kanban__input",
            name: "laneName",
            autoFocus: true,
            maxLength: LANE_NAME_MAX,
            placeholder: "新列表叫什么？",
            "aria-label": "新列表名称"
          }),
          h(
            "div",
            { className: "kanban__composer-row" },
            h("button", { type: "submit", className: "kanban__btn kanban__btn--primary" }, "创建列表"),
            h(
              "button",
              {
                type: "button",
                className: "kanban__btn kanban__btn--ghost",
                onClick: function() {
                  setAddingLane(false);
                }
              },
              "取消"
            )
          )
        ) : h(
          "button",
          {
            type: "button",
            className: "kanban__lane-add",
            onClick: function() {
              setAddingLane(true);
            }
          },
          icons.plus(16),
          "添加列表"
        )
      );
    }
    return h(
      "div",
      { className: "kanban", onKeyDown: onRootKeyDown },
      header,
      h(ErrorBanner),
      state.conflict ? h(
        "div",
        { className: "kanban__banner kanban__banner--warn", role: "status" },
        h("span", { className: "kanban__banner-text" }, "另一个看板实例保存了更新的内容，界面已切换成它的版本。")
      ) : null,
      body,
      h("div", { className: "kanban__live", role: "status", "aria-live": "polite" }, announce),
      undo ? h(
        "div",
        { className: "kanban__toast" },
        h(
          "span",
          null,
          undo.kind === "lane" ? "已删除列表「" + undo.lane.name + "」" + (undo.lane.cards.length > 0 ? "（含 " + undo.lane.cards.length + " 张卡片）" : "") : "已删除「" + (undo.title || "卡片") + "」"
        ),
        h(
          "button",
          {
            type: "button",
            className: "kanban__btn kanban__btn--ghost kanban__btn--tight",
            onClick: function() {
              if (undo.kind === "lane") boardActions.restoreLane(undo.lane);
              else boardActions.restoreCard(undo.card);
              setUndo(null);
            }
          },
          icons.undo(13),
          "撤销"
        )
      ) : null,
      editing ? h(CardEditor, {
        card: editing,
        lanes,
        onClose: function() {
          setEditingId(null);
        },
        onDelete: function() {
          removeCard(editing.id);
        },
        onSave: function(patch) {
          var laneChanged = patch.laneId !== editing.laneId;
          boardActions.updateCard(editing.id, {
            title: patch.title,
            note: patch.note,
            priority: patch.priority,
            due: patch.due,
            recurrence: patch.recurrence
          });
          if (laneChanged) boardActions.moveCard(editing.id, patch.laneId, null, null);
          setEditingId(null);
        }
      }) : null,
      dragPreview ? h(
        "div",
        {
          className: "kanban__drag-preview" + (dragPreview.kind === "lane" ? " kanban__drag-preview--lane" : ""),
          "aria-hidden": "true",
          style: {
            transform: "translate3d(" + Math.round(dragPreview.x) + "px," + Math.round(dragPreview.y) + "px,0)",
            width: dragPreview.width ? Math.round(dragPreview.width) + "px" : void 0
          }
        },
        h(
          "div",
          { className: "kanban__drag-head" },
          h("span", { className: "kanban__grip" }, icons.grip()),
          h("span", { className: "kanban__card-title" }, dragPreview.title)
        ),
        dragPreview.laneName ? h(
          "span",
          { className: "kanban__drag-target" + (dragPreview.overLane ? " is-over" : "") },
          dragPreview.overLane ? "移到「" + dragPreview.laneName + "」" : dragPreview.laneName
        ) : null
      ) : null
    );
  }

  // src/kanban/index.js
  Modulith.registerModule({
    id: "kanbanBoard",
    name: "看板",
    displayName: "看板",
    description: "把活儿按列表摆开，拖动或按键盘移动卡片",
    icon: "SquareKanban",
    priority: 70,
    category: "效率",
    component: KanbanBoard
  });
  Modulith.registerCommand({
    id: "new-card",
    title: "看板：新建一张卡片",
    keywords: ["kanban", "todo", "task"],
    run: function() {
      var board = internal.lastGood;
      if (!board || !board.lanes.length) {
        ctx.logger.warn("看板数据还没读取完成，请先打开看板模块再试");
        return;
      }
      var first = board.lanes[0];
      var trigger = document.querySelector('[data-lane-id="' + first.id + '"] .kanban__add');
      if (trigger) {
        trigger.click();
        requestAnimationFrame(function() {
          var input = document.querySelector('[data-lane-id="' + first.id + '"] .kanban__composer input');
          if (input && input.focus) input.focus();
        });
        return;
      }
      var openInput = document.querySelector('[data-lane-id="' + first.id + '"] .kanban__composer input');
      if (openInput && openInput.focus) {
        openInput.focus();
        return;
      }
      ctx.logger.warn("看板模块当前没有打开，请先切到看板再使用这个命令");
    }
  });
  ctx.logger.info("看板插件加载完成", {
    host: Modulith.version,
    notifications: ctx.notifications.isAvailable ? ctx.notifications.isAvailable() : false,
    events: ctx.events.isAvailable()
  });
})();
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsic3JjL2thbmJhbi9lbnYudHMiLCAic3JjL2thbmJhbi9zdG9yZS5qcyIsICJzcmMva2FuYmFuL21vZGVsLmpzIiwgInNyYy9rYW5iYW4vZGF0ZXMuanMiLCAic3JjL2thbmJhbi9pY29ucy5qcyIsICJzcmMva2FuYmFuL3VpLmpzIiwgInNyYy9rYW5iYW4vZWRpdG9yLmpzIiwgInNyYy9rYW5iYW4vY2FyZC5qcyIsICJzcmMva2FuYmFuL2xhbmUuanMiLCAic3JjL2thbmJhbi9tZW1vLmpzIiwgInNyYy9rYW5iYW4vYm9hcmQuanMiLCAic3JjL2thbmJhbi9pbmRleC5qcyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8vIDxyZWZlcmVuY2UgcGF0aD1cIi4uLy4uL3R5cGVzL21vZHVsaXRoLmQudHNcIiAvPlxuLy8gc3JjL2thbmJhbi9lbnYudHNcbi8vXG4vLyDnnIvmnb/mj5Lku7bnmoQqKuWFseS6q+eOr+Wigyoq77ya5a6/5Li75a+56LGh44CBUmVhY3Qg55qE566A5YaZ44CB5Lul5Y+K5YWo5o+S5Lu25YWx55So55qE5bi46YeP44CCXG4vL1xuLy8g5Li65LuA5LmI5Y2V54us5LiA5Liq5paH5Lu277yM6ICM5LiN5piv5q+P5Liq5paH5Lu25ZCE6Ieq5Y+W5LiA6YGN77yaYE1vZHVsaXRoLmNyZWF0ZUNvbnRleHQoKWBcbi8vICoq5Y+q6IO95Zyo5Yqg6L295pyf6LCD55So5LiA5qyhKirjgILmr4/kuKrmqKHlnZflkITosIPkuIDmrKHkvJrmi7/liLDlpJrkuKrkuIrkuIvmlocg4oCU4oCUIOmAmuefpeeahOWPr+eUqOaAp+OAgVxuLy8g5LqL5Lu255qE6K6i6ZiF6KGo44CB6K6+572u55qE6K+75YaZ6YO95Lya5YiG5Y+J77yM6ICM6YKj56eN5YiG6KOC5Zyo55WM6Z2i5LiK6KGo546w5Li6XCLmnInml7blgJnmlLbkuI3liLDmj5DphpJcIu+8jFxuLy8g5p6B6Zq+5b2S5Zug44CCXG4vL1xuLy8g6L+Z5Lu95paH5Lu25LuOIHBsdWdpbnMva2FuYmFuL2luZGV4LmpzIOeahCBJSUZFIOWktOmDqOaQrOi/kOiAjOadpe+8jCoq5bi46YeP5LiO5Y+W5YC85pa55byPXG4vLyDkuIDlrZfmnKrmlLkqKuOAglxuXG5jb25zdCBNb2R1bGl0aCA9IGdsb2JhbFRoaXMuTW9kdWxpdGggYXMgTW9kdWxpdGhIb3N0IHwgdW5kZWZpbmVkO1xuaWYgKCFNb2R1bGl0aCkge1xuICAvLyDljp/mlofku7blnKjov5nph4wgYGNvbnNvbGUuZXJyb3JgIOS5i+WQjiBgcmV0dXJuYO+8iOWug+aYryBJSUZF77yM5Y+v5Lul5bCx5Zyw6YCA5Ye677yJ44CCXG4gIC8vIOaLhuaIkOaooeWdl+S5i+WQjuayoeaciVwi6YCA5Ye65pW05Liq5o+S5Lu2XCLov5nnp43kuJzopb/vvIzogIwqKuaKm+mUmeeahOaViOaenOaYr+S4gOagt+eahCoq77yaXG4gIC8vIOWFpeWPo+S4jeS8muaJp+ihjO+8jOaooeWdl+S4jeS8muazqOWGjOOAguWMuuWIq+WPquaYr+Wug+abtOaYvuecvCDigJTigJQg6ICM5a6/5Li76L+eIE1vZHVsaXRoIOmDveayoeazqOWFpe+8jFxuICAvLyDov5nmnKzmnaXlsLHmmK/or6Xlk43kuIDlo7DnmoTkuovjgIJcbiAgdGhyb3cgbmV3IEVycm9yKCdba2FuYmFuXSDmnKrmib7liLAgd2luZG93Lk1vZHVsaXRo77yM5o+S5Lu25peg5rOV5Yqg6L29Jyk7XG59XG5cbmNvbnN0IFJlYWN0ID0gTW9kdWxpdGguUmVhY3Q7XG5jb25zdCBoID0gUmVhY3QuY3JlYXRlRWxlbWVudDtcbmNvbnN0IHVzZUVmZmVjdCA9IFJlYWN0LnVzZUVmZmVjdDtcbmNvbnN0IHVzZU1lbW8gPSBSZWFjdC51c2VNZW1vO1xuY29uc3QgdXNlUmVmID0gUmVhY3QudXNlUmVmO1xuY29uc3QgdXNlU3RhdGUgPSBSZWFjdC51c2VTdGF0ZTtcbmNvbnN0IHVzZVN5bmNFeHRlcm5hbFN0b3JlID0gUmVhY3QudXNlU3luY0V4dGVybmFsU3RvcmU7XG5cbi8vIGNyZWF0ZUNvbnRleHQoKSDlj6rog73lnKjliqDovb3mnJ/osIPnlKjvvIzlm6DmraTlnKjov5nph4zlj5bkuIDmrKHlubbplb/mnJ/mjIHmnInjgIJcbmNvbnN0IGN0eCA9IE1vZHVsaXRoLmNyZWF0ZUNvbnRleHQoKTtcblxuLyoqIOWtmOWCqOmUruOAguWPquWFgeiuuOWtl+avjeaVsOWtl+S4jiAuIF8gLe+8jOacgOmVvyAxMjgg5a2X56ymICovXG5jb25zdCBLRVlfQk9BUkQgPSAnYm9hcmQnO1xuY29uc3QgS0VZX0RSQUZUID0gJ2RyYWZ0JztcbmNvbnN0IEtFWV9QUkVGUyA9ICdwcmVmcyc7XG5cbi8qKiDnnIvmnb/mlbDmja7nu5PmnoTniYjmnKzjgILor7vliLDmm7Tpq5jniYjmnKzml7blj6ror7vkuI3lhpnvvIzlhY3lvpfmiormlrDniYjmlbDmja7lhpnlnY/jgIIgKi9cbmNvbnN0IFNDSEVNQV9WRVJTSU9OID0gMTtcblxuLyoqIOS6i+S7tuS4u+mimOWQjeWPquiDveeUqOWwj+WGmeWtl+avjeOAgeaVsOWtl+S4jiAuIF8gLe+8jOacgOmVvyA2NCDlrZfnrKYgKi9cbmNvbnN0IFRPUElDX0NIQU5HRUQgPSAna2FuYmFuLmJvYXJkLmNoYW5nZWQnO1xuXG5jb25zdCBERUZBVUxUX0xBTkVTID0gWyflvoXlpITnkIYnLCAn6L+b6KGM5LitJywgJ+W3suWujOaIkCddO1xuY29uc3QgTEFORV9OQU1FX01BWCA9IDE4O1xuY29uc3QgQ0FSRF9USVRMRV9NQVggPSAxMjA7XG5jb25zdCBDQVJEX05PVEVfTUFYID0gNTAwO1xuY29uc3QgRFJBRlRfTUFYID0gNDAwMDtcbmNvbnN0IExBTkVfQVVUT19ET05FID0gJ+WujOaIkCc7IC8vIOWQjeWtl+mHjOW4pui/meS4pOS4quWtl+eahOWIl+ihqO+8jOaLlui/m+WOu+iHquWKqOagh+iusOS4uuW3suWujOaIkFxuY29uc3QgVU5ET19NUyA9IDgwMDA7XG5jb25zdCBEUkFGVF9ERUJPVU5DRV9NUyA9IDQwMDtcbmNvbnN0IFNBVkVfREVCT1VOQ0VfTVMgPSA0MDA7XG5jb25zdCBEUkFHX1RIUkVTSE9MRCA9IDY7XG5jb25zdCBOT1RJRklDQVRJT05fSURfTUFYID0gMjAwO1xuXG5jb25zdCBQUklPUklUWV9MQUJFTCA9IHsgbG93OiAn5L2OJywgbm9ybWFsOiAn5LitJywgaGlnaDogJ+mrmCcgfTtcbmNvbnN0IFBSSU9SSVRZX09SREVSID0geyBoaWdoOiAwLCBub3JtYWw6IDEsIGxvdzogMiB9O1xuY29uc3QgUkVDVVJSRU5DRV9MQUJFTCA9IHsgZGFpbHk6ICfmr4/lpKknLCB3ZWVrbHk6ICfmr4/lkagnLCBtb250aGx5OiAn5q+P5pyIJyB9O1xuXG4vKipcbiAqIOexu+WQjeWGmeaIkOafpeihqOiAjOS4jeaYr+Wtl+espuS4suaLvOaOpe+8muaLvOaOpeWHuuadpeeahOexu+WQjeWcqOWFqOS7k+W6k+aQnOe0oumHjOaJvuS4jeWIsO+8jFxuICog5pS55qC35byP5pe25peg5rOV56Gu6K6k44CM6L+Z5Liq57G76L+Y5pyJ5rKh5pyJ5Lq65Zyo55So44CN77yM6Z2Z5oCB5qOA5p+l5Lmf5Lya5oqK5a6D5b2T5oiQ5rKh5Lq655So55qE5bqf5byD6KeE5YiZ44CCXG4gKi9cbmNvbnN0IFBSSU9SSVRZX0NMQVNTID0ge1xuICBsb3c6ICdrYW5iYW5fX3BpbGwtLWxvdycsXG4gIG5vcm1hbDogJ2thbmJhbl9fcGlsbC0tbm9ybWFsJyxcbiAgaGlnaDogJ2thbmJhbl9fcGlsbC0taGlnaCcsXG59O1xuY29uc3QgRFVFX0NMQVNTID0ge1xuICBub3JtYWw6ICdrYW5iYW5fX2R1ZS0tbm9ybWFsJyxcbiAgc29vbjogJ2thbmJhbl9fZHVlLS1zb29uJyxcbiAgdG9kYXk6ICdrYW5iYW5fX2R1ZS0tdG9kYXknLFxuICBvdmVyZHVlOiAna2FuYmFuX19kdWUtLW92ZXJkdWUnLFxuICBkb25lOiAna2FuYmFuX19kdWUtLWRvbmUnLFxufTtcblxuZXhwb3J0IHtcbiAgTW9kdWxpdGgsXG4gIFJlYWN0LFxuICBoLFxuICB1c2VFZmZlY3QsXG4gIHVzZU1lbW8sXG4gIHVzZVJlZixcbiAgdXNlU3RhdGUsXG4gIHVzZVN5bmNFeHRlcm5hbFN0b3JlLFxuICBjdHgsXG4gIEtFWV9CT0FSRCxcbiAgS0VZX0RSQUZULFxuICBLRVlfUFJFRlMsXG4gIFNDSEVNQV9WRVJTSU9OLFxuICBUT1BJQ19DSEFOR0VELFxuICBERUZBVUxUX0xBTkVTLFxuICBMQU5FX05BTUVfTUFYLFxuICBDQVJEX1RJVExFX01BWCxcbiAgQ0FSRF9OT1RFX01BWCxcbiAgRFJBRlRfTUFYLFxuICBMQU5FX0FVVE9fRE9ORSxcbiAgVU5ET19NUyxcbiAgRFJBRlRfREVCT1VOQ0VfTVMsXG4gIFNBVkVfREVCT1VOQ0VfTVMsXG4gIERSQUdfVEhSRVNIT0xELFxuICBOT1RJRklDQVRJT05fSURfTUFYLFxuICBQUklPUklUWV9MQUJFTCxcbiAgUFJJT1JJVFlfT1JERVIsXG4gIFJFQ1VSUkVOQ0VfTEFCRUwsXG4gIFBSSU9SSVRZX0NMQVNTLFxuICBEVUVfQ0xBU1MsXG59O1xuIiwgIi8vIOS7jiBwbHVnaW5zL2thbmJhbi9pbmRleC5qcyDmi4blh7og4oCU4oCUICoq6YC76L6R5Y6f5qC35pCs6L+Q77yM5pyq5YGa5Lu75L2V5pS55YqoKirjgIJcbi8vIOaQrOi/kOaYr+acuuaisOeahO+8muavj+Wdl+eahOS9jee9ruS4juWGheWuuemDveayoeWPmO+8jOWPquaYr+ihpeS4iuS6hiBpbXBvcnQgLyBleHBvcnTjgIJcbmltcG9ydCB7IG5leHRSZWN1cnJlbmNlRHVlLCB0b2RheUtleSB9IGZyb20gJy4vZGF0ZXMnO1xuaW1wb3J0IHsgREVGQVVMVF9MQU5FUywgRFJBRlRfTUFYLCBLRVlfQk9BUkQsIEtFWV9EUkFGVCwgS0VZX1BSRUZTLCBMQU5FX0FVVE9fRE9ORSwgTk9USUZJQ0FUSU9OX0lEX01BWCwgU0FWRV9ERUJPVU5DRV9NUywgU0NIRU1BX1ZFUlNJT04sIFRPUElDX0NIQU5HRUQsIGN0eCB9IGZyb20gJy4vZW52JztcbmltcG9ydCB7IGNhcmRzSW5MYW5lLCBjbG9uZSwgbGFuZUJ5SWQsIGxhbmVJbmRleEJ5SWQsIG1ha2VDYXJkLCBtYWtlTGFuZSwgbW92ZUNhcmRQdXJlLCBtb3ZlTGFuZVB1cmUsIG5leHRPcmRlciwgbm9ybWFsaXplQm9hcmQsIG5vcm1hbGl6ZVByZWZzLCBub3dJc28sIHRvdWNoQm9hcmQgfSBmcm9tICcuL21vZGVsJztcblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyDkuIDkuKrmnoHlsI/nmoTlpJbnva7nirbmgIHlrrnlmahcbi8vXG4vLyDnnIvmnb/mlbDmja7mlL7lnKjnu4Tku7bkuYvlpJbmnInkuKTkuKrnkIbnlLHvvJrliIblsY/nmoTkuKTkuKrlrp7kvovopoHog73kupLnm7jpgJrnn6XvvJvor7vnm5jkuI7lhpnnm5jpg73mmK/lvILmraXnmoTvvIxcbi8vIOeKtuaAgeaUvuWcqOWklumdouWPr+S7pemBv+WFjee7hOS7tumHjea4suafk+aXtumXreWMhemHjOeahOWAvOi/h+acn+OAglxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmZ1bmN0aW9uIGNyZWF0ZVN0b3JlKCkge1xuICB2YXIgc3RhdGUgPSB7XG4gICAgc3RhdHVzOiAnbG9hZGluZycsIC8vIGxvYWRpbmcgfCByZWFkeSB8IGVycm9yXG4gICAgZXJyb3JNZXNzYWdlOiBudWxsLFxuICAgIG5vdGVzOiBbXSxcbiAgICBzYXZlU3RhdGU6ICdpZGxlJywgLy8gaWRsZSB8IHNhdmluZyB8IHNhdmVkIHwgZXJyb3JcbiAgICBzYXZlRXJyb3I6IG51bGwsXG4gICAgYm9hcmQ6IG51bGwsXG4gICAgZHJhZnQ6ICcnLFxuICAgIHByZWZzOiB7IG5vdGlmeTogdHJ1ZSB9LFxuICAgIGNvbmZsaWN0OiBmYWxzZSxcbiAgfTtcbiAgdmFyIGxpc3RlbmVycyA9IG5ldyBTZXQoKTtcblxuICByZXR1cm4ge1xuICAgIHN1YnNjcmliZTogZnVuY3Rpb24gKGxpc3RlbmVyKSB7XG4gICAgICBsaXN0ZW5lcnMuYWRkKGxpc3RlbmVyKTtcbiAgICAgIHJldHVybiBmdW5jdGlvbiAoKSB7XG4gICAgICAgIGxpc3RlbmVycy5kZWxldGUobGlzdGVuZXIpO1xuICAgICAgfTtcbiAgICB9LFxuICAgIGdldFNuYXBzaG90OiBmdW5jdGlvbiAoKSB7XG4gICAgICByZXR1cm4gc3RhdGU7XG4gICAgfSxcbiAgICBzZXQ6IGZ1bmN0aW9uIChwYXRjaCkge1xuICAgICAgc3RhdGUgPSBPYmplY3QuYXNzaWduKHt9LCBzdGF0ZSwgcGF0Y2gpO1xuICAgICAgbGlzdGVuZXJzLmZvckVhY2goZnVuY3Rpb24gKGxpc3RlbmVyKSB7XG4gICAgICAgIGxpc3RlbmVyKCk7XG4gICAgICB9KTtcbiAgICB9LFxuICAgIHBhdGNoQm9hcmQ6IGZ1bmN0aW9uIChib2FyZCwgZXh0cmEpIHtcbiAgICAgIHRoaXMuc2V0KE9iamVjdC5hc3NpZ24oeyBib2FyZDogYm9hcmQgfSwgZXh0cmEgfHwge30pKTtcbiAgICB9LFxuICB9O1xufVxuXG52YXIgc3RvcmUgPSBjcmVhdGVTdG9yZSgpO1xuXG52YXIgaW50ZXJuYWwgPSB7XG4gIGFsaXZlOiBmYWxzZSxcbiAgbG9hZGVkOiBmYWxzZSxcbiAgc2F2aW5nOiBmYWxzZSxcbiAgdGltZXI6IG51bGwsXG4gIC8qKiDlt7Lnu4/miJDlip/okL3nm5jnmoTniYjmnKzlj7fvvJvno4Hnm5jkuIrnmoQgcmV2IOavlOWug+aWsO+8jOivtOaYjui/meS7veaVsOaNruaYr+WIq+eahOWunuS+i+WGmeeahCAqL1xuICBzYXZlZFJldjogMCxcbiAgbGFzdEdvb2Q6IG51bGwsXG4gIHdyaXRlQmxvY2tlZDogZmFsc2UsXG4gIHNhdmVXYWl0ZXJzOiBbXSxcbiAgZHJhZnRUaW1lcjogbnVsbCxcbiAgbm90aWZpZWRJZHM6IFtdLFxuICByZW1pbmRlZERheTogbnVsbCxcbn07XG5cbmZ1bmN0aW9uIHB1c2hOb3RlKG1lc3NhZ2UpIHtcbiAgaWYgKCFtZXNzYWdlKSByZXR1cm47XG4gIHZhciBub3RlcyA9IHN0b3JlLmdldFNuYXBzaG90KCkubm90ZXMgfHwgW107XG4gIGlmIChub3Rlcy5pbmRleE9mKG1lc3NhZ2UpID49IDApIHJldHVybjtcbiAgc3RvcmUuc2V0KHsgbm90ZXM6IG5vdGVzLmNvbmNhdChbbWVzc2FnZV0pIH0pO1xufVxuXG5mdW5jdGlvbiBncmVldGluZygpIHtcbiAgdmFyIGhvdXIgPSBuZXcgRGF0ZSgpLmdldEhvdXJzKCk7XG4gIGlmIChob3VyIDwgNSkgcmV0dXJuICflpJzmt7HkuoYnO1xuICBpZiAoaG91ciA8IDExKSByZXR1cm4gJ+aXqeS4iuWlvSc7XG4gIGlmIChob3VyIDwgMTQpIHJldHVybiAn5Lit5Y2I5aW9JztcbiAgaWYgKGhvdXIgPCAxOCkgcmV0dXJuICfkuIvljYjlpb0nO1xuICByZXR1cm4gJ+aZmuS4iuWlvSc7XG59XG5cbmZ1bmN0aW9uIGxvYWQoKSB7XG4gIHJldHVybiBjdHguc3RvcmFnZVxuICAgIC5nZXQoS0VZX0JPQVJELCBudWxsKVxuICAgIC50aGVuKGZ1bmN0aW9uIChyYXcpIHtcbiAgICAgIHZhciByZXN1bHQgPSBub3JtYWxpemVCb2FyZChyYXcpO1xuICAgICAgaWYgKCFpbnRlcm5hbC5hbGl2ZSkgcmV0dXJuO1xuICAgICAgaW50ZXJuYWwubG9hZGVkID0gdHJ1ZTtcbiAgICAgIGludGVybmFsLnNhdmVkUmV2ID0gcmVzdWx0LmJvYXJkLnJldjtcbiAgICAgIGludGVybmFsLmxhc3RHb29kID0gY2xvbmUocmVzdWx0LmJvYXJkKTtcbiAgICAgIGludGVybmFsLndyaXRlQmxvY2tlZCA9IHJlc3VsdC5ib2FyZC5zY2hlbWFWZXJzaW9uID4gU0NIRU1BX1ZFUlNJT047XG4gICAgICBzdG9yZS5zZXQoe1xuICAgICAgICBzdGF0dXM6ICdyZWFkeScsXG4gICAgICAgIGVycm9yTWVzc2FnZTogbnVsbCxcbiAgICAgICAgbm90ZXM6IHJlc3VsdC5ub3RlcyxcbiAgICAgICAgYm9hcmQ6IHJlc3VsdC5ib2FyZCxcbiAgICAgIH0pO1xuICAgICAgaWYgKGludGVybmFsLndyaXRlQmxvY2tlZCkge1xuICAgICAgICBzdG9yZS5zZXQoe1xuICAgICAgICAgIHNhdmVTdGF0ZTogJ2Vycm9yJyxcbiAgICAgICAgICBzYXZlRXJyb3I6ICfno4Hnm5jkuIrnmoTmlbDmja7mnaXoh6rmm7TmlrDniYjmnKznmoTnnIvmnb/mj5Lku7bvvIzmnKzniYjmnKzkuI3kvJrlhpnlhaXvvIzku6XlhY3opobnm5blroPjgIInLFxuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICB9KVxuICAgIC5jYXRjaChmdW5jdGlvbiAoZXJyKSB7XG4gICAgICBpZiAoIWludGVybmFsLmFsaXZlKSByZXR1cm47XG4gICAgICBjdHgubG9nZ2VyLmVycm9yKCfor7vlj5bnnIvmnb/mlbDmja7lpLHotKUnLCBlcnIpO1xuICAgICAgc3RvcmUuc2V0KHtcbiAgICAgICAgc3RhdHVzOiAnZXJyb3InLFxuICAgICAgICBlcnJvck1lc3NhZ2U6XG4gICAgICAgICAgJ+ivu+WPluaVsOaNruWksei0pe+8micgKyAoKGVyciAmJiBlcnIubWVzc2FnZSkgfHwgJ+acquefpeWOn+WboCcpICtcbiAgICAgICAgICAn44CC56OB55uY5LiK55qE5pWw5o2u5rKh5pyJ6KKr5pS55Yqo77yM5L+u5aW95Y6f5Zug5ZCO54K544CM6YeN5paw6K+75Y+W44CN5YaN6K+V44CCJyxcbiAgICAgIH0pO1xuICAgIH0pO1xufVxuXG5mdW5jdGlvbiBsb2FkRHJhZnQoKSB7XG4gIHJldHVybiBjdHguc3RvcmFnZVxuICAgIC5nZXQoS0VZX0RSQUZULCAnJylcbiAgICAudGhlbihmdW5jdGlvbiAodmFsdWUpIHtcbiAgICAgIGlmICghaW50ZXJuYWwuYWxpdmUpIHJldHVybjtcbiAgICAgIHN0b3JlLnNldCh7IGRyYWZ0OiB0eXBlb2YgdmFsdWUgPT09ICdzdHJpbmcnID8gdmFsdWUuc2xpY2UoMCwgRFJBRlRfTUFYKSA6ICcnIH0pO1xuICAgIH0pXG4gICAgLmNhdGNoKGZ1bmN0aW9uIChlcnIpIHtcbiAgICAgIGlmICghaW50ZXJuYWwuYWxpdmUpIHJldHVybjtcbiAgICAgIGN0eC5sb2dnZXIud2Fybign6K+75Y+W6YCf6K6w6I2J56i/5aSx6LSlJywgZXJyKTtcbiAgICAgIHN0b3JlLnNldCh7IGRyYWZ0OiAnJyB9KTtcbiAgICB9KTtcbn1cblxuZnVuY3Rpb24gbG9hZFByZWZzKCkge1xuICByZXR1cm4gY3R4LnN0b3JhZ2VcbiAgICAuZ2V0KEtFWV9QUkVGUywgbnVsbClcbiAgICAudGhlbihmdW5jdGlvbiAocmF3KSB7XG4gICAgICBpZiAoIWludGVybmFsLmFsaXZlKSByZXR1cm47XG4gICAgICBzdG9yZS5zZXQoeyBwcmVmczogbm9ybWFsaXplUHJlZnMocmF3KSB9KTtcbiAgICB9KVxuICAgIC5jYXRjaChmdW5jdGlvbiAoZXJyKSB7XG4gICAgICBjdHgubG9nZ2VyLndhcm4oJ+ivu+WPluaPkOmGkuiuvue9ruWksei0pe+8jOaMiem7mOiupO+8iOW8gOWQr+aPkOmGku+8ieWkhOeQhicsIGVycik7XG4gICAgfSk7XG59XG5cbmZ1bmN0aW9uIHJlbG9hZCgpIHtcbiAgc3RvcmUuc2V0KHsgc3RhdHVzOiAnbG9hZGluZycsIGVycm9yTWVzc2FnZTogbnVsbCB9KTtcbiAgcmV0dXJuIGxvYWQoKS50aGVuKGxvYWREcmFmdCkudGhlbihsb2FkUHJlZnMpO1xufVxuXG4vKipcbiAqIOWGmeebmOOAglxuICpcbiAqIOWGsueqgeetlueVpe+8muWGmeS5i+WJjeWFiOivu+S4gOasoeejgeebmOS4iueahCByZXbjgILlroPmr5TmnKzlrp7kvovjgIzlt7Lnn6XokL3nm5jnmoTniYjmnKzjgI3mlrDvvIzlsLHor7TmmI5cbiAqIOWIhuWxj+eahOWPpuS4gOWNiuaIluS4iuS4gOasoeS8muivneWGmei/h+aVsOaNriDigJTigJQg5q2k5pe25LiN6KaG55uW77yM5oqK5a+55pa555qE54mI5pys6KOF5Zue55WM6Z2i5bm26K+05piO5oOF5Ya144CCXG4gKi9cbmZ1bmN0aW9uIHNhdmVOb3cocmVhc29uKSB7XG4gIGlmIChpbnRlcm5hbC53cml0ZUJsb2NrZWQpIHtcbiAgICBzdG9yZS5zZXQoe1xuICAgICAgc2F2ZVN0YXRlOiAnZXJyb3InLFxuICAgICAgc2F2ZUVycm9yOiAn56OB55uY5LiK55qE5pWw5o2u5p2l6Ieq5pu05paw54mI5pys55qE55yL5p2/5o+S5Lu277yM5pys5qyh5rKh5pyJ5YaZ5YWl77yM5Lul5YWN6KaG55uW44CCJyxcbiAgICB9KTtcbiAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKCk7XG4gIH1cbiAgLy8g5Yay56qB5pyq5Yaz5LmL5YmN5LiN5YaN5YaZ55uY77ya5q2k5pe255WM6Z2i5YaF5a655bey57uP6KKr5o2i5oiQ56OB55uY5LiK55qE6YKj5LiA5Lu977yMXG4gIC8vIOWGjeWGmeS4gOasoeWPquS8muaKiuWQjOS4gOS4queJiOacrOWPjeWkjeWGmeWbnuWOu+OAgueUqOaIt+S4i+S4gOasoeaUueWKqOS8mue7jyBjb21taXQoKSDmuIXmjonov5nkuKrmoIflv5fjgIJcbiAgaWYgKHN0b3JlLmdldFNuYXBzaG90KCkuY29uZmxpY3QpIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcblxuICBpZiAoaW50ZXJuYWwuc2F2aW5nKSB7XG4gICAgcmV0dXJuIG5ldyBQcm9taXNlKGZ1bmN0aW9uIChyZXNvbHZlKSB7XG4gICAgICBpbnRlcm5hbC5zYXZlV2FpdGVycy5wdXNoKHJlc29sdmUpO1xuICAgIH0pO1xuICB9XG5cbiAgdmFyIHNuYXBzaG90ID0gY2xvbmUoc3RvcmUuZ2V0U25hcHNob3QoKS5ib2FyZCk7XG4gIGlmICghc25hcHNob3QpIHJldHVybiBQcm9taXNlLnJlc29sdmUoKTtcbiAgc25hcHNob3Quc2NoZW1hVmVyc2lvbiA9IFNDSEVNQV9WRVJTSU9OO1xuXG4gIGludGVybmFsLnNhdmluZyA9IHRydWU7XG4gIHN0b3JlLnNldCh7IHNhdmVTdGF0ZTogJ3NhdmluZycsIHNhdmVFcnJvcjogbnVsbCB9KTtcblxuICByZXR1cm4gY3R4LnN0b3JhZ2VcbiAgICAuZ2V0KEtFWV9CT0FSRCwgbnVsbClcbiAgICAudGhlbihmdW5jdGlvbiAocmF3KSB7XG4gICAgICB2YXIgZGlzayA9IG5vcm1hbGl6ZUJvYXJkKHJhdykuYm9hcmQ7XG4gICAgICBpZiAoZGlzay5yZXYgPiBpbnRlcm5hbC5zYXZlZFJldikge1xuICAgICAgICBpbnRlcm5hbC5zYXZlZFJldiA9IGRpc2sucmV2O1xuICAgICAgICBpbnRlcm5hbC5sYXN0R29vZCA9IGNsb25lKGRpc2spO1xuICAgICAgICBzdG9yZS5zZXQoe1xuICAgICAgICAgIGJvYXJkOiBkaXNrLFxuICAgICAgICAgIGNvbmZsaWN0OiB0cnVlLFxuICAgICAgICAgIHNhdmVTdGF0ZTogJ2Vycm9yJyxcbiAgICAgICAgICBzYXZlRXJyb3I6XG4gICAgICAgICAgICAn5qOA5rWL5Yiw5Y+m5LiA5aSE77yI5YiG5bGP55qE5Y+m5LiA5Y2K77yM5oiW5LiK5LiA5qyh5Lya6K+d77yJ5bey57uP5L+d5a2Y6L+H5pu05pS577yM55WM6Z2i5bey5YiH5o2i5oiQ5a+55pa555qE54mI5pys77yMJyArXG4gICAgICAgICAgICAn5pys5Zyw6L+Z5qyh55qE5pS55Yqo5rKh5pyJ5YaZ5YWl44CC6K+36YeN5paw6LCD5pW05ZCO5YaN6K+V44CCJyxcbiAgICAgICAgfSk7XG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgIH1cbiAgICAgIHJldHVybiBjdHguc3RvcmFnZS5zZXQoS0VZX0JPQVJELCBzbmFwc2hvdCkudGhlbihmdW5jdGlvbiAoKSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgfSk7XG4gICAgfSlcbiAgICAudGhlbihmdW5jdGlvbiAod3JpdHRlbikge1xuICAgICAgaWYgKHdyaXR0ZW4gIT09IHRydWUpIHJldHVybjtcbiAgICAgIGludGVybmFsLnNhdmVkUmV2ID0gc25hcHNob3QucmV2O1xuICAgICAgaW50ZXJuYWwubGFzdEdvb2QgPSBjbG9uZShzbmFwc2hvdCk7XG4gICAgICBzdG9yZS5zZXQoeyBzYXZlU3RhdGU6ICdzYXZlZCcsIHNhdmVFcnJvcjogbnVsbCwgY29uZmxpY3Q6IGZhbHNlIH0pO1xuICAgICAgLy8g6YCa55+l5Y+m5LiA5Liq5a6e5L6L77yb5rKh5pyJIHBsdWdpbi1jb21tdW5pY2F0ZSDml7bov5nkuIDmraXmmK/nqbrlrp7njrDvvIzkuI3lvbHlk43kv53lrZhcbiAgICAgIGN0eC5ldmVudHMucHVibGlzaChUT1BJQ19DSEFOR0VELCB7IHJldjogc25hcHNob3QucmV2LCBhdDogRGF0ZS5ub3coKSB9KTtcbiAgICB9KVxuICAgIC5jYXRjaChmdW5jdGlvbiAoZXJyKSB7XG4gICAgICBjdHgubG9nZ2VyLmVycm9yKCfkv53lrZjnnIvmnb/lpLHotKXvvIgnICsgcmVhc29uICsgJ++8iScsIGVycik7XG4gICAgICBzdG9yZS5zZXQoe1xuICAgICAgICBzYXZlU3RhdGU6ICdlcnJvcicsXG4gICAgICAgIHNhdmVFcnJvcjpcbiAgICAgICAgICAn5L+d5a2Y5aSx6LSl77yaJyArICgoZXJyICYmIGVyci5tZXNzYWdlKSB8fCAn5pyq55+l5Y6f5ZugJykgK1xuICAgICAgICAgICfjgILmlLnliqjov5jlnKjnlYzpnaLkuIrvvIzlj6/ku6XngrnjgIzph43or5Xkv53lrZjjgI3vvJvoi6XkuIDnm7TlpLHotKXvvIzlpJrljYrmmK/no4Hnm5jnqbrpl7TmiJbmlbDmja7nm67lvZXmnYPpmZDnmoTpl67popjjgIInLFxuICAgICAgfSk7XG4gICAgfSlcbiAgICAudGhlbihmdW5jdGlvbiAoKSB7XG4gICAgICBpbnRlcm5hbC5zYXZpbmcgPSBmYWxzZTtcbiAgICAgIHZhciB3YWl0ZXJzID0gaW50ZXJuYWwuc2F2ZVdhaXRlcnM7XG4gICAgICBpbnRlcm5hbC5zYXZlV2FpdGVycyA9IFtdO1xuICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCB3YWl0ZXJzLmxlbmd0aDsgaSArPSAxKSB3YWl0ZXJzW2ldKCk7XG4gICAgfSk7XG59XG5cbmZ1bmN0aW9uIHNjaGVkdWxlU2F2ZShyZWFzb24pIHtcbiAgaWYgKGludGVybmFsLnRpbWVyICE9PSBudWxsKSB7XG4gICAgY2xlYXJUaW1lb3V0KGludGVybmFsLnRpbWVyKTtcbiAgICBpbnRlcm5hbC50aW1lciA9IG51bGw7XG4gIH1cbiAgaW50ZXJuYWwudGltZXIgPSBzZXRUaW1lb3V0KGZ1bmN0aW9uICgpIHtcbiAgICBpbnRlcm5hbC50aW1lciA9IG51bGw7XG4gICAgc2F2ZU5vdyhyZWFzb24pO1xuICB9LCBTQVZFX0RFQk9VTkNFX01TKTtcbn1cblxuZnVuY3Rpb24gc2F2ZVByZWZzTm93KHByZWZzKSB7XG4gIGN0eC5zdG9yYWdlLnNldChLRVlfUFJFRlMsIHByZWZzKS5jYXRjaChmdW5jdGlvbiAoZXJyKSB7XG4gICAgY3R4LmxvZ2dlci53YXJuKCfkv53lrZjmj5DphpLorr7nva7lpLHotKUnLCBlcnIpO1xuICB9KTtcbn1cblxuLyoqIOaJgOacieaUueWKqOmDveS7jui/memHjOi1sO+8muWFiOabtOaWsOeVjOmdou+8jOWGjeiQveebmOOAguWksei0peWOn+WboOeUsemhtumDqOaoquW5hee7meWHuu+8jOW5tuW4puOAjOmHjeivleS/neWtmOOAjeOAgiAqL1xuZnVuY3Rpb24gY29tbWl0KGJvYXJkLCByZWFzb24pIHtcbiAgc3RvcmUucGF0Y2hCb2FyZCh0b3VjaEJvYXJkKGJvYXJkKSwgeyBjb25mbGljdDogZmFsc2UgfSk7XG4gIHNjaGVkdWxlU2F2ZShyZWFzb24pO1xufVxuXG4vKiog5qCH6K6w5o+Q6YaS5bey5Y+R5Ye644CC5Y+q5L+d55WZ5pyA6L+R6Iul5bmy5p2h77yM6YG/5YWN6ZW/5pe26Ze06L+Q6KGM5ZCO5peg55WM5aKe6ZW/44CCICovXG5mdW5jdGlvbiByZW1lbWJlck5vdGlmaWNhdGlvbihpZCkge1xuICBpbnRlcm5hbC5ub3RpZmllZElkcy5wdXNoKGlkKTtcbiAgaWYgKGludGVybmFsLm5vdGlmaWVkSWRzLmxlbmd0aCA+IE5PVElGSUNBVElPTl9JRF9NQVgpIHtcbiAgICBpbnRlcm5hbC5ub3RpZmllZElkcyA9IGludGVybmFsLm5vdGlmaWVkSWRzLnNsaWNlKC1OT1RJRklDQVRJT05fSURfTUFYKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBub3RpZnkodGl0bGUsIGJvZHksIGRlZHVwZUtleSkge1xuICBpZiAoIWN0eC5ub3RpZmljYXRpb25zLmlzQXZhaWxhYmxlIHx8ICFjdHgubm90aWZpY2F0aW9ucy5pc0F2YWlsYWJsZSgpKSB7XG4gICAgY3R4LmxvZ2dlci5pbmZvKCfmnKrlo7DmmI4gbm90aWZpY2F0aW9uIOadg+mZkO+8jOi3s+i/h+mAmuefpe+8micgKyB0aXRsZSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIHRyeSB7XG4gICAgY3R4Lm5vdGlmaWNhdGlvbnMuaW5mbyh0aXRsZSwgYm9keSwgZGVkdXBlS2V5KTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgY3R4LmxvZ2dlci53YXJuKCflj5HpgIHpgJrnn6XlpLHotKUnLCBlcnIpO1xuICB9XG59XG5cbi8qKlxuICog5Yiw5pyf5o+Q6YaS44CC5LiA5aSp5Y+q5Zyo5ZCM5LiA5om55YaF5a655LiK5o+Q6YaS5LiA5qyh77yaZGVkdXBlS2V5IOW4puS4iuaXpeacn+S4jumAvuacn+eKtuaAge+8jFxuICog5Zug5q2k5ZCM5LiA5aSp5YaF5LiN5Lya6YeN5aSN5by577yM56ys5LqM5aSp5Lya6YeN5paw5o+Q6YaS5LiA5qyh44CCXG4gKi9cbmZ1bmN0aW9uIGR1ZVJlbWluZGVyKGJvYXJkKSB7XG4gIGlmICghYm9hcmQgfHwgc3RvcmUuZ2V0U25hcHNob3QoKS5wcmVmcy5ub3RpZnkgPT09IGZhbHNlKSByZXR1cm47XG4gIGlmICghY3R4Lm5vdGlmaWNhdGlvbnMuaXNBdmFpbGFibGUgfHwgIWN0eC5ub3RpZmljYXRpb25zLmlzQXZhaWxhYmxlKCkpIHJldHVybjtcblxuICB2YXIgdG9kYXkgPSB0b2RheUtleSgpO1xuICB2YXIgb3ZlcmR1ZSA9IFtdO1xuICB2YXIgZHVlVG9kYXkgPSBbXTtcbiAgdmFyIGlkcyA9IE9iamVjdC5rZXlzKGJvYXJkLmNhcmRzKTtcbiAgZm9yICh2YXIgaSA9IDA7IGkgPCBpZHMubGVuZ3RoOyBpICs9IDEpIHtcbiAgICB2YXIgY2FyZCA9IGJvYXJkLmNhcmRzW2lkc1tpXV07XG4gICAgaWYgKGNhcmQuZG9uZSB8fCAhY2FyZC5kdWUpIGNvbnRpbnVlO1xuICAgIGlmIChjYXJkLmR1ZSA8IHRvZGF5KSBvdmVyZHVlLnB1c2goY2FyZCk7XG4gICAgZWxzZSBpZiAoY2FyZC5kdWUgPT09IHRvZGF5KSBkdWVUb2RheS5wdXNoKGNhcmQpO1xuICB9XG4gIGlmIChvdmVyZHVlLmxlbmd0aCA9PT0gMCAmJiBkdWVUb2RheS5sZW5ndGggPT09IDApIHJldHVybjtcblxuICB2YXIgc2lnbmF0dXJlID1cbiAgICBvdmVyZHVlLmxlbmd0aCArICc6JyArIGR1ZVRvZGF5Lmxlbmd0aCArICc6JyArIChvdmVyZHVlWzBdID8gb3ZlcmR1ZVswXS5pZCA6ICctJykgKyAnOicgKyAoZHVlVG9kYXlbMF0gPyBkdWVUb2RheVswXS5pZCA6ICctJyk7XG4gIHZhciBrZXkgPSAna2FuYmFuLWR1ZS0nICsgdG9kYXkgKyAnLScgKyBzaWduYXR1cmU7XG4gIGlmIChpbnRlcm5hbC5ub3RpZmllZElkcy5pbmRleE9mKGtleSkgPj0gMCkgcmV0dXJuO1xuICByZW1lbWJlck5vdGlmaWNhdGlvbihrZXkpO1xuXG4gIGZ1bmN0aW9uIG5hbWVzKGxpc3QpIHtcbiAgICB2YXIgc2hvd24gPSBsaXN0LnNsaWNlKDAsIDMpLm1hcChmdW5jdGlvbiAoY2FyZCkge1xuICAgICAgcmV0dXJuIGNhcmQudGl0bGU7XG4gICAgfSk7XG4gICAgcmV0dXJuIHNob3duLmpvaW4oJ+OAgScpICsgKGxpc3QubGVuZ3RoID4gMyA/ICcg562JICcgKyBsaXN0Lmxlbmd0aCArICcg6aG5JyA6ICcnKTtcbiAgfVxuXG4gIHZhciB0aXRsZTtcbiAgdmFyIGJvZHk7XG4gIGlmIChvdmVyZHVlLmxlbmd0aCA+IDAgJiYgZHVlVG9kYXkubGVuZ3RoID4gMCkge1xuICAgIHRpdGxlID0gJ+aciSAnICsgb3ZlcmR1ZS5sZW5ndGggKyAnIOmhueW3sumAvuacn+OAgScgKyBkdWVUb2RheS5sZW5ndGggKyAnIOmhueS7iuWkqeWIsOacnyc7XG4gICAgYm9keSA9ICfpgL7mnJ/vvJonICsgbmFtZXMob3ZlcmR1ZSkgKyAn77yb5LuK5aSp77yaJyArIG5hbWVzKGR1ZVRvZGF5KTtcbiAgfSBlbHNlIGlmIChvdmVyZHVlLmxlbmd0aCA+IDApIHtcbiAgICB0aXRsZSA9ICfmnIkgJyArIG92ZXJkdWUubGVuZ3RoICsgJyDpobnlt7Lnu4/pgL7mnJ8nO1xuICAgIGJvZHkgPSBuYW1lcyhvdmVyZHVlKTtcbiAgfSBlbHNlIHtcbiAgICB0aXRsZSA9ICfmnIkgJyArIGR1ZVRvZGF5Lmxlbmd0aCArICcg6aG55LuK5aSp5Yiw5pyfJztcbiAgICBib2R5ID0gbmFtZXMoZHVlVG9kYXkpO1xuICB9XG4gIG5vdGlmeSh0aXRsZSwgYm9keSwga2V5KTtcbn1cblxuLyoqIOajgOafpeaYr+WQpuWIsOS6huaWsOeahOS4gOWkqe+8iOW6lOeUqOmVv+acn+W8gOedgOaXtu+8jOmcgOimgeWcqOi3qOWkqeWQjumHjeaWsOaPkOmGkuS4gOasoe+8ieOAgiAqL1xuZnVuY3Rpb24gZGF5Q2hhbmdlZCgpIHtcbiAgdmFyIHRvZGF5ID0gdG9kYXlLZXkoKTtcbiAgaWYgKGludGVybmFsLnJlbWluZGVkRGF5ID09PSB0b2RheSkgcmV0dXJuIGZhbHNlO1xuICBpbnRlcm5hbC5yZW1pbmRlZERheSA9IHRvZGF5O1xuICByZXR1cm4gdHJ1ZTtcbn1cblxuZnVuY3Rpb24gY29tcGxldGVDYXJkKGJvYXJkLCBjYXJkKSB7XG4gIGNhcmQuZG9uZSA9IHRydWU7XG4gIGNhcmQuY29tcGxldGVkQXQgPSBub3dJc28oKTtcbiAgaWYgKGNhcmQucmVjdXJyZW5jZSkge1xuICAgIC8vIOmHjeWkjeS7u+WKoe+8mua7muWKqOWIsOS4i+S4gOasoe+8jOiAjOS4jeaYr+eVmeS4gOW8oOawuOi/nOWujOaIkOeahOWNoeeJh1xuICAgIGNhcmQuZHVlID0gbmV4dFJlY3VycmVuY2VEdWUoY2FyZC5kdWUsIGNhcmQucmVjdXJyZW5jZSk7XG4gICAgY2FyZC5kb25lID0gZmFsc2U7XG4gICAgY2FyZC5jb21wbGV0ZWRBdCA9IG51bGw7XG4gIH1cbiAgY2FyZC51cGRhdGVkQXQgPSBub3dJc28oKTtcbiAgcmV0dXJuIGJvYXJkO1xufVxuXG52YXIgYm9hcmRBY3Rpb25zID0ge1xuICBhZGRDYXJkOiBmdW5jdGlvbiAobGFuZUlkLCB0aXRsZSwgcHJpb3JpdHksIGR1ZSwgcmVjdXJyZW5jZSkge1xuICAgIHZhciBib2FyZCA9IGNsb25lKHN0b3JlLmdldFNuYXBzaG90KCkuYm9hcmQpO1xuICAgIGlmICghYm9hcmQpIHJldHVybiBudWxsO1xuICAgIHZhciBjYXJkID0gbWFrZUNhcmQobGFuZUlkLCB0aXRsZSwgbmV4dE9yZGVyKGJvYXJkLCBsYW5lSWQpKTtcbiAgICBjYXJkLnByaW9yaXR5ID0gcHJpb3JpdHkgfHwgJ25vcm1hbCc7XG4gICAgY2FyZC5kdWUgPSBkdWUgfHwgbnVsbDtcbiAgICBjYXJkLnJlY3VycmVuY2UgPSByZWN1cnJlbmNlIHx8IG51bGw7XG4gICAgYm9hcmQuY2FyZHNbY2FyZC5pZF0gPSBjYXJkO1xuICAgIGNvbW1pdChib2FyZCwgJ+aWsOWinuWNoeeJhycpO1xuICAgIHJldHVybiBjYXJkLmlkO1xuICB9LFxuXG4gIHVwZGF0ZUNhcmQ6IGZ1bmN0aW9uIChjYXJkSWQsIHBhdGNoKSB7XG4gICAgdmFyIGJvYXJkID0gY2xvbmUoc3RvcmUuZ2V0U25hcHNob3QoKS5ib2FyZCk7XG4gICAgaWYgKCFib2FyZCB8fCAhYm9hcmQuY2FyZHNbY2FyZElkXSkgcmV0dXJuO1xuICAgIHZhciBjYXJkID0gYm9hcmQuY2FyZHNbY2FyZElkXTtcbiAgICBpZiAocGF0Y2gudGl0bGUgIT09IHVuZGVmaW5lZCkgY2FyZC50aXRsZSA9IHBhdGNoLnRpdGxlO1xuICAgIGlmIChwYXRjaC5ub3RlICE9PSB1bmRlZmluZWQpIGNhcmQubm90ZSA9IHBhdGNoLm5vdGU7XG4gICAgaWYgKHBhdGNoLnByaW9yaXR5ICE9PSB1bmRlZmluZWQpIGNhcmQucHJpb3JpdHkgPSBwYXRjaC5wcmlvcml0eTtcbiAgICBpZiAocGF0Y2guZHVlICE9PSB1bmRlZmluZWQpIGNhcmQuZHVlID0gcGF0Y2guZHVlO1xuICAgIGlmIChwYXRjaC5yZWN1cnJlbmNlICE9PSB1bmRlZmluZWQpIGNhcmQucmVjdXJyZW5jZSA9IHBhdGNoLnJlY3VycmVuY2U7XG4gICAgaWYgKHBhdGNoLmRvbmUgIT09IHVuZGVmaW5lZCkge1xuICAgICAgaWYgKHBhdGNoLmRvbmUpIGNvbXBsZXRlQ2FyZChib2FyZCwgY2FyZCk7XG4gICAgICBlbHNlIHtcbiAgICAgICAgY2FyZC5kb25lID0gZmFsc2U7XG4gICAgICAgIGNhcmQuY29tcGxldGVkQXQgPSBudWxsO1xuICAgICAgfVxuICAgIH1cbiAgICBjYXJkLnVwZGF0ZWRBdCA9IG5vd0lzbygpO1xuICAgIGNvbW1pdChib2FyZCwgJ+e8lui+keWNoeeJhycpO1xuICB9LFxuXG4gIHRvZ2dsZURvbmU6IGZ1bmN0aW9uIChjYXJkSWQsIGRvbmUpIHtcbiAgICB2YXIgYm9hcmQgPSBjbG9uZShzdG9yZS5nZXRTbmFwc2hvdCgpLmJvYXJkKTtcbiAgICBpZiAoIWJvYXJkIHx8ICFib2FyZC5jYXJkc1tjYXJkSWRdKSByZXR1cm47XG4gICAgdmFyIGNhcmQgPSBib2FyZC5jYXJkc1tjYXJkSWRdO1xuICAgIGlmIChkb25lKSBjb21wbGV0ZUNhcmQoYm9hcmQsIGNhcmQpO1xuICAgIGVsc2Uge1xuICAgICAgY2FyZC5kb25lID0gZmFsc2U7XG4gICAgICBjYXJkLmNvbXBsZXRlZEF0ID0gbnVsbDtcbiAgICB9XG4gICAgY2FyZC51cGRhdGVkQXQgPSBub3dJc28oKTtcbiAgICBjb21taXQoYm9hcmQsICfliIfmjaLlrozmiJDnirbmgIEnKTtcbiAgfSxcblxuICBtb3ZlQ2FyZDogZnVuY3Rpb24gKGNhcmRJZCwgdGFyZ2V0TGFuZUlkLCBiZWZvcmVJZCwgYWZ0ZXJJZCkge1xuICAgIHZhciBib2FyZCA9IHN0b3JlLmdldFNuYXBzaG90KCkuYm9hcmQ7XG4gICAgaWYgKCFib2FyZCB8fCAhYm9hcmQuY2FyZHNbY2FyZElkXSkgcmV0dXJuO1xuICAgIHZhciBuZXh0ID0gbW92ZUNhcmRQdXJlKGJvYXJkLCBjYXJkSWQsIHRhcmdldExhbmVJZCwgYmVmb3JlSWQsIGFmdGVySWQpO1xuICAgIGlmIChuZXh0ID09PSBib2FyZCkgcmV0dXJuO1xuICAgIGNvbW1pdChuZXh0LCAn56e75Yqo5Y2h54mHJyk7XG4gIH0sXG5cbiAgZGVsZXRlQ2FyZDogZnVuY3Rpb24gKGNhcmRJZCkge1xuICAgIHZhciBib2FyZCA9IGNsb25lKHN0b3JlLmdldFNuYXBzaG90KCkuYm9hcmQpO1xuICAgIGlmICghYm9hcmQgfHwgIWJvYXJkLmNhcmRzW2NhcmRJZF0pIHJldHVybiBudWxsO1xuICAgIHZhciB0aXRsZSA9IGJvYXJkLmNhcmRzW2NhcmRJZF0udGl0bGU7XG4gICAgZGVsZXRlIGJvYXJkLmNhcmRzW2NhcmRJZF07XG4gICAgY29tbWl0KGJvYXJkLCAn5Yig6Zmk5Y2h54mHJyk7XG4gICAgcmV0dXJuIHRpdGxlO1xuICB9LFxuXG4gIHJlc3RvcmVDYXJkOiBmdW5jdGlvbiAoY2FyZCkge1xuICAgIHZhciBib2FyZCA9IGNsb25lKHN0b3JlLmdldFNuYXBzaG90KCkuYm9hcmQpO1xuICAgIGlmICghYm9hcmQpIHJldHVybjtcbiAgICBib2FyZC5jYXJkc1tjYXJkLmlkXSA9IGNsb25lKGNhcmQpO1xuICAgIGNvbW1pdChib2FyZCwgJ+aSpOmUgOWIoOmZpCcpO1xuICB9LFxuXG4gIGNsZWFyRG9uZTogZnVuY3Rpb24gKCkge1xuICAgIHZhciBib2FyZCA9IGNsb25lKHN0b3JlLmdldFNuYXBzaG90KCkuYm9hcmQpO1xuICAgIGlmICghYm9hcmQpIHJldHVybiAwO1xuICAgIHZhciByZW1vdmVkID0gMDtcbiAgICB2YXIgaWRzID0gT2JqZWN0LmtleXMoYm9hcmQuY2FyZHMpO1xuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgaWRzLmxlbmd0aDsgaSArPSAxKSB7XG4gICAgICBpZiAoYm9hcmQuY2FyZHNbaWRzW2ldXS5kb25lKSB7XG4gICAgICAgIGRlbGV0ZSBib2FyZC5jYXJkc1tpZHNbaV1dO1xuICAgICAgICByZW1vdmVkICs9IDE7XG4gICAgICB9XG4gICAgfVxuICAgIGlmIChyZW1vdmVkID4gMCkgY29tbWl0KGJvYXJkLCAn5riF6Zmk5bey5a6M5oiQJyk7XG4gICAgcmV0dXJuIHJlbW92ZWQ7XG4gIH0sXG5cbiAgYWRkTGFuZTogZnVuY3Rpb24gKG5hbWUpIHtcbiAgICB2YXIgYm9hcmQgPSBjbG9uZShzdG9yZS5nZXRTbmFwc2hvdCgpLmJvYXJkKTtcbiAgICBpZiAoIWJvYXJkKSByZXR1cm47XG4gICAgYm9hcmQubGFuZXMucHVzaChtYWtlTGFuZShuYW1lKSk7XG4gICAgY29tbWl0KGJvYXJkLCAn5paw5aKe5YiX6KGoJyk7XG4gIH0sXG5cbiAgcmVuYW1lTGFuZTogZnVuY3Rpb24gKGxhbmVJZCwgbmFtZSkge1xuICAgIHZhciBib2FyZCA9IGNsb25lKHN0b3JlLmdldFNuYXBzaG90KCkuYm9hcmQpO1xuICAgIGlmICghYm9hcmQpIHJldHVybjtcbiAgICB2YXIgdGFyZ2V0ID0gbGFuZUJ5SWQoYm9hcmQsIGxhbmVJZCk7XG4gICAgaWYgKCF0YXJnZXQpIHJldHVybjtcbiAgICB0YXJnZXQubmFtZSA9IG5hbWU7XG4gICAgY29tbWl0KGJvYXJkLCAn6YeN5ZG95ZCN5YiX6KGoJyk7XG4gIH0sXG5cbiAgdG9nZ2xlTGFuZUNvbGxhcHNlZDogZnVuY3Rpb24gKGxhbmVJZCkge1xuICAgIHZhciBib2FyZCA9IGNsb25lKHN0b3JlLmdldFNuYXBzaG90KCkuYm9hcmQpO1xuICAgIGlmICghYm9hcmQpIHJldHVybjtcbiAgICB2YXIgdGFyZ2V0ID0gbGFuZUJ5SWQoYm9hcmQsIGxhbmVJZCk7XG4gICAgaWYgKCF0YXJnZXQpIHJldHVybjtcbiAgICB0YXJnZXQuY29sbGFwc2VkID0gIXRhcmdldC5jb2xsYXBzZWQ7XG4gICAgY29tbWl0KGJvYXJkLCAn5oqY5Y+g5YiX6KGoJyk7XG4gIH0sXG5cbiAgbW92ZUxhbmU6IGZ1bmN0aW9uIChsYW5lSWQsIHRhcmdldEluZGV4KSB7XG4gICAgdmFyIGJvYXJkID0gc3RvcmUuZ2V0U25hcHNob3QoKS5ib2FyZDtcbiAgICBpZiAoIWJvYXJkKSByZXR1cm47XG4gICAgdmFyIG5leHQgPSBtb3ZlTGFuZVB1cmUoYm9hcmQsIGxhbmVJZCwgdGFyZ2V0SW5kZXgpO1xuICAgIGlmIChuZXh0ID09PSBib2FyZCkgcmV0dXJuO1xuICAgIGNvbW1pdChuZXh0LCAn6LCD5pW05YiX6KGo6aG65bqPJyk7XG4gIH0sXG5cbiAgLyoqIOWIoOmZpOWIl+ihqO+8jOi/lOWbnuWPr+S7peaSpOmUgOeahOaVsOaNru+8iOWIl+ihqOacrOi6qyArIOWug+mHjOmdoueahOWNoeeJh++8ieOAgiAqL1xuICBkZWxldGVMYW5lOiBmdW5jdGlvbiAobGFuZUlkKSB7XG4gICAgdmFyIGJvYXJkID0gY2xvbmUoc3RvcmUuZ2V0U25hcHNob3QoKS5ib2FyZCk7XG4gICAgaWYgKCFib2FyZCkgcmV0dXJuIG51bGw7XG4gICAgaWYgKGJvYXJkLmxhbmVzLmxlbmd0aCA8PSAxKSByZXR1cm4gbnVsbDsgLy8g6Iez5bCR55WZ5LiA5Liq5YiX6KGo77yM5ZCm5YiZ55WM6Z2i5Lya5Y+Y5oiQ5LiA5Liq5rKh5rOV55So55qE56m65aOzXG4gICAgdmFyIGluZGV4ID0gbGFuZUluZGV4QnlJZChib2FyZCwgbGFuZUlkKTtcbiAgICBpZiAoaW5kZXggPCAwKSByZXR1cm4gbnVsbDtcbiAgICB2YXIgcmVtb3ZlZExhbmUgPSBib2FyZC5sYW5lc1tpbmRleF07XG4gICAgdmFyIHJlbW92ZWRDYXJkcyA9IGNhcmRzSW5MYW5lKGJvYXJkLCBsYW5lSWQpO1xuICAgIGJvYXJkLmxhbmVzID0gYm9hcmQubGFuZXMuZmlsdGVyKGZ1bmN0aW9uIChpdGVtKSB7XG4gICAgICByZXR1cm4gaXRlbS5pZCAhPT0gbGFuZUlkO1xuICAgIH0pO1xuICAgIHZhciBpZHMgPSBPYmplY3Qua2V5cyhib2FyZC5jYXJkcyk7XG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBpZHMubGVuZ3RoOyBpICs9IDEpIHtcbiAgICAgIGlmIChib2FyZC5jYXJkc1tpZHNbaV1dLmxhbmVJZCA9PT0gbGFuZUlkKSBkZWxldGUgYm9hcmQuY2FyZHNbaWRzW2ldXTtcbiAgICB9XG4gICAgY29tbWl0KGJvYXJkLCAn5Yig6Zmk5YiX6KGoJyk7XG4gICAgcmV0dXJuIHsgbGFuZTogcmVtb3ZlZExhbmUsIGluZGV4OiBpbmRleCwgY2FyZHM6IHJlbW92ZWRDYXJkcywgbmFtZTogcmVtb3ZlZExhbmUubmFtZSB9O1xuICB9LFxuXG4gIHJlc3RvcmVMYW5lOiBmdW5jdGlvbiAoc25hcHNob3QpIHtcbiAgICB2YXIgYm9hcmQgPSBjbG9uZShzdG9yZS5nZXRTbmFwc2hvdCgpLmJvYXJkKTtcbiAgICBpZiAoIWJvYXJkIHx8ICFzbmFwc2hvdCkgcmV0dXJuO1xuICAgIHZhciBhdCA9IE1hdGgubWF4KDAsIE1hdGgubWluKHNuYXBzaG90LmluZGV4LCBib2FyZC5sYW5lcy5sZW5ndGgpKTtcbiAgICBib2FyZC5sYW5lcy5zcGxpY2UoYXQsIDAsIGNsb25lKHNuYXBzaG90LmxhbmUpKTtcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IHNuYXBzaG90LmNhcmRzLmxlbmd0aDsgaSArPSAxKSB7XG4gICAgICBib2FyZC5jYXJkc1tzbmFwc2hvdC5jYXJkc1tpXS5pZF0gPSBjbG9uZShzbmFwc2hvdC5jYXJkc1tpXSk7XG4gICAgfVxuICAgIGNvbW1pdChib2FyZCwgJ+aSpOmUgOWIoOmZpOWIl+ihqCcpO1xuICB9LFxuXG4gIC8qKlxuICAgKiDmgaLlpI3pu5jorqTnmoTkuInmoI/jgIJcbiAgICpcbiAgICog6buY6K6k5LiJ5qCP55qE5ZCN5a2X5bey57uP5a2Y5Zyo5bCx5aSN55So77yI5Y+q5oqK5a6D5oyq5Yiw6K+l5Zyo55qE5L2N572u77yJ77yM5LiN6YeN5aSN6YCg5LiA5qCP77ybXG4gICAqIOWNoeeJh+aMieaJgOWcqOagj+S4juWujOaIkOeKtuaAgeW9kuS9je+8muW3suWujOaIkOaIluWOn+acrOWcqOOAjOWujOaIkOOAjeagj+eahOi/m+OAjOW3suWujOaIkOOAje+8jFxuICAgKiDljp/mnKzlnKjjgIzov5vooYzkuK3jgI3nmoTov5vjgIzov5vooYzkuK3jgI3vvIzlhbbkvZnov5vjgIzlvoXlpITnkIbjgI3jgIIqKuS4gOW8oOWNoeeJh+mDveS4jeS8muiiq+WIoOOAgioqXG4gICAqL1xuICByZXNldExhbmVzOiBmdW5jdGlvbiAoKSB7XG4gICAgdmFyIGJvYXJkID0gY2xvbmUoc3RvcmUuZ2V0U25hcHNob3QoKS5ib2FyZCk7XG4gICAgaWYgKCFib2FyZCkgcmV0dXJuIGZhbHNlO1xuXG4gICAgLy8g5YWI6K6w5LiL5q+P5byg5Y2h5Y6f5p2l55qE5YiX6KGo5ZCNIOKAlOKAlCDmm7/mjaIgbGFuZXMg5LmL5ZCO5bCx5p+l5LiN5Yiw5LqGXG4gICAgdmFyIHNvdXJjZU5hbWVCeUxhbmUgPSB7fTtcbiAgICBmb3IgKHZhciBhID0gMDsgYSA8IGJvYXJkLmxhbmVzLmxlbmd0aDsgYSArPSAxKSB7XG4gICAgICBzb3VyY2VOYW1lQnlMYW5lW2JvYXJkLmxhbmVzW2FdLmlkXSA9IGJvYXJkLmxhbmVzW2FdLm5hbWU7XG4gICAgfVxuXG4gICAgdmFyIGJ5TmFtZSA9IHt9O1xuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgYm9hcmQubGFuZXMubGVuZ3RoOyBpICs9IDEpIHtcbiAgICAgIGlmICghYnlOYW1lW2JvYXJkLmxhbmVzW2ldLm5hbWVdKSBieU5hbWVbYm9hcmQubGFuZXNbaV0ubmFtZV0gPSBib2FyZC5sYW5lc1tpXTtcbiAgICB9XG4gICAgdmFyIHRhcmdldCA9IHt9O1xuICAgIHZhciBvcmRlciA9IFtdO1xuICAgIGZvciAodmFyIG4gPSAwOyBuIDwgREVGQVVMVF9MQU5FUy5sZW5ndGg7IG4gKz0gMSkge1xuICAgICAgdmFyIG5hbWUgPSBERUZBVUxUX0xBTkVTW25dO1xuICAgICAgaWYgKGJ5TmFtZVtuYW1lXSkge1xuICAgICAgICBieU5hbWVbbmFtZV0uY29sbGFwc2VkID0gZmFsc2U7XG4gICAgICAgIHRhcmdldFtuYW1lXSA9IGJ5TmFtZVtuYW1lXTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHRhcmdldFtuYW1lXSA9IG1ha2VMYW5lKG5hbWUpO1xuICAgICAgfVxuICAgICAgb3JkZXIucHVzaCh0YXJnZXRbbmFtZV0pO1xuICAgIH1cbiAgICBib2FyZC5sYW5lcyA9IG9yZGVyO1xuXG4gICAgdmFyIGlkcyA9IE9iamVjdC5rZXlzKGJvYXJkLmNhcmRzKTtcbiAgICBmb3IgKHZhciBqID0gMDsgaiA8IGlkcy5sZW5ndGg7IGogKz0gMSkge1xuICAgICAgdmFyIGNhcmQgPSBib2FyZC5jYXJkc1tpZHNbal1dO1xuICAgICAgdmFyIHNvdXJjZU5hbWUgPSBzb3VyY2VOYW1lQnlMYW5lW2NhcmQubGFuZUlkXSB8fCAnJztcbiAgICAgIHZhciB0b0RvbmUgPSBjYXJkLmRvbmUgfHwgc291cmNlTmFtZS5pbmRleE9mKExBTkVfQVVUT19ET05FKSA+PSAwO1xuICAgICAgdmFyIHRvRG9pbmcgPSAhdG9Eb25lICYmIHNvdXJjZU5hbWUgPT09IERFRkFVTFRfTEFORVNbMV07XG4gICAgICBjYXJkLmxhbmVJZCA9IHRvRG9uZVxuICAgICAgICA/IHRhcmdldFtERUZBVUxUX0xBTkVTWzJdXS5pZFxuICAgICAgICA6IHRvRG9pbmdcbiAgICAgICAgPyB0YXJnZXRbREVGQVVMVF9MQU5FU1sxXV0uaWRcbiAgICAgICAgOiB0YXJnZXRbREVGQVVMVF9MQU5FU1swXV0uaWQ7XG4gICAgICBjYXJkLnVwZGF0ZWRBdCA9IG5vd0lzbygpO1xuICAgIH1cblxuICAgIGNvbW1pdChib2FyZCwgJ+aBouWkjem7mOiupOWIl+ihqCcpO1xuICAgIHJldHVybiB0cnVlO1xuICB9LFxufTtcblxuZXhwb3J0IHsgYm9hcmRBY3Rpb25zLCBjb21taXQsIGNvbXBsZXRlQ2FyZCwgY3JlYXRlU3RvcmUsIGRheUNoYW5nZWQsIGR1ZVJlbWluZGVyLCBncmVldGluZywgaW50ZXJuYWwsIGxvYWQsIGxvYWREcmFmdCwgbG9hZFByZWZzLCBub3RpZnksIHB1c2hOb3RlLCByZWxvYWQsIHJlbWVtYmVyTm90aWZpY2F0aW9uLCBzYXZlTm93LCBzYXZlUHJlZnNOb3csIHNjaGVkdWxlU2F2ZSwgc3RvcmUgfTtcbiIsICIvLyDku44gcGx1Z2lucy9rYW5iYW4vaW5kZXguanMg5ouG5Ye6IOKAlOKAlCAqKumAu+i+keWOn+agt+aQrOi/kO+8jOacquWBmuS7u+S9leaUueWKqCoq44CCXG4vLyDmkKzov5DmmK/mnLrmorDnmoTvvJrmr4/lnZfnmoTkvY3nva7kuI7lhoXlrrnpg73msqHlj5jvvIzlj6rmmK/ooaXkuIrkuoYgaW1wb3J0IC8gZXhwb3J044CCXG5pbXBvcnQgeyBDQVJEX05PVEVfTUFYLCBDQVJEX1RJVExFX01BWCwgREVGQVVMVF9MQU5FUywgTEFORV9BVVRPX0RPTkUsIExBTkVfTkFNRV9NQVgsIFNDSEVNQV9WRVJTSU9OLCBjdHggfSBmcm9tICcuL2Vudic7XG5pbXBvcnQgeyBub3RpZnkgfSBmcm9tICcuL3N0b3JlJztcblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyDnuq/lh73mlbDvvJrmlbDmja7nu5PmnoTkuI7ov4Hnp7tcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5mdW5jdGlvbiBjbG9uZSh2YWx1ZSkge1xuICByZXR1cm4gdmFsdWUgPT09IHVuZGVmaW5lZCA/IHZhbHVlIDogSlNPTi5wYXJzZShKU09OLnN0cmluZ2lmeSh2YWx1ZSkpO1xufVxuXG5mdW5jdGlvbiBub3dJc28oKSB7XG4gIHJldHVybiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCk7XG59XG5cbmZ1bmN0aW9uIHVpZCgpIHtcbiAgLy8gY3J5cHRvLnJhbmRvbVVVSUQg5Zyo5a6J5YWo5LiK5LiL5paH6YeM5Y+v55So77yb5LiN5Y+v55So5pe26YCA5YyW5Li65pe26Ze05oiz5Yqg6ZqP5py65pWw44CCXG4gIHRyeSB7XG4gICAgaWYgKHR5cGVvZiBjcnlwdG8gIT09ICd1bmRlZmluZWQnICYmIGNyeXB0byAmJiB0eXBlb2YgY3J5cHRvLnJhbmRvbVVVSUQgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgIHJldHVybiBjcnlwdG8ucmFuZG9tVVVJRCgpO1xuICAgIH1cbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgLyog5b+955Wl77ya5LiL6Z2i6L+Y5pyJ5YWc5bqVICovXG4gIH1cbiAgcmV0dXJuICdpZC0nICsgRGF0ZS5ub3coKS50b1N0cmluZygzNikgKyAnLScgKyBNYXRoLnJhbmRvbSgpLnRvU3RyaW5nKDM2KS5zbGljZSgyLCAxMCk7XG59XG5cbmZ1bmN0aW9uIG1ha2VMYW5lKG5hbWUpIHtcbiAgcmV0dXJuIHsgaWQ6IHVpZCgpLCBuYW1lOiBuYW1lLCBjb2xsYXBzZWQ6IGZhbHNlLCBjcmVhdGVkQXQ6IG5vd0lzbygpIH07XG59XG5cbmZ1bmN0aW9uIGRlZmF1bHRMYW5lcygpIHtcbiAgdmFyIGxhbmVzID0gW107XG4gIGZvciAodmFyIGkgPSAwOyBpIDwgREVGQVVMVF9MQU5FUy5sZW5ndGg7IGkgKz0gMSkgbGFuZXMucHVzaChtYWtlTGFuZShERUZBVUxUX0xBTkVTW2ldKSk7XG4gIHJldHVybiBsYW5lcztcbn1cblxuZnVuY3Rpb24gZGVmYXVsdEJvYXJkKCkge1xuICByZXR1cm4ge1xuICAgIHNjaGVtYVZlcnNpb246IFNDSEVNQV9WRVJTSU9OLFxuICAgIHJldjogMCxcbiAgICB1cGRhdGVkQXQ6IG5vd0lzbygpLFxuICAgIGxhbmVzOiBkZWZhdWx0TGFuZXMoKSxcbiAgICBjYXJkczoge30sXG4gIH07XG59XG5cbmZ1bmN0aW9uIGlzUGxhaW5PYmplY3QodmFsdWUpIHtcbiAgcmV0dXJuICEhdmFsdWUgJiYgdHlwZW9mIHZhbHVlID09PSAnb2JqZWN0JyAmJiAhQXJyYXkuaXNBcnJheSh2YWx1ZSk7XG59XG5cbmZ1bmN0aW9uIHRleHQodmFsdWUpIHtcbiAgcmV0dXJuIHR5cGVvZiB2YWx1ZSA9PT0gJ3N0cmluZycgPyB2YWx1ZSA6ICcnO1xufVxuXG5mdW5jdGlvbiBpc0RhdGVLZXkodmFsdWUpIHtcbiAgcmV0dXJuIC9eXFxkezR9LVxcZHsyfS1cXGR7Mn0kLy50ZXN0KHZhbHVlKTtcbn1cblxuLyoqIOmAoOS4gOW8oOWNoeeJh+OAgumUruS4jiBpZCDlv4XpobvmmK/lkIzkuIDkuKrlgLwg4oCU4oCUIOWQpuWImeaMiSBpZCDmn6XkuI3liLDlroPvvIznvJbovpHkuI7liKDpmaTkvJrpnZnpu5jlpLHmlYjjgIIgKi9cbmZ1bmN0aW9uIG1ha2VDYXJkKGxhbmVJZCwgdGl0bGUsIG9yZGVyKSB7XG4gIHZhciBpZCA9IHVpZCgpO1xuICByZXR1cm4ge1xuICAgIGlkOiBpZCxcbiAgICBsYW5lSWQ6IGxhbmVJZCxcbiAgICB0aXRsZTogdGl0bGUsXG4gICAgbm90ZTogJycsXG4gICAgcHJpb3JpdHk6ICdub3JtYWwnLFxuICAgIGR1ZTogbnVsbCxcbiAgICByZWN1cnJlbmNlOiBudWxsLFxuICAgIGRvbmU6IGZhbHNlLFxuICAgIG9yZGVyOiB0eXBlb2Ygb3JkZXIgPT09ICdudW1iZXInID8gb3JkZXIgOiAxLFxuICAgIGNyZWF0ZWRBdDogbm93SXNvKCksXG4gICAgdXBkYXRlZEF0OiBub3dJc28oKSxcbiAgICBjb21wbGV0ZWRBdDogbnVsbCxcbiAgfTtcbn1cblxuLyoqXG4gKiDmioror7vliLDnmoTmlbDmja7mlbTnkIbmiJDlj6/nlKjnmoTnnIvmnb/jgIJcbiAqXG4gKiBgY3R4LnN0b3JhZ2UuZ2V0YCDmnKzouqvkvJrmjZXojrcgSlNPTiDop6PmnpDplJnor6/lubbov5Tlm57pu5jorqTlgLzvvIzkvYblrZfmrrXnvLrlpLHjgIHnsbvlnovkuI3lr7njgIFcbiAqIOWNoeeJh+W8leeUqOS6huW3suS4jeWtmOWcqOeahOWIl+ihqOi/meS6m+aDheWGteS7jeimgeiHquW3seWFnOS9jyDigJTigJQg55So5oi355qE5pWw5o2u5Y+q5pyJ5LiA5Lu977yMXG4gKiDor7vlnY/kuIDmrKHlsLHnrYnkuo7lhajkuKLjgIJcbiAqL1xuZnVuY3Rpb24gbm9ybWFsaXplQm9hcmQocmF3KSB7XG4gIGlmICghaXNQbGFpbk9iamVjdChyYXcpKSByZXR1cm4geyBib2FyZDogZGVmYXVsdEJvYXJkKCksIG5vdGVzOiBbXSB9O1xuXG4gIHZhciBub3RlcyA9IFtdO1xuICB2YXIgdmVyc2lvbiA9IHR5cGVvZiByYXcuc2NoZW1hVmVyc2lvbiA9PT0gJ251bWJlcicgPyByYXcuc2NoZW1hVmVyc2lvbiA6IFNDSEVNQV9WRVJTSU9OO1xuICBpZiAodmVyc2lvbiA+IFNDSEVNQV9WRVJTSU9OKSB7XG4gICAgbm90ZXMucHVzaCgn6L+Z5Lu95pWw5o2u5p2l6Ieq5pu05paw54mI5pys55qE55yL5p2/5o+S5Lu277yM5pys54mI5pys5Y+q6K+75Y+W44CB5LiN5YaZ5YWl77yM5Lul5YWN6KaG55uW44CCJyk7XG4gIH1cblxuICB2YXIgbGFuZUlkcyA9IHt9O1xuICB2YXIgcmF3TGFuZXMgPSBBcnJheS5pc0FycmF5KHJhdy5sYW5lcykgPyByYXcubGFuZXMgOiBbXTtcbiAgdmFyIGxhbmVzID0gW107XG5cbiAgZm9yICh2YXIgaSA9IDA7IGkgPCByYXdMYW5lcy5sZW5ndGg7IGkgKz0gMSkge1xuICAgIHZhciBpdGVtID0gcmF3TGFuZXNbaV07XG4gICAgaWYgKCFpc1BsYWluT2JqZWN0KGl0ZW0pIHx8ICF0ZXh0KGl0ZW0uaWQpIHx8IGxhbmVJZHNbaXRlbS5pZF0pIGNvbnRpbnVlO1xuICAgIGxhbmVJZHNbaXRlbS5pZF0gPSB0cnVlO1xuICAgIGxhbmVzLnB1c2goe1xuICAgICAgaWQ6IGl0ZW0uaWQsXG4gICAgICBuYW1lOiB0ZXh0KGl0ZW0ubmFtZSkuc2xpY2UoMCwgTEFORV9OQU1FX01BWCkgfHwgJ+acquWRveWQjeWIl+ihqCcsXG4gICAgICBjb2xsYXBzZWQ6ICEhaXRlbS5jb2xsYXBzZWQsXG4gICAgICBjcmVhdGVkQXQ6IHRleHQoaXRlbS5jcmVhdGVkQXQpIHx8IG5vd0lzbygpLFxuICAgIH0pO1xuICB9XG5cbiAgaWYgKGxhbmVzLmxlbmd0aCA9PT0gMCkge1xuICAgIGxhbmVzID0gZGVmYXVsdExhbmVzKCk7XG4gICAgbGFuZUlkcyA9IHt9O1xuICAgIGZvciAodmFyIGsgPSAwOyBrIDwgbGFuZXMubGVuZ3RoOyBrICs9IDEpIGxhbmVJZHNbbGFuZXNba10uaWRdID0gdHJ1ZTtcbiAgICBpZiAocmF3TGFuZXMubGVuZ3RoID4gMCkgbm90ZXMucHVzaCgn5YiX6KGo57uT5p6E5peg5rOV6K+G5Yir77yM5bey6YeN572u5Li66buY6K6k55qE5LiJ5Liq5YiX6KGo44CCJyk7XG4gIH1cblxuICB2YXIgcmF3Q2FyZHMgPSBpc1BsYWluT2JqZWN0KHJhdy5jYXJkcykgPyByYXcuY2FyZHMgOiB7fTtcbiAgdmFyIGNhcmRzID0ge307XG4gIHZhciBkcm9wcGVkID0gMDtcbiAgdmFyIGlkcyA9IE9iamVjdC5rZXlzKHJhd0NhcmRzKTtcblxuICBmb3IgKHZhciBqID0gMDsgaiA8IGlkcy5sZW5ndGg7IGogKz0gMSkge1xuICAgIHZhciBpZCA9IGlkc1tqXTtcbiAgICB2YXIgY2FyZCA9IHJhd0NhcmRzW2lkXTtcbiAgICBpZiAoIWlzUGxhaW5PYmplY3QoY2FyZCkpIHtcbiAgICAgIGRyb3BwZWQgKz0gMTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICAvLyDplK7kuI7lhoXpg6ggaWQg5LiN5LiA6Ie05pe25Lul6ZSu5Li65YeG5bm25L+u5q2jIGlk77ya5pep5pyf54mI5pys5YaZ6L+H6L+Z56eN5pWw5o2u77yMXG4gICAgLy8g5LiN5L+u5q2j55qE6K+d6L+Z5Lqb5Y2h54mH5Zyo55WM6Z2i5LiK54K55LiN5Yqo44CCXG4gICAgdmFyIGNhcmRJZCA9IHRleHQoY2FyZC5pZCkgfHwgaWQ7XG4gICAgaWYgKGNhcmRJZCAhPT0gaWQpIGRyb3BwZWQgKz0gMDsgLy8g6Z2Z6buY5L+u5q2j77yM5LiN5omT5omw55So5oi3XG4gICAgaWYgKCFsYW5lSWRzW2NhcmQubGFuZUlkXSkge1xuICAgICAgZHJvcHBlZCArPSAxOyAvLyDlvJXnlKjkuI3lrZjlnKjnmoTliJfooajvvJrlroHlj6/lsJHkuIDlvKDvvIzkuZ/kuI3opoHmuLLmn5PkuIDkuKrngrnkuI3liLDnmoTljaHniYdcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICB2YXIgZG9uZSA9ICEhY2FyZC5kb25lO1xuICAgIHZhciByZWN1cnJlbmNlID1cbiAgICAgIGNhcmQucmVjdXJyZW5jZSA9PT0gJ2RhaWx5JyB8fCBjYXJkLnJlY3VycmVuY2UgPT09ICd3ZWVrbHknIHx8IGNhcmQucmVjdXJyZW5jZSA9PT0gJ21vbnRobHknXG4gICAgICAgID8gY2FyZC5yZWN1cnJlbmNlXG4gICAgICAgIDogbnVsbDtcbiAgICBjYXJkc1tpZF0gPSB7XG4gICAgICBpZDogaWQsXG4gICAgICBsYW5lSWQ6IGNhcmQubGFuZUlkLFxuICAgICAgdGl0bGU6IHRleHQoY2FyZC50aXRsZSkuc2xpY2UoMCwgQ0FSRF9USVRMRV9NQVgpIHx8ICfmnKrlkb3lkI3ljaHniYcnLFxuICAgICAgbm90ZTogdGV4dChjYXJkLm5vdGUpLnNsaWNlKDAsIENBUkRfTk9URV9NQVgpLFxuICAgICAgcHJpb3JpdHk6IGNhcmQucHJpb3JpdHkgPT09ICdsb3cnIHx8IGNhcmQucHJpb3JpdHkgPT09ICdoaWdoJyA/IGNhcmQucHJpb3JpdHkgOiAnbm9ybWFsJyxcbiAgICAgIGR1ZTogaXNEYXRlS2V5KHRleHQoY2FyZC5kdWUpKSA/IGNhcmQuZHVlIDogbnVsbCxcbiAgICAgIHJlY3VycmVuY2U6IHJlY3VycmVuY2UsXG4gICAgICBkb25lOiBkb25lLFxuICAgICAgb3JkZXI6IHR5cGVvZiBjYXJkLm9yZGVyID09PSAnbnVtYmVyJyAmJiBpc0Zpbml0ZShjYXJkLm9yZGVyKSA/IGNhcmQub3JkZXIgOiAwLFxuICAgICAgY3JlYXRlZEF0OiB0ZXh0KGNhcmQuY3JlYXRlZEF0KSB8fCBub3dJc28oKSxcbiAgICAgIHVwZGF0ZWRBdDogdGV4dChjYXJkLnVwZGF0ZWRBdCkgfHwgbm93SXNvKCksXG4gICAgICBjb21wbGV0ZWRBdDogZG9uZSA/IHRleHQoY2FyZC5jb21wbGV0ZWRBdCkgfHwgbm93SXNvKCkgOiBudWxsLFxuICAgIH07XG4gIH1cblxuICBpZiAoZHJvcHBlZCA+IDApIG5vdGVzLnB1c2goJ+aciSAnICsgZHJvcHBlZCArICcg5byg5Y2h54mH55qE5pWw5o2u5LiN5a6M5pW077yM5bey6Lez6L+H44CCJyk7XG5cbiAgcmV0dXJuIHtcbiAgICBib2FyZDoge1xuICAgICAgc2NoZW1hVmVyc2lvbjogTWF0aC5tYXgodmVyc2lvbiwgU0NIRU1BX1ZFUlNJT04pLFxuICAgICAgcmV2OiB0eXBlb2YgcmF3LnJldiA9PT0gJ251bWJlcicgJiYgaXNGaW5pdGUocmF3LnJldikgPyByYXcucmV2IDogMCxcbiAgICAgIHVwZGF0ZWRBdDogdGV4dChyYXcudXBkYXRlZEF0KSB8fCBub3dJc28oKSxcbiAgICAgIGxhbmVzOiBsYW5lcyxcbiAgICAgIGNhcmRzOiBjYXJkcyxcbiAgICB9LFxuICAgIG5vdGVzOiBub3RlcyxcbiAgfTtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplUHJlZnMocmF3KSB7XG4gIGlmICghaXNQbGFpbk9iamVjdChyYXcpKSByZXR1cm4geyBub3RpZnk6IHRydWUgfTtcbiAgcmV0dXJuIHsgbm90aWZ5OiByYXcubm90aWZ5ICE9PSBmYWxzZSB9O1xufVxuXG5mdW5jdGlvbiBjYXJkc0luTGFuZShib2FyZCwgbGFuZUlkKSB7XG4gIHZhciByZXN1bHQgPSBbXTtcbiAgdmFyIGlkcyA9IE9iamVjdC5rZXlzKGJvYXJkLmNhcmRzKTtcbiAgZm9yICh2YXIgaSA9IDA7IGkgPCBpZHMubGVuZ3RoOyBpICs9IDEpIHtcbiAgICBpZiAoYm9hcmQuY2FyZHNbaWRzW2ldXS5sYW5lSWQgPT09IGxhbmVJZCkgcmVzdWx0LnB1c2goYm9hcmQuY2FyZHNbaWRzW2ldXSk7XG4gIH1cbiAgcmVzdWx0LnNvcnQoZnVuY3Rpb24gKGEsIGIpIHtcbiAgICB2YXIgYnlPcmRlciA9IGEub3JkZXIgLSBiLm9yZGVyO1xuICAgIGlmIChieU9yZGVyICE9PSAwKSByZXR1cm4gYnlPcmRlcjtcbiAgICBpZiAoYS5jcmVhdGVkQXQgIT09IGIuY3JlYXRlZEF0KSByZXR1cm4gYS5jcmVhdGVkQXQgPCBiLmNyZWF0ZWRBdCA/IC0xIDogMTtcbiAgICByZXR1cm4gYS5pZCA8IGIuaWQgPyAtMSA6IDE7XG4gIH0pO1xuICByZXR1cm4gcmVzdWx0O1xufVxuXG5mdW5jdGlvbiBuZXh0T3JkZXIoYm9hcmQsIGxhbmVJZCkge1xuICB2YXIgbGlzdCA9IGNhcmRzSW5MYW5lKGJvYXJkLCBsYW5lSWQpO1xuICByZXR1cm4gbGlzdC5sZW5ndGggPT09IDAgPyAxIDogbGlzdFtsaXN0Lmxlbmd0aCAtIDFdLm9yZGVyICsgMTtcbn1cblxuZnVuY3Rpb24gbGFuZUJ5SWQoYm9hcmQsIGxhbmVJZCkge1xuICBmb3IgKHZhciBpID0gMDsgaSA8IGJvYXJkLmxhbmVzLmxlbmd0aDsgaSArPSAxKSB7XG4gICAgaWYgKGJvYXJkLmxhbmVzW2ldLmlkID09PSBsYW5lSWQpIHJldHVybiBib2FyZC5sYW5lc1tpXTtcbiAgfVxuICByZXR1cm4gbnVsbDtcbn1cblxuZnVuY3Rpb24gbGFuZUluZGV4QnlJZChib2FyZCwgbGFuZUlkKSB7XG4gIGZvciAodmFyIGkgPSAwOyBpIDwgYm9hcmQubGFuZXMubGVuZ3RoOyBpICs9IDEpIHtcbiAgICBpZiAoYm9hcmQubGFuZXNbaV0uaWQgPT09IGxhbmVJZCkgcmV0dXJuIGk7XG4gIH1cbiAgcmV0dXJuIC0xO1xufVxuXG5mdW5jdGlvbiBsYW5lTmFtZU9mKGJvYXJkLCBsYW5lSWQpIHtcbiAgdmFyIGZvdW5kID0gbGFuZUJ5SWQoYm9hcmQsIGxhbmVJZCk7XG4gIHJldHVybiBmb3VuZCA/IGZvdW5kLm5hbWUgOiAn5bey5Yig6Zmk55qE5YiX6KGoJztcbn1cblxuLyoqIOWPmOabtOWQjue7n+S4gOaOqOi/m+eJiOacrOWPt+S4juaXtumXtOaIs++8jOS+v+S6juS4pOS4quWunuS+i+avlOWvueOAjOiwgeeahOaVsOaNruabtOaWsOOAjeOAgiAqL1xuZnVuY3Rpb24gdG91Y2hCb2FyZChib2FyZCkge1xuICBib2FyZC5yZXYgPSAodHlwZW9mIGJvYXJkLnJldiA9PT0gJ251bWJlcicgPyBib2FyZC5yZXYgOiAwKSArIDE7XG4gIGJvYXJkLnVwZGF0ZWRBdCA9IG5vd0lzbygpO1xuICByZXR1cm4gYm9hcmQ7XG59XG5cbi8qKlxuICog5oqK5LiA5byg5Y2h54mH5pS+5Yiw55uu5qCH5YiX6KGo6YeMIGBiZWZvcmVgIOS4jiBgYWZ0ZXJgIOS4pOW8oOWNoeeJh+S5i+mXtOOAglxuICpcbiAqIOeUqOmCu+WNoeiAjOS4jeaYr+WPr+ingeS4i+agh+adpeWumuS9je+8jOaYr+WboOS4uueVjOmdouS4iueahOmhuuW6j+S4jeetieS6juaVsOe7hOmhuuW6j++8muaYvuekuumhuuW6j+i/mOimgeaMiVxuICog44CM5pyq5a6M5oiQIOKGkiDkvJjlhYjnuqcg4oaSIOaIquatouaXpeOAjemHjeaOkuOAguWPquS8oOS4i+agh+eahOivne+8jOS4gOasoeaLluWKqOWPr+iDveiQveWcqOWujOWFqOS4jeWQjOeahOS9jee9riDigJTigJRcbiAqIOeUqOaIt+eci+WIsOeahOeOsOixoeWwseaYr+OAjOaLluS6huayoeWPjeW6lOOAjeOAgui/memHjOaKiuaNoueul+aUvuWcqOS4gOWkhO+8jOiuqeiQveS9jeS4juaMh+ekuue6v+awuOi/nOS4gOiHtOOAglxuICovXG5mdW5jdGlvbiBtb3ZlQ2FyZFB1cmUoYm9hcmQsIGNhcmRJZCwgdGFyZ2V0TGFuZUlkLCBiZWZvcmVJZCwgYWZ0ZXJJZCkge1xuICB2YXIgY2FyZCA9IGJvYXJkLmNhcmRzW2NhcmRJZF07XG4gIGlmICghY2FyZCB8fCAhbGFuZUJ5SWQoYm9hcmQsIHRhcmdldExhbmVJZCkpIHJldHVybiBib2FyZDtcblxuICB2YXIgbmV4dCA9IGNsb25lKGJvYXJkKTtcbiAgdmFyIHNvdXJjZSA9IG5leHQuY2FyZHNbY2FyZElkXTtcbiAgdmFyIHRhcmdldCA9IGxhbmVCeUlkKG5leHQsIHRhcmdldExhbmVJZCk7XG4gIHZhciBiZWZvcmUgPSBiZWZvcmVJZCAmJiBiZWZvcmVJZCAhPT0gY2FyZElkID8gbmV4dC5jYXJkc1tiZWZvcmVJZF0gOiBudWxsO1xuICB2YXIgYWZ0ZXIgPSBhZnRlcklkICYmIGFmdGVySWQgIT09IGNhcmRJZCA/IG5leHQuY2FyZHNbYWZ0ZXJJZF0gOiBudWxsO1xuXG4gIHZhciBvcmRlcjtcbiAgaWYgKGJlZm9yZSkgb3JkZXIgPSBiZWZvcmUub3JkZXIgKyAxO1xuICBlbHNlIGlmIChhZnRlcikgb3JkZXIgPSBhZnRlci5vcmRlciAtIDE7XG4gIGVsc2Ugb3JkZXIgPSBuZXh0T3JkZXIobmV4dCwgdGFyZ2V0TGFuZUlkKTtcbiAgaWYgKGJlZm9yZSAmJiBhZnRlciAmJiBvcmRlciA+PSBhZnRlci5vcmRlcikgb3JkZXIgPSAoYmVmb3JlLm9yZGVyICsgYWZ0ZXIub3JkZXIpIC8gMjtcblxuICB2YXIgbGFuZUNoYW5nZWQgPSBzb3VyY2UubGFuZUlkICE9PSB0YXJnZXRMYW5lSWQ7XG4gIHNvdXJjZS5vcmRlciA9IG9yZGVyO1xuICBzb3VyY2UubGFuZUlkID0gdGFyZ2V0TGFuZUlkO1xuICBzb3VyY2UudXBkYXRlZEF0ID0gbm93SXNvKCk7XG5cbiAgaWYgKGxhbmVDaGFuZ2VkICYmIHRhcmdldCAmJiB0YXJnZXQubmFtZS5pbmRleE9mKExBTkVfQVVUT19ET05FKSA+PSAwICYmICFzb3VyY2UuZG9uZSkge1xuICAgIHNvdXJjZS5kb25lID0gdHJ1ZTtcbiAgICBzb3VyY2UuY29tcGxldGVkQXQgPSBub3dJc28oKTtcbiAgfVxuXG4gIHJldHVybiB0b3VjaEJvYXJkKG5leHQpO1xufVxuXG4vKiog5oqK5YiX6KGo5pW05L2T5oyq5Yiw5Y+m5LiA5Liq5L2N572u77yI5ouW5Yqo5YiX6KGo5oiW6I+c5Y2V6YeM55qE44CM5bem56e7IC8g5Y+z56e744CN6YO96LWw6L+Z6YeM77yJ44CCICovXG5mdW5jdGlvbiBtb3ZlTGFuZVB1cmUoYm9hcmQsIGxhbmVJZCwgdGFyZ2V0SW5kZXgpIHtcbiAgdmFyIGZyb20gPSBsYW5lSW5kZXhCeUlkKGJvYXJkLCBsYW5lSWQpO1xuICBpZiAoZnJvbSA8IDApIHJldHVybiBib2FyZDtcbiAgdmFyIHRvID0gdHlwZW9mIHRhcmdldEluZGV4ID09PSAnbnVtYmVyJyA/IHRhcmdldEluZGV4IDogZnJvbTtcbiAgaWYgKHRvIDwgMCkgdG8gPSAwO1xuICBpZiAodG8gPiBib2FyZC5sYW5lcy5sZW5ndGggLSAxKSB0byA9IGJvYXJkLmxhbmVzLmxlbmd0aCAtIDE7XG4gIGlmICh0byA9PT0gZnJvbSkgcmV0dXJuIGJvYXJkO1xuXG4gIHZhciBuZXh0ID0gY2xvbmUoYm9hcmQpO1xuICB2YXIgbW92ZWQgPSBuZXh0LmxhbmVzLnNwbGljZShmcm9tLCAxKVswXTtcbiAgbmV4dC5sYW5lcy5zcGxpY2UodG8sIDAsIG1vdmVkKTtcbiAgcmV0dXJuIHRvdWNoQm9hcmQobmV4dCk7XG59XG5cbmV4cG9ydCB7IGNhcmRzSW5MYW5lLCBjbG9uZSwgZGVmYXVsdEJvYXJkLCBkZWZhdWx0TGFuZXMsIGlzRGF0ZUtleSwgaXNQbGFpbk9iamVjdCwgbGFuZUJ5SWQsIGxhbmVJbmRleEJ5SWQsIGxhbmVOYW1lT2YsIG1ha2VDYXJkLCBtYWtlTGFuZSwgbW92ZUNhcmRQdXJlLCBtb3ZlTGFuZVB1cmUsIG5leHRPcmRlciwgbm9ybWFsaXplQm9hcmQsIG5vcm1hbGl6ZVByZWZzLCBub3dJc28sIHRleHQsIHRvdWNoQm9hcmQsIHVpZCB9O1xuIiwgIi8vIOS7jiBwbHVnaW5zL2thbmJhbi9pbmRleC5qcyDmi4blh7og4oCU4oCUICoq6YC76L6R5Y6f5qC35pCs6L+Q77yM5pyq5YGa5Lu75L2V5pS55YqoKirjgIJcbi8vIOaQrOi/kOaYr+acuuaisOeahO+8muavj+Wdl+eahOS9jee9ruS4juWGheWuuemDveayoeWPmO+8jOWPquaYr+ihpeS4iuS6hiBpbXBvcnQgLyBleHBvcnTjgIJcbmltcG9ydCB7IFBSSU9SSVRZX09SREVSIH0gZnJvbSAnLi9lbnYnO1xuaW1wb3J0IHsgdGV4dCB9IGZyb20gJy4vbW9kZWwnO1xuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIOaXpeacn+S4jumHjeWkjVxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmZ1bmN0aW9uIHBhZDIodmFsdWUpIHtcbiAgcmV0dXJuICh2YWx1ZSA8IDEwID8gJzAnIDogJycpICsgdmFsdWU7XG59XG5cbmZ1bmN0aW9uIGRhdGVLZXkoZGF0ZSkge1xuICByZXR1cm4gZGF0ZS5nZXRGdWxsWWVhcigpICsgJy0nICsgcGFkMihkYXRlLmdldE1vbnRoKCkgKyAxKSArICctJyArIHBhZDIoZGF0ZS5nZXREYXRlKCkpO1xufVxuXG5mdW5jdGlvbiBwYXJzZURhdGVLZXkoa2V5KSB7XG4gIHZhciBwYXJ0cyA9IHRleHQoa2V5KS5zcGxpdCgnLScpO1xuICBpZiAocGFydHMubGVuZ3RoICE9PSAzKSByZXR1cm4gbnVsbDtcbiAgdmFyIGRhdGUgPSBuZXcgRGF0ZShOdW1iZXIocGFydHNbMF0pLCBOdW1iZXIocGFydHNbMV0pIC0gMSwgTnVtYmVyKHBhcnRzWzJdKSk7XG4gIHJldHVybiBpc05hTihkYXRlLmdldFRpbWUoKSkgPyBudWxsIDogZGF0ZTtcbn1cblxuZnVuY3Rpb24gdG9kYXlLZXkoKSB7XG4gIHJldHVybiBkYXRlS2V5KG5ldyBEYXRlKCkpO1xufVxuXG5mdW5jdGlvbiBhZGREYXlzKGtleSwgZGF5cykge1xuICB2YXIgZGF0ZSA9IHBhcnNlRGF0ZUtleShrZXkpIHx8IG5ldyBEYXRlKCk7XG4gIGRhdGUuc2V0RGF0ZShkYXRlLmdldERhdGUoKSArIGRheXMpO1xuICByZXR1cm4gZGF0ZUtleShkYXRlKTtcbn1cblxuLyoqIOS4i+S4gOS4quWRqOacq++8iOWRqOWFre+8ieOAguW3sue7j+WIsOWRqOacq+Wwsei/lOWbnuacrOWRqOWFreOAgiAqL1xuZnVuY3Rpb24gbmV4dFdlZWtlbmRLZXkoKSB7XG4gIHZhciBkYXRlID0gbmV3IERhdGUoKTtcbiAgdmFyIGRheSA9IGRhdGUuZ2V0RGF5KCk7IC8vIDAgPSDlkajml6VcbiAgZGF0ZS5zZXREYXRlKGRhdGUuZ2V0RGF0ZSgpICsgKCg2IC0gZGF5ICsgNykgJSA3KSk7XG4gIHJldHVybiBkYXRlS2V5KGRhdGUpO1xufVxuXG4vKiog5LiL5ZGo5LiA44CCICovXG5mdW5jdGlvbiBuZXh0TW9uZGF5S2V5KCkge1xuICB2YXIgZGF0ZSA9IG5ldyBEYXRlKCk7XG4gIHZhciBkYXkgPSBkYXRlLmdldERheSgpO1xuICBkYXRlLnNldERhdGUoZGF0ZS5nZXREYXRlKCkgKyAoKDggLSBkYXkpICUgNyB8fCA3KSk7XG4gIHJldHVybiBkYXRlS2V5KGRhdGUpO1xufVxuXG4vKiog5a6M5oiQ5LiA5byg6YeN5aSN5Y2h54mH5pe277yM566X5Ye65a6D55qE5LiL5LiA5qyh5pel5pyf44CC5oyJ44CM5b2T5YmN5pel5pyf44CN5o6o6L+b77yM6YG/5YWN6YC+5pyf5aSq5LmF56ev5Y6L5Ye65LiA5Liy6L+H5Y675pel5pyf44CCICovXG5mdW5jdGlvbiBuZXh0UmVjdXJyZW5jZUR1ZShjdXJyZW50RHVlLCByZWN1cnJlbmNlKSB7XG4gIHZhciBiYXNlID0gcGFyc2VEYXRlS2V5KGN1cnJlbnREdWUpO1xuICB2YXIgdG9kYXkgPSBuZXcgRGF0ZSgpO1xuICBpZiAoIWJhc2UgfHwgYmFzZS5nZXRUaW1lKCkgPCBuZXcgRGF0ZSh0b2RheS5nZXRGdWxsWWVhcigpLCB0b2RheS5nZXRNb250aCgpLCB0b2RheS5nZXREYXRlKCkpLmdldFRpbWUoKSkge1xuICAgIGJhc2UgPSB0b2RheTtcbiAgfVxuICB2YXIgbmV4dCA9IG5ldyBEYXRlKGJhc2UuZ2V0RnVsbFllYXIoKSwgYmFzZS5nZXRNb250aCgpLCBiYXNlLmdldERhdGUoKSk7XG4gIGlmIChyZWN1cnJlbmNlID09PSAnZGFpbHknKSB7XG4gICAgbmV4dC5zZXREYXRlKG5leHQuZ2V0RGF0ZSgpICsgMSk7XG4gIH0gZWxzZSBpZiAocmVjdXJyZW5jZSA9PT0gJ3dlZWtseScpIHtcbiAgICBuZXh0LnNldERhdGUobmV4dC5nZXREYXRlKCkgKyA3KTtcbiAgfSBlbHNlIGlmIChyZWN1cnJlbmNlID09PSAnbW9udGhseScpIHtcbiAgICB2YXIgYW5jaG9yID0gcGFyc2VEYXRlS2V5KGN1cnJlbnREdWUpIHx8IHRvZGF5O1xuICAgIHZhciBkYXkgPSBhbmNob3IuZ2V0RGF0ZSgpO1xuICAgIHZhciB5ZWFyID0gYmFzZS5nZXRGdWxsWWVhcigpO1xuICAgIHZhciBtb250aCA9IGJhc2UuZ2V0TW9udGgoKSArIDE7XG4gICAgaWYgKG1vbnRoID4gMTEpIHtcbiAgICAgIG1vbnRoID0gMDtcbiAgICAgIHllYXIgKz0gMTtcbiAgICB9XG4gICAgdmFyIGxhc3REYXkgPSBuZXcgRGF0ZSh5ZWFyLCBtb250aCArIDEsIDApLmdldERhdGUoKTtcbiAgICBuZXh0ID0gbmV3IERhdGUoeWVhciwgbW9udGgsIE1hdGgubWluKGRheSwgbGFzdERheSkpO1xuICB9XG4gIHJldHVybiBkYXRlS2V5KG5leHQpO1xufVxuXG5mdW5jdGlvbiBkdWVJbmZvKGR1ZSwgZG9uZSkge1xuICBpZiAoIWR1ZSkgcmV0dXJuIG51bGw7XG4gIGlmIChkb25lKSByZXR1cm4geyB0ZXh0OiBkdWUsIHRvbmU6ICdkb25lJyB9O1xuXG4gIHZhciB0b2RheSA9IHRvZGF5S2V5KCk7XG4gIGlmIChkdWUgPT09IHRvZGF5KSByZXR1cm4geyB0ZXh0OiAn5LuK5aSp5Yiw5pyfJywgdG9uZTogJ3RvZGF5JyB9O1xuXG4gIHZhciBkYXlzID0gTWF0aC5yb3VuZChcbiAgICAoKHBhcnNlRGF0ZUtleShkdWUpIHx8IG5ldyBEYXRlKCkpLmdldFRpbWUoKSAtIChwYXJzZURhdGVLZXkodG9kYXkpIHx8IG5ldyBEYXRlKCkpLmdldFRpbWUoKSkgLyA4NjQwMDAwMFxuICApO1xuICBpZiAoZGF5cyA8IDApIHJldHVybiB7IHRleHQ6ICfpgL7mnJ8gJyArIE1hdGguYWJzKGRheXMpICsgJyDlpKknLCB0b25lOiAnb3ZlcmR1ZScgfTtcbiAgaWYgKGRheXMgPT09IDEpIHJldHVybiB7IHRleHQ6ICfmmI7lpKnliLDmnJ8nLCB0b25lOiAnc29vbicgfTtcbiAgaWYgKGRheXMgPD0gNikgcmV0dXJuIHsgdGV4dDogZGF5cyArICcg5aSp5ZCOJywgdG9uZTogJ3Nvb24nIH07XG4gIHJldHVybiB7IHRleHQ6ICfmiKrmraIgJyArIGR1ZS5zbGljZSg1KSwgdG9uZTogJ25vcm1hbCcgfTtcbn1cblxuZnVuY3Rpb24gZm9ybWF0RGF0ZVRpbWUoaXNvKSB7XG4gIGlmICghaXNvKSByZXR1cm4gJyc7XG4gIHZhciB2YWx1ZSA9IG5ldyBEYXRlKGlzbyk7XG4gIGlmIChpc05hTih2YWx1ZS5nZXRUaW1lKCkpKSByZXR1cm4gJyc7XG4gIHJldHVybiAoXG4gICAgdmFsdWUuZ2V0RnVsbFllYXIoKSArICctJyArIHBhZDIodmFsdWUuZ2V0TW9udGgoKSArIDEpICsgJy0nICsgcGFkMih2YWx1ZS5nZXREYXRlKCkpICtcbiAgICAnICcgKyBwYWQyKHZhbHVlLmdldEhvdXJzKCkpICsgJzonICsgcGFkMih2YWx1ZS5nZXRNaW51dGVzKCkpXG4gICk7XG59XG5cbmZ1bmN0aW9uIGlzT3ZlcmR1ZShjYXJkLCB0b2RheSkge1xuICByZXR1cm4gISFjYXJkLmR1ZSAmJiAhY2FyZC5kb25lICYmIGNhcmQuZHVlIDwgdG9kYXk7XG59XG5cbmZ1bmN0aW9uIG1hdGNoZXNRdWVyeShjYXJkLCBxdWVyeSkge1xuICBpZiAoIXF1ZXJ5KSByZXR1cm4gdHJ1ZTtcbiAgdmFyIG5lZWRsZSA9IHF1ZXJ5LnRvTG93ZXJDYXNlKCk7XG4gIHJldHVybiBjYXJkLnRpdGxlLnRvTG93ZXJDYXNlKCkuaW5kZXhPZihuZWVkbGUpID49IDAgfHwgY2FyZC5ub3RlLnRvTG93ZXJDYXNlKCkuaW5kZXhPZihuZWVkbGUpID49IDA7XG59XG5cbi8qKlxuICog5pi+56S66aG65bqP77ya5pyq5a6M5oiQ5LyY5YWIIOKGkiDkvJjlhYjnuqcg4oaSIOaIquatouaXpe+8iOaXoOaIquatouaXpeaOkuacgOWQju+8ieKGkiDmiYvliqjpobrluo/jgIJcbiAqIOaLluWKqOWPquWcqOOAjOWQjOS4gOS8mOWFiOe6p+OAgeWQjOS4gOaIquatouaXpeOAjeeahOWNoeeJh+S5i+mXtOaUueWPmOmhuuW6j++8jOingeaWh+S7tuWktOeahOivtOaYjuOAglxuICovXG5mdW5jdGlvbiBzb3J0Q2FyZHMobGlzdCkge1xuICByZXR1cm4gbGlzdC5zbGljZSgpLnNvcnQoZnVuY3Rpb24gKGEsIGIpIHtcbiAgICBpZiAoYS5kb25lICE9PSBiLmRvbmUpIHJldHVybiBhLmRvbmUgPyAxIDogLTE7XG4gICAgdmFyIGJ5UHJpb3JpdHkgPSBQUklPUklUWV9PUkRFUlthLnByaW9yaXR5XSAtIFBSSU9SSVRZX09SREVSW2IucHJpb3JpdHldO1xuICAgIGlmIChieVByaW9yaXR5ICE9PSAwKSByZXR1cm4gYnlQcmlvcml0eTtcbiAgICBpZiAoYS5kdWUgJiYgYi5kdWUpIHtcbiAgICAgIGlmIChhLmR1ZSAhPT0gYi5kdWUpIHJldHVybiBhLmR1ZSA8IGIuZHVlID8gLTEgOiAxO1xuICAgIH0gZWxzZSBpZiAoYS5kdWUgfHwgYi5kdWUpIHtcbiAgICAgIHJldHVybiBhLmR1ZSA/IC0xIDogMTtcbiAgICB9XG4gICAgaWYgKGEub3JkZXIgIT09IGIub3JkZXIpIHJldHVybiBhLm9yZGVyIC0gYi5vcmRlcjtcbiAgICBpZiAoYS5jcmVhdGVkQXQgIT09IGIuY3JlYXRlZEF0KSByZXR1cm4gYS5jcmVhdGVkQXQgPCBiLmNyZWF0ZWRBdCA/IC0xIDogMTtcbiAgICByZXR1cm4gYS5pZCA8IGIuaWQgPyAtMSA6IDE7XG4gIH0pO1xufVxuXG5leHBvcnQgeyBhZGREYXlzLCBkYXRlS2V5LCBkdWVJbmZvLCBmb3JtYXREYXRlVGltZSwgaXNPdmVyZHVlLCBtYXRjaGVzUXVlcnksIG5leHRNb25kYXlLZXksIG5leHRSZWN1cnJlbmNlRHVlLCBuZXh0V2Vla2VuZEtleSwgcGFkMiwgcGFyc2VEYXRlS2V5LCBzb3J0Q2FyZHMsIHRvZGF5S2V5IH07XG4iLCAiLy8g5LuOIHBsdWdpbnMva2FuYmFuL2luZGV4LmpzIOaLhuWHuiDigJTigJQgKirpgLvovpHljp/moLfmkKzov5DvvIzmnKrlgZrku7vkvZXmlLnliqgqKuOAglxuLy8g5pCs6L+Q5piv5py65qKw55qE77ya5q+P5Z2X55qE5L2N572u5LiO5YaF5a656YO95rKh5Y+Y77yM5Y+q5piv6KGl5LiK5LqGIGltcG9ydCAvIGV4cG9ydOOAglxuaW1wb3J0IHsgaCB9IGZyb20gJy4vZW52JztcblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyDlm77moIfvvJrlhoXogZQgU1ZH77yM5LiN5byV5YWl5Zu+5qCH5bqTXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuZnVuY3Rpb24gaWNvbihzaXplLCBjaGlsZHJlbikge1xuICByZXR1cm4gaChcbiAgICAnc3ZnJyxcbiAgICB7XG4gICAgICB2aWV3Qm94OiAnMCAwIDI0IDI0JyxcbiAgICAgIHdpZHRoOiBzaXplLFxuICAgICAgaGVpZ2h0OiBzaXplLFxuICAgICAgZmlsbDogJ25vbmUnLFxuICAgICAgc3Ryb2tlOiAnY3VycmVudENvbG9yJyxcbiAgICAgIHN0cm9rZVdpZHRoOiAxLjgsXG4gICAgICBzdHJva2VMaW5lY2FwOiAncm91bmQnLFxuICAgICAgc3Ryb2tlTGluZWpvaW46ICdyb3VuZCcsXG4gICAgICAnYXJpYS1oaWRkZW4nOiAndHJ1ZScsXG4gICAgICBmb2N1c2FibGU6ICdmYWxzZScsXG4gICAgfSxcbiAgICBjaGlsZHJlblxuICApO1xufVxuXG52YXIgaWNvbnMgPSB7XG4gIHBsdXM6IGZ1bmN0aW9uIChzaXplKSB7XG4gICAgcmV0dXJuIGljb24oc2l6ZSB8fCAxNiwgW2goJ3BhdGgnLCB7IGtleTogJ2EnLCBkOiAnTTEyIDV2MTQnIH0pLCBoKCdwYXRoJywgeyBrZXk6ICdiJywgZDogJ001IDEyaDE0JyB9KV0pO1xuICB9LFxuICBzZWFyY2g6IGZ1bmN0aW9uICgpIHtcbiAgICByZXR1cm4gaWNvbigxNSwgW1xuICAgICAgaCgnY2lyY2xlJywgeyBrZXk6ICdhJywgY3g6IDExLCBjeTogMTEsIHI6IDcgfSksXG4gICAgICBoKCdwYXRoJywgeyBrZXk6ICdiJywgZDogJ00yMCAyMGwtMy42LTMuNicgfSksXG4gICAgXSk7XG4gIH0sXG4gIGdyaXA6IGZ1bmN0aW9uIChzaXplKSB7XG4gICAgcmV0dXJuIGljb24oc2l6ZSB8fCAxNCwgW2goJ3BhdGgnLCB7IGtleTogJ2EnLCBkOiAnTTkgNmguMDFNOSAxMmguMDFNOSAxOGguMDFNMTUgNmguMDFNMTUgMTJoLjAxTTE1IDE4aC4wMScgfSldKTtcbiAgfSxcbiAgcGVuY2lsOiBmdW5jdGlvbiAoKSB7XG4gICAgcmV0dXJuIGljb24oMTQsIFtoKCdwYXRoJywgeyBrZXk6ICdhJywgZDogJ000IDIwaDRMMTggMTBsLTQtNEw0IDE2djR6JyB9KSwgaCgncGF0aCcsIHsga2V5OiAnYicsIGQ6ICdNMTMuNSA2LjVsNCA0JyB9KV0pO1xuICB9LFxuICBhcnJvd1JpZ2h0OiBmdW5jdGlvbiAoKSB7XG4gICAgcmV0dXJuIGljb24oMTQsIFtoKCdwYXRoJywgeyBrZXk6ICdhJywgZDogJ001IDEyaDE0JyB9KSwgaCgncGF0aCcsIHsga2V5OiAnYicsIGQ6ICdNMTMgNmw2IDYtNiA2JyB9KV0pO1xuICB9LFxuICBhcnJvd0xlZnQ6IGZ1bmN0aW9uICgpIHtcbiAgICByZXR1cm4gaWNvbigxNCwgW2goJ3BhdGgnLCB7IGtleTogJ2EnLCBkOiAnTTE5IDEySDUnIH0pLCBoKCdwYXRoJywgeyBrZXk6ICdiJywgZDogJ00xMSA2bC02IDYgNiA2JyB9KV0pO1xuICB9LFxuICB0cmFzaDogZnVuY3Rpb24gKCkge1xuICAgIHJldHVybiBpY29uKDE0LCBbXG4gICAgICBoKCdwYXRoJywgeyBrZXk6ICdhJywgZDogJ000IDdoMTYnIH0pLFxuICAgICAgaCgncGF0aCcsIHsga2V5OiAnYicsIGQ6ICdNNyA3bDEgMTNoOGwxLTEzJyB9KSxcbiAgICAgIGgoJ3BhdGgnLCB7IGtleTogJ2MnLCBkOiAnTTkgN1Y0aDZ2MycgfSksXG4gICAgXSk7XG4gIH0sXG4gIGNoZWNrOiBmdW5jdGlvbiAoKSB7XG4gICAgcmV0dXJuIGljb24oMTQsIFtoKCdwYXRoJywgeyBrZXk6ICdhJywgZDogJ001IDEzbDQgNEwxOSA3JyB9KV0pO1xuICB9LFxuICB1bmRvOiBmdW5jdGlvbiAoKSB7XG4gICAgcmV0dXJuIGljb24oMTQsIFtoKCdwYXRoJywgeyBrZXk6ICdhJywgZDogJ005IDE0TDQgOWw1LTUnIH0pLCBoKCdwYXRoJywgeyBrZXk6ICdiJywgZDogJ000IDloMTBhNiA2IDAgMCAxIDAgMTJoLTMnIH0pXSk7XG4gIH0sXG4gIGNhbGVuZGFyOiBmdW5jdGlvbiAoc2l6ZSkge1xuICAgIHJldHVybiBpY29uKHNpemUgfHwgMTMsIFtcbiAgICAgIGgoJ3JlY3QnLCB7IGtleTogJ2EnLCB4OiAzLjUsIHk6IDUsIHdpZHRoOiAxNywgaGVpZ2h0OiAxNSwgcng6IDIgfSksXG4gICAgICBoKCdwYXRoJywgeyBrZXk6ICdiJywgZDogJ004IDN2NE0xNiAzdjRNMy41IDEwaDE3JyB9KSxcbiAgICBdKTtcbiAgfSxcbiAgcmVwZWF0OiBmdW5jdGlvbiAoc2l6ZSkge1xuICAgIHJldHVybiBpY29uKHNpemUgfHwgMTMsIFtcbiAgICAgIGgoJ3BhdGgnLCB7IGtleTogJ2EnLCBkOiAnTTQgOWgxMWE0IDQgMCAwIDEgMCA4SDcnIH0pLFxuICAgICAgaCgncGF0aCcsIHsga2V5OiAnYicsIGQ6ICdNNyA1TDMgOWw0IDQnIH0pLFxuICAgIF0pO1xuICB9LFxuICBub3RlOiBmdW5jdGlvbiAoc2l6ZSkge1xuICAgIHJldHVybiBpY29uKHNpemUgfHwgMTMsIFtoKCdwYXRoJywgeyBrZXk6ICdhJywgZDogJ001IDVoMTRNNSAxMGgxNE01IDE1aDknIH0pXSk7XG4gIH0sXG4gIGJlbGw6IGZ1bmN0aW9uIChzaXplKSB7XG4gICAgcmV0dXJuIGljb24oc2l6ZSB8fCAxNCwgW1xuICAgICAgaCgncGF0aCcsIHsga2V5OiAnYScsIGQ6ICdNNiA5YTYgNiAwIDEgMSAxMiAwYzAgNCAxLjUgNS41IDIgNkg0Yy41LS41IDItMiAyLTZ6JyB9KSxcbiAgICAgIGgoJ3BhdGgnLCB7IGtleTogJ2InLCBkOiAnTTEwIDE5YTIgMiAwIDAgMCA0IDAnIH0pLFxuICAgIF0pO1xuICB9LFxuICBiZWxsT2ZmOiBmdW5jdGlvbiAoc2l6ZSkge1xuICAgIHJldHVybiBpY29uKHNpemUgfHwgMTQsIFtcbiAgICAgIGgoJ3BhdGgnLCB7IGtleTogJ2EnLCBkOiAnTTggNi4zQTYgNiAwIDAgMSAxOCA5YzAgMS42LjMgMi44LjcgMy43JyB9KSxcbiAgICAgIGgoJ3BhdGgnLCB7IGtleTogJ2InLCBkOiAnTTYgOS42QzUuOCAxMi40IDQuNiAxNCA0IDE1aDExJyB9KSxcbiAgICAgIGgoJ3BhdGgnLCB7IGtleTogJ2MnLCBkOiAnTTQgNGwxNiAxNicgfSksXG4gICAgXSk7XG4gIH0sXG4gIGNsb3NlOiBmdW5jdGlvbiAoKSB7XG4gICAgcmV0dXJuIGljb24oMTYsIFtoKCdwYXRoJywgeyBrZXk6ICdhJywgZDogJ002IDZsMTIgMTInIH0pLCBoKCdwYXRoJywgeyBrZXk6ICdiJywgZDogJ00xOCA2TDYgMTgnIH0pXSk7XG4gIH0sXG4gIGluYm94OiBmdW5jdGlvbiAoc2l6ZSkge1xuICAgIHJldHVybiBpY29uKHNpemUgfHwgMTQsIFtcbiAgICAgIGgoJ3BhdGgnLCB7IGtleTogJ2EnLCBkOiAnTTQgMTNsMi03aDEybDIgN3Y2SDR6JyB9KSxcbiAgICAgIGgoJ3BhdGgnLCB7IGtleTogJ2InLCBkOiAnTTQgMTNoNWwxIDJoNGwxLTJoNScgfSksXG4gICAgXSk7XG4gIH0sXG4gIGNvbHVtbnM6IGZ1bmN0aW9uIChzaXplKSB7XG4gICAgcmV0dXJuIGljb24oc2l6ZSB8fCAxNCwgW1xuICAgICAgaCgncmVjdCcsIHsga2V5OiAnYScsIHg6IDMsIHk6IDUsIHdpZHRoOiA3LCBoZWlnaHQ6IDE0LCByeDogMS42IH0pLFxuICAgICAgaCgncmVjdCcsIHsga2V5OiAnYicsIHg6IDE0LCB5OiA1LCB3aWR0aDogNywgaGVpZ2h0OiAxNCwgcng6IDEuNiB9KSxcbiAgICBdKTtcbiAgfSxcbiAgbW9yZTogZnVuY3Rpb24gKHNpemUpIHtcbiAgICByZXR1cm4gaWNvbihzaXplIHx8IDE0LCBbXG4gICAgICBoKCdwYXRoJywgeyBrZXk6ICdhJywgZDogJ00xMiA2aC4wMU0xMiAxMmguMDFNMTIgMThoLjAxJyB9KSxcbiAgICBdKTtcbiAgfSxcbn07XG5cbmV4cG9ydCB7IGljb24sIGljb25zIH07XG4iLCAiLy8g5LuOIHBsdWdpbnMva2FuYmFuL2luZGV4LmpzIOaLhuWHuiDigJTigJQgKirpgLvovpHljp/moLfmkKzov5DvvIzmnKrlgZrku7vkvZXmlLnliqgqKuOAglxuLy8g5pCs6L+Q5piv5py65qKw55qE77ya5q+P5Z2X55qE5L2N572u5LiO5YaF5a656YO95rKh5Y+Y77yM5Y+q5piv6KGl5LiK5LqGIGltcG9ydCAvIGV4cG9ydOOAglxuaW1wb3J0IHsgYWRkRGF5cywgbmV4dE1vbmRheUtleSwgbmV4dFdlZWtlbmRLZXksIHRvZGF5S2V5IH0gZnJvbSAnLi9kYXRlcyc7XG5pbXBvcnQgeyBoLCB1c2VFZmZlY3QsIHVzZVJlZiwgdXNlU3RhdGUsIHVzZVN5bmNFeHRlcm5hbFN0b3JlIH0gZnJvbSAnLi9lbnYnO1xuaW1wb3J0IHsgaWNvbiwgaWNvbnMgfSBmcm9tICcuL2ljb25zJztcbmltcG9ydCB7IHRleHQgfSBmcm9tICcuL21vZGVsJztcbmltcG9ydCB7IHJlbG9hZCwgc2F2ZU5vdywgc3RvcmUgfSBmcm9tICcuL3N0b3JlJztcblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyDlsI/nu4Tku7Zcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5mdW5jdGlvbiBJY29uQnV0dG9uKHByb3BzKSB7XG4gIHJldHVybiBoKFxuICAgICdidXR0b24nLFxuICAgIHtcbiAgICAgIHR5cGU6ICdidXR0b24nLFxuICAgICAgY2xhc3NOYW1lOlxuICAgICAgICAna2FuYmFuX19pY29uLWJ0bicgK1xuICAgICAgICAocHJvcHMudG9uZSA9PT0gJ2RhbmdlcicgPyAnIGthbmJhbl9faWNvbi1idG4tLWRhbmdlcicgOiAnJykgK1xuICAgICAgICAocHJvcHMuYWN0aXZlID8gJyBpcy1hY3RpdmUnIDogJycpICtcbiAgICAgICAgKHByb3BzLmdyaXAgPyAnIGthbmJhbl9faWNvbi1idG4tLWdyaXAnIDogJycpLFxuICAgICAgJ2FyaWEtbGFiZWwnOiBwcm9wcy5sYWJlbCxcbiAgICAgIHRpdGxlOiBwcm9wcy50aXRsZSB8fCBwcm9wcy5sYWJlbCxcbiAgICAgICdhcmlhLXByZXNzZWQnOiBwcm9wcy5wcmVzc2VkLFxuICAgICAgZGlzYWJsZWQ6IHByb3BzLmRpc2FibGVkLFxuICAgICAgb25DbGljazogcHJvcHMub25DbGljayxcbiAgICAgIG9uUG9pbnRlckRvd246IHByb3BzLm9uUG9pbnRlckRvd24sXG4gICAgfSxcbiAgICBwcm9wcy5jaGlsZHJlblxuICApO1xufVxuXG4vKipcbiAqIOS4gOS4quW4puOAjOeCueWklumdouWFs+mXrSAvIEVzYyDlhbPpl63jgI3nmoTlsI/kuIvmi4noj5zljZXjgIJcbiAqIOaKveWHuuadpeaYr+WboOS4uuW3peWFt+agj+WSjOavj+S4quWIl+ihqOmDveimgeeUqO+8jOaJi+WGmeS4iemBjeW/heeEtuS4ieS7veihjOS4uuS4jeS4gOiHtOOAglxuICovXG5mdW5jdGlvbiBNZW51KHByb3BzKSB7XG4gIHZhciBvcGVuU3RhdGUgPSB1c2VTdGF0ZShmYWxzZSk7XG4gIHZhciBvcGVuID0gb3BlblN0YXRlWzBdO1xuICB2YXIgc2V0T3BlbiA9IG9wZW5TdGF0ZVsxXTtcbiAgdmFyIHdyYXBSZWYgPSB1c2VSZWYobnVsbCk7XG5cbiAgdXNlRWZmZWN0KGZ1bmN0aW9uICgpIHtcbiAgICBpZiAoIW9wZW4pIHJldHVybiB1bmRlZmluZWQ7XG4gICAgZnVuY3Rpb24gb25Qb2ludGVyRG93bihldmVudCkge1xuICAgICAgaWYgKHdyYXBSZWYuY3VycmVudCAmJiB3cmFwUmVmLmN1cnJlbnQuY29udGFpbnMoZXZlbnQudGFyZ2V0KSkgcmV0dXJuO1xuICAgICAgc2V0T3BlbihmYWxzZSk7XG4gICAgfVxuICAgIGZ1bmN0aW9uIG9uS2V5RG93bihldmVudCkge1xuICAgICAgaWYgKGV2ZW50LmtleSA9PT0gJ0VzY2FwZScpIHNldE9wZW4oZmFsc2UpO1xuICAgIH1cbiAgICAvLyDlu7blkI7kuIDluKflho3mjILnm5HlkKzvvJrlkKbliJnop6blj5Hoj5zljZXmiZPlvIDnmoTpgqPkuIDmrKEgcG9pbnRlcmRvd24g5Lya56uL5Yi75oqK5a6D5YWz5o6JXG4gICAgdmFyIHRpbWVyID0gc2V0VGltZW91dChmdW5jdGlvbiAoKSB7XG4gICAgICB3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcigncG9pbnRlcmRvd24nLCBvblBvaW50ZXJEb3duKTtcbiAgICAgIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKCdrZXlkb3duJywgb25LZXlEb3duKTtcbiAgICB9LCAwKTtcbiAgICByZXR1cm4gZnVuY3Rpb24gKCkge1xuICAgICAgY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgICAgIHdpbmRvdy5yZW1vdmVFdmVudExpc3RlbmVyKCdwb2ludGVyZG93bicsIG9uUG9pbnRlckRvd24pO1xuICAgICAgd2luZG93LnJlbW92ZUV2ZW50TGlzdGVuZXIoJ2tleWRvd24nLCBvbktleURvd24pO1xuICAgIH07XG4gIH0sIFtvcGVuXSk7XG5cbiAgcmV0dXJuIGgoXG4gICAgJ2RpdicsXG4gICAgeyBjbGFzc05hbWU6ICdrYW5iYW5fX21lbnUtd3JhcCcsIHJlZjogd3JhcFJlZiB9LFxuICAgIGgoXG4gICAgICAnYnV0dG9uJyxcbiAgICAgIHtcbiAgICAgICAgdHlwZTogJ2J1dHRvbicsXG4gICAgICAgIGNsYXNzTmFtZTogcHJvcHMudHJpZ2dlckNsYXNzIHx8ICdrYW5iYW5fX2ljb24tYnRuJyxcbiAgICAgICAgJ2FyaWEtaGFzcG9wdXAnOiAnbWVudScsXG4gICAgICAgICdhcmlhLWV4cGFuZGVkJzogb3BlbixcbiAgICAgICAgJ2FyaWEtbGFiZWwnOiBwcm9wcy5sYWJlbCxcbiAgICAgICAgdGl0bGU6IHByb3BzLnRpdGxlIHx8IHByb3BzLmxhYmVsLFxuICAgICAgICBvbkNsaWNrOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgc2V0T3Blbighb3Blbik7XG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgICAgcHJvcHMudHJpZ2dlclxuICAgICksXG4gICAgb3BlblxuICAgICAgPyBoKFxuICAgICAgICAgICdkaXYnLFxuICAgICAgICAgIHsgY2xhc3NOYW1lOiAna2FuYmFuX19tZW51Jywgcm9sZTogJ21lbnUnLCAnYXJpYS1sYWJlbCc6IHByb3BzLmxhYmVsIH0sXG4gICAgICAgICAgdHlwZW9mIHByb3BzLmNoaWxkcmVuID09PSAnZnVuY3Rpb24nID8gcHJvcHMuY2hpbGRyZW4oZnVuY3Rpb24gKCkgeyBzZXRPcGVuKGZhbHNlKTsgfSkgOiBwcm9wcy5jaGlsZHJlblxuICAgICAgICApXG4gICAgICA6IG51bGxcbiAgKTtcbn1cblxuZnVuY3Rpb24gTWVudUl0ZW0ocHJvcHMpIHtcbiAgcmV0dXJuIGgoXG4gICAgJ2J1dHRvbicsXG4gICAge1xuICAgICAgdHlwZTogJ2J1dHRvbicsXG4gICAgICByb2xlOiAnbWVudWl0ZW0nLFxuICAgICAgY2xhc3NOYW1lOiAna2FuYmFuX19tZW51LWl0ZW0nICsgKHByb3BzLmRhbmdlciA/ICcga2FuYmFuX19tZW51LWl0ZW0tLWRhbmdlcicgOiAnJyksXG4gICAgICBkaXNhYmxlZDogcHJvcHMuZGlzYWJsZWQsXG4gICAgICBvbkNsaWNrOiBwcm9wcy5vbkNsaWNrLFxuICAgIH0sXG4gICAgcHJvcHMuY2hpbGRyZW5cbiAgKTtcbn1cblxuZnVuY3Rpb24gRXJyb3JCYW5uZXIoKSB7XG4gIHZhciBzdGF0ZSA9IHVzZVN5bmNFeHRlcm5hbFN0b3JlKHN0b3JlLnN1YnNjcmliZSwgc3RvcmUuZ2V0U25hcHNob3QsIHN0b3JlLmdldFNuYXBzaG90KTtcblxuICBpZiAoc3RhdGUuc3RhdHVzID09PSAnZXJyb3InKSB7XG4gICAgcmV0dXJuIGgoXG4gICAgICAnZGl2JyxcbiAgICAgIHsgY2xhc3NOYW1lOiAna2FuYmFuX19iYW5uZXIga2FuYmFuX19iYW5uZXItLWVycm9yJywgcm9sZTogJ2FsZXJ0JyB9LFxuICAgICAgaCgnc3BhbicsIHsgY2xhc3NOYW1lOiAna2FuYmFuX19iYW5uZXItdGV4dCcgfSwgc3RhdGUuZXJyb3JNZXNzYWdlKSxcbiAgICAgIGgoJ2J1dHRvbicsIHsgdHlwZTogJ2J1dHRvbicsIGNsYXNzTmFtZTogJ2thbmJhbl9fYnRuIGthbmJhbl9fYnRuLS1naG9zdCcsIG9uQ2xpY2s6IHJlbG9hZCB9LCAn6YeN5paw6K+75Y+WJylcbiAgICApO1xuICB9XG4gIGlmIChzdGF0ZS5zdGF0dXMgPT09ICdyZWFkeScgJiYgc3RhdGUuc2F2ZVN0YXRlID09PSAnZXJyb3InKSB7XG4gICAgcmV0dXJuIGgoXG4gICAgICAnZGl2JyxcbiAgICAgIHsgY2xhc3NOYW1lOiAna2FuYmFuX19iYW5uZXIga2FuYmFuX19iYW5uZXItLWVycm9yJywgcm9sZTogJ2FsZXJ0JyB9LFxuICAgICAgaCgnc3BhbicsIHsgY2xhc3NOYW1lOiAna2FuYmFuX19iYW5uZXItdGV4dCcgfSwgc3RhdGUuc2F2ZUVycm9yKSxcbiAgICAgIGgoXG4gICAgICAgICdidXR0b24nLFxuICAgICAgICB7XG4gICAgICAgICAgdHlwZTogJ2J1dHRvbicsXG4gICAgICAgICAgY2xhc3NOYW1lOiAna2FuYmFuX19idG4ga2FuYmFuX19idG4tLWdob3N0JyxcbiAgICAgICAgICBvbkNsaWNrOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICBzYXZlTm93KCfmiYvliqjph43or5UnKTtcbiAgICAgICAgICB9LFxuICAgICAgICB9LFxuICAgICAgICAn6YeN6K+V5L+d5a2YJ1xuICAgICAgKVxuICAgICk7XG4gIH1cbiAgaWYgKHN0YXRlLnN0YXR1cyA9PT0gJ3JlYWR5JyAmJiBzdGF0ZS5ub3Rlcy5sZW5ndGggPiAwKSB7XG4gICAgcmV0dXJuIGgoXG4gICAgICAnZGl2JyxcbiAgICAgIHsgY2xhc3NOYW1lOiAna2FuYmFuX19iYW5uZXIga2FuYmFuX19iYW5uZXItLXdhcm4nLCByb2xlOiAnc3RhdHVzJyB9LFxuICAgICAgaCgnc3BhbicsIHsgY2xhc3NOYW1lOiAna2FuYmFuX19iYW5uZXItdGV4dCcgfSwgc3RhdGUubm90ZXMuam9pbignICcpKVxuICAgICk7XG4gIH1cbiAgcmV0dXJuIG51bGw7XG59XG5cbi8qKiDpgJ/orrDkuI7nnIvmnb/lkIToh6rmnInoh6rlt7HnmoTkv53lrZjoioLlpY/vvIzov5nph4zmiorkuKTogIXnmoTnirbmgIHlkIjotbfmnaXmmL7npLrjgIIgKi9cbmZ1bmN0aW9uIFNhdmVJbmRpY2F0b3IocHJvcHMpIHtcbiAgdmFyIHN0YXRlID0gdXNlU3luY0V4dGVybmFsU3RvcmUoc3RvcmUuc3Vic2NyaWJlLCBzdG9yZS5nZXRTbmFwc2hvdCwgc3RvcmUuZ2V0U25hcHNob3QpO1xuICBpZiAoc3RhdGUuc3RhdHVzICE9PSAncmVhZHknKSByZXR1cm4gbnVsbDtcblxuICB2YXIgbGFiZWwgPSAn6Ieq5Yqo5L+d5a2YJztcbiAgdmFyIHRvbmUgPSAnaXMtbXV0ZWQnO1xuICBpZiAocHJvcHMuZHJhZnRTdGF0ZSA9PT0gJ2Vycm9yJyB8fCBzdGF0ZS5zYXZlU3RhdGUgPT09ICdlcnJvcicpIHtcbiAgICBsYWJlbCA9ICfmnInmlLnliqjmsqHkv53lrZgnO1xuICAgIHRvbmUgPSAnaXMtZGFuZ2VyJztcbiAgfSBlbHNlIGlmIChwcm9wcy5kcmFmdFN0YXRlID09PSAnc2F2aW5nJyB8fCBzdGF0ZS5zYXZlU3RhdGUgPT09ICdzYXZpbmcnKSB7XG4gICAgbGFiZWwgPSAn5q2j5Zyo5L+d5a2Y4oCmJztcbiAgfSBlbHNlIGlmIChwcm9wcy5kcmFmdFN0YXRlID09PSAnc2F2ZWQnIHx8IHN0YXRlLnNhdmVTdGF0ZSA9PT0gJ3NhdmVkJykge1xuICAgIGxhYmVsID0gJ+W3suS/neWtmCc7XG4gICAgdG9uZSA9ICdpcy1vayc7XG4gIH1cbiAgcmV0dXJuIGgoXG4gICAgJ3NwYW4nLFxuICAgIHsgY2xhc3NOYW1lOiAna2FuYmFuX19zYXZlICcgKyB0b25lLCByb2xlOiAnc3RhdHVzJywgJ2FyaWEtbGl2ZSc6ICdwb2xpdGUnIH0sXG4gICAgdG9uZSA9PT0gJ2lzLW9rJyA/IGljb25zLmNoZWNrKCkgOiBudWxsLFxuICAgIGxhYmVsXG4gICk7XG59XG5cbi8qKlxuICog5pel5pyf6YCJ5oup44CC5Y6f55Sf5pel5Y6G5pys6Lqr5aW955So77yM6Zeu6aKY5Zyo44CM6K6+5oiq5q2i5pel44CN6L+Z5Lu25LqL55qE6buY6K6k6Lev5b6E5aSq57uV77yaXG4gKiDlhYjngrnlvIDml6XljobjgIHlho3lnKjmnIjljobph4zmib7ku4rlpKnjgILlm6DmraTluLjnlKjml6XmnJ/lgZrmiJDkuIDmraXlj6/ovr7nmoTmjInpkq7vvIxcbiAqIOecn+ato+mcgOimgee/u+aciOeahOaDheWGteS7jeeEtueUqOWOn+eUn+aXpeWOhuOAglxuICovXG5mdW5jdGlvbiBEYXRlUGlja2VyKHByb3BzKSB7XG4gIHZhciBxdWljayA9IFtcbiAgICB7IGxhYmVsOiAn5LuK5aSpJywgdmFsdWU6IHRvZGF5S2V5KCkgfSxcbiAgICB7IGxhYmVsOiAn5piO5aSpJywgdmFsdWU6IGFkZERheXModG9kYXlLZXkoKSwgMSkgfSxcbiAgICB7IGxhYmVsOiAn5pys5ZGo5pyrJywgdmFsdWU6IG5leHRXZWVrZW5kS2V5KCkgfSxcbiAgICB7IGxhYmVsOiAn5LiL5ZGo5LiAJywgdmFsdWU6IG5leHRNb25kYXlLZXkoKSB9LFxuICBdO1xuICB2YXIgY3VycmVudCA9IHByb3BzLnZhbHVlIHx8ICcnO1xuXG4gIHJldHVybiBoKFxuICAgICdkaXYnLFxuICAgIHsgY2xhc3NOYW1lOiAna2FuYmFuX19kYXRlcGljaycgfSxcbiAgICBoKFxuICAgICAgJ2RpdicsXG4gICAgICB7IGNsYXNzTmFtZTogJ2thbmJhbl9fcXVpY2snIH0sXG4gICAgICBxdWljay5tYXAoZnVuY3Rpb24gKGl0ZW0pIHtcbiAgICAgICAgcmV0dXJuIGgoXG4gICAgICAgICAgJ2J1dHRvbicsXG4gICAgICAgICAge1xuICAgICAgICAgICAga2V5OiBpdGVtLmxhYmVsLFxuICAgICAgICAgICAgdHlwZTogJ2J1dHRvbicsXG4gICAgICAgICAgICBjbGFzc05hbWU6ICdrYW5iYW5fX3F1aWNrLWJ0bicgKyAoY3VycmVudCA9PT0gaXRlbS52YWx1ZSA/ICcgaXMtYWN0aXZlJyA6ICcnKSxcbiAgICAgICAgICAgICdhcmlhLXByZXNzZWQnOiBjdXJyZW50ID09PSBpdGVtLnZhbHVlLFxuICAgICAgICAgICAgb25DbGljazogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICBwcm9wcy5vbkNoYW5nZShjdXJyZW50ID09PSBpdGVtLnZhbHVlID8gbnVsbCA6IGl0ZW0udmFsdWUpO1xuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9LFxuICAgICAgICAgIGl0ZW0ubGFiZWxcbiAgICAgICAgKTtcbiAgICAgIH0pLFxuICAgICAgaChcbiAgICAgICAgJ2J1dHRvbicsXG4gICAgICAgIHtcbiAgICAgICAgICB0eXBlOiAnYnV0dG9uJyxcbiAgICAgICAgICBjbGFzc05hbWU6ICdrYW5iYW5fX3F1aWNrLWJ0bicgKyAocHJvcHMudmFsdWUgPyAnJyA6ICcgaXMtYWN0aXZlJyksXG4gICAgICAgICAgb25DbGljazogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgcHJvcHMub25DaGFuZ2UobnVsbCk7XG4gICAgICAgICAgfSxcbiAgICAgICAgfSxcbiAgICAgICAgJ+S4jeiuvidcbiAgICAgIClcbiAgICApLFxuICAgIGgoXG4gICAgICAnZGl2JyxcbiAgICAgIHsgY2xhc3NOYW1lOiAna2FuYmFuX19kYXRlcGljay1yb3cnIH0sXG4gICAgICBoKCdzcGFuJywgeyBjbGFzc05hbWU6ICdrYW5iYW5fX2RhdGVwaWNrLWljb24nLCAnYXJpYS1oaWRkZW4nOiAndHJ1ZScgfSwgaWNvbnMuY2FsZW5kYXIoMTQpKSxcbiAgICAgIGgoJ2lucHV0Jywge1xuICAgICAgICB0eXBlOiAnZGF0ZScsXG4gICAgICAgIGNsYXNzTmFtZTogJ2thbmJhbl9faW5wdXQga2FuYmFuX19pbnB1dC0tZGF0ZScsXG4gICAgICAgIHZhbHVlOiBjdXJyZW50LFxuICAgICAgICAnYXJpYS1sYWJlbCc6ICfoh6rpgInmiKrmraLml6UnLFxuICAgICAgICBvbkNoYW5nZTogZnVuY3Rpb24gKGV2ZW50KSB7XG4gICAgICAgICAgcHJvcHMub25DaGFuZ2UoZXZlbnQudGFyZ2V0LnZhbHVlIHx8IG51bGwpO1xuICAgICAgICB9LFxuICAgICAgfSksXG4gICAgICBjdXJyZW50XG4gICAgICAgID8gaChcbiAgICAgICAgICAgICdidXR0b24nLFxuICAgICAgICAgICAge1xuICAgICAgICAgICAgICB0eXBlOiAnYnV0dG9uJyxcbiAgICAgICAgICAgICAgY2xhc3NOYW1lOiAna2FuYmFuX19idG4ga2FuYmFuX19idG4tLWdob3N0IGthbmJhbl9fYnRuLS10aWdodCcsXG4gICAgICAgICAgICAgIG9uQ2xpY2s6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICBwcm9wcy5vbkNoYW5nZShhZGREYXlzKGN1cnJlbnQsIDEpKTtcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAn6aG65bu25LiA5aSpJ1xuICAgICAgICAgIClcbiAgICAgICAgOiBudWxsXG4gICAgKVxuICApO1xufVxuXG5mdW5jdGlvbiBSZWN1cnJlbmNlU2VsZWN0KHByb3BzKSB7XG4gIHJldHVybiBoKFxuICAgICdzZWxlY3QnLFxuICAgIHtcbiAgICAgIGNsYXNzTmFtZTogJ2thbmJhbl9fc2VsZWN0JyxcbiAgICAgIHZhbHVlOiBwcm9wcy52YWx1ZSB8fCAnJyxcbiAgICAgICdhcmlhLWxhYmVsJzogJ+mHjeWkjScsXG4gICAgICBvbkNoYW5nZTogZnVuY3Rpb24gKGV2ZW50KSB7XG4gICAgICAgIHByb3BzLm9uQ2hhbmdlKGV2ZW50LnRhcmdldC52YWx1ZSB8fCBudWxsKTtcbiAgICAgIH0sXG4gICAgfSxcbiAgICBoKCdvcHRpb24nLCB7IHZhbHVlOiAnJyB9LCAn5LiN6YeN5aSNJyksXG4gICAgaCgnb3B0aW9uJywgeyB2YWx1ZTogJ2RhaWx5JyB9LCAn5q+P5aSpJyksXG4gICAgaCgnb3B0aW9uJywgeyB2YWx1ZTogJ3dlZWtseScgfSwgJ+avj+WRqCcpLFxuICAgIGgoJ29wdGlvbicsIHsgdmFsdWU6ICdtb250aGx5JyB9LCAn5q+P5pyIJylcbiAgKTtcbn1cblxuZXhwb3J0IHsgRGF0ZVBpY2tlciwgRXJyb3JCYW5uZXIsIEljb25CdXR0b24sIE1lbnUsIE1lbnVJdGVtLCBSZWN1cnJlbmNlU2VsZWN0LCBTYXZlSW5kaWNhdG9yIH07XG4iLCAiLy8g5LuOIHBsdWdpbnMva2FuYmFuL2luZGV4LmpzIOaLhuWHuiDigJTigJQgKirpgLvovpHljp/moLfmkKzov5DvvIzmnKrlgZrku7vkvZXmlLnliqgqKuOAglxuLy8g5pCs6L+Q5piv5py65qKw55qE77ya5q+P5Z2X55qE5L2N572u5LiO5YaF5a656YO95rKh5Y+Y77yM5Y+q5piv6KGl5LiK5LqGIGltcG9ydCAvIGV4cG9ydOOAglxuaW1wb3J0IHsgZHVlSW5mbywgZm9ybWF0RGF0ZVRpbWUgfSBmcm9tICcuL2RhdGVzJztcbmltcG9ydCB7IENBUkRfTk9URV9NQVgsIENBUkRfVElUTEVfTUFYLCBEVUVfQ0xBU1MsIFJFQ1VSUkVOQ0VfTEFCRUwsIGgsIHVzZUVmZmVjdCwgdXNlUmVmLCB1c2VTdGF0ZSB9IGZyb20gJy4vZW52JztcbmltcG9ydCB7IGljb25zIH0gZnJvbSAnLi9pY29ucyc7XG5pbXBvcnQgeyB0ZXh0IH0gZnJvbSAnLi9tb2RlbCc7XG5pbXBvcnQgeyBEYXRlUGlja2VyLCBJY29uQnV0dG9uLCBSZWN1cnJlbmNlU2VsZWN0IH0gZnJvbSAnLi91aSc7XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8g5Y2h54mH57yW6L6R5ZmoXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuZnVuY3Rpb24gQ2FyZEVkaXRvcihwcm9wcykge1xuICB2YXIgY2FyZCA9IHByb3BzLmNhcmQ7XG4gIHZhciB0aXRsZVN0YXRlID0gdXNlU3RhdGUoY2FyZC50aXRsZSk7XG4gIHZhciB0aXRsZSA9IHRpdGxlU3RhdGVbMF07XG4gIHZhciBzZXRUaXRsZSA9IHRpdGxlU3RhdGVbMV07XG5cbiAgdmFyIG5vdGVTdGF0ZSA9IHVzZVN0YXRlKGNhcmQubm90ZSk7XG4gIHZhciBub3RlID0gbm90ZVN0YXRlWzBdO1xuICB2YXIgc2V0Tm90ZSA9IG5vdGVTdGF0ZVsxXTtcblxuICB2YXIgcHJpb3JpdHlTdGF0ZSA9IHVzZVN0YXRlKGNhcmQucHJpb3JpdHkpO1xuICB2YXIgcHJpb3JpdHkgPSBwcmlvcml0eVN0YXRlWzBdO1xuICB2YXIgc2V0UHJpb3JpdHkgPSBwcmlvcml0eVN0YXRlWzFdO1xuXG4gIHZhciBkdWVTdGF0ZSA9IHVzZVN0YXRlKGNhcmQuZHVlIHx8IG51bGwpO1xuICB2YXIgZHVlID0gZHVlU3RhdGVbMF07XG4gIHZhciBzZXREdWUgPSBkdWVTdGF0ZVsxXTtcblxuICB2YXIgcmVjdXJyZW5jZVN0YXRlID0gdXNlU3RhdGUoY2FyZC5yZWN1cnJlbmNlIHx8IG51bGwpO1xuICB2YXIgcmVjdXJyZW5jZSA9IHJlY3VycmVuY2VTdGF0ZVswXTtcbiAgdmFyIHNldFJlY3VycmVuY2UgPSByZWN1cnJlbmNlU3RhdGVbMV07XG5cbiAgdmFyIGxhbmVTdGF0ZSA9IHVzZVN0YXRlKGNhcmQubGFuZUlkKTtcbiAgdmFyIGxhbmVJZCA9IGxhbmVTdGF0ZVswXTtcbiAgdmFyIHNldExhbmVJZCA9IGxhbmVTdGF0ZVsxXTtcblxuICB2YXIgY29uZmlybVN0YXRlID0gdXNlU3RhdGUoZmFsc2UpO1xuICB2YXIgY29uZmlybWluZyA9IGNvbmZpcm1TdGF0ZVswXTtcbiAgdmFyIHNldENvbmZpcm1pbmcgPSBjb25maXJtU3RhdGVbMV07XG5cbiAgdmFyIHBhbmVsUmVmID0gdXNlUmVmKG51bGwpO1xuXG4gIHVzZUVmZmVjdChmdW5jdGlvbiAoKSB7XG4gICAgaWYgKHBhbmVsUmVmLmN1cnJlbnQgJiYgcGFuZWxSZWYuY3VycmVudC5mb2N1cykgcGFuZWxSZWYuY3VycmVudC5mb2N1cygpO1xuICB9LCBbXSk7XG5cbiAgZnVuY3Rpb24gb25LZXlEb3duKGV2ZW50KSB7XG4gICAgaWYgKGV2ZW50LmtleSA9PT0gJ0VzY2FwZScpIHtcbiAgICAgIGV2ZW50LnN0b3BQcm9wYWdhdGlvbigpO1xuICAgICAgcHJvcHMub25DbG9zZSgpO1xuICAgIH1cbiAgfVxuXG4gIGZ1bmN0aW9uIHN1Ym1pdChldmVudCkge1xuICAgIGlmIChldmVudCkgZXZlbnQucHJldmVudERlZmF1bHQoKTtcbiAgICB2YXIgdmFsdWUgPSB0aXRsZS50cmltKCk7XG4gICAgcHJvcHMub25TYXZlKHtcbiAgICAgIHRpdGxlOiB2YWx1ZS5sZW5ndGggPiAwID8gdmFsdWUuc2xpY2UoMCwgQ0FSRF9USVRMRV9NQVgpIDogY2FyZC50aXRsZSxcbiAgICAgIG5vdGU6IG5vdGUuc2xpY2UoMCwgQ0FSRF9OT1RFX01BWCksXG4gICAgICBwcmlvcml0eTogcHJpb3JpdHksXG4gICAgICBkdWU6IGR1ZSB8fCBudWxsLFxuICAgICAgcmVjdXJyZW5jZTogcmVjdXJyZW5jZSxcbiAgICAgIGxhbmVJZDogbGFuZUlkLFxuICAgIH0pO1xuICB9XG5cbiAgdmFyIGR1ZUhpbnQgPSBkdWVJbmZvKGR1ZSwgZmFsc2UpO1xuXG4gIHJldHVybiBoKFxuICAgICdkaXYnLFxuICAgIHtcbiAgICAgIGNsYXNzTmFtZTogJ2thbmJhbl9fb3ZlcmxheScsXG4gICAgICBvblBvaW50ZXJEb3duOiBmdW5jdGlvbiAoZXZlbnQpIHtcbiAgICAgICAgaWYgKGV2ZW50LnRhcmdldCA9PT0gZXZlbnQuY3VycmVudFRhcmdldCkgcHJvcHMub25DbG9zZSgpO1xuICAgICAgfSxcbiAgICB9LFxuICAgIGgoXG4gICAgICAnZm9ybScsXG4gICAgICB7XG4gICAgICAgIHJlZjogcGFuZWxSZWYsXG4gICAgICAgIGNsYXNzTmFtZTogJ2thbmJhbl9fZGlhbG9nJyxcbiAgICAgICAgdGFiSW5kZXg6IC0xLFxuICAgICAgICByb2xlOiAnZGlhbG9nJyxcbiAgICAgICAgJ2FyaWEtbW9kYWwnOiAndHJ1ZScsXG4gICAgICAgICdhcmlhLWxhYmVsJzogJ+e8lui+keWNoeeJhycsXG4gICAgICAgIG9uU3VibWl0OiBzdWJtaXQsXG4gICAgICAgIG9uS2V5RG93bjogb25LZXlEb3duLFxuICAgICAgfSxcbiAgICAgIGgoXG4gICAgICAgICdkaXYnLFxuICAgICAgICB7IGNsYXNzTmFtZTogJ2thbmJhbl9fZGlhbG9nLWhlYWQnIH0sXG4gICAgICAgIGgoJ2gzJywgeyBjbGFzc05hbWU6ICdrYW5iYW5fX2RpYWxvZy10aXRsZScgfSwgJ+e8lui+keWNoeeJhycpLFxuICAgICAgICBkdWVIaW50ID8gaCgnc3BhbicsIHsgY2xhc3NOYW1lOiAna2FuYmFuX19kdWUgJyArIERVRV9DTEFTU1tkdWVIaW50LnRvbmVdIH0sIGR1ZUhpbnQudGV4dCkgOiBudWxsLFxuICAgICAgICBoKCdzcGFuJywgeyBjbGFzc05hbWU6ICdrYW5iYW5fX2NhcmQtc3BhY2VyJyB9KSxcbiAgICAgICAgaChJY29uQnV0dG9uLCB7IGxhYmVsOiAn5YWz6Zet57yW6L6R5ZmoJywgdGl0bGU6ICflhbPpl63vvIhFc2PvvIknLCBvbkNsaWNrOiBwcm9wcy5vbkNsb3NlIH0sIGljb25zLmNsb3NlKCkpXG4gICAgICApLFxuICAgICAgaChcbiAgICAgICAgJ2xhYmVsJyxcbiAgICAgICAgeyBjbGFzc05hbWU6ICdrYW5iYW5fX2ZpZWxkJyB9LFxuICAgICAgICBoKCdzcGFuJywgeyBjbGFzc05hbWU6ICdrYW5iYW5fX2xhYmVsJyB9LCAn6KaB5YGa5LuA5LmIJyksXG4gICAgICAgIGgoJ2lucHV0Jywge1xuICAgICAgICAgIGNsYXNzTmFtZTogJ2thbmJhbl9faW5wdXQnLFxuICAgICAgICAgIHZhbHVlOiB0aXRsZSxcbiAgICAgICAgICBtYXhMZW5ndGg6IENBUkRfVElUTEVfTUFYLFxuICAgICAgICAgIGF1dG9Gb2N1czogdHJ1ZSxcbiAgICAgICAgICBvbkNoYW5nZTogZnVuY3Rpb24gKGV2ZW50KSB7XG4gICAgICAgICAgICBzZXRUaXRsZShldmVudC50YXJnZXQudmFsdWUpO1xuICAgICAgICAgIH0sXG4gICAgICAgIH0pXG4gICAgICApLFxuICAgICAgaChcbiAgICAgICAgJ2xhYmVsJyxcbiAgICAgICAgeyBjbGFzc05hbWU6ICdrYW5iYW5fX2ZpZWxkJyB9LFxuICAgICAgICBoKCdzcGFuJywgeyBjbGFzc05hbWU6ICdrYW5iYW5fX2xhYmVsJyB9LCAn6KGl5YWF6K+05piO77yI5Y+v55WZ56m677yJJyksXG4gICAgICAgIGgoJ3RleHRhcmVhJywge1xuICAgICAgICAgIGNsYXNzTmFtZTogJ2thbmJhbl9fdGV4dGFyZWEnLFxuICAgICAgICAgIHZhbHVlOiBub3RlLFxuICAgICAgICAgIG1heExlbmd0aDogQ0FSRF9OT1RFX01BWCxcbiAgICAgICAgICByb3dzOiAzLFxuICAgICAgICAgIHBsYWNlaG9sZGVyOiAn57uG6IqC44CB6ZO+5o6l44CB5LiL5LiA5q2l4oCm4oCmJyxcbiAgICAgICAgICBvbkNoYW5nZTogZnVuY3Rpb24gKGV2ZW50KSB7XG4gICAgICAgICAgICBzZXROb3RlKGV2ZW50LnRhcmdldC52YWx1ZSk7XG4gICAgICAgICAgfSxcbiAgICAgICAgfSksXG4gICAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzTmFtZTogJ2thbmJhbl9faGludCcgfSwgbm90ZS5sZW5ndGggKyAnIC8gJyArIENBUkRfTk9URV9NQVgpXG4gICAgICApLFxuICAgICAgaChcbiAgICAgICAgJ2RpdicsXG4gICAgICAgIHsgY2xhc3NOYW1lOiAna2FuYmFuX19maWVsZCcgfSxcbiAgICAgICAgaCgnc3BhbicsIHsgY2xhc3NOYW1lOiAna2FuYmFuX19sYWJlbCcgfSwgJ+aIquatouaXpScpLFxuICAgICAgICBoKERhdGVQaWNrZXIsIHsgdmFsdWU6IGR1ZSwgb25DaGFuZ2U6IHNldER1ZSB9KVxuICAgICAgKSxcbiAgICAgIGgoXG4gICAgICAgICdkaXYnLFxuICAgICAgICB7IGNsYXNzTmFtZTogJ2thbmJhbl9fZmllbGQtcm93JyB9LFxuICAgICAgICBoKFxuICAgICAgICAgICdsYWJlbCcsXG4gICAgICAgICAgeyBjbGFzc05hbWU6ICdrYW5iYW5fX2ZpZWxkJyB9LFxuICAgICAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzTmFtZTogJ2thbmJhbl9fbGFiZWwnIH0sICfkvJjlhYjnuqcnKSxcbiAgICAgICAgICBoKFxuICAgICAgICAgICAgJ3NlbGVjdCcsXG4gICAgICAgICAgICB7XG4gICAgICAgICAgICAgIGNsYXNzTmFtZTogJ2thbmJhbl9fc2VsZWN0JyxcbiAgICAgICAgICAgICAgdmFsdWU6IHByaW9yaXR5LFxuICAgICAgICAgICAgICBvbkNoYW5nZTogZnVuY3Rpb24gKGV2ZW50KSB7XG4gICAgICAgICAgICAgICAgc2V0UHJpb3JpdHkoZXZlbnQudGFyZ2V0LnZhbHVlKTtcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICBoKCdvcHRpb24nLCB7IHZhbHVlOiAnbG93JyB9LCAn5L2OJyksXG4gICAgICAgICAgICBoKCdvcHRpb24nLCB7IHZhbHVlOiAnbm9ybWFsJyB9LCAn5LitJyksXG4gICAgICAgICAgICBoKCdvcHRpb24nLCB7IHZhbHVlOiAnaGlnaCcgfSwgJ+mrmCcpXG4gICAgICAgICAgKVxuICAgICAgICApLFxuICAgICAgICBoKFxuICAgICAgICAgICdsYWJlbCcsXG4gICAgICAgICAgeyBjbGFzc05hbWU6ICdrYW5iYW5fX2ZpZWxkJyB9LFxuICAgICAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzTmFtZTogJ2thbmJhbl9fbGFiZWwnIH0sICfph43lpI0nKSxcbiAgICAgICAgICBoKFJlY3VycmVuY2VTZWxlY3QsIHsgdmFsdWU6IHJlY3VycmVuY2UsIG9uQ2hhbmdlOiBzZXRSZWN1cnJlbmNlIH0pXG4gICAgICAgICksXG4gICAgICAgIGgoXG4gICAgICAgICAgJ2xhYmVsJyxcbiAgICAgICAgICB7IGNsYXNzTmFtZTogJ2thbmJhbl9fZmllbGQnIH0sXG4gICAgICAgICAgaCgnc3BhbicsIHsgY2xhc3NOYW1lOiAna2FuYmFuX19sYWJlbCcgfSwgJ+aJgOWcqOWIl+ihqCcpLFxuICAgICAgICAgIGgoXG4gICAgICAgICAgICAnc2VsZWN0JyxcbiAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgY2xhc3NOYW1lOiAna2FuYmFuX19zZWxlY3QnLFxuICAgICAgICAgICAgICB2YWx1ZTogbGFuZUlkLFxuICAgICAgICAgICAgICBvbkNoYW5nZTogZnVuY3Rpb24gKGV2ZW50KSB7XG4gICAgICAgICAgICAgICAgc2V0TGFuZUlkKGV2ZW50LnRhcmdldC52YWx1ZSk7XG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAgcHJvcHMubGFuZXMubWFwKGZ1bmN0aW9uIChpdGVtKSB7XG4gICAgICAgICAgICAgIHJldHVybiBoKCdvcHRpb24nLCB7IGtleTogaXRlbS5pZCwgdmFsdWU6IGl0ZW0uaWQgfSwgaXRlbS5uYW1lKTtcbiAgICAgICAgICAgIH0pXG4gICAgICAgICAgKVxuICAgICAgICApXG4gICAgICApLFxuICAgICAgcmVjdXJyZW5jZVxuICAgICAgICA/IGgoXG4gICAgICAgICAgICAncCcsXG4gICAgICAgICAgICB7IGNsYXNzTmFtZTogJ2thbmJhbl9faGludCcgfSxcbiAgICAgICAgICAgICfli77pgInlrozmiJDml7bov5nlvKDljaHniYfkuI3kvJrlgZzlnKjov5nph4zvvIzogIzmmK/oh6rliqjmiormiKrmraLml6XmjqjliLDkuIvkuIDmrKHvvIgnICsgUkVDVVJSRU5DRV9MQUJFTFtyZWN1cnJlbmNlXSArICfvvInjgIInXG4gICAgICAgICAgKVxuICAgICAgICA6IG51bGwsXG4gICAgICBoKFxuICAgICAgICAnZGl2JyxcbiAgICAgICAgeyBjbGFzc05hbWU6ICdrYW5iYW5fX2RpYWxvZy1mb290JyB9LFxuICAgICAgICBoKCdidXR0b24nLCB7IHR5cGU6ICdzdWJtaXQnLCBjbGFzc05hbWU6ICdrYW5iYW5fX2J0biBrYW5iYW5fX2J0bi0tcHJpbWFyeScgfSwgJ+S/neWtmCcpLFxuICAgICAgICBoKCdidXR0b24nLCB7IHR5cGU6ICdidXR0b24nLCBjbGFzc05hbWU6ICdrYW5iYW5fX2J0biBrYW5iYW5fX2J0bi0tZ2hvc3QnLCBvbkNsaWNrOiBwcm9wcy5vbkNsb3NlIH0sICflj5bmtognKSxcbiAgICAgICAgaCgnc3BhbicsIHsgY2xhc3NOYW1lOiAna2FuYmFuX19jYXJkLXNwYWNlcicgfSksXG4gICAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzTmFtZTogJ2thbmJhbl9faGludCBrYW5iYW5fX2hpbnQtLW1ldGEnIH0sICfliJvlu7rkuo4gJyArIGZvcm1hdERhdGVUaW1lKGNhcmQuY3JlYXRlZEF0KSksXG4gICAgICAgIGNvbmZpcm1pbmdcbiAgICAgICAgICA/IGgoJ2J1dHRvbicsIHsgdHlwZTogJ2J1dHRvbicsIGNsYXNzTmFtZTogJ2thbmJhbl9fYnRuIGthbmJhbl9fYnRuLS1kYW5nZXInLCBvbkNsaWNrOiBwcm9wcy5vbkRlbGV0ZSB9LCAn56Gu6K6k5Yig6ZmkJylcbiAgICAgICAgICA6IGgoXG4gICAgICAgICAgICAgICdidXR0b24nLFxuICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgdHlwZTogJ2J1dHRvbicsXG4gICAgICAgICAgICAgICAgY2xhc3NOYW1lOiAna2FuYmFuX19idG4ga2FuYmFuX19idG4tLWRhbmdlci1naG9zdCcsXG4gICAgICAgICAgICAgICAgb25DbGljazogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgICAgc2V0Q29uZmlybWluZyh0cnVlKTtcbiAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAn5Yig6Zmk5Y2h54mHJ1xuICAgICAgICAgICAgKVxuICAgICAgKVxuICAgIClcbiAgKTtcbn1cblxuZXhwb3J0IHsgQ2FyZEVkaXRvciB9O1xuIiwgIi8vIOS7jiBwbHVnaW5zL2thbmJhbi9pbmRleC5qcyDmi4blh7og4oCU4oCUICoq6YC76L6R5Y6f5qC35pCs6L+Q77yM5pyq5YGa5Lu75L2V5pS55YqoKirjgIJcbi8vIOaQrOi/kOaYr+acuuaisOeahO+8muavj+Wdl+eahOS9jee9ruS4juWGheWuuemDveayoeWPmO+8jOWPquaYr+ihpeS4iuS6hiBpbXBvcnQgLyBleHBvcnTjgIJcbmltcG9ydCB7IGR1ZUluZm8sIGlzT3ZlcmR1ZSwgdG9kYXlLZXkgfSBmcm9tICcuL2RhdGVzJztcbmltcG9ydCB7IERVRV9DTEFTUywgUFJJT1JJVFlfQ0xBU1MsIFBSSU9SSVRZX0xBQkVMLCBSRUNVUlJFTkNFX0xBQkVMLCBoLCB1c2VSZWYgfSBmcm9tICcuL2Vudic7XG5pbXBvcnQgeyBpY29ucyB9IGZyb20gJy4vaWNvbnMnO1xuaW1wb3J0IHsgbGFuZU5hbWVPZiwgdGV4dCB9IGZyb20gJy4vbW9kZWwnO1xuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIOWNoeeJh1xuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKlxuICog5Y2h54mH55qE5biD5bGA77ya5qCH6aKY54us5Y2g5LiA6KGM77yI5Y+v5Lul5o2i6KGM77yM5LiN6KKr6KeS5qCH5oyk5oiQ5LiA5YiX5a2X77yJ77yMXG4gKiDlhbbkvZnkv6Hmga/lhajpg6jmlLbov5vkuIvpnaLkuIDooYzlhYPkv6Hmga/vvIzmk43kvZzmjInpkq7lj7Plr7npvZDjgIJcbiAqIOi/meagt+eqhOeql+WPo+S4i+S5n+WPquaYr+aNouihjO+8jOS4jeS8muWHuueOsOOAjOagh+mimOiiq+WOi+aIkOS4ieihjOOAgeaXpeacn+mjmOWcqOS4remXtOOAjemCo+enjeWIq+aJreaEn+OAglxuICovXG5mdW5jdGlvbiBUYXNrQ2FyZChwcm9wcykge1xuICB2YXIgY2FyZCA9IHByb3BzLmNhcmQ7XG4gIHZhciBkdWUgPSBkdWVJbmZvKGNhcmQuZHVlLCBjYXJkLmRvbmUpO1xuICB2YXIgbm9kZVJlZiA9IHVzZVJlZihudWxsKTtcblxuICBmdW5jdGlvbiBpc0VkaXRpbmdUZXh0KCkge1xuICAgIHZhciBub2RlID0gbm9kZVJlZi5jdXJyZW50O1xuICAgIGlmICghbm9kZSB8fCAhbm9kZS50YWdOYW1lKSByZXR1cm4gZmFsc2U7XG4gICAgdmFyIHRhZyA9IG5vZGUudGFnTmFtZS50b0xvd2VyQ2FzZSgpO1xuICAgIHJldHVybiB0YWcgPT09ICdpbnB1dCcgfHwgdGFnID09PSAndGV4dGFyZWEnIHx8IHRhZyA9PT0gJ3NlbGVjdCc7XG4gIH1cblxuICBmdW5jdGlvbiBvbktleURvd24oZXZlbnQpIHtcbiAgICBpZiAoaXNFZGl0aW5nVGV4dCgpKSByZXR1cm47XG5cbiAgICB2YXIgZm9yd2FyZCA9IChldmVudC5hbHRLZXkgJiYgZXZlbnQua2V5ID09PSAnQXJyb3dSaWdodCcpIHx8IChldmVudC5jdHJsS2V5ICYmIGV2ZW50LmtleSA9PT0gJ0Fycm93RG93bicpO1xuICAgIHZhciBiYWNrd2FyZCA9IChldmVudC5hbHRLZXkgJiYgZXZlbnQua2V5ID09PSAnQXJyb3dMZWZ0JykgfHwgKGV2ZW50LmN0cmxLZXkgJiYgZXZlbnQua2V5ID09PSAnQXJyb3dVcCcpO1xuICAgIGlmIChmb3J3YXJkIHx8IGJhY2t3YXJkKSB7XG4gICAgICBldmVudC5wcmV2ZW50RGVmYXVsdCgpO1xuICAgICAgdmFyIG5leHQgPSBmb3J3YXJkID8gcHJvcHMubGFuZUluZGV4ICsgMSA6IHByb3BzLmxhbmVJbmRleCAtIDE7XG4gICAgICBpZiAobmV4dCA8IDAgfHwgbmV4dCA+PSBwcm9wcy5sYW5lQ291bnQpIHJldHVybjtcbiAgICAgIHByb3BzLm9uTW92ZVRvTGFuZShuZXh0KTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKGV2ZW50LmtleSA9PT0gJ0VudGVyJykge1xuICAgICAgLy8g5Y2h54mH5pys6Lqr5piv5pyJ54Sm54K555qE5oyJ6ZKu77ya5Zue6L2m5b+F6aG76IO95omT5byA57yW6L6R5Zmo77yMXG4gICAgICAvLyDlkKbliJnjgIxUYWIg6LWw6L+H5p2l5LmL5ZCO6IO95bmy5LuA5LmI44CN5bCx5piv5LiA5Lu25Y+q6IO954yc55qE5LqL44CCXG4gICAgICBldmVudC5wcmV2ZW50RGVmYXVsdCgpO1xuICAgICAgcHJvcHMub25FZGl0KGNhcmQuaWQpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAoZXZlbnQua2V5ID09PSAnbScgfHwgZXZlbnQua2V5ID09PSAnTScpIHtcbiAgICAgIGlmIChldmVudC5jdHJsS2V5IHx8IGV2ZW50Lm1ldGFLZXkgfHwgZXZlbnQuYWx0S2V5KSByZXR1cm47XG4gICAgICBldmVudC5wcmV2ZW50RGVmYXVsdCgpO1xuICAgICAgcHJvcHMub25TaGlmdER1ZShjYXJkLmlkLCAxKTtcbiAgICB9XG4gIH1cblxuICBmdW5jdGlvbiBvblBvaW50ZXJEb3duKGV2ZW50KSB7XG4gICAgaWYgKHByb3BzLmRyYWdnaW5nKSByZXR1cm47IC8vIOaLluWKqOi/m+ihjOS4reS4jeWGjeWPkei1t+esrOS6jOasoVxuICAgIGlmIChldmVudC5idXR0b24gIT09IDApIHJldHVybjsgLy8g5Y+q5o6l566h5Li76ZSuXG4gICAgdmFyIHRhcmdldCA9IGV2ZW50LnRhcmdldDtcbiAgICB2YXIgaW50ZXJhY3RpdmUgPSB0YXJnZXQgJiYgdGFyZ2V0LmNsb3Nlc3QgPyB0YXJnZXQuY2xvc2VzdCgnYnV0dG9uLCBpbnB1dCwgdGV4dGFyZWEsIHNlbGVjdCwgYSwgc3VtbWFyeScpIDogbnVsbDtcbiAgICBpZiAoaW50ZXJhY3RpdmUpIHJldHVybjsgLy8g5Y2h54mH5LiK55qE5bCP5oyJ6ZKu44CB6L6T5YWl5qGG6Ieq5bex5aSE55CG54K55Ye7XG4gICAgcHJvcHMub25EcmFnU3RhcnQoY2FyZC5pZCwgZXZlbnQpO1xuICB9XG5cbiAgcmV0dXJuIGgoXG4gICAgJ2FydGljbGUnLFxuICAgIHtcbiAgICAgIHJlZjogbm9kZVJlZixcbiAgICAgIGNsYXNzTmFtZTpcbiAgICAgICAgJ2thbmJhbl9fY2FyZCcgK1xuICAgICAgICAoY2FyZC5kb25lID8gJyBpcy1kb25lJyA6ICcnKSArXG4gICAgICAgIChpc092ZXJkdWUoY2FyZCwgdG9kYXlLZXkoKSkgPyAnIGlzLW92ZXJkdWUnIDogJycpICtcbiAgICAgICAgKHByb3BzLmp1c3RNb3ZlZCA/ICcgaXMtanVzdC1tb3ZlZCcgOiAnJyksXG4gICAgICB0YWJJbmRleDogMCxcbiAgICAgIHJvbGU6ICdncm91cCcsXG4gICAgICAnYXJpYS1sYWJlbCc6XG4gICAgICAgIGNhcmQudGl0bGUgKyAn77yM5L2N5LqO44CMJyArIGxhbmVOYW1lT2YocHJvcHMuYm9hcmQsIGNhcmQubGFuZUlkKSArICfjgI3liJfooagnICtcbiAgICAgICAgKGNhcmQuZG9uZSA/ICfvvIzlt7LlrozmiJAnIDogJycpICtcbiAgICAgICAgKGR1ZSA/ICfvvIwnICsgZHVlLnRleHQgOiAnJykgK1xuICAgICAgICAn44CC5oyJ5Zue6L2m5omT5byA57yW6L6R5Zmo77yM5oyJIEFsdCDliqDlt6blj7PmlrnlkJHplK7np7vliqjliLDnm7jpgrvliJfooajvvIzmjIkgTSDpobrlu7bkuIDlpKnjgIInLFxuICAgICAgJ2RhdGEtY2FyZC1pZCc6IGNhcmQuaWQsXG4gICAgICAnZGF0YS1sYW5lLWlkJzogY2FyZC5sYW5lSWQsXG4gICAgICBvblBvaW50ZXJEb3duOiBvblBvaW50ZXJEb3duLFxuICAgICAgb25LZXlEb3duOiBvbktleURvd24sXG4gICAgICBvbkRvdWJsZUNsaWNrOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgIHByb3BzLm9uRWRpdChjYXJkLmlkKTtcbiAgICAgIH0sXG4gICAgfSxcbiAgICBoKCdoMycsIHsgY2xhc3NOYW1lOiAna2FuYmFuX19jYXJkLXRpdGxlJyB9LCBjYXJkLnRpdGxlKSxcbiAgICBjYXJkLm5vdGUgPyBoKCdwJywgeyBjbGFzc05hbWU6ICdrYW5iYW5fX2NhcmQtbm90ZScgfSwgY2FyZC5ub3RlKSA6IG51bGwsXG4gICAgaChcbiAgICAgICdkaXYnLFxuICAgICAgeyBjbGFzc05hbWU6ICdrYW5iYW5fX2NhcmQtbWV0YScgfSxcbiAgICAgIGgoXG4gICAgICAgICdidXR0b24nLFxuICAgICAgICB7XG4gICAgICAgICAgdHlwZTogJ2J1dHRvbicsXG4gICAgICAgICAgY2xhc3NOYW1lOiAna2FuYmFuX19waWxsICcgKyBQUklPUklUWV9DTEFTU1tjYXJkLnByaW9yaXR5XSxcbiAgICAgICAgICB0aXRsZTogJ+S8mOWFiOe6p++8micgKyBQUklPUklUWV9MQUJFTFtjYXJkLnByaW9yaXR5XSArICfvvIjngrnlh7vliIfmjaLvvIknLFxuICAgICAgICAgICdhcmlhLWxhYmVsJzogJ+S8mOWFiOe6p++8micgKyBQUklPUklUWV9MQUJFTFtjYXJkLnByaW9yaXR5XSArICfvvIzngrnlh7vliIfmjaInLFxuICAgICAgICAgIG9uQ2xpY2s6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIHZhciBvcmRlciA9IFsnbm9ybWFsJywgJ2hpZ2gnLCAnbG93J107XG4gICAgICAgICAgICBwcm9wcy5vblNldFByaW9yaXR5KGNhcmQuaWQsIG9yZGVyWyhvcmRlci5pbmRleE9mKGNhcmQucHJpb3JpdHkpICsgMSkgJSBvcmRlci5sZW5ndGhdKTtcbiAgICAgICAgICB9LFxuICAgICAgICB9LFxuICAgICAgICBQUklPUklUWV9MQUJFTFtjYXJkLnByaW9yaXR5XVxuICAgICAgKSxcbiAgICAgIGR1ZVxuICAgICAgICA/IGgoXG4gICAgICAgICAgICAnYnV0dG9uJyxcbiAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgdHlwZTogJ2J1dHRvbicsXG4gICAgICAgICAgICAgIGNsYXNzTmFtZTogJ2thbmJhbl9fZHVlICcgKyBEVUVfQ0xBU1NbZHVlLnRvbmVdLFxuICAgICAgICAgICAgICB0aXRsZTogJ+aIquatouaXpe+8micgKyAoY2FyZC5kdWUgfHwgJ+aXoCcpICsgJ++8iOeCueWHu+mhuuW7tuS4gOWkqe+8iScsXG4gICAgICAgICAgICAgICdhcmlhLWxhYmVsJzogJ+aIquatouaXpSAnICsgKGNhcmQuZHVlIHx8ICfmnKrorr7nva4nKSArICfvvIzngrnlh7vpobrlu7bkuIDlpKknLFxuICAgICAgICAgICAgICBvbkNsaWNrOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgcHJvcHMub25TaGlmdER1ZShjYXJkLmlkLCAxKTtcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICBpY29ucy5jYWxlbmRhcigxMiksXG4gICAgICAgICAgICBkdWUudGV4dFxuICAgICAgICAgIClcbiAgICAgICAgOiBoKFxuICAgICAgICAgICAgJ2J1dHRvbicsXG4gICAgICAgICAgICB7XG4gICAgICAgICAgICAgIHR5cGU6ICdidXR0b24nLFxuICAgICAgICAgICAgICBjbGFzc05hbWU6ICdrYW5iYW5fX2R1ZSBrYW5iYW5fX2R1ZS0tZW1wdHknLFxuICAgICAgICAgICAgICB0aXRsZTogJ+iuvue9ruaIquatouaXpe+8muS7iuWkqScsXG4gICAgICAgICAgICAgICdhcmlhLWxhYmVsJzogJ+acquiuvuaIquatouaXpe+8jOeCueWHu+iuvuS4uuS7iuWkqScsXG4gICAgICAgICAgICAgIG9uQ2xpY2s6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICBwcm9wcy5vblNldER1ZShjYXJkLmlkLCB0b2RheUtleSgpKTtcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICBpY29ucy5jYWxlbmRhcigxMiksXG4gICAgICAgICAgICAn5pyq6K6+5pel5pyfJ1xuICAgICAgICAgICksXG4gICAgICBjYXJkLnJlY3VycmVuY2VcbiAgICAgICAgPyBoKFxuICAgICAgICAgICAgJ3NwYW4nLFxuICAgICAgICAgICAgeyBjbGFzc05hbWU6ICdrYW5iYW5fX3RhZyBrYW5iYW5fX3RhZy0tcmVwZWF0JywgdGl0bGU6ICfph43lpI3vvJonICsgUkVDVVJSRU5DRV9MQUJFTFtjYXJkLnJlY3VycmVuY2VdIH0sXG4gICAgICAgICAgICBpY29ucy5yZXBlYXQoMTIpLFxuICAgICAgICAgICAgUkVDVVJSRU5DRV9MQUJFTFtjYXJkLnJlY3VycmVuY2VdXG4gICAgICAgICAgKVxuICAgICAgICA6IG51bGwsXG4gICAgICBjYXJkLm5vdGUgPyBoKCdzcGFuJywgeyBjbGFzc05hbWU6ICdrYW5iYW5fX3RhZycsIHRpdGxlOiBjYXJkLm5vdGUgfSwgaWNvbnMubm90ZSgxMikpIDogbnVsbCxcbiAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzTmFtZTogJ2thbmJhbl9fY2FyZC1zcGFjZXInIH0pLFxuICAgICAgaChcbiAgICAgICAgJ2RpdicsXG4gICAgICAgIHsgY2xhc3NOYW1lOiAna2FuYmFuX19jYXJkLWFjdGlvbnMnIH0sXG4gICAgICAgIGgoXG4gICAgICAgICAgJ2J1dHRvbicsXG4gICAgICAgICAge1xuICAgICAgICAgICAgdHlwZTogJ2J1dHRvbicsXG4gICAgICAgICAgICBjbGFzc05hbWU6ICdrYW5iYW5fX21pbmknICsgKGNhcmQuZG9uZSA/ICcgaXMtYWN0aXZlJyA6ICcnKSxcbiAgICAgICAgICAgICdhcmlhLWxhYmVsJzogY2FyZC5kb25lID8gJ+agh+iusOS4uuacquWujOaIkO+8micgKyBjYXJkLnRpdGxlIDogJ+agh+iusOS4uuW3suWujOaIkO+8micgKyBjYXJkLnRpdGxlLFxuICAgICAgICAgICAgJ2FyaWEtcHJlc3NlZCc6IGNhcmQuZG9uZSxcbiAgICAgICAgICAgIHRpdGxlOiBjYXJkLmRvbmUgPyAn5qCH6K6w5Li65pyq5a6M5oiQJyA6ICfmoIforrDkuLrlt7LlrozmiJAnLFxuICAgICAgICAgICAgb25DbGljazogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICBwcm9wcy5vblRvZ2dsZURvbmUoY2FyZC5pZCwgIWNhcmQuZG9uZSk7XG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0sXG4gICAgICAgICAgaWNvbnMuY2hlY2soKVxuICAgICAgICApLFxuICAgICAgICBoKFxuICAgICAgICAgICdidXR0b24nLFxuICAgICAgICAgIHtcbiAgICAgICAgICAgIHR5cGU6ICdidXR0b24nLFxuICAgICAgICAgICAgY2xhc3NOYW1lOiAna2FuYmFuX19taW5pJyxcbiAgICAgICAgICAgICdhcmlhLWxhYmVsJzogJ+e8lui+ke+8micgKyBjYXJkLnRpdGxlLFxuICAgICAgICAgICAgdGl0bGU6ICfnvJbovpEnLFxuICAgICAgICAgICAgb25DbGljazogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICBwcm9wcy5vbkVkaXQoY2FyZC5pZCk7XG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0sXG4gICAgICAgICAgaWNvbnMucGVuY2lsKClcbiAgICAgICAgKSxcbiAgICAgICAgaChcbiAgICAgICAgICAnYnV0dG9uJyxcbiAgICAgICAgICB7XG4gICAgICAgICAgICB0eXBlOiAnYnV0dG9uJyxcbiAgICAgICAgICAgIGNsYXNzTmFtZTogJ2thbmJhbl9fbWluaScsXG4gICAgICAgICAgICAnYXJpYS1sYWJlbCc6ICfmiorjgIwnICsgY2FyZC50aXRsZSArICfjgI3np7vliLDkuIvkuIDkuKrliJfooagnLFxuICAgICAgICAgICAgdGl0bGU6ICfnp7vliLDkuIvkuIDkuKrliJfooajvvIhBbHQgKyDihpLvvIknLFxuICAgICAgICAgICAgZGlzYWJsZWQ6IHByb3BzLmxhbmVJbmRleCA+PSBwcm9wcy5sYW5lQ291bnQgLSAxLFxuICAgICAgICAgICAgb25DbGljazogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICBwcm9wcy5vbk1vdmVUb0xhbmUocHJvcHMubGFuZUluZGV4ICsgMSk7XG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0sXG4gICAgICAgICAgaWNvbnMuYXJyb3dSaWdodCgpXG4gICAgICAgICksXG4gICAgICAgIGgoXG4gICAgICAgICAgJ2J1dHRvbicsXG4gICAgICAgICAge1xuICAgICAgICAgICAgdHlwZTogJ2J1dHRvbicsXG4gICAgICAgICAgICBjbGFzc05hbWU6ICdrYW5iYW5fX21pbmkga2FuYmFuX19taW5pLS1kYW5nZXInLFxuICAgICAgICAgICAgJ2FyaWEtbGFiZWwnOiAn5Yig6Zmk77yaJyArIGNhcmQudGl0bGUsXG4gICAgICAgICAgICB0aXRsZTogJ+WIoOmZpCcsXG4gICAgICAgICAgICBvbkNsaWNrOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgIHByb3BzLm9uRGVsZXRlKGNhcmQuaWQpO1xuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9LFxuICAgICAgICAgIGljb25zLnRyYXNoKClcbiAgICAgICAgKVxuICAgICAgKVxuICAgIClcbiAgKTtcbn1cblxuZXhwb3J0IHsgVGFza0NhcmQgfTtcbiIsICIvLyDku44gcGx1Z2lucy9rYW5iYW4vaW5kZXguanMg5ouG5Ye6IOKAlOKAlCAqKumAu+i+keWOn+agt+aQrOi/kO+8jOacquWBmuS7u+S9leaUueWKqCoq44CCXG4vLyDmkKzov5DmmK/mnLrmorDnmoTvvJrmr4/lnZfnmoTkvY3nva7kuI7lhoXlrrnpg73msqHlj5jvvIzlj6rmmK/ooaXkuIrkuoYgaW1wb3J0IC8gZXhwb3J044CCXG5pbXBvcnQgeyBUYXNrQ2FyZCB9IGZyb20gJy4vY2FyZCc7XG5pbXBvcnQgeyBDQVJEX1RJVExFX01BWCwgTEFORV9OQU1FX01BWCwgaCwgdXNlRWZmZWN0LCB1c2VSZWYsIHVzZVN0YXRlIH0gZnJvbSAnLi9lbnYnO1xuaW1wb3J0IHsgaWNvbnMgfSBmcm9tICcuL2ljb25zJztcbmltcG9ydCB7IERhdGVQaWNrZXIsIEljb25CdXR0b24sIE1lbnUsIE1lbnVJdGVtLCBSZWN1cnJlbmNlU2VsZWN0IH0gZnJvbSAnLi91aSc7XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8g5YiX6KGo77yI5qCP77yJXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuZnVuY3Rpb24gTGFuZShwcm9wcykge1xuICB2YXIgbGFuZSA9IHByb3BzLmxhbmU7XG4gIHZhciBjb21wb3NlclN0YXRlID0gdXNlU3RhdGUoZmFsc2UpO1xuICB2YXIgY29tcG9zaW5nID0gY29tcG9zZXJTdGF0ZVswXTtcbiAgdmFyIHNldENvbXBvc2luZyA9IGNvbXBvc2VyU3RhdGVbMV07XG5cbiAgdmFyIGZvcm1TdGF0ZSA9IHVzZVN0YXRlKHsgdGl0bGU6ICcnLCBwcmlvcml0eTogJ25vcm1hbCcsIGR1ZTogbnVsbCwgcmVjdXJyZW5jZTogbnVsbCB9KTtcbiAgdmFyIGZvcm0gPSBmb3JtU3RhdGVbMF07XG4gIHZhciBzZXRGb3JtID0gZm9ybVN0YXRlWzFdO1xuXG4gIHZhciByZW5hbWVTdGF0ZSA9IHVzZVN0YXRlKGZhbHNlKTtcbiAgdmFyIHJlbmFtaW5nID0gcmVuYW1lU3RhdGVbMF07XG4gIHZhciBzZXRSZW5hbWluZyA9IHJlbmFtZVN0YXRlWzFdO1xuXG4gIHZhciBjb25maXJtU3RhdGUgPSB1c2VTdGF0ZShmYWxzZSk7XG4gIHZhciBjb25maXJtaW5nID0gY29uZmlybVN0YXRlWzBdO1xuICB2YXIgc2V0Q29uZmlybWluZyA9IGNvbmZpcm1TdGF0ZVsxXTtcblxuICB2YXIgaW5wdXRSZWYgPSB1c2VSZWYobnVsbCk7XG5cbiAgdXNlRWZmZWN0KGZ1bmN0aW9uICgpIHtcbiAgICBpZiAoY29tcG9zaW5nICYmIGlucHV0UmVmLmN1cnJlbnQgJiYgaW5wdXRSZWYuY3VycmVudC5mb2N1cykgaW5wdXRSZWYuY3VycmVudC5mb2N1cygpO1xuICB9LCBbY29tcG9zaW5nXSk7XG5cbiAgdXNlRWZmZWN0KGZ1bmN0aW9uICgpIHtcbiAgICBpZiAoIWNvbmZpcm1pbmcpIHJldHVybiB1bmRlZmluZWQ7XG4gICAgdmFyIHRpbWVyID0gc2V0VGltZW91dChmdW5jdGlvbiAoKSB7XG4gICAgICBzZXRDb25maXJtaW5nKGZhbHNlKTtcbiAgICB9LCA1MDAwKTtcbiAgICByZXR1cm4gZnVuY3Rpb24gKCkge1xuICAgICAgY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgICB9O1xuICB9LCBbY29uZmlybWluZ10pO1xuXG4gIGZ1bmN0aW9uIHJlc2V0Q29tcG9zZXIoKSB7XG4gICAgc2V0Rm9ybSh7IHRpdGxlOiAnJywgcHJpb3JpdHk6ICdub3JtYWwnLCBkdWU6IG51bGwsIHJlY3VycmVuY2U6IG51bGwgfSk7XG4gICAgc2V0Q29tcG9zaW5nKGZhbHNlKTtcbiAgfVxuXG4gIGZ1bmN0aW9uIHN1Ym1pdChldmVudCkge1xuICAgIGlmIChldmVudCkgZXZlbnQucHJldmVudERlZmF1bHQoKTtcbiAgICB2YXIgdGl0bGUgPSBmb3JtLnRpdGxlLnRyaW0oKTtcbiAgICBpZiAoIXRpdGxlKSByZXR1cm47XG4gICAgcHJvcHMub25BZGRDYXJkKHRpdGxlLnNsaWNlKDAsIENBUkRfVElUTEVfTUFYKSwgZm9ybS5wcmlvcml0eSwgZm9ybS5kdWUsIGZvcm0ucmVjdXJyZW5jZSk7XG4gICAgc2V0Rm9ybSh7IHRpdGxlOiAnJywgcHJpb3JpdHk6IGZvcm0ucHJpb3JpdHksIGR1ZTogbnVsbCwgcmVjdXJyZW5jZTogbnVsbCB9KTtcbiAgICBpZiAoaW5wdXRSZWYuY3VycmVudCAmJiBpbnB1dFJlZi5jdXJyZW50LmZvY3VzKSBpbnB1dFJlZi5jdXJyZW50LmZvY3VzKCk7XG4gIH1cblxuICBmdW5jdGlvbiBvbkNvbXBvc2VyS2V5RG93bihldmVudCkge1xuICAgIGlmIChldmVudC5rZXkgPT09ICdFc2NhcGUnKSB7XG4gICAgICBldmVudC5wcmV2ZW50RGVmYXVsdCgpO1xuICAgICAgcmVzZXRDb21wb3NlcigpO1xuICAgIH1cbiAgICBpZiAoZXZlbnQua2V5ID09PSAnRW50ZXInICYmIChldmVudC5jdHJsS2V5IHx8IGV2ZW50Lm1ldGFLZXkpKSB7XG4gICAgICBldmVudC5wcmV2ZW50RGVmYXVsdCgpO1xuICAgICAgc3VibWl0KGV2ZW50KTtcbiAgICB9XG4gIH1cblxuICB2YXIgY2FyZHMgPSBwcm9wcy5jYXJkcztcbiAgdmFyIGlzRHJvcExhbmUgPSBwcm9wcy5kcmFnZ2luZyAmJiBwcm9wcy5sYW5lRHJvcEJlZm9yZUlkID09PSBsYW5lLmlkO1xuICB2YXIgaXNEcm9wTGFuZUFmdGVyID0gcHJvcHMuZHJhZ2dpbmcgJiYgcHJvcHMubGFuZURyb3BBZnRlcklkID09PSBsYW5lLmlkO1xuXG4gIGlmIChsYW5lLmNvbGxhcHNlZCkge1xuICAgIHJldHVybiBoKFxuICAgICAgJ3NlY3Rpb24nLFxuICAgICAge1xuICAgICAgICBjbGFzc05hbWU6XG4gICAgICAgICAgJ2thbmJhbl9fbGFuZSBrYW5iYW5fX2xhbmUtLWNvbGxhcHNlZCcgK1xuICAgICAgICAgIChpc0Ryb3BMYW5lID8gJyBpcy1kcm9wLWJlZm9yZScgOiAnJykgK1xuICAgICAgICAgIChpc0Ryb3BMYW5lQWZ0ZXIgPyAnIGlzLWRyb3AtYWZ0ZXInIDogJycpLFxuICAgICAgICAnZGF0YS1sYW5lLWlkJzogbGFuZS5pZCxcbiAgICAgICAgJ2FyaWEtbGFiZWwnOiBsYW5lLm5hbWUgKyAn5YiX6KGo77yM5bey5oqY5Y+g77yM5YWxICcgKyBjYXJkcy5sZW5ndGggKyAnIOW8oOWNoeeJhycsXG4gICAgICB9LFxuICAgICAgaChcbiAgICAgICAgJ2J1dHRvbicsXG4gICAgICAgIHtcbiAgICAgICAgICB0eXBlOiAnYnV0dG9uJyxcbiAgICAgICAgICBjbGFzc05hbWU6ICdrYW5iYW5fX2xhbmUtY29sbGFwc2VkLWJ0bicsXG4gICAgICAgICAgJ2FyaWEtbGFiZWwnOiAn5bGV5byA5YiX6KGo77yaJyArIGxhbmUubmFtZSxcbiAgICAgICAgICB0aXRsZTogJ+WxleW8gOWIl+ihqCcsXG4gICAgICAgICAgb25DbGljazogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgcHJvcHMub25Ub2dnbGVDb2xsYXBzZWQobGFuZS5pZCk7XG4gICAgICAgICAgfSxcbiAgICAgICAgfSxcbiAgICAgICAgaWNvbnMuYXJyb3dSaWdodCgpLFxuICAgICAgICBoKCdzcGFuJywgeyBjbGFzc05hbWU6ICdrYW5iYW5fX2xhbmUtbmFtZScgfSwgbGFuZS5uYW1lKSxcbiAgICAgICAgaCgnc3BhbicsIHsgY2xhc3NOYW1lOiAna2FuYmFuX19sYW5lLWNvdW50JyB9LCBTdHJpbmcoY2FyZHMubGVuZ3RoKSlcbiAgICAgIClcbiAgICApO1xuICB9XG5cbiAgcmV0dXJuIGgoXG4gICAgJ3NlY3Rpb24nLFxuICAgIHtcbiAgICAgIGNsYXNzTmFtZTpcbiAgICAgICAgJ2thbmJhbl9fbGFuZScgK1xuICAgICAgICAocHJvcHMuZHJvcExhbmVJZCA9PT0gbGFuZS5pZCAmJiBwcm9wcy5kcmFnZ2luZyA9PT0gJ2NhcmQnID8gJyBpcy1kcm9wLXRhcmdldCcgOiAnJykgK1xuICAgICAgICAoaXNEcm9wTGFuZSA/ICcgaXMtZHJvcC1iZWZvcmUnIDogJycpICtcbiAgICAgICAgKGlzRHJvcExhbmVBZnRlciA/ICcgaXMtZHJvcC1hZnRlcicgOiAnJyksXG4gICAgICAnZGF0YS1sYW5lLWlkJzogbGFuZS5pZCxcbiAgICAgICdhcmlhLWxhYmVsJzogbGFuZS5uYW1lICsgJ+WIl+ihqO+8jOWFsSAnICsgY2FyZHMubGVuZ3RoICsgJyDlvKDljaHniYcnLFxuICAgIH0sXG4gICAgaChcbiAgICAgICdoZWFkZXInLFxuICAgICAgeyBjbGFzc05hbWU6ICdrYW5iYW5fX2xhbmUtaGVhZCcgfSxcbiAgICAgIGgoXG4gICAgICAgIEljb25CdXR0b24sXG4gICAgICAgIHtcbiAgICAgICAgICBsYWJlbDogJ+aLluWKqOiwg+aVtOOAjCcgKyBsYW5lLm5hbWUgKyAn44CN55qE5L2N572uJyxcbiAgICAgICAgICB0aXRsZTogJ+aMieS9j+aLluWKqOWPr+iwg+aVtOWIl+ihqOmhuuW6jycsXG4gICAgICAgICAgZ3JpcDogdHJ1ZSxcbiAgICAgICAgICBvblBvaW50ZXJEb3duOiBmdW5jdGlvbiAoZXZlbnQpIHtcbiAgICAgICAgICAgIHByb3BzLm9uTGFuZURyYWdTdGFydChsYW5lLmlkLCBldmVudCk7XG4gICAgICAgICAgfSxcbiAgICAgICAgfSxcbiAgICAgICAgaWNvbnMuZ3JpcCgpXG4gICAgICApLFxuICAgICAgcmVuYW1pbmdcbiAgICAgICAgPyBoKCdpbnB1dCcsIHtcbiAgICAgICAgICAgIGNsYXNzTmFtZTogJ2thbmJhbl9faW5wdXQga2FuYmFuX19pbnB1dC0taW5saW5lJyxcbiAgICAgICAgICAgIGRlZmF1bHRWYWx1ZTogbGFuZS5uYW1lLFxuICAgICAgICAgICAgYXV0b0ZvY3VzOiB0cnVlLFxuICAgICAgICAgICAgbWF4TGVuZ3RoOiBMQU5FX05BTUVfTUFYLFxuICAgICAgICAgICAgJ2FyaWEtbGFiZWwnOiAn5YiX6KGo5ZCN56ewJyxcbiAgICAgICAgICAgIG9uQmx1cjogZnVuY3Rpb24gKGV2ZW50KSB7XG4gICAgICAgICAgICAgIHZhciB2YWx1ZSA9IGV2ZW50LnRhcmdldC52YWx1ZS50cmltKCk7XG4gICAgICAgICAgICAgIGlmICh2YWx1ZSAmJiB2YWx1ZSAhPT0gbGFuZS5uYW1lKSBwcm9wcy5vblJlbmFtZUxhbmUobGFuZS5pZCwgdmFsdWUuc2xpY2UoMCwgTEFORV9OQU1FX01BWCkpO1xuICAgICAgICAgICAgICBzZXRSZW5hbWluZyhmYWxzZSk7XG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAgb25LZXlEb3duOiBmdW5jdGlvbiAoZXZlbnQpIHtcbiAgICAgICAgICAgICAgaWYgKGV2ZW50LmtleSA9PT0gJ0VudGVyJykge1xuICAgICAgICAgICAgICAgIGV2ZW50LnByZXZlbnREZWZhdWx0KCk7XG4gICAgICAgICAgICAgICAgZXZlbnQudGFyZ2V0LmJsdXIoKTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICBpZiAoZXZlbnQua2V5ID09PSAnRXNjYXBlJykge1xuICAgICAgICAgICAgICAgIGV2ZW50LnByZXZlbnREZWZhdWx0KCk7XG4gICAgICAgICAgICAgICAgc2V0UmVuYW1pbmcoZmFsc2UpO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0pXG4gICAgICAgIDogaCgnaDInLCB7IGNsYXNzTmFtZTogJ2thbmJhbl9fbGFuZS1uYW1lJyB9LCBsYW5lLm5hbWUpLFxuICAgICAgaCgnc3BhbicsIHsgY2xhc3NOYW1lOiAna2FuYmFuX19sYW5lLWNvdW50JyB9LCBTdHJpbmcoY2FyZHMubGVuZ3RoKSksXG4gICAgICBoKCdzcGFuJywgeyBjbGFzc05hbWU6ICdrYW5iYW5fX2NhcmQtc3BhY2VyJyB9KSxcbiAgICAgIGgoXG4gICAgICAgIE1lbnUsXG4gICAgICAgIHtcbiAgICAgICAgICBsYWJlbDogJ+WIl+ihqOOAjCcgKyBsYW5lLm5hbWUgKyAn44CN55qE5pu05aSa5pON5L2cJyxcbiAgICAgICAgICB0aXRsZTogJ+WIl+ihqOaTjeS9nCcsXG4gICAgICAgICAgdHJpZ2dlcjogaWNvbnMubW9yZSgpLFxuICAgICAgICB9LFxuICAgICAgICBmdW5jdGlvbiAoY2xvc2UpIHtcbiAgICAgICAgICByZXR1cm4gW1xuICAgICAgICAgICAgaChcbiAgICAgICAgICAgICAgTWVudUl0ZW0sXG4gICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICBrZXk6ICdyZW5hbWUnLFxuICAgICAgICAgICAgICAgIG9uQ2xpY2s6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICAgIGNsb3NlKCk7XG4gICAgICAgICAgICAgICAgICBzZXRSZW5hbWluZyh0cnVlKTtcbiAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAn6YeN5ZG95ZCNJ1xuICAgICAgICAgICAgKSxcbiAgICAgICAgICAgIGgoXG4gICAgICAgICAgICAgIE1lbnVJdGVtLFxuICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAga2V5OiAnbGVmdCcsXG4gICAgICAgICAgICAgICAgZGlzYWJsZWQ6IHByb3BzLmxhbmVJbmRleCA9PT0gMCxcbiAgICAgICAgICAgICAgICBvbkNsaWNrOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgICBjbG9zZSgpO1xuICAgICAgICAgICAgICAgICAgcHJvcHMub25Nb3ZlTGFuZShsYW5lLmlkLCBwcm9wcy5sYW5lSW5kZXggLSAxKTtcbiAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAn5bem56e75LiA5qCPJ1xuICAgICAgICAgICAgKSxcbiAgICAgICAgICAgIGgoXG4gICAgICAgICAgICAgIE1lbnVJdGVtLFxuICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAga2V5OiAncmlnaHQnLFxuICAgICAgICAgICAgICAgIGRpc2FibGVkOiBwcm9wcy5sYW5lSW5kZXggPj0gcHJvcHMubGFuZUNvdW50IC0gMSxcbiAgICAgICAgICAgICAgICBvbkNsaWNrOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgICBjbG9zZSgpO1xuICAgICAgICAgICAgICAgICAgcHJvcHMub25Nb3ZlTGFuZShsYW5lLmlkLCBwcm9wcy5sYW5lSW5kZXggKyAxKTtcbiAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAn5Y+z56e75LiA5qCPJ1xuICAgICAgICAgICAgKSxcbiAgICAgICAgICAgIGgoXG4gICAgICAgICAgICAgIE1lbnVJdGVtLFxuICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAga2V5OiAnY29sbGFwc2UnLFxuICAgICAgICAgICAgICAgIG9uQ2xpY2s6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICAgIGNsb3NlKCk7XG4gICAgICAgICAgICAgICAgICBwcm9wcy5vblRvZ2dsZUNvbGxhcHNlZChsYW5lLmlkKTtcbiAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAn5oqY5Y+g5YiX6KGoJ1xuICAgICAgICAgICAgKSxcbiAgICAgICAgICAgIGgoXG4gICAgICAgICAgICAgIE1lbnVJdGVtLFxuICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAga2V5OiAncmVtb3ZlJyxcbiAgICAgICAgICAgICAgICBkYW5nZXI6IHRydWUsXG4gICAgICAgICAgICAgICAgZGlzYWJsZWQ6IHByb3BzLmxhbmVDb3VudCA8PSAxLFxuICAgICAgICAgICAgICAgIG9uQ2xpY2s6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICAgIGNsb3NlKCk7XG4gICAgICAgICAgICAgICAgICBzZXRDb25maXJtaW5nKHRydWUpO1xuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICfliKDpmaTliJfooajigKYnXG4gICAgICAgICAgICApLFxuICAgICAgICAgIF07XG4gICAgICAgIH1cbiAgICAgIClcbiAgICApLFxuICAgIGNvbmZpcm1pbmdcbiAgICAgID8gaChcbiAgICAgICAgICAncCcsXG4gICAgICAgICAgeyBjbGFzc05hbWU6ICdrYW5iYW5fX2xhbmUtd2FybicsIHJvbGU6ICdhbGVydCcgfSxcbiAgICAgICAgICBoKCdzcGFuJywgbnVsbCwgJ+WIoOmZpOOAjCcgKyBsYW5lLm5hbWUgKyAn44CN77yM6YeM6Z2iICcgKyBjYXJkcy5sZW5ndGggKyAnIOW8oOWNoeeJh+S8muS4gOi1t+enu+mZpOOAgicpLFxuICAgICAgICAgIGgoXG4gICAgICAgICAgICAnYnV0dG9uJyxcbiAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgdHlwZTogJ2J1dHRvbicsXG4gICAgICAgICAgICAgIGNsYXNzTmFtZTogJ2thbmJhbl9fYnRuIGthbmJhbl9fYnRuLS1kYW5nZXIga2FuYmFuX19idG4tLXRpZ2h0JyxcbiAgICAgICAgICAgICAgb25DbGljazogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgIHByb3BzLm9uUmVtb3ZlTGFuZShsYW5lLmlkKTtcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAn56Gu6K6k5Yig6ZmkJ1xuICAgICAgICAgICksXG4gICAgICAgICAgaChcbiAgICAgICAgICAgICdidXR0b24nLFxuICAgICAgICAgICAge1xuICAgICAgICAgICAgICB0eXBlOiAnYnV0dG9uJyxcbiAgICAgICAgICAgICAgY2xhc3NOYW1lOiAna2FuYmFuX19idG4ga2FuYmFuX19idG4tLWdob3N0IGthbmJhbl9fYnRuLS10aWdodCcsXG4gICAgICAgICAgICAgIG9uQ2xpY2s6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICBzZXRDb25maXJtaW5nKGZhbHNlKTtcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAn5Y+W5raIJ1xuICAgICAgICAgIClcbiAgICAgICAgKVxuICAgICAgOiBudWxsLFxuICAgIGgoXG4gICAgICAnZGl2JyxcbiAgICAgIHsgY2xhc3NOYW1lOiAna2FuYmFuX19sYW5lLWJvZHknLCAnZGF0YS1sYW5lLWJvZHknOiAnMScsICdkYXRhLWxhbmUtaWQnOiBsYW5lLmlkIH0sXG4gICAgICBjYXJkcy5sZW5ndGggPT09IDBcbiAgICAgICAgPyBoKFxuICAgICAgICAgICAgJ3AnLFxuICAgICAgICAgICAgeyBjbGFzc05hbWU6ICdrYW5iYW5fX2xhbmUtZW1wdHknIH0sXG4gICAgICAgICAgICBwcm9wcy5oYXNRdWVyeSA/ICfov5nkuKrliJfooajph4zmsqHmnInljLnphY3nmoTljaHniYfjgIInIDogJ+i/meS4quWIl+ihqOi/mOaYr+epuueahOOAgueCueS4i+mdoueahOOAjOa3u+WKoOWNoeeJh+OAjeWGmeS4i+esrOS4gOS7tuS6i+OAgidcbiAgICAgICAgICApXG4gICAgICAgIDogbnVsbCxcbiAgICAgIGNhcmRzLm1hcChmdW5jdGlvbiAoY2FyZCwgaW5kZXgpIHtcbiAgICAgICAgLy8g6JC954K55oyH56S657q/55S75Zyo5Y2h54mH5Lya6KKr5o+S6L+b5Y6755qE6YKj5Liq5L2N572u5LiK77yM6ICM5LiN5piv5LiA5b6L55S75Zyo5bqV6YOoIOKAlOKAlFxuICAgICAgICAvLyDlj6rmnInot5/nnYDmjIfpkojotbDnmoTpgqPmnaHnur/miY3og73or7TmmI7mnb7miYvkuYvlkI7ljaHniYfkvJrljrvlk6rjgIJcbiAgICAgICAgdmFyIHNob3dMaW5lID0gcHJvcHMuZHJhZ2dpbmcgPT09ICdjYXJkJyAmJiBwcm9wcy5kcm9wTGFuZUlkID09PSBsYW5lLmlkICYmIHByb3BzLmRyb3BJbmRleCA9PT0gaW5kZXg7XG4gICAgICAgIHJldHVybiBoKFxuICAgICAgICAgICdkaXYnLFxuICAgICAgICAgIHsga2V5OiBjYXJkLmlkLCBjbGFzc05hbWU6ICdrYW5iYW5fX2NhcmQtc2xvdCcgfSxcbiAgICAgICAgICBzaG93TGluZSA/IGgoJ2RpdicsIHsgY2xhc3NOYW1lOiAna2FuYmFuX19kcm9wLWhpbnQnLCAnYXJpYS1oaWRkZW4nOiAndHJ1ZScgfSkgOiBudWxsLFxuICAgICAgICAgIGgoVGFza0NhcmQsIHtcbiAgICAgICAgICAgIGNhcmQ6IGNhcmQsXG4gICAgICAgICAgICBib2FyZDogcHJvcHMuYm9hcmQsXG4gICAgICAgICAgICBsYW5lSW5kZXg6IHByb3BzLmxhbmVJbmRleCxcbiAgICAgICAgICAgIGxhbmVDb3VudDogcHJvcHMubGFuZUNvdW50LFxuICAgICAgICAgICAgZHJhZ2dpbmc6ICEhcHJvcHMuZHJhZ2dpbmcsXG4gICAgICAgICAgICBqdXN0TW92ZWQ6IHByb3BzLmp1c3RNb3ZlZElkID09PSBjYXJkLmlkLFxuICAgICAgICAgICAgb25EcmFnU3RhcnQ6IHByb3BzLm9uRHJhZ1N0YXJ0LFxuICAgICAgICAgICAgb25FZGl0OiBwcm9wcy5vbkVkaXQsXG4gICAgICAgICAgICBvbkRlbGV0ZTogcHJvcHMub25EZWxldGUsXG4gICAgICAgICAgICBvblRvZ2dsZURvbmU6IHByb3BzLm9uVG9nZ2xlRG9uZSxcbiAgICAgICAgICAgIG9uU2V0UHJpb3JpdHk6IHByb3BzLm9uU2V0UHJpb3JpdHksXG4gICAgICAgICAgICBvblNldER1ZTogcHJvcHMub25TZXREdWUsXG4gICAgICAgICAgICBvblNoaWZ0RHVlOiBwcm9wcy5vblNoaWZ0RHVlLFxuICAgICAgICAgICAgb25Nb3ZlVG9MYW5lOiBmdW5jdGlvbiAodGFyZ2V0SW5kZXgpIHtcbiAgICAgICAgICAgICAgcHJvcHMub25Nb3ZlQ2FyZFRvTGFuZShjYXJkLmlkLCB0YXJnZXRJbmRleCk7XG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0pXG4gICAgICAgICk7XG4gICAgICB9KSxcbiAgICAgIHByb3BzLmRyYWdnaW5nID09PSAnY2FyZCcgJiYgcHJvcHMuZHJvcExhbmVJZCA9PT0gbGFuZS5pZCAmJiBwcm9wcy5kcm9wSW5kZXggPj0gY2FyZHMubGVuZ3RoXG4gICAgICAgID8gaCgnZGl2JywgeyBjbGFzc05hbWU6ICdrYW5iYW5fX2Ryb3AtaGludCcsICdhcmlhLWhpZGRlbic6ICd0cnVlJyB9KVxuICAgICAgICA6IG51bGxcbiAgICApLFxuICAgIGNvbXBvc2luZ1xuICAgICAgPyBoKFxuICAgICAgICAgICdmb3JtJyxcbiAgICAgICAgICB7IGNsYXNzTmFtZTogJ2thbmJhbl9fY29tcG9zZXInLCBvblN1Ym1pdDogc3VibWl0IH0sXG4gICAgICAgICAgaCgnaW5wdXQnLCB7XG4gICAgICAgICAgICByZWY6IGlucHV0UmVmLFxuICAgICAgICAgICAgY2xhc3NOYW1lOiAna2FuYmFuX19pbnB1dCcsXG4gICAgICAgICAgICB2YWx1ZTogZm9ybS50aXRsZSxcbiAgICAgICAgICAgIG1heExlbmd0aDogQ0FSRF9USVRMRV9NQVgsXG4gICAgICAgICAgICBwbGFjZWhvbGRlcjogJ+i/meW8oOWNoeeJh+imgeWBmuS7gOS5iO+8nycsXG4gICAgICAgICAgICAnYXJpYS1sYWJlbCc6ICfmlrDljaHniYfmoIfpopgnLFxuICAgICAgICAgICAgb25DaGFuZ2U6IGZ1bmN0aW9uIChldmVudCkge1xuICAgICAgICAgICAgICBzZXRGb3JtKE9iamVjdC5hc3NpZ24oe30sIGZvcm0sIHsgdGl0bGU6IGV2ZW50LnRhcmdldC52YWx1ZSB9KSk7XG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAgb25LZXlEb3duOiBvbkNvbXBvc2VyS2V5RG93bixcbiAgICAgICAgICB9KSxcbiAgICAgICAgICBoKFxuICAgICAgICAgICAgJ2RpdicsXG4gICAgICAgICAgICB7IGNsYXNzTmFtZTogJ2thbmJhbl9fY29tcG9zZXItcm93JyB9LFxuICAgICAgICAgICAgaChcbiAgICAgICAgICAgICAgJ3NlbGVjdCcsXG4gICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICBjbGFzc05hbWU6ICdrYW5iYW5fX3NlbGVjdCcsXG4gICAgICAgICAgICAgICAgdmFsdWU6IGZvcm0ucHJpb3JpdHksXG4gICAgICAgICAgICAgICAgJ2FyaWEtbGFiZWwnOiAn5LyY5YWI57qnJyxcbiAgICAgICAgICAgICAgICBvbkNoYW5nZTogZnVuY3Rpb24gKGV2ZW50KSB7XG4gICAgICAgICAgICAgICAgICBzZXRGb3JtKE9iamVjdC5hc3NpZ24oe30sIGZvcm0sIHsgcHJpb3JpdHk6IGV2ZW50LnRhcmdldC52YWx1ZSB9KSk7XG4gICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgaCgnb3B0aW9uJywgeyB2YWx1ZTogJ25vcm1hbCcgfSwgJ+S8mOWFiOe6p++8muS4rScpLFxuICAgICAgICAgICAgICBoKCdvcHRpb24nLCB7IHZhbHVlOiAnaGlnaCcgfSwgJ+S8mOWFiOe6p++8mumrmCcpLFxuICAgICAgICAgICAgICBoKCdvcHRpb24nLCB7IHZhbHVlOiAnbG93JyB9LCAn5LyY5YWI57qn77ya5L2OJylcbiAgICAgICAgICAgICksXG4gICAgICAgICAgICBoKFxuICAgICAgICAgICAgICAnc3BhbicsXG4gICAgICAgICAgICAgIHsgY2xhc3NOYW1lOiAna2FuYmFuX19jb21wb3Nlci1yZWN1cicgfSxcbiAgICAgICAgICAgICAgaChSZWN1cnJlbmNlU2VsZWN0LCB7XG4gICAgICAgICAgICAgICAgdmFsdWU6IGZvcm0ucmVjdXJyZW5jZSxcbiAgICAgICAgICAgICAgICBvbkNoYW5nZTogZnVuY3Rpb24gKHZhbHVlKSB7XG4gICAgICAgICAgICAgICAgICBzZXRGb3JtKE9iamVjdC5hc3NpZ24oe30sIGZvcm0sIHsgcmVjdXJyZW5jZTogdmFsdWUgfSkpO1xuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgIH0pXG4gICAgICAgICAgICApXG4gICAgICAgICAgKSxcbiAgICAgICAgICBoKERhdGVQaWNrZXIsIHtcbiAgICAgICAgICAgIHZhbHVlOiBmb3JtLmR1ZSxcbiAgICAgICAgICAgIG9uQ2hhbmdlOiBmdW5jdGlvbiAodmFsdWUpIHtcbiAgICAgICAgICAgICAgc2V0Rm9ybShPYmplY3QuYXNzaWduKHt9LCBmb3JtLCB7IGR1ZTogdmFsdWUgfSkpO1xuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9KSxcbiAgICAgICAgICBoKFxuICAgICAgICAgICAgJ2RpdicsXG4gICAgICAgICAgICB7IGNsYXNzTmFtZTogJ2thbmJhbl9fY29tcG9zZXItcm93JyB9LFxuICAgICAgICAgICAgaChcbiAgICAgICAgICAgICAgJ2J1dHRvbicsXG4gICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICB0eXBlOiAnc3VibWl0JyxcbiAgICAgICAgICAgICAgICBjbGFzc05hbWU6ICdrYW5iYW5fX2J0biBrYW5iYW5fX2J0bi0tcHJpbWFyeScsXG4gICAgICAgICAgICAgICAgZGlzYWJsZWQ6IGZvcm0udGl0bGUudHJpbSgpLmxlbmd0aCA9PT0gMCxcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgJ+a3u+WKoOWNoeeJhydcbiAgICAgICAgICAgICksXG4gICAgICAgICAgICBoKCdidXR0b24nLCB7IHR5cGU6ICdidXR0b24nLCBjbGFzc05hbWU6ICdrYW5iYW5fX2J0biBrYW5iYW5fX2J0bi0tZ2hvc3QnLCBvbkNsaWNrOiByZXNldENvbXBvc2VyIH0sICflj5bmtognKSxcbiAgICAgICAgICAgIGgoJ3NwYW4nLCB7IGNsYXNzTmFtZTogJ2thbmJhbl9faGludCcgfSwgJ0N0cmwgKyBFbnRlciDkuZ/lj6/ku6Xmt7vliqAnKVxuICAgICAgICAgIClcbiAgICAgICAgKVxuICAgICAgOiBoKFxuICAgICAgICAgICdidXR0b24nLFxuICAgICAgICAgIHtcbiAgICAgICAgICAgIHR5cGU6ICdidXR0b24nLFxuICAgICAgICAgICAgY2xhc3NOYW1lOiAna2FuYmFuX19hZGQnLFxuICAgICAgICAgICAgb25DbGljazogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICBzZXRDb21wb3NpbmcodHJ1ZSk7XG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0sXG4gICAgICAgICAgaWNvbnMucGx1cygxNCksXG4gICAgICAgICAgJ+a3u+WKoOWNoeeJhydcbiAgICAgICAgKVxuICApO1xufVxuXG5leHBvcnQgeyBMYW5lIH07XG4iLCAiLy8g5LuOIHBsdWdpbnMva2FuYmFuL2luZGV4LmpzIOaLhuWHuiDigJTigJQgKirpgLvovpHljp/moLfmkKzov5DvvIzmnKrlgZrku7vkvZXmlLnliqgqKuOAglxuLy8g5pCs6L+Q5piv5py65qKw55qE77ya5q+P5Z2X55qE5L2N572u5LiO5YaF5a656YO95rKh5Y+Y77yM5Y+q5piv6KGl5LiK5LqGIGltcG9ydCAvIGV4cG9ydOOAglxuaW1wb3J0IHsgQ0FSRF9USVRMRV9NQVgsIERSQUZUX01BWCwgaCwgdXNlRWZmZWN0LCB1c2VNZW1vLCB1c2VTdGF0ZSB9IGZyb20gJy4vZW52JztcbmltcG9ydCB7IGljb25zIH0gZnJvbSAnLi9pY29ucyc7XG5pbXBvcnQgeyB0ZXh0IH0gZnJvbSAnLi9tb2RlbCc7XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8g6YCf6K6wXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuLyoqIOaKiuS4gOihjOaWh+Wtl+WPmOaIkOS4gOS4quWPr+WKoOWFpeeci+adv+eahOadoeebruOAguavj+S4gOihjOmDveiDveWNleeLrOmAgeWOu+afkOS4quWIl+ihqOOAgiAqL1xuZnVuY3Rpb24gTWVtbyhwcm9wcykge1xuICB2YXIgdGV4dCA9IHByb3BzLnRleHQ7XG4gIHZhciBzZW5kU3RhdGUgPSB1c2VTdGF0ZShmYWxzZSk7XG4gIHZhciBzZW5kaW5nID0gc2VuZFN0YXRlWzBdO1xuICB2YXIgc2V0U2VuZGluZyA9IHNlbmRTdGF0ZVsxXTtcblxuICB2YXIgbGFuZVN0YXRlID0gdXNlU3RhdGUocHJvcHMubGFuZXNbMF0gPyBwcm9wcy5sYW5lc1swXS5pZCA6ICcnKTtcbiAgdmFyIGxhbmVJZCA9IGxhbmVTdGF0ZVswXTtcbiAgdmFyIHNldExhbmVJZCA9IGxhbmVTdGF0ZVsxXTtcblxuICB2YXIgZHJhZnRUZXh0ID0gdGV4dC50cmltKCk7XG4gIGlmIChkcmFmdFRleHQubGVuZ3RoID09PSAwKSByZXR1cm4gaCgnZGl2JywgeyBjbGFzc05hbWU6ICdrYW5iYW5fX3ByZXZpZXctZ2FwJyB9KTtcblxuICAvLyDljrvmjonluLjop4HnmoTliJfooajliY3nvIDvvIgtIOOAgSog44CBMS4g44CBWyBd77yJ77yM5qCH6aKY6YeM5LiN6K+l5bim552A5a6DXG4gIHZhciBjbGVhbiA9IGRyYWZ0VGV4dC5yZXBsYWNlKC9eKFstKivigKJdfFxcZCtbLildfFxcW1xccz9cXF18XFxbeFxcXSlcXHMqL2ksICcnKS5zbGljZSgwLCBDQVJEX1RJVExFX01BWCk7XG5cbiAgcmV0dXJuIGgoXG4gICAgJ2RpdicsXG4gICAgeyBjbGFzc05hbWU6ICdrYW5iYW5fX21lbW8nICsgKHNlbmRpbmcgPyAnIGlzLXNlbmRpbmcnIDogJycpIH0sXG4gICAgaCgncCcsIHsgY2xhc3NOYW1lOiAna2FuYmFuX19wcmV2aWV3LWxpbmUnIH0sIHRleHQpLFxuICAgIGgoXG4gICAgICAnZGl2JyxcbiAgICAgIHsgY2xhc3NOYW1lOiAna2FuYmFuX19tZW1vLWFjdGlvbnMnIH0sXG4gICAgICBoKFxuICAgICAgICAnYnV0dG9uJyxcbiAgICAgICAge1xuICAgICAgICAgIHR5cGU6ICdidXR0b24nLFxuICAgICAgICAgIGNsYXNzTmFtZTogJ2thbmJhbl9fbWluaScsXG4gICAgICAgICAgJ2FyaWEtbGFiZWwnOiAn5oqK6L+Z5LiA6KGM5Yqg5YWl55yL5p2/77yaJyArIGNsZWFuLFxuICAgICAgICAgIHRpdGxlOiAn5Yqg5YWl55yL5p2/JyxcbiAgICAgICAgICBvbkNsaWNrOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICBzZXRTZW5kaW5nKCFzZW5kaW5nKTtcbiAgICAgICAgICB9LFxuICAgICAgICB9LFxuICAgICAgICBpY29ucy5pbmJveCgpXG4gICAgICApLFxuICAgICAgaChcbiAgICAgICAgJ2J1dHRvbicsXG4gICAgICAgIHtcbiAgICAgICAgICB0eXBlOiAnYnV0dG9uJyxcbiAgICAgICAgICBjbGFzc05hbWU6ICdrYW5iYW5fX21pbmknLFxuICAgICAgICAgICdhcmlhLWxhYmVsJzogJ+aKiui/meS4gOihjOWkjeWItuWIsOWJqui0tOadvycsXG4gICAgICAgICAgdGl0bGU6ICflpI3liLbov5nkuIDooYwnLFxuICAgICAgICAgIG9uQ2xpY2s6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIHByb3BzLm9uQ29weUxpbmUoY2xlYW4pO1xuICAgICAgICAgIH0sXG4gICAgICAgIH0sXG4gICAgICAgIGljb25zLm5vdGUoMTMpXG4gICAgICApXG4gICAgKSxcbiAgICBzZW5kaW5nXG4gICAgICA/IGgoXG4gICAgICAgICAgJ2RpdicsXG4gICAgICAgICAgeyBjbGFzc05hbWU6ICdrYW5iYW5fX21lbW8tc2VuZCcgfSxcbiAgICAgICAgICBoKFxuICAgICAgICAgICAgJ3NlbGVjdCcsXG4gICAgICAgICAgICB7XG4gICAgICAgICAgICAgIGNsYXNzTmFtZTogJ2thbmJhbl9fc2VsZWN0JyxcbiAgICAgICAgICAgICAgdmFsdWU6IGxhbmVJZCxcbiAgICAgICAgICAgICAgJ2FyaWEtbGFiZWwnOiAn6YCJ5oup6KaB5Yqg5YWl55qE5YiX6KGoJyxcbiAgICAgICAgICAgICAgb25DaGFuZ2U6IGZ1bmN0aW9uIChldmVudCkge1xuICAgICAgICAgICAgICAgIHNldExhbmVJZChldmVudC50YXJnZXQudmFsdWUpO1xuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIHByb3BzLmxhbmVzLm1hcChmdW5jdGlvbiAoaXRlbSkge1xuICAgICAgICAgICAgICByZXR1cm4gaCgnb3B0aW9uJywgeyBrZXk6IGl0ZW0uaWQsIHZhbHVlOiBpdGVtLmlkIH0sIGl0ZW0ubmFtZSk7XG4gICAgICAgICAgICB9KVxuICAgICAgICAgICksXG4gICAgICAgICAgaChcbiAgICAgICAgICAgICdidXR0b24nLFxuICAgICAgICAgICAge1xuICAgICAgICAgICAgICB0eXBlOiAnYnV0dG9uJyxcbiAgICAgICAgICAgICAgY2xhc3NOYW1lOiAna2FuYmFuX19idG4ga2FuYmFuX19idG4tLXByaW1hcnkga2FuYmFuX19idG4tLXRpZ2h0JyxcbiAgICAgICAgICAgICAgb25DbGljazogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgIHByb3BzLm9uU2VuZFRvQm9hcmQobGFuZUlkLCBjbGVhbik7XG4gICAgICAgICAgICAgICAgc2V0U2VuZGluZyhmYWxzZSk7XG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAgJ+WKoOWFpSdcbiAgICAgICAgICApLFxuICAgICAgICAgIGgoXG4gICAgICAgICAgICAnYnV0dG9uJyxcbiAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgdHlwZTogJ2J1dHRvbicsXG4gICAgICAgICAgICAgIGNsYXNzTmFtZTogJ2thbmJhbl9fYnRuIGthbmJhbl9fYnRuLS1naG9zdCBrYW5iYW5fX2J0bi0tdGlnaHQnLFxuICAgICAgICAgICAgICBvbkNsaWNrOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgc2V0U2VuZGluZyhmYWxzZSk7XG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAgJ+WPlua2iCdcbiAgICAgICAgICApXG4gICAgICAgIClcbiAgICAgIDogbnVsbFxuICApO1xufVxuXG5mdW5jdGlvbiBEcmFmdFZpZXcocHJvcHMpIHtcbiAgdmFyIGRyYWZ0ID0gcHJvcHMuZHJhZnQ7XG4gIHZhciBtb3JlU3RhdGUgPSB1c2VTdGF0ZShmYWxzZSk7XG4gIHZhciBzaG93TW9yZSA9IG1vcmVTdGF0ZVswXTtcbiAgdmFyIHNldFNob3dNb3JlID0gbW9yZVN0YXRlWzFdO1xuXG4gIHZhciB0b2FzdFN0YXRlID0gdXNlU3RhdGUobnVsbCk7XG4gIHZhciB0b2FzdCA9IHRvYXN0U3RhdGVbMF07XG4gIHZhciBzZXRUb2FzdCA9IHRvYXN0U3RhdGVbMV07XG5cbiAgdmFyIHByZXZpZXcgPSBkcmFmdC5sZW5ndGggPiAxMjAwICYmICFzaG93TW9yZSA/IGRyYWZ0LnNsaWNlKDAsIDEyMDApIDogZHJhZnQ7XG4gIHZhciBoaWRkZW4gPSBkcmFmdC5sZW5ndGggLSBwcmV2aWV3Lmxlbmd0aDtcblxuICB2YXIgbGluZXMgPSB1c2VNZW1vKFxuICAgIGZ1bmN0aW9uICgpIHtcbiAgICAgIHJldHVybiBwcmV2aWV3LnNwbGl0KCdcXG4nKTtcbiAgICB9LFxuICAgIFtwcmV2aWV3XVxuICApO1xuXG4gIHVzZUVmZmVjdChmdW5jdGlvbiAoKSB7XG4gICAgaWYgKCF0b2FzdCkgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICB2YXIgdGltZXIgPSBzZXRUaW1lb3V0KGZ1bmN0aW9uICgpIHtcbiAgICAgIHNldFRvYXN0KG51bGwpO1xuICAgIH0sIDI1MDApO1xuICAgIHJldHVybiBmdW5jdGlvbiAoKSB7XG4gICAgICBjbGVhclRpbWVvdXQodGltZXIpO1xuICAgIH07XG4gIH0sIFt0b2FzdF0pO1xuXG4gIGZ1bmN0aW9uIGNvcHlUZXh0KHZhbHVlLCBsYWJlbCkge1xuICAgIGZ1bmN0aW9uIGZhaWxlZCgpIHtcbiAgICAgIHNldFRvYXN0KCfmtY/op4jlmajmsqHmnInlhYHorrjlhpnlhaXliarotLTmnb/vvIzor7fmiYvliqjpgInkuK3mloflrZflpI3liLbjgIInKTtcbiAgICB9XG4gICAgdHJ5IHtcbiAgICAgIGlmIChuYXZpZ2F0b3IuY2xpcGJvYXJkICYmIG5hdmlnYXRvci5jbGlwYm9hcmQud3JpdGVUZXh0KSB7XG4gICAgICAgIG5hdmlnYXRvci5jbGlwYm9hcmQud3JpdGVUZXh0KHZhbHVlKS50aGVuKGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICBzZXRUb2FzdChsYWJlbCArICflt7LlpI3liLYnKTtcbiAgICAgICAgfSwgZmFpbGVkKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGZhaWxlZCgpO1xuICAgICAgfVxuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgZmFpbGVkKCk7XG4gICAgfVxuICB9XG5cbiAgdmFyIGl0ZW1Db3VudCA9IGRyYWZ0XG4gICAgLnNwbGl0KCdcXG4nKVxuICAgIC5maWx0ZXIoZnVuY3Rpb24gKGxpbmUpIHtcbiAgICAgIHJldHVybiBsaW5lLnRyaW0oKS5sZW5ndGggPiAwO1xuICAgIH0pLmxlbmd0aDtcblxuICByZXR1cm4gaChcbiAgICAnZGl2JyxcbiAgICB7IGNsYXNzTmFtZTogJ2thbmJhbl9fZHJhZnQnIH0sXG4gICAgaChcbiAgICAgICdkaXYnLFxuICAgICAgeyBjbGFzc05hbWU6ICdrYW5iYW5fX2RyYWZ0LW1haW4nIH0sXG4gICAgICBoKFxuICAgICAgICAnbGFiZWwnLFxuICAgICAgICB7IGNsYXNzTmFtZTogJ2thbmJhbl9fZmllbGQnIH0sXG4gICAgICAgIGgoXG4gICAgICAgICAgJ3NwYW4nLFxuICAgICAgICAgIHsgY2xhc3NOYW1lOiAna2FuYmFuX19sYWJlbCcgfSxcbiAgICAgICAgICAn6ZqP5omL6K6wJyxcbiAgICAgICAgICBoKCdzcGFuJywgeyBjbGFzc05hbWU6ICdrYW5iYW5fX2xhYmVsLWhpbnQnIH0sICfkuIDooYzkuIDku7bkuovvvIzlj7Povrnlj6/ku6XpgJDmnaHliqDlhaXnnIvmnb8nKVxuICAgICAgICApLFxuICAgICAgICBoKCd0ZXh0YXJlYScsIHtcbiAgICAgICAgICBjbGFzc05hbWU6ICdrYW5iYW5fX3RleHRhcmVhIGthbmJhbl9fdGV4dGFyZWEtLWRyYWZ0JyxcbiAgICAgICAgICB2YWx1ZTogZHJhZnQsXG4gICAgICAgICAgbWF4TGVuZ3RoOiBEUkFGVF9NQVgsXG4gICAgICAgICAgcGxhY2Vob2xkZXI6ICfmg7PliLDku4DkuYjlhYjlhpnlnKjov5nph4zjgIJcXG7kuIDooYzkuIDku7bkuovvvIzlhpnlrozljrvlj7PovrnmiormnInnlKjnmoTlh6DmnaHliqDov5vnnIvmnb/jgIInLFxuICAgICAgICAgICdhcmlhLWxhYmVsJzogJ+maj+aJi+iusOiNieeovycsXG4gICAgICAgICAgb25DaGFuZ2U6IGZ1bmN0aW9uIChldmVudCkge1xuICAgICAgICAgICAgcHJvcHMub25DaGFuZ2UoZXZlbnQudGFyZ2V0LnZhbHVlLnNsaWNlKDAsIERSQUZUX01BWCkpO1xuICAgICAgICAgIH0sXG4gICAgICAgIH0pXG4gICAgICApLFxuICAgICAgaChcbiAgICAgICAgJ2RpdicsXG4gICAgICAgIHsgY2xhc3NOYW1lOiAna2FuYmFuX19kcmFmdC1hY3Rpb25zJyB9LFxuICAgICAgICBoKFxuICAgICAgICAgICdidXR0b24nLFxuICAgICAgICAgIHtcbiAgICAgICAgICAgIHR5cGU6ICdidXR0b24nLFxuICAgICAgICAgICAgY2xhc3NOYW1lOiAna2FuYmFuX19idG4ga2FuYmFuX19idG4tLWdob3N0JyxcbiAgICAgICAgICAgIGRpc2FibGVkOiBkcmFmdC5sZW5ndGggPT09IDAsXG4gICAgICAgICAgICBvbkNsaWNrOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgIGNvcHlUZXh0KGRyYWZ0LCAn5YWo6YOo5paH5a2XJyk7XG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0sXG4gICAgICAgICAgJ+WkjeWItuWFqOmDqCdcbiAgICAgICAgKSxcbiAgICAgICAgaChcbiAgICAgICAgICAnYnV0dG9uJyxcbiAgICAgICAgICB7XG4gICAgICAgICAgICB0eXBlOiAnYnV0dG9uJyxcbiAgICAgICAgICAgIGNsYXNzTmFtZTogJ2thbmJhbl9fYnRuIGthbmJhbl9fYnRuLS1naG9zdCcsXG4gICAgICAgICAgICBkaXNhYmxlZDogZHJhZnQubGVuZ3RoID09PSAwLFxuICAgICAgICAgICAgb25DbGljazogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICBwcm9wcy5vbkNoYW5nZSgnJyk7XG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0sXG4gICAgICAgICAgJ+a4heepuidcbiAgICAgICAgKSxcbiAgICAgICAgaChcbiAgICAgICAgICAnc3BhbicsXG4gICAgICAgICAgeyBjbGFzc05hbWU6ICdrYW5iYW5fX2hpbnQnIH0sXG4gICAgICAgICAgZHJhZnQubGVuZ3RoICsgJyAvICcgKyBEUkFGVF9NQVggKyAn77yM5YWxICcgKyBpdGVtQ291bnQgKyAnIOadoe+8jOi+ueWGmei+ueS/neWtmCdcbiAgICAgICAgKSxcbiAgICAgICAgdG9hc3QgPyBoKCdzcGFuJywgeyBjbGFzc05hbWU6ICdrYW5iYW5fX2RyYWZ0LXRvYXN0Jywgcm9sZTogJ3N0YXR1cycgfSwgdG9hc3QpIDogbnVsbFxuICAgICAgKVxuICAgICksXG4gICAgaChcbiAgICAgICdhc2lkZScsXG4gICAgICB7IGNsYXNzTmFtZTogJ2thbmJhbl9fcHJldmlldycgfSxcbiAgICAgIGgoXG4gICAgICAgICdkaXYnLFxuICAgICAgICB7IGNsYXNzTmFtZTogJ2thbmJhbl9fcHJldmlldy1oZWFkJyB9LFxuICAgICAgICBoKCdoMycsIHsgY2xhc3NOYW1lOiAna2FuYmFuX19wcmV2aWV3LXRpdGxlJyB9LCAn5pW055CGJyksXG4gICAgICAgIGl0ZW1Db3VudCA+IDAgPyBoKCdzcGFuJywgeyBjbGFzc05hbWU6ICdrYW5iYW5fX2hpbnQnIH0sIGl0ZW1Db3VudCArICcg5p2hJykgOiBudWxsXG4gICAgICApLFxuICAgICAgZHJhZnQubGVuZ3RoID09PSAwXG4gICAgICAgID8gaChcbiAgICAgICAgICAgICdwJyxcbiAgICAgICAgICAgIHsgY2xhc3NOYW1lOiAna2FuYmFuX19sYW5lLWVtcHR5JyB9LFxuICAgICAgICAgICAgJ+W3pui+ueWGmeeCueS7gOS5iO+8jOi/memHjOS8muaKiuavj+S4gOihjOWIl+WHuuadpeOAguavj+ihjOWPs+S+p+eahOaMiemSruWPr+S7peaKiuWug+ebtOaOpeWKoOi/m+afkOS4quWIl+ihqCDigJTigJQg5LiN5b+F5YaN5aSN5Yi25LiA6YGN44CCJ1xuICAgICAgICAgIClcbiAgICAgICAgOiBoKFxuICAgICAgICAgICAgJ2RpdicsXG4gICAgICAgICAgICB7IGNsYXNzTmFtZTogJ2thbmJhbl9fcHJldmlldy1ib2R5JyB9LFxuICAgICAgICAgICAgbGluZXMubWFwKGZ1bmN0aW9uIChsaW5lLCBpbmRleCkge1xuICAgICAgICAgICAgICByZXR1cm4gaChNZW1vLCB7XG4gICAgICAgICAgICAgICAga2V5OiAnbGluZS0nICsgaW5kZXgsXG4gICAgICAgICAgICAgICAgdGV4dDogbGluZSxcbiAgICAgICAgICAgICAgICBsYW5lczogcHJvcHMubGFuZXMsXG4gICAgICAgICAgICAgICAgb25TZW5kVG9Cb2FyZDogcHJvcHMub25TZW5kVG9Cb2FyZCxcbiAgICAgICAgICAgICAgICBvbkNvcHlMaW5lOiBmdW5jdGlvbiAodmFsdWUpIHtcbiAgICAgICAgICAgICAgICAgIGNvcHlUZXh0KHZhbHVlLCAn6L+Z5LiA6KGMJyk7XG4gICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9KSxcbiAgICAgICAgICAgIGhpZGRlbiA+IDBcbiAgICAgICAgICAgICAgPyBoKFxuICAgICAgICAgICAgICAgICAgJ2J1dHRvbicsXG4gICAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgIHR5cGU6ICdidXR0b24nLFxuICAgICAgICAgICAgICAgICAgICBjbGFzc05hbWU6ICdrYW5iYW5fX2J0biBrYW5iYW5fX2J0bi0tZ2hvc3QnLFxuICAgICAgICAgICAgICAgICAgICBvbkNsaWNrOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgICAgICAgc2V0U2hvd01vcmUodHJ1ZSk7XG4gICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgJ+i/mOaciSAnICsgaGlkZGVuICsgJyDkuKrlrZfvvIzlsZXlvIDmn6XnnIsnXG4gICAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgICA6IG51bGxcbiAgICAgICAgICApXG4gICAgKVxuICApO1xufVxuXG5leHBvcnQgeyBEcmFmdFZpZXcsIE1lbW8gfTtcbiIsICIvLyDku44gcGx1Z2lucy9rYW5iYW4vaW5kZXguanMg5ouG5Ye6IOKAlOKAlCAqKumAu+i+keWOn+agt+aQrOi/kO+8jOacquWBmuS7u+S9leaUueWKqCoq44CCXG4vLyDmkKzov5DmmK/mnLrmorDnmoTvvJrmr4/lnZfnmoTkvY3nva7kuI7lhoXlrrnpg73msqHlj5jvvIzlj6rmmK/ooaXkuIrkuoYgaW1wb3J0IC8gZXhwb3J044CCXG5pbXBvcnQgeyBhZGREYXlzLCBpc092ZXJkdWUsIG1hdGNoZXNRdWVyeSwgc29ydENhcmRzLCB0b2RheUtleSB9IGZyb20gJy4vZGF0ZXMnO1xuaW1wb3J0IHsgQ2FyZEVkaXRvciB9IGZyb20gJy4vZWRpdG9yJztcbmltcG9ydCB7IENBUkRfVElUTEVfTUFYLCBERUZBVUxUX0xBTkVTLCBEUkFGVF9ERUJPVU5DRV9NUywgRFJBR19USFJFU0hPTEQsIEtFWV9EUkFGVCwgTEFORV9OQU1FX01BWCwgTW9kdWxpdGgsIFRPUElDX0NIQU5HRUQsIFVORE9fTVMsIGN0eCwgaCwgdXNlRWZmZWN0LCB1c2VNZW1vLCB1c2VSZWYsIHVzZVN0YXRlLCB1c2VTeW5jRXh0ZXJuYWxTdG9yZSB9IGZyb20gJy4vZW52JztcbmltcG9ydCB7IGljb24sIGljb25zIH0gZnJvbSAnLi9pY29ucyc7XG5pbXBvcnQgeyBMYW5lIH0gZnJvbSAnLi9sYW5lJztcbmltcG9ydCB7IERyYWZ0VmlldyB9IGZyb20gJy4vbWVtbyc7XG5pbXBvcnQgeyBjYXJkc0luTGFuZSwgY2xvbmUsIGxhbmVCeUlkLCBsYW5lTmFtZU9mLCB0ZXh0IH0gZnJvbSAnLi9tb2RlbCc7XG5pbXBvcnQgeyBib2FyZEFjdGlvbnMsIGRheUNoYW5nZWQsIGR1ZVJlbWluZGVyLCBncmVldGluZywgaW50ZXJuYWwsIGxvYWQsIGxvYWREcmFmdCwgbm90aWZ5LCBwdXNoTm90ZSwgcmVsb2FkLCBzYXZlUHJlZnNOb3csIHN0b3JlIH0gZnJvbSAnLi9zdG9yZSc7XG5pbXBvcnQgeyBFcnJvckJhbm5lciwgTWVudSwgTWVudUl0ZW0sIFNhdmVJbmRpY2F0b3IgfSBmcm9tICcuL3VpJztcblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyDnnIvmnb/kuLvkvZNcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5mdW5jdGlvbiBLYW5iYW5Cb2FyZCgpIHtcbiAgdmFyIHN0YXRlID0gdXNlU3luY0V4dGVybmFsU3RvcmUoc3RvcmUuc3Vic2NyaWJlLCBzdG9yZS5nZXRTbmFwc2hvdCwgc3RvcmUuZ2V0U25hcHNob3QpO1xuICB2YXIgYWN0aXZlID0gTW9kdWxpdGgudXNlTW9kdWxlQWN0aXZlKCk7XG5cbiAgdmFyIHZpZXdTdGF0ZSA9IHVzZVN0YXRlKCdib2FyZCcpOyAvLyBib2FyZCB8IGRyYWZ0XG4gIHZhciB2aWV3ID0gdmlld1N0YXRlWzBdO1xuICB2YXIgc2V0VmlldyA9IHZpZXdTdGF0ZVsxXTtcblxuICB2YXIgcXVlcnlTdGF0ZSA9IHVzZVN0YXRlKCcnKTtcbiAgdmFyIHF1ZXJ5ID0gcXVlcnlTdGF0ZVswXTtcbiAgdmFyIHNldFF1ZXJ5ID0gcXVlcnlTdGF0ZVsxXTtcblxuICB2YXIgZmlsdGVyU3RhdGUgPSB1c2VTdGF0ZSgnYWxsJyk7IC8vIGFsbCB8IG92ZXJkdWUgfCBoaWdoXG4gIHZhciBmaWx0ZXIgPSBmaWx0ZXJTdGF0ZVswXTtcbiAgdmFyIHNldEZpbHRlciA9IGZpbHRlclN0YXRlWzFdO1xuXG4gIHZhciBzaG93RG9uZVN0YXRlID0gdXNlU3RhdGUodHJ1ZSk7XG4gIHZhciBzaG93RG9uZSA9IHNob3dEb25lU3RhdGVbMF07XG4gIHZhciBzZXRTaG93RG9uZSA9IHNob3dEb25lU3RhdGVbMV07XG5cbiAgdmFyIGVkaXRpbmdTdGF0ZSA9IHVzZVN0YXRlKG51bGwpO1xuICB2YXIgZWRpdGluZ0lkID0gZWRpdGluZ1N0YXRlWzBdO1xuICB2YXIgc2V0RWRpdGluZ0lkID0gZWRpdGluZ1N0YXRlWzFdO1xuXG4gIHZhciB1bmRvU3RhdGUgPSB1c2VTdGF0ZShudWxsKTtcbiAgdmFyIHVuZG8gPSB1bmRvU3RhdGVbMF07XG4gIHZhciBzZXRVbmRvID0gdW5kb1N0YXRlWzFdO1xuXG4gIHZhciBkcmFnU3RhdGUgPSB1c2VTdGF0ZShudWxsKTsgLy8geyBraW5kOiAnY2FyZCcgfCAnbGFuZScsIGxhYmVsIH1cbiAgdmFyIGRyYWdQcmV2aWV3ID0gZHJhZ1N0YXRlWzBdO1xuICB2YXIgc2V0RHJhZ1ByZXZpZXcgPSBkcmFnU3RhdGVbMV07XG5cbiAgdmFyIGRyb3BTdGF0ZSA9IHVzZVN0YXRlKG51bGwpOyAvLyDljaHniYfvvJp7IGxhbmVJZCwgaW5kZXgsIGJlZm9yZUlkLCBhZnRlcklkIH3vvJvliJfooajvvJp7IGxhbmVJZCB9XG4gIHZhciBkcm9wID0gZHJvcFN0YXRlWzBdO1xuICB2YXIgc2V0RHJvcCA9IGRyb3BTdGF0ZVsxXTtcblxuICB2YXIgbGFuZURyb3BTdGF0ZSA9IHVzZVN0YXRlKG51bGwpOyAvLyDliJfooajmi5bliqjml7bnmoTokL3ngrnvvJp7IGJlZm9yZUlkLCBhZnRlcklkIH1cbiAgdmFyIGxhbmVEcm9wID0gbGFuZURyb3BTdGF0ZVswXTtcbiAgdmFyIHNldExhbmVEcm9wID0gbGFuZURyb3BTdGF0ZVsxXTtcblxuICB2YXIgYWRkTGFuZVN0YXRlID0gdXNlU3RhdGUoZmFsc2UpO1xuICB2YXIgYWRkaW5nTGFuZSA9IGFkZExhbmVTdGF0ZVswXTtcbiAgdmFyIHNldEFkZGluZ0xhbmUgPSBhZGRMYW5lU3RhdGVbMV07XG5cbiAgdmFyIGFubm91bmNlU3RhdGUgPSB1c2VTdGF0ZSgnJyk7XG4gIHZhciBhbm5vdW5jZSA9IGFubm91bmNlU3RhdGVbMF07XG4gIHZhciBzZXRBbm5vdW5jZSA9IGFubm91bmNlU3RhdGVbMV07XG5cbiAgdmFyIGp1c3RNb3ZlZFN0YXRlID0gdXNlU3RhdGUobnVsbCk7XG4gIHZhciBqdXN0TW92ZWRJZCA9IGp1c3RNb3ZlZFN0YXRlWzBdO1xuICB2YXIgc2V0SnVzdE1vdmVkSWQgPSBqdXN0TW92ZWRTdGF0ZVsxXTtcblxuICB2YXIgZHJhZnRTYXZlU3RhdGUgPSB1c2VTdGF0ZSgnaWRsZScpO1xuICB2YXIgZHJhZnRTYXZlID0gZHJhZnRTYXZlU3RhdGVbMF07XG4gIHZhciBzZXREcmFmdFNhdmUgPSBkcmFmdFNhdmVTdGF0ZVsxXTtcblxuICB2YXIgZmlyc3RDYXJkU3RhdGUgPSB1c2VTdGF0ZSgnJyk7XG4gIHZhciBmaXJzdENhcmQgPSBmaXJzdENhcmRTdGF0ZVswXTtcbiAgdmFyIHNldEZpcnN0Q2FyZCA9IGZpcnN0Q2FyZFN0YXRlWzFdO1xuXG4gIHZhciBkcmFnZ2luZ1JlZiA9IHVzZVJlZihudWxsKTtcbiAgdmFyIGdlb21ldHJ5UmVmID0gdXNlUmVmKG51bGwpO1xuICB2YXIgbGFuZUJveGVzUmVmID0gdXNlUmVmKG51bGwpO1xuICB2YXIgbW9kZVJlZiA9IHVzZVJlZih2aWV3KTtcbiAgdmFyIHVuZG9UaW1lclJlZiA9IHVzZVJlZihudWxsKTtcbiAgdmFyIG1vdmVGbGFzaFJlZiA9IHVzZVJlZihudWxsKTtcblxuICBtb2RlUmVmLmN1cnJlbnQgPSB2aWV3O1xuXG4gIC8vIOi/m+WFpeaooeWdl++8muivu+aVsOaNru+8jOaOpeS4iuWPpuS4gOS4quWunuS+i+eahOWPmOabtOmAmuefpe+8jOajgOafpeS4gOasoeWIsOacn+aPkOmGkuOAglxuICB1c2VFZmZlY3QoZnVuY3Rpb24gKCkge1xuICAgIGludGVybmFsLmFsaXZlID0gdHJ1ZTtcbiAgICByZWxvYWQoKS50aGVuKGZ1bmN0aW9uICgpIHtcbiAgICAgIGR1ZVJlbWluZGVyKHN0b3JlLmdldFNuYXBzaG90KCkuYm9hcmQpO1xuICAgIH0pO1xuXG4gICAgdmFyIHVuc3Vic2NyaWJlID0gY3R4LmV2ZW50cy5zdWJzY3JpYmUoVE9QSUNfQ0hBTkdFRCwgZnVuY3Rpb24gKGV2ZW50KSB7XG4gICAgICBpZiAoIWludGVybmFsLmFsaXZlIHx8ICFpbnRlcm5hbC5sb2FkZWQpIHJldHVybjtcbiAgICAgIHZhciByZXYgPSBldmVudCAmJiBldmVudC5wYXlsb2FkICYmIHR5cGVvZiBldmVudC5wYXlsb2FkLnJldiA9PT0gJ251bWJlcicgPyBldmVudC5wYXlsb2FkLnJldiA6IDA7XG4gICAgICBpZiAocmV2ID4gMCAmJiByZXYgPD0gaW50ZXJuYWwuc2F2ZWRSZXYpIHJldHVybjsgLy8g5bCx5piv6Ieq5bex5YaZ55qE6YKj5LiA5qyhXG4gICAgICBzdG9yZS5zZXQoeyBjb25mbGljdDogZmFsc2UgfSk7XG4gICAgICBsb2FkKCkudGhlbihmdW5jdGlvbiAoKSB7XG4gICAgICAgIGlmIChtb2RlUmVmLmN1cnJlbnQgPT09ICdkcmFmdCcpIGxvYWREcmFmdCgpO1xuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICByZXR1cm4gZnVuY3Rpb24gKCkge1xuICAgICAgaW50ZXJuYWwuYWxpdmUgPSBmYWxzZTtcbiAgICAgIGlmIChpbnRlcm5hbC50aW1lciAhPT0gbnVsbCkge1xuICAgICAgICBjbGVhclRpbWVvdXQoaW50ZXJuYWwudGltZXIpO1xuICAgICAgICBpbnRlcm5hbC50aW1lciA9IG51bGw7XG4gICAgICB9XG4gICAgICBpZiAoaW50ZXJuYWwuZHJhZnRUaW1lciAhPT0gbnVsbCkge1xuICAgICAgICBjbGVhclRpbWVvdXQoaW50ZXJuYWwuZHJhZnRUaW1lcik7XG4gICAgICAgIGludGVybmFsLmRyYWZ0VGltZXIgPSBudWxsO1xuICAgICAgfVxuICAgICAgaWYgKHVuZG9UaW1lclJlZi5jdXJyZW50ICE9PSBudWxsKSB7XG4gICAgICAgIGNsZWFyVGltZW91dCh1bmRvVGltZXJSZWYuY3VycmVudCk7XG4gICAgICAgIHVuZG9UaW1lclJlZi5jdXJyZW50ID0gbnVsbDtcbiAgICAgIH1cbiAgICAgIGlmIChtb3ZlRmxhc2hSZWYuY3VycmVudCAhPT0gbnVsbCkge1xuICAgICAgICBjbGVhclRpbWVvdXQobW92ZUZsYXNoUmVmLmN1cnJlbnQpO1xuICAgICAgICBtb3ZlRmxhc2hSZWYuY3VycmVudCA9IG51bGw7XG4gICAgICB9XG4gICAgICB1bnN1YnNjcmliZSgpO1xuICAgIH07XG4gIH0sIFtdKTtcblxuICAvLyDph43mlrDlj6/op4Hml7blho3or7vkuIDmrKHvvJrkuI3lj6/op4HmnJ/pl7Tlj6bkuIDkuKrlrp7kvovlj6/og73lt7Lnu4/lhpnov4fmlbDmja7jgIJcbiAgLy8g5pys5Zyw6L+Y5pyJ5rKh6JC955uY55qE5pS55Yqo5pe257ud5LiN6K+7IOKAlOKAlCDpgqPkvJrmiorno4Hnm5jkuIrnmoTml6fniYjmnKzoo4Xlm57nlYzpnaLvvIzpobbmjonnlKjmiLfliJrlgZrnmoTmlLnliqjjgIJcbiAgLy8g6Leo5aSp5pe25Lmf5Zyo6L+Z6YeM6KGl5LiA5qyh5o+Q6YaS5qOA5p+l44CCXG4gIHVzZUVmZmVjdChmdW5jdGlvbiAoKSB7XG4gICAgaWYgKCFhY3RpdmUgfHwgIWludGVybmFsLmxvYWRlZCkgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICBpZiAoaW50ZXJuYWwudGltZXIgIT09IG51bGwgfHwgaW50ZXJuYWwuc2F2aW5nIHx8IHN0b3JlLmdldFNuYXBzaG90KCkuY29uZmxpY3QpIHJldHVybiB1bmRlZmluZWQ7XG4gICAgbG9hZCgpLnRoZW4oZnVuY3Rpb24gKCkge1xuICAgICAgaWYgKG1vZGVSZWYuY3VycmVudCA9PT0gJ2RyYWZ0JykgbG9hZERyYWZ0KCk7XG4gICAgICBpZiAoZGF5Q2hhbmdlZCgpKSBkdWVSZW1pbmRlcihzdG9yZS5nZXRTbmFwc2hvdCgpLmJvYXJkKTtcbiAgICB9KTtcbiAgICByZXR1cm4gdW5kZWZpbmVkO1xuICB9LCBbYWN0aXZlXSk7XG5cbiAgLy8g5pKk6ZSA5p2h5Yiw54K56Ieq5Yqo5pS26LW3XG4gIHVzZUVmZmVjdChmdW5jdGlvbiAoKSB7XG4gICAgaWYgKCF1bmRvKSByZXR1cm4gdW5kZWZpbmVkO1xuICAgIHZhciB0aW1lciA9IHNldFRpbWVvdXQoZnVuY3Rpb24gKCkge1xuICAgICAgc2V0VW5kbyhudWxsKTtcbiAgICB9LCBVTkRPX01TKTtcbiAgICByZXR1cm4gZnVuY3Rpb24gKCkge1xuICAgICAgY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgICB9O1xuICB9LCBbdW5kb10pO1xuXG4gIC8vIOaSreaKpee7meivu+Wxj+i9r+S7tu+8muaLluWKqOaIlumUruebmOenu+WKqOS5i+WQju+8jOWFiemdoOinhuinieWPjemmiOaYr+aUtuS4jeWIsOeahFxuICB1c2VFZmZlY3QoZnVuY3Rpb24gKCkge1xuICAgIGlmICghYW5ub3VuY2UpIHJldHVybiB1bmRlZmluZWQ7XG4gICAgdmFyIHRpbWVyID0gc2V0VGltZW91dChmdW5jdGlvbiAoKSB7XG4gICAgICBzZXRBbm5vdW5jZSgnJyk7XG4gICAgfSwgNDAwMCk7XG4gICAgcmV0dXJuIGZ1bmN0aW9uICgpIHtcbiAgICAgIGNsZWFyVGltZW91dCh0aW1lcik7XG4gICAgfTtcbiAgfSwgW2Fubm91bmNlXSk7XG5cbiAgdmFyIGJvYXJkID0gc3RhdGUuYm9hcmQ7XG4gIHZhciBsYW5lcyA9IGJvYXJkID8gYm9hcmQubGFuZXMgOiBbXTtcbiAgdmFyIGNhcmRzID0gYm9hcmQgPyBib2FyZC5jYXJkcyA6IHt9O1xuICB2YXIgdG9kYXkgPSB0b2RheUtleSgpO1xuXG4gIHZhciBtYXRjaGVzID0gdXNlTWVtbyhcbiAgICBmdW5jdGlvbiAoKSB7XG4gICAgICB2YXIgbWFwID0ge307XG4gICAgICB2YXIgaWRzID0gT2JqZWN0LmtleXMoY2FyZHMpO1xuICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCBpZHMubGVuZ3RoOyBpICs9IDEpIHtcbiAgICAgICAgdmFyIGNhcmQgPSBjYXJkc1tpZHNbaV1dO1xuICAgICAgICB2YXIgdmlzaWJsZSA9IHRydWU7XG4gICAgICAgIGlmIChjYXJkLmRvbmUgJiYgIXNob3dEb25lKSB2aXNpYmxlID0gZmFsc2U7XG4gICAgICAgIGlmICh2aXNpYmxlICYmIGZpbHRlciA9PT0gJ292ZXJkdWUnICYmICFpc092ZXJkdWUoY2FyZCwgdG9kYXkpKSB2aXNpYmxlID0gZmFsc2U7XG4gICAgICAgIGlmICh2aXNpYmxlICYmIGZpbHRlciA9PT0gJ2hpZ2gnICYmIGNhcmQucHJpb3JpdHkgIT09ICdoaWdoJykgdmlzaWJsZSA9IGZhbHNlO1xuICAgICAgICBpZiAodmlzaWJsZSAmJiAhbWF0Y2hlc1F1ZXJ5KGNhcmQsIHF1ZXJ5KSkgdmlzaWJsZSA9IGZhbHNlO1xuICAgICAgICBtYXBbY2FyZC5pZF0gPSB2aXNpYmxlO1xuICAgICAgfVxuICAgICAgcmV0dXJuIG1hcDtcbiAgICB9LFxuICAgIFtjYXJkcywgcXVlcnksIHNob3dEb25lLCBmaWx0ZXIsIHRvZGF5XVxuICApO1xuXG4gIHZhciBpZHMgPSBPYmplY3Qua2V5cyhjYXJkcyk7XG4gIHZhciBjb3VudEFsbCA9IGlkcy5sZW5ndGg7XG4gIHZhciBjb3VudERvbmUgPSAwO1xuICB2YXIgY291bnRPdmVyZHVlID0gMDtcbiAgdmFyIGNvdW50VG9kYXkgPSAwO1xuICB2YXIgY291bnRNYXRjaGVkID0gMDtcbiAgZm9yICh2YXIgaSA9IDA7IGkgPCBpZHMubGVuZ3RoOyBpICs9IDEpIHtcbiAgICB2YXIgaXRlbSA9IGNhcmRzW2lkc1tpXV07XG4gICAgaWYgKGl0ZW0uZG9uZSkgY291bnREb25lICs9IDE7XG4gICAgZWxzZSB7XG4gICAgICBpZiAoaXNPdmVyZHVlKGl0ZW0sIHRvZGF5KSkgY291bnRPdmVyZHVlICs9IDE7XG4gICAgICBlbHNlIGlmIChpdGVtLmR1ZSA9PT0gdG9kYXkpIGNvdW50VG9kYXkgKz0gMTtcbiAgICB9XG4gICAgaWYgKG1hdGNoZXNbaXRlbS5pZF0pIGNvdW50TWF0Y2hlZCArPSAxO1xuICB9XG5cbiAgdmFyIGFjdGl2ZURyYWcgPSBkcmFnUHJldmlldyA/IGRyYWdQcmV2aWV3LmtpbmQgOiBudWxsO1xuXG4gIC8vIC0tLSDmi5bliqggLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbiAgZnVuY3Rpb24gbWVhc3VyZUxhbmVCb2RpZXMoKSB7XG4gICAgdmFyIGJvZHlOb2RlcyA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLWxhbmUtYm9keT1cIjFcIl0nKTtcbiAgICB2YXIgZ2VvbWV0cnkgPSBbXTtcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGJvZHlOb2Rlcy5sZW5ndGg7IGkgKz0gMSkge1xuICAgICAgdmFyIG5vZGUgPSBib2R5Tm9kZXNbaV07XG4gICAgICB2YXIgYm94ID0gbm9kZS5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTtcbiAgICAgIHZhciBjYXJkTm9kZXMgPSBub2RlLnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLWNhcmQtaWRdJyk7XG4gICAgICB2YXIgZW50cmllcyA9IFtdO1xuICAgICAgZm9yICh2YXIgaiA9IDA7IGogPCBjYXJkTm9kZXMubGVuZ3RoOyBqICs9IDEpIHtcbiAgICAgICAgdmFyIGNhcmRCb3ggPSBjYXJkTm9kZXNbal0uZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7XG4gICAgICAgIGVudHJpZXMucHVzaCh7IGlkOiBjYXJkTm9kZXNbal0uZ2V0QXR0cmlidXRlKCdkYXRhLWNhcmQtaWQnKSwgdG9wOiBjYXJkQm94LnRvcCwgaGVpZ2h0OiBjYXJkQm94LmhlaWdodCB9KTtcbiAgICAgIH1cbiAgICAgIGdlb21ldHJ5LnB1c2goe1xuICAgICAgICBsYW5lSWQ6IG5vZGUuZ2V0QXR0cmlidXRlKCdkYXRhLWxhbmUtaWQnKSxcbiAgICAgICAgdG9wOiBib3gudG9wLFxuICAgICAgICBib3R0b206IGJveC5ib3R0b20sXG4gICAgICAgIGxlZnQ6IGJveC5sZWZ0LFxuICAgICAgICByaWdodDogYm94LnJpZ2h0LFxuICAgICAgICBjYXJkczogZW50cmllcyxcbiAgICAgIH0pO1xuICAgIH1cbiAgICByZXR1cm4gZ2VvbWV0cnk7XG4gIH1cblxuICBmdW5jdGlvbiBtZWFzdXJlTGFuZXMoKSB7XG4gICAgdmFyIG5vZGVzID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmthbmJhbl9fbGFuZVtkYXRhLWxhbmUtaWRdJyk7XG4gICAgdmFyIGJveGVzID0gW107XG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBub2Rlcy5sZW5ndGg7IGkgKz0gMSkge1xuICAgICAgdmFyIGJveCA9IG5vZGVzW2ldLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpO1xuICAgICAgYm94ZXMucHVzaCh7XG4gICAgICAgIGxhbmVJZDogbm9kZXNbaV0uZ2V0QXR0cmlidXRlKCdkYXRhLWxhbmUtaWQnKSxcbiAgICAgICAgbGVmdDogYm94LmxlZnQsXG4gICAgICAgIHJpZ2h0OiBib3gucmlnaHQsXG4gICAgICAgIGNlbnRlcjogYm94LmxlZnQgKyBib3gud2lkdGggLyAyLFxuICAgICAgfSk7XG4gICAgfVxuICAgIHJldHVybiBib3hlcztcbiAgfVxuXG4gIGZ1bmN0aW9uIGNvbXB1dGVDYXJkRHJvcChjbGllbnRYLCBjbGllbnRZKSB7XG4gICAgdmFyIGdlb21ldHJ5ID0gZ2VvbWV0cnlSZWYuY3VycmVudDtcbiAgICBpZiAoIWdlb21ldHJ5IHx8IGdlb21ldHJ5Lmxlbmd0aCA9PT0gMCkgcmV0dXJuIG51bGw7XG5cbiAgICB2YXIgdGFyZ2V0ID0gbnVsbDtcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGdlb21ldHJ5Lmxlbmd0aDsgaSArPSAxKSB7XG4gICAgICBpZiAoY2xpZW50WSA+PSBnZW9tZXRyeVtpXS50b3AgJiYgY2xpZW50WSA8PSBnZW9tZXRyeVtpXS5ib3R0b20pIHtcbiAgICAgICAgdGFyZ2V0ID0gZ2VvbWV0cnlbaV07XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgIH1cbiAgICBpZiAoIXRhcmdldCkge1xuICAgICAgLy8g5oyH6ZKI6JC95Zyo5YiX6KGo5LmL6Ze055qE56m66ZqZ5oiW5YiX6KGo5LiL5pa577ya5Y+W5rC05bmz6Led56a75pyA6L+R55qE6YKj5LiA5YiXXG4gICAgICB2YXIgYmVzdCA9IG51bGw7XG4gICAgICB2YXIgYmVzdERpc3RhbmNlID0gSW5maW5pdHk7XG4gICAgICBmb3IgKHZhciBqID0gMDsgaiA8IGdlb21ldHJ5Lmxlbmd0aDsgaiArPSAxKSB7XG4gICAgICAgIHZhciBjZW50ZXIgPSAoZ2VvbWV0cnlbal0ubGVmdCArIGdlb21ldHJ5W2pdLnJpZ2h0KSAvIDI7XG4gICAgICAgIHZhciBkaXN0YW5jZSA9IE1hdGguYWJzKGNsaWVudFggLSBjZW50ZXIpO1xuICAgICAgICBpZiAoZGlzdGFuY2UgPCBiZXN0RGlzdGFuY2UpIHtcbiAgICAgICAgICBiZXN0RGlzdGFuY2UgPSBkaXN0YW5jZTtcbiAgICAgICAgICBiZXN0ID0gZ2VvbWV0cnlbal07XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIHRhcmdldCA9IGJlc3Q7XG4gICAgfVxuICAgIGlmICghdGFyZ2V0KSByZXR1cm4gbnVsbDtcblxuICAgIC8vIOaMh+mSiOiQveWcqOesrCBuIOW8oOWNoeeJh+eahOWTquS4gOWNiu+8jOWGs+WumuWug+aPkuWIsOi/meW8oOWNoeeJh+S5i+WJjei/mOaYr+S5i+WQjlxuICAgIHZhciBpbmRleCA9IHRhcmdldC5jYXJkcy5sZW5ndGg7XG4gICAgZm9yICh2YXIgayA9IDA7IGsgPCB0YXJnZXQuY2FyZHMubGVuZ3RoOyBrICs9IDEpIHtcbiAgICAgIHZhciBlbnRyeSA9IHRhcmdldC5jYXJkc1trXTtcbiAgICAgIGlmIChjbGllbnRZIDwgZW50cnkudG9wICsgZW50cnkuaGVpZ2h0IC8gMikge1xuICAgICAgICBpbmRleCA9IGs7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgIH1cblxuICAgIHZhciBwcmV2ID0gaW5kZXggPiAwID8gdGFyZ2V0LmNhcmRzW2luZGV4IC0gMV0gOiBudWxsO1xuICAgIHZhciBuZXh0ID0gaW5kZXggPCB0YXJnZXQuY2FyZHMubGVuZ3RoID8gdGFyZ2V0LmNhcmRzW2luZGV4XSA6IG51bGw7XG4gICAgcmV0dXJuIHtcbiAgICAgIGxhbmVJZDogdGFyZ2V0LmxhbmVJZCxcbiAgICAgIGluZGV4OiBpbmRleCxcbiAgICAgIGJlZm9yZUlkOiBwcmV2ID8gcHJldi5pZCA6IG51bGwsXG4gICAgICBhZnRlcklkOiBuZXh0ID8gbmV4dC5pZCA6IG51bGwsXG4gICAgfTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGNvbXB1dGVMYW5lRHJvcChjbGllbnRYKSB7XG4gICAgdmFyIGJveGVzID0gbGFuZUJveGVzUmVmLmN1cnJlbnQ7XG4gICAgaWYgKCFib3hlcyB8fCBib3hlcy5sZW5ndGggPT09IDApIHJldHVybiBudWxsO1xuXG4gICAgdmFyIG5lYXJlc3QgPSBudWxsO1xuICAgIHZhciBiZXN0RGlzdGFuY2UgPSBJbmZpbml0eTtcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGJveGVzLmxlbmd0aDsgaSArPSAxKSB7XG4gICAgICB2YXIgZGlzdGFuY2UgPSBNYXRoLmFicyhjbGllbnRYIC0gYm94ZXNbaV0uY2VudGVyKTtcbiAgICAgIGlmIChkaXN0YW5jZSA8IGJlc3REaXN0YW5jZSkge1xuICAgICAgICBiZXN0RGlzdGFuY2UgPSBkaXN0YW5jZTtcbiAgICAgICAgbmVhcmVzdCA9IGJveGVzW2ldO1xuICAgICAgfVxuICAgIH1cbiAgICBpZiAoIW5lYXJlc3QpIHJldHVybiBudWxsO1xuXG4gICAgLy8g6JC95Zyo5bem5Y2K6L655bCx5o+S5Yiw5a6D5YmN6Z2i77yM5Y+z5Y2K6L655o+S5Yiw5a6D5ZCO6Z2iXG4gICAgdmFyIGFmdGVyID0gY2xpZW50WCA+IG5lYXJlc3QuY2VudGVyO1xuICAgIHZhciBpbmRleCA9IC0xO1xuICAgIGZvciAodmFyIGogPSAwOyBqIDwgYm94ZXMubGVuZ3RoOyBqICs9IDEpIHtcbiAgICAgIGlmIChib3hlc1tqXS5sYW5lSWQgPT09IG5lYXJlc3QubGFuZUlkKSB7XG4gICAgICAgIGluZGV4ID0gajtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgfVxuICAgIGlmIChpbmRleCA8IDApIHJldHVybiBudWxsO1xuICAgIHZhciB0YXJnZXRJbmRleCA9IGFmdGVyID8gaW5kZXggKyAxIDogaW5kZXg7XG4gICAgdmFyIGJlZm9yZUxhbmUgPSB0YXJnZXRJbmRleCA+IDAgPyBib3hlc1t0YXJnZXRJbmRleCAtIDFdIDogbnVsbDtcbiAgICB2YXIgYWZ0ZXJMYW5lID0gdGFyZ2V0SW5kZXggPCBib3hlcy5sZW5ndGggPyBib3hlc1t0YXJnZXRJbmRleF0gOiBudWxsO1xuICAgIHJldHVybiB7XG4gICAgICB0YXJnZXRJbmRleDogdGFyZ2V0SW5kZXgsXG4gICAgICBiZWZvcmVJZDogYmVmb3JlTGFuZSA/IGJlZm9yZUxhbmUubGFuZUlkIDogbnVsbCxcbiAgICAgIGFmdGVySWQ6IGFmdGVyTGFuZSA/IGFmdGVyTGFuZS5sYW5lSWQgOiBudWxsLFxuICAgIH07XG4gIH1cblxuICBmdW5jdGlvbiBjbGVhckRyYWcoKSB7XG4gICAgZHJhZ2dpbmdSZWYuY3VycmVudCA9IG51bGw7XG4gICAgZ2VvbWV0cnlSZWYuY3VycmVudCA9IG51bGw7XG4gICAgbGFuZUJveGVzUmVmLmN1cnJlbnQgPSBudWxsO1xuICAgIHNldERyYWdQcmV2aWV3KG51bGwpO1xuICAgIHNldERyb3AobnVsbCk7XG4gICAgc2V0TGFuZURyb3AobnVsbCk7XG4gIH1cblxuICAvKiog6auY5Lqu5Yia6JC95Yiw5paw5L2N572u55qE5Y2h54mH77yM6K6p44CM56Gu5a6e5oyq6L+H5Y675LqG44CN6L+Z5Lu25LqL55yL5b6X6KeB44CCICovXG4gIGZ1bmN0aW9uIGZsYXNoTW92ZWQoY2FyZElkKSB7XG4gICAgc2V0SnVzdE1vdmVkSWQoY2FyZElkKTtcbiAgICBpZiAobW92ZUZsYXNoUmVmLmN1cnJlbnQgIT09IG51bGwpIGNsZWFyVGltZW91dChtb3ZlRmxhc2hSZWYuY3VycmVudCk7XG4gICAgbW92ZUZsYXNoUmVmLmN1cnJlbnQgPSBzZXRUaW1lb3V0KGZ1bmN0aW9uICgpIHtcbiAgICAgIG1vdmVGbGFzaFJlZi5jdXJyZW50ID0gbnVsbDtcbiAgICAgIHNldEp1c3RNb3ZlZElkKG51bGwpO1xuICAgIH0sIDEyMDApO1xuICB9XG5cbiAgLyoqXG4gICAqIOe7n+S4gOeahOaLluWKqOi/h+eoi+OAgmtpbmQg5Yaz5a6a5rWL5LuA5LmI44CB55S75LuA5LmI44CB5p2+5omL5ZCO5YGa5LuA5LmI77yaXG4gICAqICAgJ2NhcmQnIOKAlOKAlCDljaHniYflnKjliJfooajlhoXmjaLkvY3miJbmjaLliJfooahcbiAgICogICAnbGFuZScg4oCU4oCUIOWIl+ihqOaVtOS9k+aNouS9jVxuICAgKiDkuKTogIXlhbHnlKjlkIzkuIDlpZfjgIzpmIjlgLwg4oaSIOiQveeCuSDihpIg5Y+W5raIIOKGkiDmnb7miYvjgI3mtYHnqIvvvIzpgb/lhY3kuKTku73lrp7njrDooYzkuLrkuI3kuIDoh7TjgIJcbiAgICovXG4gIGZ1bmN0aW9uIHN0YXJ0RHJhZyhraW5kLCB0YXJnZXRJZCwgZXZlbnQpIHtcbiAgICBpZiAoZHJhZ2dpbmdSZWYuY3VycmVudCkgcmV0dXJuO1xuICAgIHZhciBjdXJyZW50Qm9hcmQgPSBzdG9yZS5nZXRTbmFwc2hvdCgpLmJvYXJkO1xuICAgIGlmICghY3VycmVudEJvYXJkKSByZXR1cm47XG5cbiAgICB2YXIgYW5jaG9yID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcihcbiAgICAgIChraW5kID09PSAnY2FyZCcgPyAnW2RhdGEtY2FyZC1pZD1cIicgOiAnLmthbmJhbl9fbGFuZVtkYXRhLWxhbmUtaWQ9XCInKSArIHRhcmdldElkICsgJ1wiXSdcbiAgICApO1xuICAgIGlmICghYW5jaG9yKSByZXR1cm47XG5cbiAgICBpZiAoa2luZCA9PT0gJ2NhcmQnKSB7XG4gICAgICBpZiAoIWN1cnJlbnRCb2FyZC5jYXJkc1t0YXJnZXRJZF0pIHJldHVybjtcbiAgICAgIGdlb21ldHJ5UmVmLmN1cnJlbnQgPSBtZWFzdXJlTGFuZUJvZGllcygpO1xuICAgIH0gZWxzZSB7XG4gICAgICBpZiAoIWxhbmVCeUlkKGN1cnJlbnRCb2FyZCwgdGFyZ2V0SWQpKSByZXR1cm47XG4gICAgICBsYW5lQm94ZXNSZWYuY3VycmVudCA9IG1lYXN1cmVMYW5lcygpO1xuICAgIH1cblxuICAgIHZhciBib3ggPSBhbmNob3IuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7XG4gICAgdmFyIGRyYWcgPSB7XG4gICAgICBraW5kOiBraW5kLFxuICAgICAgdGFyZ2V0SWQ6IHRhcmdldElkLFxuICAgICAgd2lkdGg6IGJveC53aWR0aCxcbiAgICAgIGhlaWdodDogYm94LmhlaWdodCxcbiAgICAgIG9mZnNldFg6IGV2ZW50LmNsaWVudFggLSBib3gubGVmdCxcbiAgICAgIG9mZnNldFk6IGV2ZW50LmNsaWVudFkgLSBib3gudG9wLFxuICAgICAgbW92ZWQ6IGZhbHNlLFxuICAgIH07XG4gICAgZHJhZ2dpbmdSZWYuY3VycmVudCA9IGRyYWc7XG4gICAgdmFyIG9yaWdpbiA9IHsgeDogZXZlbnQuY2xpZW50WCwgeTogZXZlbnQuY2xpZW50WSB9O1xuXG4gICAgZnVuY3Rpb24gb25Nb3ZlKG1vdmVFdmVudCkge1xuICAgICAgdmFyIGN1cnJlbnQgPSBkcmFnZ2luZ1JlZi5jdXJyZW50O1xuICAgICAgaWYgKCFjdXJyZW50KSByZXR1cm47XG4gICAgICBpZiAoIWN1cnJlbnQubW92ZWQpIHtcbiAgICAgICAgdmFyIGR4ID0gbW92ZUV2ZW50LmNsaWVudFggLSBvcmlnaW4ueDtcbiAgICAgICAgdmFyIGR5ID0gbW92ZUV2ZW50LmNsaWVudFkgLSBvcmlnaW4ueTtcbiAgICAgICAgaWYgKGR4ICogZHggKyBkeSAqIGR5IDwgRFJBR19USFJFU0hPTEQgKiBEUkFHX1RIUkVTSE9MRCkgcmV0dXJuOyAvLyDmipbliqjkuI3nrpfmi5bliqjvvIzpgb/lhY3or6/op6ZcbiAgICAgICAgY3VycmVudC5tb3ZlZCA9IHRydWU7XG4gICAgICAgIGRvY3VtZW50LmJvZHkuY2xhc3NMaXN0LmFkZCgna2FuYmFuLWRyYWdnaW5nJyk7XG4gICAgICB9XG4gICAgICBtb3ZlRXZlbnQucHJldmVudERlZmF1bHQoKTtcblxuICAgICAgaWYgKGtpbmQgPT09ICdjYXJkJykge1xuICAgICAgICB2YXIgY2FyZCA9IHN0b3JlLmdldFNuYXBzaG90KCkuYm9hcmQuY2FyZHNbdGFyZ2V0SWRdO1xuICAgICAgICBpZiAoIWNhcmQpIHJldHVybjtcbiAgICAgICAgdmFyIG5leHQgPSBjb21wdXRlQ2FyZERyb3AobW92ZUV2ZW50LmNsaWVudFgsIG1vdmVFdmVudC5jbGllbnRZKTtcbiAgICAgICAgaWYgKG5leHQpIHtcbiAgICAgICAgICBzZXREcm9wKG5leHQpO1xuICAgICAgICAgIHNldERyYWdQcmV2aWV3KHtcbiAgICAgICAgICAgIGtpbmQ6ICdjYXJkJyxcbiAgICAgICAgICAgIHRpdGxlOiBjYXJkLnRpdGxlLFxuICAgICAgICAgICAgbGFuZU5hbWU6IGxhbmVOYW1lT2Yoc3RvcmUuZ2V0U25hcHNob3QoKS5ib2FyZCwgbmV4dC5sYW5lSWQpLFxuICAgICAgICAgICAgb3ZlckxhbmU6IG5leHQubGFuZUlkICE9PSBjYXJkLmxhbmVJZCxcbiAgICAgICAgICAgIHg6IG1vdmVFdmVudC5jbGllbnRYIC0gY3VycmVudC5vZmZzZXRYLFxuICAgICAgICAgICAgeTogbW92ZUV2ZW50LmNsaWVudFkgLSBjdXJyZW50Lm9mZnNldFksXG4gICAgICAgICAgICB3aWR0aDogY3VycmVudC53aWR0aCxcbiAgICAgICAgICB9KTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBzZXREcmFnUHJldmlldyh7XG4gICAgICAgICAgICBraW5kOiAnY2FyZCcsXG4gICAgICAgICAgICB0aXRsZTogY2FyZC50aXRsZSxcbiAgICAgICAgICAgIGxhbmVOYW1lOiBudWxsLFxuICAgICAgICAgICAgb3ZlckxhbmU6IGZhbHNlLFxuICAgICAgICAgICAgeDogbW92ZUV2ZW50LmNsaWVudFggLSBjdXJyZW50Lm9mZnNldFgsXG4gICAgICAgICAgICB5OiBtb3ZlRXZlbnQuY2xpZW50WSAtIGN1cnJlbnQub2Zmc2V0WSxcbiAgICAgICAgICAgIHdpZHRoOiBjdXJyZW50LndpZHRoLFxuICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgLy8g5YiX6KGo5ouW5YqoXG4gICAgICB2YXIgbGFuZSA9IGxhbmVCeUlkKHN0b3JlLmdldFNuYXBzaG90KCkuYm9hcmQsIHRhcmdldElkKTtcbiAgICAgIGlmICghbGFuZSkgcmV0dXJuO1xuICAgICAgdmFyIGxhbmVOZXh0ID0gY29tcHV0ZUxhbmVEcm9wKG1vdmVFdmVudC5jbGllbnRYKTtcbiAgICAgIGlmIChsYW5lTmV4dCkgc2V0TGFuZURyb3AobGFuZU5leHQpO1xuICAgICAgc2V0RHJhZ1ByZXZpZXcoe1xuICAgICAgICBraW5kOiAnbGFuZScsXG4gICAgICAgIHRpdGxlOiBsYW5lLm5hbWUsXG4gICAgICAgIGxhbmVOYW1lOiBsYW5lTmV4dCA/ICfmlL7liLDnrKwgJyArIChsYW5lTmV4dC50YXJnZXRJbmRleCArIDEpICsgJyDmoI8nIDogbnVsbCxcbiAgICAgICAgb3ZlckxhbmU6IGZhbHNlLFxuICAgICAgICB4OiBtb3ZlRXZlbnQuY2xpZW50WCAtIGN1cnJlbnQub2Zmc2V0WCxcbiAgICAgICAgeTogbW92ZUV2ZW50LmNsaWVudFkgLSBjdXJyZW50Lm9mZnNldFksXG4gICAgICAgIHdpZHRoOiBjdXJyZW50LndpZHRoLFxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gZGV0YWNoKCkge1xuICAgICAgd2luZG93LnJlbW92ZUV2ZW50TGlzdGVuZXIoJ3BvaW50ZXJtb3ZlJywgb25Nb3ZlKTtcbiAgICAgIHdpbmRvdy5yZW1vdmVFdmVudExpc3RlbmVyKCdwb2ludGVydXAnLCBvblVwKTtcbiAgICAgIHdpbmRvdy5yZW1vdmVFdmVudExpc3RlbmVyKCdwb2ludGVyY2FuY2VsJywgb25DYW5jZWwpO1xuICAgICAgd2luZG93LnJlbW92ZUV2ZW50TGlzdGVuZXIoJ2tleWRvd24nLCBvbktleSk7XG4gICAgICBkb2N1bWVudC5ib2R5LmNsYXNzTGlzdC5yZW1vdmUoJ2thbmJhbi1kcmFnZ2luZycpO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIG9uVXAodXBFdmVudCkge1xuICAgICAgZGV0YWNoKCk7XG4gICAgICB2YXIgY3VycmVudCA9IGRyYWdnaW5nUmVmLmN1cnJlbnQ7XG4gICAgICBpZiAoIWN1cnJlbnQpIHJldHVybjtcbiAgICAgIGlmICghY3VycmVudC5tb3ZlZCkge1xuICAgICAgICBjbGVhckRyYWcoKTsgLy8g5rKh5pyJ55yf5q2j56e75Yqo77ya5b2T5oiQ5LiA5qyh5pmu6YCa54K55Ye777yM5LiN5Yqo5pWw5o2uXG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgaWYgKGtpbmQgPT09ICdjYXJkJykge1xuICAgICAgICB2YXIgdGFyZ2V0ID0gY29tcHV0ZUNhcmREcm9wKHVwRXZlbnQuY2xpZW50WCwgdXBFdmVudC5jbGllbnRZKTtcbiAgICAgICAgdmFyIHNvdXJjZUxhbmVJZCA9IHN0b3JlLmdldFNuYXBzaG90KCkuYm9hcmQuY2FyZHNbdGFyZ2V0SWRdLmxhbmVJZDtcbiAgICAgICAgY2xlYXJEcmFnKCk7XG4gICAgICAgIGlmICghdGFyZ2V0KSByZXR1cm47XG4gICAgICAgIGJvYXJkQWN0aW9ucy5tb3ZlQ2FyZCh0YXJnZXRJZCwgdGFyZ2V0LmxhbmVJZCwgdGFyZ2V0LmJlZm9yZUlkLCB0YXJnZXQuYWZ0ZXJJZCk7XG4gICAgICAgIHZhciBuYW1lID0gbGFuZU5hbWVPZihzdG9yZS5nZXRTbmFwc2hvdCgpLmJvYXJkLCB0YXJnZXQubGFuZUlkKTtcbiAgICAgICAgZmxhc2hNb3ZlZCh0YXJnZXRJZCk7XG4gICAgICAgIHNldEFubm91bmNlKFxuICAgICAgICAgIHRhcmdldC5sYW5lSWQgPT09IHNvdXJjZUxhbmVJZCA/ICflt7LlnKjjgIwnICsgbmFtZSArICfjgI3lhoXosIPmlbTpobrluo8nIDogJ+W3suenu+WKqOWIsOOAjCcgKyBuYW1lICsgJ+OAjSdcbiAgICAgICAgKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuXG4gICAgICB2YXIgbGFuZVRhcmdldCA9IGNvbXB1dGVMYW5lRHJvcCh1cEV2ZW50LmNsaWVudFgpO1xuICAgICAgdmFyIGxhbmVOYW1lID0gbGFuZU5hbWVPZihzdG9yZS5nZXRTbmFwc2hvdCgpLmJvYXJkLCB0YXJnZXRJZCk7XG4gICAgICBjbGVhckRyYWcoKTtcbiAgICAgIGlmICghbGFuZVRhcmdldCkgcmV0dXJuO1xuICAgICAgYm9hcmRBY3Rpb25zLm1vdmVMYW5lKHRhcmdldElkLCBsYW5lVGFyZ2V0LnRhcmdldEluZGV4KTtcbiAgICAgIHNldEFubm91bmNlKCfliJfooajjgIwnICsgbGFuZU5hbWUgKyAn44CN5bey5pS+5Yiw56ysICcgKyAobGFuZVRhcmdldC50YXJnZXRJbmRleCArIDEpICsgJyDmoI8nKTtcbiAgICB9XG5cbiAgICBmdW5jdGlvbiBvbkNhbmNlbCgpIHtcbiAgICAgIGRldGFjaCgpO1xuICAgICAgY2xlYXJEcmFnKCk7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gb25LZXkoa2V5RXZlbnQpIHtcbiAgICAgIGlmIChrZXlFdmVudC5rZXkgIT09ICdFc2NhcGUnKSByZXR1cm47XG4gICAgICBrZXlFdmVudC5wcmV2ZW50RGVmYXVsdCgpO1xuICAgICAgb25DYW5jZWwoKTtcbiAgICB9XG5cbiAgICB3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcigncG9pbnRlcm1vdmUnLCBvbk1vdmUpO1xuICAgIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKCdwb2ludGVydXAnLCBvblVwKTtcbiAgICB3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcigncG9pbnRlcmNhbmNlbCcsIG9uQ2FuY2VsKTtcbiAgICB3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcigna2V5ZG93bicsIG9uS2V5KTtcbiAgfVxuXG4gIGZ1bmN0aW9uIG1vdmVDYXJkVG9MYW5lKGNhcmRJZCwgbGFuZUluZGV4KSB7XG4gICAgdmFyIHRhcmdldCA9IGJvYXJkICYmIGJvYXJkLmxhbmVzW2xhbmVJbmRleF07XG4gICAgaWYgKCF0YXJnZXQpIHJldHVybjtcbiAgICBib2FyZEFjdGlvbnMubW92ZUNhcmQoY2FyZElkLCB0YXJnZXQuaWQsIG51bGwsIG51bGwpO1xuICAgIGZsYXNoTW92ZWQoY2FyZElkKTtcbiAgICBzZXRBbm5vdW5jZSgn5bey56e75Yqo5Yiw44CMJyArIHRhcmdldC5uYW1lICsgJ+OAjScpO1xuICB9XG5cbiAgZnVuY3Rpb24gcmVtb3ZlQ2FyZChjYXJkSWQpIHtcbiAgICB2YXIgY3VycmVudCA9IHN0b3JlLmdldFNuYXBzaG90KCkuYm9hcmQ7XG4gICAgaWYgKCFjdXJyZW50IHx8ICFjdXJyZW50LmNhcmRzW2NhcmRJZF0pIHJldHVybjtcbiAgICB2YXIgc25hcHNob3QgPSBjbG9uZShjdXJyZW50LmNhcmRzW2NhcmRJZF0pO1xuICAgIHZhciB0aXRsZSA9IGJvYXJkQWN0aW9ucy5kZWxldGVDYXJkKGNhcmRJZCk7XG4gICAgc2V0RWRpdGluZ0lkKG51bGwpO1xuICAgIHNldFVuZG8oeyBraW5kOiAnY2FyZCcsIGNhcmQ6IHNuYXBzaG90LCB0aXRsZTogdGl0bGUgfSk7XG4gICAgc2V0QW5ub3VuY2UoJ+W3suWIoOmZpOOAjCcgKyAodGl0bGUgfHwgJ+WNoeeJhycpICsgJ+OAje+8jOWPr+S7peaSpOmUgCcpO1xuICB9XG5cbiAgZnVuY3Rpb24gcmVtb3ZlTGFuZShsYW5lSWQpIHtcbiAgICB2YXIgcmVtb3ZlZCA9IGJvYXJkQWN0aW9ucy5kZWxldGVMYW5lKGxhbmVJZCk7XG4gICAgaWYgKCFyZW1vdmVkKSB7XG4gICAgICBzZXRBbm5vdW5jZSgn6Iez5bCR6KaB5L+d55WZ5LiA5Liq5YiX6KGoJyk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIHNldFVuZG8oeyBraW5kOiAnbGFuZScsIGxhbmU6IHJlbW92ZWQgfSk7XG4gICAgc2V0QW5ub3VuY2UoJ+W3suWIoOmZpOWIl+ihqOOAjCcgKyByZW1vdmVkLm5hbWUgKyAn44CN77yM5Y+v5Lul5pKk6ZSAJyk7XG4gICAgbm90aWZ5KFxuICAgICAgJ+WIl+ihqOOAjCcgKyByZW1vdmVkLm5hbWUgKyAn44CN5bey5Yig6ZmkJyxcbiAgICAgIHJlbW92ZWQuY2FyZHMubGVuZ3RoID4gMCA/ICflhbbkuK3nmoQgJyArIHJlbW92ZWQuY2FyZHMubGVuZ3RoICsgJyDlvKDljaHniYfkuZ/kuIDotbfnp7vpmaTkuobjgIInIDogJ+ivpeWIl+ihqOWOn+acrOaYr+epuueahOOAgicsXG4gICAgICAna2FuYmFuLWxhbmUtcmVtb3ZlZCdcbiAgICApO1xuICB9XG5cbiAgZnVuY3Rpb24gc2VuZExpbmVUb0JvYXJkKGxhbmVJZCwgdGl0bGUpIHtcbiAgICB2YXIgY2FyZElkID0gYm9hcmRBY3Rpb25zLmFkZENhcmQobGFuZUlkLCB0aXRsZSwgJ25vcm1hbCcsIG51bGwsIG51bGwpO1xuICAgIGlmICghY2FyZElkKSByZXR1cm47XG4gICAgc2V0QW5ub3VuY2UoJ+W3suaKiuOAjCcgKyB0aXRsZSArICfjgI3liqDlhaXjgIwnICsgbGFuZU5hbWVPZihzdG9yZS5nZXRTbmFwc2hvdCgpLmJvYXJkLCBsYW5lSWQpICsgJ+OAjScpO1xuICB9XG5cbiAgZnVuY3Rpb24gdG9nZ2xlTm90aWZ5KCkge1xuICAgIHZhciBwcmVmcyA9IHN0b3JlLmdldFNuYXBzaG90KCkucHJlZnMgfHwgeyBub3RpZnk6IHRydWUgfTtcbiAgICB2YXIgbmV4dCA9IHsgbm90aWZ5OiBwcmVmcy5ub3RpZnkgPT09IGZhbHNlIH07XG4gICAgc3RvcmUuc2V0KHsgcHJlZnM6IG5leHQgfSk7XG4gICAgc2F2ZVByZWZzTm93KG5leHQpO1xuICAgIGlmIChuZXh0Lm5vdGlmeSkge1xuICAgICAgZHVlUmVtaW5kZXIoc3RvcmUuZ2V0U25hcHNob3QoKS5ib2FyZCk7XG4gICAgICBub3RpZnkoJ+WIsOacn+aPkOmGkuW3suW8gOWQrycsICfmnInljaHniYfliLDmnJ/miJbpgL7mnJ/ml7bvvIzmiJHkvJrlnKjov5nkuKrlupTnlKjph4zmj5DphpLkvaDkuIDmrKHjgIInLCAna2FuYmFuLW5vdGlmeS1vbicpO1xuICAgIH1cbiAgfVxuXG4gIGZ1bmN0aW9uIG9uUm9vdEtleURvd24oZXZlbnQpIHtcbiAgICB2YXIgbW9kaWZpZXIgPSBldmVudC5jdHJsS2V5IHx8IGV2ZW50Lm1ldGFLZXk7XG4gICAgaWYgKG1vZGlmaWVyICYmIChldmVudC5rZXkgPT09ICduJyB8fCBldmVudC5rZXkgPT09ICdOJykpIHtcbiAgICAgIGlmICh2aWV3ICE9PSAnYm9hcmQnKSBzZXRWaWV3KCdib2FyZCcpO1xuICAgICAgZXZlbnQucHJldmVudERlZmF1bHQoKTtcbiAgICAgIHZhciBmaXJzdCA9IGJvYXJkICYmIGJvYXJkLmxhbmVzWzBdO1xuICAgICAgaWYgKCFmaXJzdCkgcmV0dXJuO1xuICAgICAgdmFyIGV4aXN0aW5nID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcignW2RhdGEtbGFuZS1pZD1cIicgKyBmaXJzdC5pZCArICdcIl0gLmthbmJhbl9fY29tcG9zZXIgaW5wdXQnKTtcbiAgICAgIGlmIChleGlzdGluZykge1xuICAgICAgICBleGlzdGluZy5mb2N1cygpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICB2YXIgYWRkQnV0dG9uID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcignW2RhdGEtbGFuZS1pZD1cIicgKyBmaXJzdC5pZCArICdcIl0gLmthbmJhbl9fYWRkJyk7XG4gICAgICBpZiAoYWRkQnV0dG9uKSBhZGRCdXR0b24uY2xpY2soKTtcbiAgICAgIHJlcXVlc3RBbmltYXRpb25GcmFtZShmdW5jdGlvbiAoKSB7XG4gICAgICAgIHZhciBsYXRlciA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJ1tkYXRhLWxhbmUtaWQ9XCInICsgZmlyc3QuaWQgKyAnXCJdIC5rYW5iYW5fX2NvbXBvc2VyIGlucHV0Jyk7XG4gICAgICAgIGlmIChsYXRlcikgbGF0ZXIuZm9jdXMoKTtcbiAgICAgIH0pO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAobW9kaWZpZXIgJiYgKGV2ZW50LmtleSA9PT0gJ2YnIHx8IGV2ZW50LmtleSA9PT0gJ0YnKSkge1xuICAgICAgZXZlbnQucHJldmVudERlZmF1bHQoKTtcbiAgICAgIHZhciBzZWFyY2ggPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCcua2FuYmFuX19zZWFyY2ggaW5wdXQnKTtcbiAgICAgIGlmIChzZWFyY2gpIHNlYXJjaC5mb2N1cygpO1xuICAgIH1cbiAgfVxuXG4gIC8vIC0tLSDmuLLmn5MgLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbiAgdmFyIGVkaXRpbmcgPSBlZGl0aW5nSWQgJiYgYm9hcmQgPyBib2FyZC5jYXJkc1tlZGl0aW5nSWRdIDogbnVsbDtcbiAgdmFyIHByZWZzID0gc3RhdGUucHJlZnMgfHwgeyBub3RpZnk6IHRydWUgfTtcblxuICB2YXIgaGVhZGVyID0gaChcbiAgICAnaGVhZGVyJyxcbiAgICB7IGNsYXNzTmFtZTogJ2thbmJhbl9faGVhZGVyJyB9LFxuICAgIGgoXG4gICAgICAnZGl2JyxcbiAgICAgIHsgY2xhc3NOYW1lOiAna2FuYmFuX19oZWFkZXItdG9wJyB9LFxuICAgICAgaChcbiAgICAgICAgJ2RpdicsXG4gICAgICAgIHsgY2xhc3NOYW1lOiAna2FuYmFuX190aXRsZS1ibG9jaycgfSxcbiAgICAgICAgaCgnaDEnLCB7IGNsYXNzTmFtZTogJ2thbmJhbl9fdGl0bGUnIH0sICfnnIvmnb8nKSxcbiAgICAgICAgaChcbiAgICAgICAgICAncCcsXG4gICAgICAgICAgeyBjbGFzc05hbWU6ICdrYW5iYW5fX3N1YnRpdGxlJyB9LFxuICAgICAgICAgIGdyZWV0aW5nKCkgK1xuICAgICAgICAgICAgJ+OAgicgK1xuICAgICAgICAgICAgKGNvdW50QWxsID09PSAwXG4gICAgICAgICAgICAgID8gJ+i/mOayoeacieWNoeeJh+OAgidcbiAgICAgICAgICAgICAgOiBjb3VudE92ZXJkdWUgPiAwXG4gICAgICAgICAgICAgID8gJ+aciSAnICsgY291bnRPdmVyZHVlICsgJyDpobnlt7Lnu4/pgL7mnJ/jgIInXG4gICAgICAgICAgICAgIDogY291bnRUb2RheSA+IDBcbiAgICAgICAgICAgICAgPyAn5LuK5aSp5pyJICcgKyBjb3VudFRvZGF5ICsgJyDpobnliLDmnJ/jgIInXG4gICAgICAgICAgICAgIDogJ+WFsSAnICsgY291bnRBbGwgKyAnIOmhue+8jOWFtuS4rSAnICsgY291bnREb25lICsgJyDpobnlt7LlrozmiJDjgIInKVxuICAgICAgICApXG4gICAgICApLFxuICAgICAgaChcbiAgICAgICAgJ2RpdicsXG4gICAgICAgIHsgY2xhc3NOYW1lOiAna2FuYmFuX190YWJzJywgcm9sZTogJ3RhYmxpc3QnLCAnYXJpYS1sYWJlbCc6ICfop4blm77liIfmjaInIH0sXG4gICAgICAgIGgoXG4gICAgICAgICAgJ2J1dHRvbicsXG4gICAgICAgICAge1xuICAgICAgICAgICAgdHlwZTogJ2J1dHRvbicsXG4gICAgICAgICAgICByb2xlOiAndGFiJyxcbiAgICAgICAgICAgIGNsYXNzTmFtZTogJ2thbmJhbl9fdGFiJyArICh2aWV3ID09PSAnYm9hcmQnID8gJyBpcy1hY3RpdmUnIDogJycpLFxuICAgICAgICAgICAgJ2FyaWEtc2VsZWN0ZWQnOiB2aWV3ID09PSAnYm9hcmQnLFxuICAgICAgICAgICAgb25DbGljazogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICBzZXRWaWV3KCdib2FyZCcpO1xuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9LFxuICAgICAgICAgICfnnIvmnb8nXG4gICAgICAgICksXG4gICAgICAgIGgoXG4gICAgICAgICAgJ2J1dHRvbicsXG4gICAgICAgICAge1xuICAgICAgICAgICAgdHlwZTogJ2J1dHRvbicsXG4gICAgICAgICAgICByb2xlOiAndGFiJyxcbiAgICAgICAgICAgIGNsYXNzTmFtZTogJ2thbmJhbl9fdGFiJyArICh2aWV3ID09PSAnZHJhZnQnID8gJyBpcy1hY3RpdmUnIDogJycpLFxuICAgICAgICAgICAgJ2FyaWEtc2VsZWN0ZWQnOiB2aWV3ID09PSAnZHJhZnQnLFxuICAgICAgICAgICAgb25DbGljazogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICBzZXRWaWV3KCdkcmFmdCcpO1xuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9LFxuICAgICAgICAgICfpgJ/orrAnXG4gICAgICAgIClcbiAgICAgICksXG4gICAgICBoKCdzcGFuJywgeyBjbGFzc05hbWU6ICdrYW5iYW5fX2NhcmQtc3BhY2VyJyB9KSxcbiAgICAgIGgoU2F2ZUluZGljYXRvciwgeyBkcmFmdFN0YXRlOiBkcmFmdFNhdmUgfSlcbiAgICApLFxuICAgIGgoXG4gICAgICAnZGl2JyxcbiAgICAgIHsgY2xhc3NOYW1lOiAna2FuYmFuX190b29sYmFyJyB9LFxuICAgICAgdmlldyA9PT0gJ2JvYXJkJ1xuICAgICAgICA/IGgoXG4gICAgICAgICAgICAnZGl2JyxcbiAgICAgICAgICAgIHsgY2xhc3NOYW1lOiAna2FuYmFuX19zZWFyY2gnIH0sXG4gICAgICAgICAgICBoKCdzcGFuJywgeyBjbGFzc05hbWU6ICdrYW5iYW5fX3NlYXJjaC1pY29uJywgJ2FyaWEtaGlkZGVuJzogJ3RydWUnIH0sIGljb25zLnNlYXJjaCgpKSxcbiAgICAgICAgICAgIGgoJ2lucHV0Jywge1xuICAgICAgICAgICAgICBjbGFzc05hbWU6ICdrYW5iYW5fX2lucHV0JyxcbiAgICAgICAgICAgICAgdHlwZTogJ3NlYXJjaCcsXG4gICAgICAgICAgICAgIHZhbHVlOiBxdWVyeSxcbiAgICAgICAgICAgICAgcGxhY2Vob2xkZXI6ICfmkJzntKLvvIhDdHJsICsgRu+8iScsXG4gICAgICAgICAgICAgICdhcmlhLWxhYmVsJzogJ+aQnOe0ouWNoeeJhycsXG4gICAgICAgICAgICAgIG9uQ2hhbmdlOiBmdW5jdGlvbiAoZXZlbnQpIHtcbiAgICAgICAgICAgICAgICBzZXRRdWVyeShldmVudC50YXJnZXQudmFsdWUpO1xuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgfSlcbiAgICAgICAgICApXG4gICAgICAgIDogbnVsbCxcbiAgICAgIHZpZXcgPT09ICdib2FyZCdcbiAgICAgICAgPyBoKFxuICAgICAgICAgICAgJ2RpdicsXG4gICAgICAgICAgICB7IGNsYXNzTmFtZTogJ2thbmJhbl9fZmlsdGVycycsIHJvbGU6ICdncm91cCcsICdhcmlhLWxhYmVsJzogJ+etm+mAiScgfSxcbiAgICAgICAgICAgIGgoXG4gICAgICAgICAgICAgICdidXR0b24nLFxuICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgdHlwZTogJ2J1dHRvbicsXG4gICAgICAgICAgICAgICAgY2xhc3NOYW1lOiAna2FuYmFuX19maWx0ZXInICsgKGZpbHRlciA9PT0gJ2FsbCcgPyAnIGlzLWFjdGl2ZScgOiAnJyksXG4gICAgICAgICAgICAgICAgJ2FyaWEtcHJlc3NlZCc6IGZpbHRlciA9PT0gJ2FsbCcsXG4gICAgICAgICAgICAgICAgb25DbGljazogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgICAgc2V0RmlsdGVyKCdhbGwnKTtcbiAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAn5YWo6YOoJ1xuICAgICAgICAgICAgKSxcbiAgICAgICAgICAgIGgoXG4gICAgICAgICAgICAgICdidXR0b24nLFxuICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgdHlwZTogJ2J1dHRvbicsXG4gICAgICAgICAgICAgICAgY2xhc3NOYW1lOiAna2FuYmFuX19maWx0ZXInICsgKGZpbHRlciA9PT0gJ292ZXJkdWUnID8gJyBpcy1hY3RpdmUgaXMtd2FybicgOiAnJyksXG4gICAgICAgICAgICAgICAgJ2FyaWEtcHJlc3NlZCc6IGZpbHRlciA9PT0gJ292ZXJkdWUnLFxuICAgICAgICAgICAgICAgIGRpc2FibGVkOiBjb3VudE92ZXJkdWUgPT09IDAsXG4gICAgICAgICAgICAgICAgb25DbGljazogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgICAgc2V0RmlsdGVyKGZpbHRlciA9PT0gJ292ZXJkdWUnID8gJ2FsbCcgOiAnb3ZlcmR1ZScpO1xuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICflt7LpgL7mnJ8nLFxuICAgICAgICAgICAgICBjb3VudE92ZXJkdWUgPiAwID8gaCgnc3BhbicsIHsgY2xhc3NOYW1lOiAna2FuYmFuX19maWx0ZXItY291bnQnIH0sIFN0cmluZyhjb3VudE92ZXJkdWUpKSA6IG51bGxcbiAgICAgICAgICAgICksXG4gICAgICAgICAgICBoKFxuICAgICAgICAgICAgICAnYnV0dG9uJyxcbiAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgIHR5cGU6ICdidXR0b24nLFxuICAgICAgICAgICAgICAgIGNsYXNzTmFtZTogJ2thbmJhbl9fZmlsdGVyJyArIChmaWx0ZXIgPT09ICdoaWdoJyA/ICcgaXMtYWN0aXZlJyA6ICcnKSxcbiAgICAgICAgICAgICAgICAnYXJpYS1wcmVzc2VkJzogZmlsdGVyID09PSAnaGlnaCcsXG4gICAgICAgICAgICAgICAgb25DbGljazogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgICAgc2V0RmlsdGVyKGZpbHRlciA9PT0gJ2hpZ2gnID8gJ2FsbCcgOiAnaGlnaCcpO1xuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICfpq5jkvJjlhYjnuqcnXG4gICAgICAgICAgICApXG4gICAgICAgICAgKVxuICAgICAgICA6IG51bGwsXG4gICAgICBoKCdzcGFuJywgeyBjbGFzc05hbWU6ICdrYW5iYW5fX2NhcmQtc3BhY2VyJyB9KSxcbiAgICAgIHZpZXcgPT09ICdib2FyZCdcbiAgICAgICAgPyBoKFxuICAgICAgICAgICAgJ3NwYW4nLFxuICAgICAgICAgICAgeyBjbGFzc05hbWU6ICdrYW5iYW5fX3N0YXRzJyB9LFxuICAgICAgICAgICAgcXVlcnkgfHwgZmlsdGVyICE9PSAnYWxsJyA/ICfmmL7npLogJyArIGNvdW50TWF0Y2hlZCArICcgLyAnICsgY291bnRBbGwgKyAnIOW8oCcgOiBjb3VudEFsbCArICcg5byg5Y2h54mHJ1xuICAgICAgICAgIClcbiAgICAgICAgOiBudWxsLFxuICAgICAgaChcbiAgICAgICAgJ2J1dHRvbicsXG4gICAgICAgIHtcbiAgICAgICAgICB0eXBlOiAnYnV0dG9uJyxcbiAgICAgICAgICBjbGFzc05hbWU6ICdrYW5iYW5fX2ljb24tYnRuJyArIChwcmVmcy5ub3RpZnkgPyAnJyA6ICcgaXMtb2ZmJyksXG4gICAgICAgICAgJ2FyaWEtbGFiZWwnOiBwcmVmcy5ub3RpZnkgPyAn5Yiw5pyf5o+Q6YaS5bey5byA5ZCv77yM54K55Ye75YWz6ZetJyA6ICfliLDmnJ/mj5DphpLlt7LlhbPpl63vvIzngrnlh7vlvIDlkK8nLFxuICAgICAgICAgICdhcmlhLXByZXNzZWQnOiAhIXByZWZzLm5vdGlmeSxcbiAgICAgICAgICB0aXRsZTogcHJlZnMubm90aWZ5ID8gJ+WIsOacn+aPkOmGkuW3suW8gOWQrycgOiAn5Yiw5pyf5o+Q6YaS5bey5YWz6ZetJyxcbiAgICAgICAgICBvbkNsaWNrOiB0b2dnbGVOb3RpZnksXG4gICAgICAgIH0sXG4gICAgICAgIHByZWZzLm5vdGlmeSA/IGljb25zLmJlbGwoKSA6IGljb25zLmJlbGxPZmYoKVxuICAgICAgKSxcbiAgICAgIHZpZXcgPT09ICdib2FyZCdcbiAgICAgICAgPyBoKFxuICAgICAgICAgICAgTWVudSxcbiAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgbGFiZWw6ICfliJfooajmk43kvZwnLFxuICAgICAgICAgICAgICB0aXRsZTogJ+WIl+ihqCcsXG4gICAgICAgICAgICAgIHRyaWdnZXJDbGFzczogJ2thbmJhbl9faWNvbi1idG4nLFxuICAgICAgICAgICAgICB0cmlnZ2VyOiBpY29ucy5jb2x1bW5zKCksXG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAgZnVuY3Rpb24gKGNsb3NlKSB7XG4gICAgICAgICAgICAgIHJldHVybiBbXG4gICAgICAgICAgICAgICAgaChcbiAgICAgICAgICAgICAgICAgIE1lbnVJdGVtLFxuICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICBrZXk6ICdhZGQnLFxuICAgICAgICAgICAgICAgICAgICBvbkNsaWNrOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgICAgICAgY2xvc2UoKTtcbiAgICAgICAgICAgICAgICAgICAgICBzZXRBZGRpbmdMYW5lKHRydWUpO1xuICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICfmt7vliqDliJfooajigKYnXG4gICAgICAgICAgICAgICAgKSxcbiAgICAgICAgICAgICAgICBoKFxuICAgICAgICAgICAgICAgICAgTWVudUl0ZW0sXG4gICAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgIGtleTogJ3Jlc2V0JyxcbiAgICAgICAgICAgICAgICAgICAgZGlzYWJsZWQ6IGNvdW50QWxsID4gMCAmJiBib2FyZC5sYW5lcy5tYXAoZnVuY3Rpb24gKGwpIHsgcmV0dXJuIGwubmFtZTsgfSkuam9pbignfCcpID09PSBERUZBVUxUX0xBTkVTLmpvaW4oJ3wnKSxcbiAgICAgICAgICAgICAgICAgICAgb25DbGljazogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgICAgICAgIGNsb3NlKCk7XG4gICAgICAgICAgICAgICAgICAgICAgdmFyIG1vdmVkID0gYm9hcmRBY3Rpb25zLnJlc2V0TGFuZXMoKTtcbiAgICAgICAgICAgICAgICAgICAgICBpZiAobW92ZWQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHNldEFubm91bmNlKCflt7LmgaLlpI3pu5jorqTliJfooajvvJvljaHniYfmjInmiYDlnKjmoI/kuI7lrozmiJDnirbmgIHlvZLkvY3vvIzkuIDlvKDpg73msqHmnInliKDjgIInKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIG5vdGlmeShcbiAgICAgICAgICAgICAgICAgICAgICAgICAgJ+W3suaBouWkjem7mOiupOWIl+ihqCcsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICfjgIwnICsgREVGQVVMVF9MQU5FUy5qb2luKCfjgI3jgIwnKSArICfjgI3kuInmoI/lt7LlsLHnu6rvvIzljaHniYfmjInljp/nirbmgIHlvZLlhaXvvIzmsqHmnInliKDpmaTku7vkvZXljaHniYfjgIInLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAna2FuYmFuLWxhbmVzLXJlc2V0J1xuICAgICAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgJ+aBouWkjem7mOiupOWIl+ihqCdcbiAgICAgICAgICAgICAgICApLFxuICAgICAgICAgICAgICBdO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIClcbiAgICAgICAgOiBudWxsLFxuICAgICAgdmlldyA9PT0gJ2JvYXJkJyAmJiBjb3VudERvbmUgPiAwXG4gICAgICAgID8gaChcbiAgICAgICAgICAgIE1lbnUsXG4gICAgICAgICAgICB7XG4gICAgICAgICAgICAgIGxhYmVsOiAn5bey5a6M5oiQ5Y2h54mHJyxcbiAgICAgICAgICAgICAgdGl0bGU6ICflt7LlrozmiJAnLFxuICAgICAgICAgICAgICB0cmlnZ2VyQ2xhc3M6ICdrYW5iYW5fX2J0biBrYW5iYW5fX2J0bi0tZ2hvc3Qga2FuYmFuX19idG4tLXRpZ2h0JyxcbiAgICAgICAgICAgICAgdHJpZ2dlcjogW1xuICAgICAgICAgICAgICAgICflt7LlrozmiJAgJyArIGNvdW50RG9uZSxcbiAgICAgICAgICAgICAgICBzaG93RG9uZSA/IG51bGwgOiBoKCdzcGFuJywgeyBrZXk6ICdoaW50JywgY2xhc3NOYW1lOiAna2FuYmFuX19oaW50JyB9LCAn77yI5bey6ZqQ6JeP77yJJyksXG4gICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAgZnVuY3Rpb24gKGNsb3NlKSB7XG4gICAgICAgICAgICAgIHJldHVybiBbXG4gICAgICAgICAgICAgICAgaChcbiAgICAgICAgICAgICAgICAgIE1lbnVJdGVtLFxuICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICBrZXk6ICd0b2dnbGUnLFxuICAgICAgICAgICAgICAgICAgICBvbkNsaWNrOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgICAgICAgY2xvc2UoKTtcbiAgICAgICAgICAgICAgICAgICAgICBzZXRTaG93RG9uZSghc2hvd0RvbmUpO1xuICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgIHNob3dEb25lID8gJ+makOiXj+W3suWujOaIkOWNoeeJhycgOiAn5pi+56S65bey5a6M5oiQ5Y2h54mHJ1xuICAgICAgICAgICAgICAgICksXG4gICAgICAgICAgICAgICAgaChcbiAgICAgICAgICAgICAgICAgIE1lbnVJdGVtLFxuICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICBrZXk6ICdjbGVhcicsXG4gICAgICAgICAgICAgICAgICAgIGRhbmdlcjogdHJ1ZSxcbiAgICAgICAgICAgICAgICAgICAgb25DbGljazogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgICAgICAgIGNsb3NlKCk7XG4gICAgICAgICAgICAgICAgICAgICAgdmFyIHJlbW92ZWQgPSBib2FyZEFjdGlvbnMuY2xlYXJEb25lKCk7XG4gICAgICAgICAgICAgICAgICAgICAgaWYgKHJlbW92ZWQgPiAwKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBzZXRBbm5vdW5jZSgn5bey5riF6ZmkICcgKyByZW1vdmVkICsgJyDlvKDlt7LlrozmiJDljaHniYcnKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIG5vdGlmeSgn5bey5riF6ZmkICcgKyByZW1vdmVkICsgJyDlvKDlt7LlrozmiJDljaHniYcnLCAn5riF6Zmk5o6J55qE5Y2h54mH5peg5rOV5om+5Zue44CCJywgJ2thbmJhbi1jbGVhci1kb25lJyk7XG4gICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICfmuIXpmaTov5kgJyArIGNvdW50RG9uZSArICcg5byg5Y2h54mHJ1xuICAgICAgICAgICAgICAgICksXG4gICAgICAgICAgICAgIF07XG4gICAgICAgICAgICB9XG4gICAgICAgICAgKVxuICAgICAgICA6IG51bGxcbiAgICApXG4gICk7XG5cbiAgdmFyIGJvZHk7XG4gIGlmIChzdGF0ZS5zdGF0dXMgPT09ICdsb2FkaW5nJykge1xuICAgIGJvZHkgPSBoKCdwJywgeyBjbGFzc05hbWU6ICdrYW5iYW5fX3BsYWNlaG9sZGVyJyB9LCAn5q2j5Zyo6K+75Y+W5L2g55qE55yL5p2/4oCmJyk7XG4gIH0gZWxzZSBpZiAoc3RhdGUuc3RhdHVzID09PSAnZXJyb3InKSB7XG4gICAgYm9keSA9IGgoXG4gICAgICAncCcsXG4gICAgICB7IGNsYXNzTmFtZTogJ2thbmJhbl9fcGxhY2Vob2xkZXInIH0sXG4gICAgICAn5pWw5o2u5rKh6IO96K+75Ye65p2l44CC5LiK6Z2i55qE5o+Q56S66YeM5YaZ5LqG5Y6f5Zug77yb56OB55uY5LiK55qE5pWw5o2u5rKh5pyJ6KKr5pS55Yqo77yM5L+u5aW95LmL5ZCO54K544CM6YeN5paw6K+75Y+W44CN5Y2z5Y+v44CCJ1xuICAgICk7XG4gIH0gZWxzZSBpZiAodmlldyA9PT0gJ2RyYWZ0Jykge1xuICAgIGJvZHkgPSBoKERyYWZ0Vmlldywge1xuICAgICAgZHJhZnQ6IHN0YXRlLmRyYWZ0LFxuICAgICAgbGFuZXM6IGxhbmVzLFxuICAgICAgb25TZW5kVG9Cb2FyZDogc2VuZExpbmVUb0JvYXJkLFxuICAgICAgb25DaGFuZ2U6IGZ1bmN0aW9uICh2YWx1ZSkge1xuICAgICAgICBzdG9yZS5zZXQoeyBkcmFmdDogdmFsdWUgfSk7XG4gICAgICAgIHNldERyYWZ0U2F2ZSgnc2F2aW5nJyk7XG4gICAgICAgIGlmIChpbnRlcm5hbC5kcmFmdFRpbWVyICE9PSBudWxsKSBjbGVhclRpbWVvdXQoaW50ZXJuYWwuZHJhZnRUaW1lcik7XG4gICAgICAgIGludGVybmFsLmRyYWZ0VGltZXIgPSBzZXRUaW1lb3V0KGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICBpbnRlcm5hbC5kcmFmdFRpbWVyID0gbnVsbDtcbiAgICAgICAgICBjdHguc3RvcmFnZVxuICAgICAgICAgICAgLnNldChLRVlfRFJBRlQsIHN0b3JlLmdldFNuYXBzaG90KCkuZHJhZnQpXG4gICAgICAgICAgICAudGhlbihmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgIHNldERyYWZ0U2F2ZSgnc2F2ZWQnKTtcbiAgICAgICAgICAgIH0pXG4gICAgICAgICAgICAuY2F0Y2goZnVuY3Rpb24gKGVycikge1xuICAgICAgICAgICAgICBjdHgubG9nZ2VyLndhcm4oJ+S/neWtmOmAn+iusOiNieeov+Wksei0pScsIGVycik7XG4gICAgICAgICAgICAgIHNldERyYWZ0U2F2ZSgnZXJyb3InKTtcbiAgICAgICAgICAgICAgcHVzaE5vdGUoJ+mAn+iusOiNieeov+ayoeiDveWGmei/m+WtmOWCqO+8jOS4i+asoeaJk+W8gOWPr+iDveeci+S4jeWIsOWug+OAgicpO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH0sIERSQUZUX0RFQk9VTkNFX01TKTtcbiAgICAgIH0sXG4gICAgfSk7XG4gIH0gZWxzZSBpZiAoY291bnRBbGwgPT09IDAgJiYgIXF1ZXJ5ICYmIGZpbHRlciA9PT0gJ2FsbCcpIHtcbiAgICBib2R5ID0gaChcbiAgICAgICdkaXYnLFxuICAgICAgeyBjbGFzc05hbWU6ICdrYW5iYW5fX2VtcHR5JyB9LFxuICAgICAgaCgnaDInLCB7IGNsYXNzTmFtZTogJ2thbmJhbl9fZW1wdHktdGl0bGUnIH0sICfku47nrKzkuIDku7bkuovlvIDlp4snKSxcbiAgICAgIGgoXG4gICAgICAgICdwJyxcbiAgICAgICAgeyBjbGFzc05hbWU6ICdrYW5iYW5fX2VtcHR5LXRleHQnIH0sXG4gICAgICAgICflhpnkuIvmnaXvvIzlroPkvJrokL3lnKjjgIzlvoXlpITnkIbjgI3ph4zjgILkuYvlkI7lj6/ku6Xmi5bliqjljaHniYfmjaLmoI/vvIxBbHQgKyDlt6blj7PmlrnlkJHplK7kuZ/lj6/ku6XvvJsnICtcbiAgICAgICAgICAn5oyJ5Zue6L2m5omT5byA57yW6L6R5Zmo6KGl5YWF6K+05piO44CB5LyY5YWI57qn5LiO5oiq5q2i5pel44CC5oiq5q2i5pel5Yiw5LqG5Lya5pyJ5o+Q6YaS44CCJ1xuICAgICAgKSxcbiAgICAgIGgoXG4gICAgICAgICdkaXYnLFxuICAgICAgICB7IGNsYXNzTmFtZTogJ2thbmJhbl9fZW1wdHktYWN0aW9ucycgfSxcbiAgICAgICAgaCgnaW5wdXQnLCB7XG4gICAgICAgICAgY2xhc3NOYW1lOiAna2FuYmFuX19pbnB1dCBrYW5iYW5fX2VtcHR5LWlucHV0JyxcbiAgICAgICAgICB2YWx1ZTogZmlyc3RDYXJkLFxuICAgICAgICAgIG1heExlbmd0aDogQ0FSRF9USVRMRV9NQVgsXG4gICAgICAgICAgcGxhY2Vob2xkZXI6ICfkvovlpoLvvJrmiorlkajmiqXlhpnlrownLFxuICAgICAgICAgICdhcmlhLWxhYmVsJzogJ+esrOS4gOW8oOWNoeeJh+eahOagh+mimCcsXG4gICAgICAgICAgb25DaGFuZ2U6IGZ1bmN0aW9uIChldmVudCkge1xuICAgICAgICAgICAgc2V0Rmlyc3RDYXJkKGV2ZW50LnRhcmdldC52YWx1ZSk7XG4gICAgICAgICAgfSxcbiAgICAgICAgICBvbktleURvd246IGZ1bmN0aW9uIChldmVudCkge1xuICAgICAgICAgICAgaWYgKGV2ZW50LmtleSAhPT0gJ0VudGVyJykgcmV0dXJuO1xuICAgICAgICAgICAgZXZlbnQucHJldmVudERlZmF1bHQoKTtcbiAgICAgICAgICAgIGlmICghZmlyc3RDYXJkLnRyaW0oKSkgcmV0dXJuO1xuICAgICAgICAgICAgYm9hcmRBY3Rpb25zLmFkZENhcmQoYm9hcmQubGFuZXNbMF0uaWQsIGZpcnN0Q2FyZC50cmltKCkuc2xpY2UoMCwgQ0FSRF9USVRMRV9NQVgpLCAnbm9ybWFsJywgbnVsbCwgbnVsbCk7XG4gICAgICAgICAgICBzZXRGaXJzdENhcmQoJycpO1xuICAgICAgICAgIH0sXG4gICAgICAgIH0pLFxuICAgICAgICBoKFxuICAgICAgICAgICdidXR0b24nLFxuICAgICAgICAgIHtcbiAgICAgICAgICAgIHR5cGU6ICdidXR0b24nLFxuICAgICAgICAgICAgY2xhc3NOYW1lOiAna2FuYmFuX19idG4ga2FuYmFuX19idG4tLXByaW1hcnknLFxuICAgICAgICAgICAgZGlzYWJsZWQ6IGZpcnN0Q2FyZC50cmltKCkubGVuZ3RoID09PSAwLFxuICAgICAgICAgICAgb25DbGljazogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICBib2FyZEFjdGlvbnMuYWRkQ2FyZChib2FyZC5sYW5lc1swXS5pZCwgZmlyc3RDYXJkLnRyaW0oKS5zbGljZSgwLCBDQVJEX1RJVExFX01BWCksICdub3JtYWwnLCBudWxsLCBudWxsKTtcbiAgICAgICAgICAgICAgc2V0Rmlyc3RDYXJkKCcnKTtcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfSxcbiAgICAgICAgICAn5re75Yqg6L+Z5byg5Y2h54mHJ1xuICAgICAgICApXG4gICAgICApLFxuICAgICAgaChcbiAgICAgICAgJ3AnLFxuICAgICAgICB7IGNsYXNzTmFtZTogJ2thbmJhbl9faGludCBrYW5iYW5fX2VtcHR5LWZvb3QnIH0sXG4gICAgICAgICflt7Lnu4/lnKjliKvlpITorrDkuobvvJ/liIfliLDjgIzpgJ/orrDjgI3miormr4/kuIDooYzpgJDkuKrliqDov5vmnaXjgIInXG4gICAgICApXG4gICAgKTtcbiAgfSBlbHNlIHtcbiAgICB2YXIgbGFuZU5vZGVzID0gbGFuZXMubWFwKGZ1bmN0aW9uIChsYW5lLCBpbmRleCkge1xuICAgICAgdmFyIGxpc3QgPSBbXTtcbiAgICAgIHZhciBhbGwgPSBjYXJkc0luTGFuZShib2FyZCwgbGFuZS5pZCk7XG4gICAgICBmb3IgKHZhciBuID0gMDsgbiA8IGFsbC5sZW5ndGg7IG4gKz0gMSkge1xuICAgICAgICBpZiAobWF0Y2hlc1thbGxbbl0uaWRdKSBsaXN0LnB1c2goYWxsW25dKTtcbiAgICAgIH1cbiAgICAgIGxpc3QgPSBzb3J0Q2FyZHMobGlzdCk7XG4gICAgICByZXR1cm4gaChMYW5lLCB7XG4gICAgICAgIGtleTogbGFuZS5pZCxcbiAgICAgICAgbGFuZTogbGFuZSxcbiAgICAgICAgYm9hcmQ6IGJvYXJkLFxuICAgICAgICBjYXJkczogbGlzdCxcbiAgICAgICAgbGFuZUluZGV4OiBpbmRleCxcbiAgICAgICAgbGFuZUNvdW50OiBsYW5lcy5sZW5ndGgsXG4gICAgICAgIGRyYWdnaW5nOiBhY3RpdmVEcmFnLFxuICAgICAgICBkcm9wTGFuZUlkOiBkcm9wID8gZHJvcC5sYW5lSWQgOiBudWxsLFxuICAgICAgICBkcm9wSW5kZXg6IGRyb3AgPyBkcm9wLmluZGV4IDogMCxcbiAgICAgICAgbGFuZURyb3BCZWZvcmVJZDogbGFuZURyb3AgPyBsYW5lRHJvcC5iZWZvcmVJZCA6IG51bGwsXG4gICAgICAgIGxhbmVEcm9wQWZ0ZXJJZDogbGFuZURyb3AgPyBsYW5lRHJvcC5hZnRlcklkIDogbnVsbCxcbiAgICAgICAganVzdE1vdmVkSWQ6IGp1c3RNb3ZlZElkLFxuICAgICAgICBoYXNRdWVyeTogcXVlcnkubGVuZ3RoID4gMCB8fCBmaWx0ZXIgIT09ICdhbGwnLFxuICAgICAgICBvbkRyYWdTdGFydDogZnVuY3Rpb24gKGNhcmRJZCwgZXZlbnQpIHtcbiAgICAgICAgICBzdGFydERyYWcoJ2NhcmQnLCBjYXJkSWQsIGV2ZW50KTtcbiAgICAgICAgfSxcbiAgICAgICAgb25MYW5lRHJhZ1N0YXJ0OiBmdW5jdGlvbiAobGFuZUlkLCBldmVudCkge1xuICAgICAgICAgIHN0YXJ0RHJhZygnbGFuZScsIGxhbmVJZCwgZXZlbnQpO1xuICAgICAgICB9LFxuICAgICAgICBvbkFkZENhcmQ6IGZ1bmN0aW9uICh0aXRsZSwgcHJpb3JpdHksIGR1ZSwgcmVjdXJyZW5jZSkge1xuICAgICAgICAgIGJvYXJkQWN0aW9ucy5hZGRDYXJkKGxhbmUuaWQsIHRpdGxlLCBwcmlvcml0eSwgZHVlLCByZWN1cnJlbmNlKTtcbiAgICAgICAgfSxcbiAgICAgICAgb25SZW5hbWVMYW5lOiBmdW5jdGlvbiAobGFuZUlkLCBuYW1lKSB7XG4gICAgICAgICAgYm9hcmRBY3Rpb25zLnJlbmFtZUxhbmUobGFuZUlkLCBuYW1lKTtcbiAgICAgICAgfSxcbiAgICAgICAgb25Ub2dnbGVDb2xsYXBzZWQ6IGZ1bmN0aW9uIChsYW5lSWQpIHtcbiAgICAgICAgICBib2FyZEFjdGlvbnMudG9nZ2xlTGFuZUNvbGxhcHNlZChsYW5lSWQpO1xuICAgICAgICB9LFxuICAgICAgICBvbk1vdmVMYW5lOiBmdW5jdGlvbiAobGFuZUlkLCB0YXJnZXRJbmRleCkge1xuICAgICAgICAgIGJvYXJkQWN0aW9ucy5tb3ZlTGFuZShsYW5lSWQsIHRhcmdldEluZGV4KTtcbiAgICAgICAgICBzZXRBbm5vdW5jZSgn5YiX6KGo5bey56e75Yqo5Yiw56ysICcgKyAodGFyZ2V0SW5kZXggKyAxKSArICcg5qCPJyk7XG4gICAgICAgIH0sXG4gICAgICAgIG9uUmVtb3ZlTGFuZTogcmVtb3ZlTGFuZSxcbiAgICAgICAgb25FZGl0OiBmdW5jdGlvbiAoY2FyZElkKSB7XG4gICAgICAgICAgc2V0RWRpdGluZ0lkKGNhcmRJZCk7XG4gICAgICAgIH0sXG4gICAgICAgIG9uRGVsZXRlOiByZW1vdmVDYXJkLFxuICAgICAgICBvblRvZ2dsZURvbmU6IGZ1bmN0aW9uIChjYXJkSWQsIGRvbmUpIHtcbiAgICAgICAgICBib2FyZEFjdGlvbnMudG9nZ2xlRG9uZShjYXJkSWQsIGRvbmUpO1xuICAgICAgICB9LFxuICAgICAgICBvblNldFByaW9yaXR5OiBmdW5jdGlvbiAoY2FyZElkLCBwcmlvcml0eSkge1xuICAgICAgICAgIGJvYXJkQWN0aW9ucy51cGRhdGVDYXJkKGNhcmRJZCwgeyBwcmlvcml0eTogcHJpb3JpdHkgfSk7XG4gICAgICAgIH0sXG4gICAgICAgIG9uU2V0RHVlOiBmdW5jdGlvbiAoY2FyZElkLCBkdWUpIHtcbiAgICAgICAgICBib2FyZEFjdGlvbnMudXBkYXRlQ2FyZChjYXJkSWQsIHsgZHVlOiBkdWUgfSk7XG4gICAgICAgICAgc2V0QW5ub3VuY2UoZHVlID8gJ+aIquatouaXpeW3suiuvuS4uiAnICsgZHVlIDogJ+W3sua4hemZpOaIquatouaXpScpO1xuICAgICAgICB9LFxuICAgICAgICBvblNoaWZ0RHVlOiBmdW5jdGlvbiAoY2FyZElkLCBkYXlzKSB7XG4gICAgICAgICAgdmFyIGNhcmQgPSBzdG9yZS5nZXRTbmFwc2hvdCgpLmJvYXJkLmNhcmRzW2NhcmRJZF07XG4gICAgICAgICAgaWYgKCFjYXJkKSByZXR1cm47XG4gICAgICAgICAgdmFyIG5leHQgPSBhZGREYXlzKGNhcmQuZHVlIHx8IHRvZGF5S2V5KCksIGRheXMpO1xuICAgICAgICAgIGJvYXJkQWN0aW9ucy51cGRhdGVDYXJkKGNhcmRJZCwgeyBkdWU6IG5leHQgfSk7XG4gICAgICAgICAgc2V0QW5ub3VuY2UoJ+aIquatouaXpeaUueS4uiAnICsgbmV4dCk7XG4gICAgICAgIH0sXG4gICAgICAgIG9uTW92ZUNhcmRUb0xhbmU6IG1vdmVDYXJkVG9MYW5lLFxuICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICBib2R5ID0gaChcbiAgICAgICdkaXYnLFxuICAgICAgeyBjbGFzc05hbWU6ICdrYW5iYW5fX2JvYXJkJyB9LFxuICAgICAgbGFuZU5vZGVzLFxuICAgICAgYWRkaW5nTGFuZVxuICAgICAgICA/IGgoXG4gICAgICAgICAgICAnZm9ybScsXG4gICAgICAgICAgICB7XG4gICAgICAgICAgICAgIGNsYXNzTmFtZTogJ2thbmJhbl9fbGFuZSBrYW5iYW5fX2xhbmUtLW5ldycsXG4gICAgICAgICAgICAgIG9uU3VibWl0OiBmdW5jdGlvbiAoZXZlbnQpIHtcbiAgICAgICAgICAgICAgICBldmVudC5wcmV2ZW50RGVmYXVsdCgpO1xuICAgICAgICAgICAgICAgIHZhciB2YWx1ZSA9IGV2ZW50LnRhcmdldC5lbGVtZW50cy5sYW5lTmFtZS52YWx1ZS50cmltKCk7XG4gICAgICAgICAgICAgICAgaWYgKHZhbHVlKSBib2FyZEFjdGlvbnMuYWRkTGFuZSh2YWx1ZS5zbGljZSgwLCBMQU5FX05BTUVfTUFYKSk7XG4gICAgICAgICAgICAgICAgc2V0QWRkaW5nTGFuZShmYWxzZSk7XG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAgaCgnaW5wdXQnLCB7XG4gICAgICAgICAgICAgIGNsYXNzTmFtZTogJ2thbmJhbl9faW5wdXQnLFxuICAgICAgICAgICAgICBuYW1lOiAnbGFuZU5hbWUnLFxuICAgICAgICAgICAgICBhdXRvRm9jdXM6IHRydWUsXG4gICAgICAgICAgICAgIG1heExlbmd0aDogTEFORV9OQU1FX01BWCxcbiAgICAgICAgICAgICAgcGxhY2Vob2xkZXI6ICfmlrDliJfooajlj6vku4DkuYjvvJ8nLFxuICAgICAgICAgICAgICAnYXJpYS1sYWJlbCc6ICfmlrDliJfooajlkI3np7AnLFxuICAgICAgICAgICAgfSksXG4gICAgICAgICAgICBoKFxuICAgICAgICAgICAgICAnZGl2JyxcbiAgICAgICAgICAgICAgeyBjbGFzc05hbWU6ICdrYW5iYW5fX2NvbXBvc2VyLXJvdycgfSxcbiAgICAgICAgICAgICAgaCgnYnV0dG9uJywgeyB0eXBlOiAnc3VibWl0JywgY2xhc3NOYW1lOiAna2FuYmFuX19idG4ga2FuYmFuX19idG4tLXByaW1hcnknIH0sICfliJvlu7rliJfooagnKSxcbiAgICAgICAgICAgICAgaChcbiAgICAgICAgICAgICAgICAnYnV0dG9uJyxcbiAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICB0eXBlOiAnYnV0dG9uJyxcbiAgICAgICAgICAgICAgICAgIGNsYXNzTmFtZTogJ2thbmJhbl9fYnRuIGthbmJhbl9fYnRuLS1naG9zdCcsXG4gICAgICAgICAgICAgICAgICBvbkNsaWNrOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgICAgIHNldEFkZGluZ0xhbmUoZmFsc2UpO1xuICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICflj5bmtognXG4gICAgICAgICAgICAgIClcbiAgICAgICAgICAgIClcbiAgICAgICAgICApXG4gICAgICAgIDogaChcbiAgICAgICAgICAgICdidXR0b24nLFxuICAgICAgICAgICAge1xuICAgICAgICAgICAgICB0eXBlOiAnYnV0dG9uJyxcbiAgICAgICAgICAgICAgY2xhc3NOYW1lOiAna2FuYmFuX19sYW5lLWFkZCcsXG4gICAgICAgICAgICAgIG9uQ2xpY2s6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICBzZXRBZGRpbmdMYW5lKHRydWUpO1xuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIGljb25zLnBsdXMoMTYpLFxuICAgICAgICAgICAgJ+a3u+WKoOWIl+ihqCdcbiAgICAgICAgICApXG4gICAgKTtcbiAgfVxuXG4gIHJldHVybiBoKFxuICAgICdkaXYnLFxuICAgIHsgY2xhc3NOYW1lOiAna2FuYmFuJywgb25LZXlEb3duOiBvblJvb3RLZXlEb3duIH0sXG4gICAgaGVhZGVyLFxuICAgIGgoRXJyb3JCYW5uZXIpLFxuICAgIHN0YXRlLmNvbmZsaWN0XG4gICAgICA/IGgoXG4gICAgICAgICAgJ2RpdicsXG4gICAgICAgICAgeyBjbGFzc05hbWU6ICdrYW5iYW5fX2Jhbm5lciBrYW5iYW5fX2Jhbm5lci0td2FybicsIHJvbGU6ICdzdGF0dXMnIH0sXG4gICAgICAgICAgaCgnc3BhbicsIHsgY2xhc3NOYW1lOiAna2FuYmFuX19iYW5uZXItdGV4dCcgfSwgJ+WPpuS4gOS4queci+adv+WunuS+i+S/neWtmOS6huabtOaWsOeahOWGheWuue+8jOeVjOmdouW3suWIh+aNouaIkOWug+eahOeJiOacrOOAgicpXG4gICAgICAgIClcbiAgICAgIDogbnVsbCxcbiAgICBib2R5LFxuICAgIGgoJ2RpdicsIHsgY2xhc3NOYW1lOiAna2FuYmFuX19saXZlJywgcm9sZTogJ3N0YXR1cycsICdhcmlhLWxpdmUnOiAncG9saXRlJyB9LCBhbm5vdW5jZSksXG4gICAgdW5kb1xuICAgICAgPyBoKFxuICAgICAgICAgICdkaXYnLFxuICAgICAgICAgIHsgY2xhc3NOYW1lOiAna2FuYmFuX190b2FzdCcgfSxcbiAgICAgICAgICBoKFxuICAgICAgICAgICAgJ3NwYW4nLFxuICAgICAgICAgICAgbnVsbCxcbiAgICAgICAgICAgIHVuZG8ua2luZCA9PT0gJ2xhbmUnXG4gICAgICAgICAgICAgID8gJ+W3suWIoOmZpOWIl+ihqOOAjCcgKyB1bmRvLmxhbmUubmFtZSArICfjgI0nICsgKHVuZG8ubGFuZS5jYXJkcy5sZW5ndGggPiAwID8gJ++8iOWQqyAnICsgdW5kby5sYW5lLmNhcmRzLmxlbmd0aCArICcg5byg5Y2h54mH77yJJyA6ICcnKVxuICAgICAgICAgICAgICA6ICflt7LliKDpmaTjgIwnICsgKHVuZG8udGl0bGUgfHwgJ+WNoeeJhycpICsgJ+OAjSdcbiAgICAgICAgICApLFxuICAgICAgICAgIGgoXG4gICAgICAgICAgICAnYnV0dG9uJyxcbiAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgdHlwZTogJ2J1dHRvbicsXG4gICAgICAgICAgICAgIGNsYXNzTmFtZTogJ2thbmJhbl9fYnRuIGthbmJhbl9fYnRuLS1naG9zdCBrYW5iYW5fX2J0bi0tdGlnaHQnLFxuICAgICAgICAgICAgICBvbkNsaWNrOiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgaWYgKHVuZG8ua2luZCA9PT0gJ2xhbmUnKSBib2FyZEFjdGlvbnMucmVzdG9yZUxhbmUodW5kby5sYW5lKTtcbiAgICAgICAgICAgICAgICBlbHNlIGJvYXJkQWN0aW9ucy5yZXN0b3JlQ2FyZCh1bmRvLmNhcmQpO1xuICAgICAgICAgICAgICAgIHNldFVuZG8obnVsbCk7XG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAgaWNvbnMudW5kbygxMyksXG4gICAgICAgICAgICAn5pKk6ZSAJ1xuICAgICAgICAgIClcbiAgICAgICAgKVxuICAgICAgOiBudWxsLFxuICAgIGVkaXRpbmdcbiAgICAgID8gaChDYXJkRWRpdG9yLCB7XG4gICAgICAgICAgY2FyZDogZWRpdGluZyxcbiAgICAgICAgICBsYW5lczogbGFuZXMsXG4gICAgICAgICAgb25DbG9zZTogZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgc2V0RWRpdGluZ0lkKG51bGwpO1xuICAgICAgICAgIH0sXG4gICAgICAgICAgb25EZWxldGU6IGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIHJlbW92ZUNhcmQoZWRpdGluZy5pZCk7XG4gICAgICAgICAgfSxcbiAgICAgICAgICBvblNhdmU6IGZ1bmN0aW9uIChwYXRjaCkge1xuICAgICAgICAgICAgdmFyIGxhbmVDaGFuZ2VkID0gcGF0Y2gubGFuZUlkICE9PSBlZGl0aW5nLmxhbmVJZDtcbiAgICAgICAgICAgIGJvYXJkQWN0aW9ucy51cGRhdGVDYXJkKGVkaXRpbmcuaWQsIHtcbiAgICAgICAgICAgICAgdGl0bGU6IHBhdGNoLnRpdGxlLFxuICAgICAgICAgICAgICBub3RlOiBwYXRjaC5ub3RlLFxuICAgICAgICAgICAgICBwcmlvcml0eTogcGF0Y2gucHJpb3JpdHksXG4gICAgICAgICAgICAgIGR1ZTogcGF0Y2guZHVlLFxuICAgICAgICAgICAgICByZWN1cnJlbmNlOiBwYXRjaC5yZWN1cnJlbmNlLFxuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICBpZiAobGFuZUNoYW5nZWQpIGJvYXJkQWN0aW9ucy5tb3ZlQ2FyZChlZGl0aW5nLmlkLCBwYXRjaC5sYW5lSWQsIG51bGwsIG51bGwpO1xuICAgICAgICAgICAgc2V0RWRpdGluZ0lkKG51bGwpO1xuICAgICAgICAgIH0sXG4gICAgICAgIH0pXG4gICAgICA6IG51bGwsXG4gICAgZHJhZ1ByZXZpZXdcbiAgICAgID8gaChcbiAgICAgICAgICAnZGl2JyxcbiAgICAgICAgICB7XG4gICAgICAgICAgICBjbGFzc05hbWU6XG4gICAgICAgICAgICAgICdrYW5iYW5fX2RyYWctcHJldmlldycgKyAoZHJhZ1ByZXZpZXcua2luZCA9PT0gJ2xhbmUnID8gJyBrYW5iYW5fX2RyYWctcHJldmlldy0tbGFuZScgOiAnJyksXG4gICAgICAgICAgICAnYXJpYS1oaWRkZW4nOiAndHJ1ZScsXG4gICAgICAgICAgICBzdHlsZToge1xuICAgICAgICAgICAgICB0cmFuc2Zvcm06ICd0cmFuc2xhdGUzZCgnICsgTWF0aC5yb3VuZChkcmFnUHJldmlldy54KSArICdweCwnICsgTWF0aC5yb3VuZChkcmFnUHJldmlldy55KSArICdweCwwKScsXG4gICAgICAgICAgICAgIHdpZHRoOiBkcmFnUHJldmlldy53aWR0aCA/IE1hdGgucm91bmQoZHJhZ1ByZXZpZXcud2lkdGgpICsgJ3B4JyA6IHVuZGVmaW5lZCxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfSxcbiAgICAgICAgICBoKFxuICAgICAgICAgICAgJ2RpdicsXG4gICAgICAgICAgICB7IGNsYXNzTmFtZTogJ2thbmJhbl9fZHJhZy1oZWFkJyB9LFxuICAgICAgICAgICAgaCgnc3BhbicsIHsgY2xhc3NOYW1lOiAna2FuYmFuX19ncmlwJyB9LCBpY29ucy5ncmlwKCkpLFxuICAgICAgICAgICAgaCgnc3BhbicsIHsgY2xhc3NOYW1lOiAna2FuYmFuX19jYXJkLXRpdGxlJyB9LCBkcmFnUHJldmlldy50aXRsZSlcbiAgICAgICAgICApLFxuICAgICAgICAgIGRyYWdQcmV2aWV3LmxhbmVOYW1lXG4gICAgICAgICAgICA/IGgoXG4gICAgICAgICAgICAgICAgJ3NwYW4nLFxuICAgICAgICAgICAgICAgIHsgY2xhc3NOYW1lOiAna2FuYmFuX19kcmFnLXRhcmdldCcgKyAoZHJhZ1ByZXZpZXcub3ZlckxhbmUgPyAnIGlzLW92ZXInIDogJycpIH0sXG4gICAgICAgICAgICAgICAgZHJhZ1ByZXZpZXcub3ZlckxhbmUgPyAn56e75Yiw44CMJyArIGRyYWdQcmV2aWV3LmxhbmVOYW1lICsgJ+OAjScgOiBkcmFnUHJldmlldy5sYW5lTmFtZVxuICAgICAgICAgICAgICApXG4gICAgICAgICAgICA6IG51bGxcbiAgICAgICAgKVxuICAgICAgOiBudWxsXG4gICk7XG59XG5cbmV4cG9ydCB7IEthbmJhbkJvYXJkIH07XG4iLCAiLy8g5LuOIHBsdWdpbnMva2FuYmFuL2luZGV4LmpzIOaLhuWHuiDigJTigJQgKirpgLvovpHljp/moLfmkKzov5DvvIzmnKrlgZrku7vkvZXmlLnliqgqKuOAglxuLy8g5pCs6L+Q5piv5py65qKw55qE77ya5q+P5Z2X55qE5L2N572u5LiO5YaF5a656YO95rKh5Y+Y77yM5Y+q5piv6KGl5LiK5LqGIGltcG9ydCAvIGV4cG9ydOOAglxuaW1wb3J0IHsgS2FuYmFuQm9hcmQgfSBmcm9tICcuL2JvYXJkJztcbmltcG9ydCB7IE1vZHVsaXRoLCBSZWFjdCwgY3R4IH0gZnJvbSAnLi9lbnYnO1xuaW1wb3J0IHsgaWNvbiB9IGZyb20gJy4vaWNvbnMnO1xuaW1wb3J0IHsgaW50ZXJuYWwgfSBmcm9tICcuL3N0b3JlJztcblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyDms6jlhozvvJrlv4XpobvlnKggSUlGRSDpobblsYIqKuWQjOatpSoq5a6M5oiQXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuTW9kdWxpdGgucmVnaXN0ZXJNb2R1bGUoe1xuICBpZDogJ2thbmJhbkJvYXJkJyxcbiAgbmFtZTogJ+eci+advycsXG4gIGRpc3BsYXlOYW1lOiAn55yL5p2/JyxcbiAgZGVzY3JpcHRpb246ICfmiormtLvlhL/mjInliJfooajmkYblvIDvvIzmi5bliqjmiJbmjInplK7nm5jnp7vliqjljaHniYcnLFxuICBpY29uOiAnU3F1YXJlS2FuYmFuJyxcbiAgcHJpb3JpdHk6IDcwLFxuICBjYXRlZ29yeTogJ+aViOeOhycsXG4gIGNvbXBvbmVudDogS2FuYmFuQm9hcmQsXG59KTtcblxuTW9kdWxpdGgucmVnaXN0ZXJDb21tYW5kKHtcbiAgaWQ6ICduZXctY2FyZCcsXG4gIHRpdGxlOiAn55yL5p2/77ya5paw5bu65LiA5byg5Y2h54mHJyxcbiAga2V5d29yZHM6IFsna2FuYmFuJywgJ3RvZG8nLCAndGFzayddLFxuICBydW46IGZ1bmN0aW9uICgpIHtcbiAgICAvLyDlkb3ku6Tlj6/ku6Xku47ku7vkvZXmqKHlnZfop6blj5HvvIzmraTml7bnnIvmnb/lvojlj6/og73ov5jmsqHmjILovb3vvIjmqKHlnZfmnKrmiZPlvIDvvInvvIxcbiAgICAvLyDlm6DmraTlhYjlsJ3or5XngrnlvIDnrKzkuIDmoI/nmoTmlrDlu7rmjInpkq7vvIzngrnkuI3liLDlsLHmmI7noa7or7TmuIXljp/lm6Ag4oCU4oCUIOmdmem7mOS4jeWKqOS9nOacgOiuqeS6uuWbsOaDkeOAglxuICAgIHZhciBib2FyZCA9IGludGVybmFsLmxhc3RHb29kO1xuICAgIGlmICghYm9hcmQgfHwgIWJvYXJkLmxhbmVzLmxlbmd0aCkge1xuICAgICAgY3R4LmxvZ2dlci53YXJuKCfnnIvmnb/mlbDmja7ov5jmsqHor7vlj5blrozmiJDvvIzor7flhYjmiZPlvIDnnIvmnb/mqKHlnZflho3or5UnKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgdmFyIGZpcnN0ID0gYm9hcmQubGFuZXNbMF07XG4gICAgdmFyIHRyaWdnZXIgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCdbZGF0YS1sYW5lLWlkPVwiJyArIGZpcnN0LmlkICsgJ1wiXSAua2FuYmFuX19hZGQnKTtcbiAgICBpZiAodHJpZ2dlcikge1xuICAgICAgdHJpZ2dlci5jbGljaygpO1xuICAgICAgLy8g5bGV5byA5paw5bu66KGo5Y2V5pivIFJlYWN0IOeahOW8guatpeabtOaWsO+8jOi+k+WFpeahhuimgeWIsOS4i+S4gOW4p+aJjeWtmOWcqFxuICAgICAgcmVxdWVzdEFuaW1hdGlvbkZyYW1lKGZ1bmN0aW9uICgpIHtcbiAgICAgICAgdmFyIGlucHV0ID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcignW2RhdGEtbGFuZS1pZD1cIicgKyBmaXJzdC5pZCArICdcIl0gLmthbmJhbl9fY29tcG9zZXIgaW5wdXQnKTtcbiAgICAgICAgaWYgKGlucHV0ICYmIGlucHV0LmZvY3VzKSBpbnB1dC5mb2N1cygpO1xuICAgICAgfSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIHZhciBvcGVuSW5wdXQgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCdbZGF0YS1sYW5lLWlkPVwiJyArIGZpcnN0LmlkICsgJ1wiXSAua2FuYmFuX19jb21wb3NlciBpbnB1dCcpO1xuICAgIGlmIChvcGVuSW5wdXQgJiYgb3BlbklucHV0LmZvY3VzKSB7XG4gICAgICBvcGVuSW5wdXQuZm9jdXMoKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgY3R4LmxvZ2dlci53YXJuKCfnnIvmnb/mqKHlnZflvZPliY3msqHmnInmiZPlvIDvvIzor7flhYjliIfliLDnnIvmnb/lho3kvb/nlKjov5nkuKrlkb3ku6QnKTtcbiAgfSxcbn0pO1xuXG5jdHgubG9nZ2VyLmluZm8oJ+eci+adv+aPkuS7tuWKoOi9veWujOaIkCcsIHtcbiAgaG9zdDogTW9kdWxpdGgudmVyc2lvbixcbiAgbm90aWZpY2F0aW9uczogY3R4Lm5vdGlmaWNhdGlvbnMuaXNBdmFpbGFibGUgPyBjdHgubm90aWZpY2F0aW9ucy5pc0F2YWlsYWJsZSgpIDogZmFsc2UsXG4gIGV2ZW50czogY3R4LmV2ZW50cy5pc0F2YWlsYWJsZSgpLFxufSk7XG5cbiJdLAogICJtYXBwaW5ncyI6ICI7Ozs7Ozs7Ozs7QUFhQSxNQUFNLFdBQVcsV0FBVztBQUM1QixNQUFJLENBQUMsVUFBVTtBQUtiLFVBQU0sSUFBSSxNQUFNLHFDQUFxQztBQUFBLEVBQ3ZEO0FBRUEsTUFBTSxRQUFRLFNBQVM7QUFDdkIsTUFBTSxJQUFJLE1BQU07QUFDaEIsTUFBTSxZQUFZLE1BQU07QUFDeEIsTUFBTSxVQUFVLE1BQU07QUFDdEIsTUFBTSxTQUFTLE1BQU07QUFDckIsTUFBTSxXQUFXLE1BQU07QUFDdkIsTUFBTSx1QkFBdUIsTUFBTTtBQUduQyxNQUFNLE1BQU0sU0FBUyxjQUFjO0FBR25DLE1BQU0sWUFBWTtB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O0FBQ2hDLGNBQUksUUFBUSxTQUFTLGNBQWMsb0JBQW9CLE1BQU0sS0FBSyw0QkFBNEI7QUFDOUYsY0FBSSxTQUFTLE1BQU0sTUFBTyxPQUFNLE1BQU07QUFBQSxRQUN4QyxDQUFDO0FBQ0Q7QUFBQSxNQUNGO0FBQ0EsVUFBSSxZQUFZLFNBQVMsY0FBYyxvQkFBb0IsTUFBTSxLQUFLLDRCQUE0QjtBQUNsRyxVQUFJLGFBQWEsVUFBVSxPQUFPO0FBQ2hDLGtCQUFVLE1BQU07QUFDaEI7QUFBQSxNQUNGO0FBQ0EsVUFBSSxPQUFPLEtBQUssMEJBQTBCO0FBQUEsSUFDNUM7QUFBQSxFQUNGLENBQUM7QUFFRCxNQUFJLE9BQU8sS0FBSyxZQUFZO0FBQUEsSUFDMUIsTUFBTSxTQUFTO0FBQUEsSUFDZixlQUFlLElBQUksY0FBYyxjQUFjLElBQUksY0FBYyxZQUFZLElBQUk7QUFBQSxJQUNqRixRQUFRLElBQUksT0FBTyxZQUFZO0FBQUEsRUFDakMsQ0FBQzsiLAogICJuYW1lcyI6IFsiY2FyZCIsICJ0ZXh0IiwgImlkcyIsICJpIiwgInByZWZzIl0KfQo=
