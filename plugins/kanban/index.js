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
