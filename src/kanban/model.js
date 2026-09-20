// 从 plugins/kanban/index.js 拆出 —— **逻辑原样搬运，未做任何改动**。
// 搬运是机械的：每块的位置与内容都没变，只是补上了 import / export。
import { CARD_NOTE_MAX, CARD_TITLE_MAX, DEFAULT_LANES, LANE_AUTO_DONE, LANE_NAME_MAX, SCHEMA_VERSION, ctx } from './env';
import { notify } from './store';

// ---------------------------------------------------------------------------
// 纯函数：数据结构与迁移
// ---------------------------------------------------------------------------

function clone(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function nowIso() {
  return new Date().toISOString();
}

function uid() {
  // crypto.randomUUID 在安全上下文里可用；不可用时退化为时间戳加随机数。
  try {
    if (typeof crypto !== 'undefined' && crypto && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch (err) {
    /* 忽略：下面还有兜底 */
  }
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

function makeLane(name) {
  return { id: uid(), name: name, collapsed: false, createdAt: nowIso() };
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
    cards: {},
  };
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function text(value) {
  return typeof value === 'string' ? value : '';
}

function isDateKey(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** 造一张卡片。键与 id 必须是同一个值 —— 否则按 id 查不到它，编辑与删除会静默失效。 */
function makeCard(laneId, title, order) {
  var id = uid();
  return {
    id: id,
    laneId: laneId,
    title: title,
    note: '',
    priority: 'normal',
    due: null,
    recurrence: null,
    done: false,
    order: typeof order === 'number' ? order : 1,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    completedAt: null,
  };
}

/**
 * 把读到的数据整理成可用的看板。
 *
 * `ctx.storage.get` 本身会捕获 JSON 解析错误并返回默认值，但字段缺失、类型不对、
 * 卡片引用了已不存在的列表这些情况仍要自己兜住 —— 用户的数据只有一份，
 * 读坏一次就等于全丢。
 */
function normalizeBoard(raw) {
  if (!isPlainObject(raw)) return { board: defaultBoard(), notes: [] };

  var notes = [];
  var version = typeof raw.schemaVersion === 'number' ? raw.schemaVersion : SCHEMA_VERSION;
  if (version > SCHEMA_VERSION) {
    notes.push('这份数据来自更新版本的看板插件，本版本只读取、不写入，以免覆盖。');
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
      name: text(item.name).slice(0, LANE_NAME_MAX) || '未命名列表',
      collapsed: !!item.collapsed,
      createdAt: text(item.createdAt) || nowIso(),
    });
  }

  if (lanes.length === 0) {
    lanes = defaultLanes();
    laneIds = {};
    for (var k = 0; k < lanes.length; k += 1) laneIds[lanes[k].id] = true;
    if (rawLanes.length > 0) notes.push('列表结构无法识别，已重置为默认的三个列表。');
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
    // 键与内部 id 不一致时以键为准并修正 id：早期版本写过这种数据，
    // 不修正的话这些卡片在界面上点不动。
    var cardId = text(card.id) || id;
    if (cardId !== id) dropped += 0; // 静默修正，不打扰用户
    if (!laneIds[card.laneId]) {
      dropped += 1; // 引用不存在的列表：宁可少一张，也不要渲染一个点不到的卡片
      continue;
    }
    var done = !!card.done;
    var recurrence =
      card.recurrence === 'daily' || card.recurrence === 'weekly' || card.recurrence === 'monthly'
        ? card.recurrence
        : null;
    cards[id] = {
      id: id,
      laneId: card.laneId,
      title: text(card.title).slice(0, CARD_TITLE_MAX) || '未命名卡片',
      note: text(card.note).slice(0, CARD_NOTE_MAX),
      priority: card.priority === 'low' || card.priority === 'high' ? card.priority : 'normal',
      due: isDateKey(text(card.due)) ? card.due : null,
      recurrence: recurrence,
      done: done,
      order: typeof card.order === 'number' && isFinite(card.order) ? card.order : 0,
      createdAt: text(card.createdAt) || nowIso(),
      updatedAt: text(card.updatedAt) || nowIso(),
      completedAt: done ? text(card.completedAt) || nowIso() : null,
    };
  }

  if (dropped > 0) notes.push('有 ' + dropped + ' 张卡片的数据不完整，已跳过。');

  return {
    board: {
      schemaVersion: Math.max(version, SCHEMA_VERSION),
      rev: typeof raw.rev === 'number' && isFinite(raw.rev) ? raw.rev : 0,
      updatedAt: text(raw.updatedAt) || nowIso(),
      lanes: lanes,
      cards: cards,
    },
    notes: notes,
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
  result.sort(function (a, b) {
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
  return found ? found.name : '已删除的列表';
}

/** 变更后统一推进版本号与时间戳，便于两个实例比对「谁的数据更新」。 */
function touchBoard(board) {
  board.rev = (typeof board.rev === 'number' ? board.rev : 0) + 1;
  board.updatedAt = nowIso();
  return board;
}

/**
 * 把一张卡片放到目标列表里 `before` 与 `after` 两张卡片之间。
 *
 * 用邻卡而不是可见下标来定位，是因为界面上的顺序不等于数组顺序：显示顺序还要按
 * 「未完成 → 优先级 → 截止日」重排。只传下标的话，一次拖动可能落在完全不同的位置 ——
 * 用户看到的现象就是「拖了没反应」。这里把换算放在一处，让落位与指示线永远一致。
 */
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

/** 把列表整体挪到另一个位置（拖动列表或菜单里的「左移 / 右移」都走这里）。 */
function moveLanePure(board, laneId, targetIndex) {
  var from = laneIndexById(board, laneId);
  if (from < 0) return board;
  var to = typeof targetIndex === 'number' ? targetIndex : from;
  if (to < 0) to = 0;
  if (to > board.lanes.length - 1) to = board.lanes.length - 1;
  if (to === from) return board;

  var next = clone(board);
  var moved = next.lanes.splice(from, 1)[0];
  next.lanes.splice(to, 0, moved);
  return touchBoard(next);
}

export { cardsInLane, clone, defaultBoard, defaultLanes, isDateKey, isPlainObject, laneById, laneIndexById, laneNameOf, makeCard, makeLane, moveCardPure, moveLanePure, nextOrder, normalizeBoard, normalizePrefs, nowIso, text, touchBoard, uid };
