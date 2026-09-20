// 从 plugins/kanban/index.js 拆出 —— **逻辑原样搬运，未做任何改动**。
// 搬运是机械的：每块的位置与内容都没变，只是补上了 import / export。
import { PRIORITY_ORDER } from './env';
import { text } from './model';

// ---------------------------------------------------------------------------
// 日期与重复
// ---------------------------------------------------------------------------

function pad2(value) {
  return (value < 10 ? '0' : '') + value;
}

function dateKey(date) {
  return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
}

function parseDateKey(key) {
  var parts = text(key).split('-');
  if (parts.length !== 3) return null;
  var date = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  return isNaN(date.getTime()) ? null : date;
}

function todayKey() {
  return dateKey(new Date());
}

function addDays(key, days) {
  var date = parseDateKey(key) || new Date();
  date.setDate(date.getDate() + days);
  return dateKey(date);
}

/** 下一个周末（周六）。已经到周末就返回本周六。 */
function nextWeekendKey() {
  var date = new Date();
  var day = date.getDay(); // 0 = 周日
  date.setDate(date.getDate() + ((6 - day + 7) % 7));
  return dateKey(date);
}

/** 下周一。 */
function nextMondayKey() {
  var date = new Date();
  var day = date.getDay();
  date.setDate(date.getDate() + ((8 - day) % 7 || 7));
  return dateKey(date);
}

/** 完成一张重复卡片时，算出它的下一次日期。按「当前日期」推进，避免逾期太久积压出一串过去日期。 */
function nextRecurrenceDue(currentDue, recurrence) {
  var base = parseDateKey(currentDue);
  var today = new Date();
  if (!base || base.getTime() < new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) {
    base = today;
  }
  var next = new Date(base.getFullYear(), base.getMonth(), base.getDate());
  if (recurrence === 'daily') {
    next.setDate(next.getDate() + 1);
  } else if (recurrence === 'weekly') {
    next.setDate(next.getDate() + 7);
  } else if (recurrence === 'monthly') {
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
  if (done) return { text: due, tone: 'done' };

  var today = todayKey();
  if (due === today) return { text: '今天到期', tone: 'today' };

  var days = Math.round(
    ((parseDateKey(due) || new Date()).getTime() - (parseDateKey(today) || new Date()).getTime()) / 86400000
  );
  if (days < 0) return { text: '逾期 ' + Math.abs(days) + ' 天', tone: 'overdue' };
  if (days === 1) return { text: '明天到期', tone: 'soon' };
  if (days <= 6) return { text: days + ' 天后', tone: 'soon' };
  return { text: '截止 ' + due.slice(5), tone: 'normal' };
}

function formatDateTime(iso) {
  if (!iso) return '';
  var value = new Date(iso);
  if (isNaN(value.getTime())) return '';
  return (
    value.getFullYear() + '-' + pad2(value.getMonth() + 1) + '-' + pad2(value.getDate()) +
    ' ' + pad2(value.getHours()) + ':' + pad2(value.getMinutes())
  );
}

function isOverdue(card, today) {
  return !!card.due && !card.done && card.due < today;
}

function matchesQuery(card, query) {
  if (!query) return true;
  var needle = query.toLowerCase();
  return card.title.toLowerCase().indexOf(needle) >= 0 || card.note.toLowerCase().indexOf(needle) >= 0;
}

/**
 * 显示顺序：未完成优先 → 优先级 → 截止日（无截止日排最后）→ 手动顺序。
 * 拖动只在「同一优先级、同一截止日」的卡片之间改变顺序，见文件头的说明。
 */
function sortCards(list) {
  return list.slice().sort(function (a, b) {
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

export { addDays, dateKey, dueInfo, formatDateTime, isOverdue, matchesQuery, nextMondayKey, nextRecurrenceDue, nextWeekendKey, pad2, parseDateKey, sortCards, todayKey };
