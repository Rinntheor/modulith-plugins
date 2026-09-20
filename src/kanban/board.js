// 从 plugins/kanban/index.js 拆出 —— **逻辑原样搬运，未做任何改动**。
// 搬运是机械的：每块的位置与内容都没变，只是补上了 import / export。
import { addDays, isOverdue, matchesQuery, sortCards, todayKey } from './dates';
import { CardEditor } from './editor';
import { CARD_TITLE_MAX, DEFAULT_LANES, DRAFT_DEBOUNCE_MS, DRAG_THRESHOLD, KEY_DRAFT, LANE_NAME_MAX, Modulith, TOPIC_CHANGED, UNDO_MS, ctx, h, useEffect, useMemo, useRef, useState, useSyncExternalStore } from './env';
import { icon, icons } from './icons';
import { Lane } from './lane';
import { DraftView } from './memo';
import { cardsInLane, clone, laneById, laneNameOf, text } from './model';
import { boardActions, dayChanged, dueReminder, greeting, internal, load, loadDraft, notify, pushNote, reload, savePrefsNow, store } from './store';
import { ErrorBanner, Menu, MenuItem, SaveIndicator } from './ui';

// ---------------------------------------------------------------------------
// 看板主体
// ---------------------------------------------------------------------------

function KanbanBoard() {
  var state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  var active = Modulith.useModuleActive();

  var viewState = useState('board'); // board | draft
  var view = viewState[0];
  var setView = viewState[1];

  var queryState = useState('');
  var query = queryState[0];
  var setQuery = queryState[1];

  var filterState = useState('all'); // all | overdue | high
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

  var dragState = useState(null); // { kind: 'card' | 'lane', label }
  var dragPreview = dragState[0];
  var setDragPreview = dragState[1];

  var dropState = useState(null); // 卡片：{ laneId, index, beforeId, afterId }；列表：{ laneId }
  var drop = dropState[0];
  var setDrop = dropState[1];

  var laneDropState = useState(null); // 列表拖动时的落点：{ beforeId, afterId }
  var laneDrop = laneDropState[0];
  var setLaneDrop = laneDropState[1];

  var addLaneState = useState(false);
  var addingLane = addLaneState[0];
  var setAddingLane = addLaneState[1];

  var announceState = useState('');
  var announce = announceState[0];
  var setAnnounce = announceState[1];

  var justMovedState = useState(null);
  var justMovedId = justMovedState[0];
  var setJustMovedId = justMovedState[1];

  var draftSaveState = useState('idle');
  var draftSave = draftSaveState[0];
  var setDraftSave = draftSaveState[1];

  var firstCardState = useState('');
  var firstCard = firstCardState[0];
  var setFirstCard = firstCardState[1];

  var draggingRef = useRef(null);
  var geometryRef = useRef(null);
  var laneBoxesRef = useRef(null);
  var modeRef = useRef(view);
  var undoTimerRef = useRef(null);
  var moveFlashRef = useRef(null);

  modeRef.current = view;

  // 进入模块：读数据，接上另一个实例的变更通知，检查一次到期提醒。
  useEffect(function () {
    internal.alive = true;
    reload().then(function () {
      dueReminder(store.getSnapshot().board);
    });

    var unsubscribe = ctx.events.subscribe(TOPIC_CHANGED, function (event) {
      if (!internal.alive || !internal.loaded) return;
      var rev = event && event.payload && typeof event.payload.rev === 'number' ? event.payload.rev : 0;
      if (rev > 0 && rev <= internal.savedRev) return; // 就是自己写的那一次
      store.set({ conflict: false });
      load().then(function () {
        if (modeRef.current === 'draft') loadDraft();
      });
    });

    return function () {
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

  // 重新可见时再读一次：不可见期间另一个实例可能已经写过数据。
  // 本地还有没落盘的改动时绝不读 —— 那会把磁盘上的旧版本装回界面，顶掉用户刚做的改动。
  // 跨天时也在这里补一次提醒检查。
  useEffect(function () {
    if (!active || !internal.loaded) return undefined;
    if (internal.timer !== null || internal.saving || store.getSnapshot().conflict) return undefined;
    load().then(function () {
      if (modeRef.current === 'draft') loadDraft();
      if (dayChanged()) dueReminder(store.getSnapshot().board);
    });
    return undefined;
  }, [active]);

  // 撤销条到点自动收起
  useEffect(function () {
    if (!undo) return undefined;
    var timer = setTimeout(function () {
      setUndo(null);
    }, UNDO_MS);
    return function () {
      clearTimeout(timer);
    };
  }, [undo]);

  // 播报给读屏软件：拖动或键盘移动之后，光靠视觉反馈是收不到的
  useEffect(function () {
    if (!announce) return undefined;
    var timer = setTimeout(function () {
      setAnnounce('');
    }, 4000);
    return function () {
      clearTimeout(timer);
    };
  }, [announce]);

  var board = state.board;
  var lanes = board ? board.lanes : [];
  var cards = board ? board.cards : {};
  var today = todayKey();

  var matches = useMemo(
    function () {
      var map = {};
      var ids = Object.keys(cards);
      for (var i = 0; i < ids.length; i += 1) {
        var card = cards[ids[i]];
        var visible = true;
        if (card.done && !showDone) visible = false;
        if (visible && filter === 'overdue' && !isOverdue(card, today)) visible = false;
        if (visible && filter === 'high' && card.priority !== 'high') visible = false;
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

  // --- 拖动 ---------------------------------------------------------------

  function measureLaneBodies() {
    var bodyNodes = document.querySelectorAll('[data-lane-body="1"]');
    var geometry = [];
    for (var i = 0; i < bodyNodes.length; i += 1) {
      var node = bodyNodes[i];
      var box = node.getBoundingClientRect();
      var cardNodes = node.querySelectorAll('[data-card-id]');
      var entries = [];
      for (var j = 0; j < cardNodes.length; j += 1) {
        var cardBox = cardNodes[j].getBoundingClientRect();
        entries.push({ id: cardNodes[j].getAttribute('data-card-id'), top: cardBox.top, height: cardBox.height });
      }
      geometry.push({
        laneId: node.getAttribute('data-lane-id'),
        top: box.top,
        bottom: box.bottom,
        left: box.left,
        right: box.right,
        cards: entries,
      });
    }
    return geometry;
  }

  function measureLanes() {
    var nodes = document.querySelectorAll('.kanban__lane[data-lane-id]');
    var boxes = [];
    for (var i = 0; i < nodes.length; i += 1) {
      var box = nodes[i].getBoundingClientRect();
      boxes.push({
        laneId: nodes[i].getAttribute('data-lane-id'),
        left: box.left,
        right: box.right,
        center: box.left + box.width / 2,
      });
    }
    return boxes;
  }

  function computeCardDrop(clientX, clientY) {
    var geometry = geometryRef.current;
    if (!geometry || geometry.length === 0) return null;

    var target = null;
    for (var i = 0; i < geometry.length; i += 1) {
      if (clientY >= geometry[i].top && clientY <= geometry[i].bottom) {
        target = geometry[i];
        break;
      }
    }
    if (!target) {
      // 指针落在列表之间的空隙或列表下方：取水平距离最近的那一列
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

    // 指针落在第 n 张卡片的哪一半，决定它插到这张卡片之前还是之后
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
      index: index,
      beforeId: prev ? prev.id : null,
      afterId: next ? next.id : null,
    };
  }

  function computeLaneDrop(clientX) {
    var boxes = laneBoxesRef.current;
    if (!boxes || boxes.length === 0) return null;

    var nearest = null;
    var bestDistance = Infinity;
    for (var i = 0; i < boxes.length; i += 1) {
      var distance = Math.abs(clientX - boxes[i].center);
      if (distance < bestDistance) {
        bestDistance = distance;
        nearest = boxes[i];
      }
    }
    if (!nearest) return null;

    // 落在左半边就插到它前面，右半边插到它后面
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
      targetIndex: targetIndex,
      beforeId: beforeLane ? beforeLane.laneId : null,
      afterId: afterLane ? afterLane.laneId : null,
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

  /** 高亮刚落到新位置的卡片，让「确实挪过去了」这件事看得见。 */
  function flashMoved(cardId) {
    setJustMovedId(cardId);
    if (moveFlashRef.current !== null) clearTimeout(moveFlashRef.current);
    moveFlashRef.current = setTimeout(function () {
      moveFlashRef.current = null;
      setJustMovedId(null);
    }, 1200);
  }

  /**
   * 统一的拖动过程。kind 决定测什么、画什么、松手后做什么：
   *   'card' —— 卡片在列表内换位或换列表
   *   'lane' —— 列表整体换位
   * 两者共用同一套「阈值 → 落点 → 取消 → 松手」流程，避免两份实现行为不一致。
   */
  function startDrag(kind, targetId, event) {
    if (draggingRef.current) return;
    var currentBoard = store.getSnapshot().board;
    if (!currentBoard) return;

    var anchor = document.querySelector(
      (kind === 'card' ? '[data-card-id="' : '.kanban__lane[data-lane-id="') + targetId + '"]'
    );
    if (!anchor) return;

    if (kind === 'card') {
      if (!currentBoard.cards[targetId]) return;
      geometryRef.current = measureLaneBodies();
    } else {
      if (!laneById(currentBoard, targetId)) return;
      laneBoxesRef.current = measureLanes();
    }

    var box = anchor.getBoundingClientRect();
    var drag = {
      kind: kind,
      targetId: targetId,
      width: box.width,
      height: box.height,
      offsetX: event.clientX - box.left,
      offsetY: event.clientY - box.top,
      moved: false,
    };
    draggingRef.current = drag;
    var origin = { x: event.clientX, y: event.clientY };

    function onMove(moveEvent) {
      var current = draggingRef.current;
      if (!current) return;
      if (!current.moved) {
        var dx = moveEvent.clientX - origin.x;
        var dy = moveEvent.clientY - origin.y;
        if (dx * dx + dy * dy < DRAG_THRESHOLD * DRAG_THRESHOLD) return; // 抖动不算拖动，避免误触
        current.moved = true;
        document.body.classList.add('kanban-dragging');
      }
      moveEvent.preventDefault();

      if (kind === 'card') {
        var card = store.getSnapshot().board.cards[targetId];
        if (!card) return;
        var next = computeCardDrop(moveEvent.clientX, moveEvent.clientY);
        if (next) {
          setDrop(next);
          setDragPreview({
            kind: 'card',
            title: card.title,
            laneName: laneNameOf(store.getSnapshot().board, next.laneId),
            overLane: next.laneId !== card.laneId,
            x: moveEvent.clientX - current.offsetX,
            y: moveEvent.clientY - current.offsetY,
            width: current.width,
          });
        } else {
          setDragPreview({
            kind: 'card',
            title: card.title,
            laneName: null,
            overLane: false,
            x: moveEvent.clientX - current.offsetX,
            y: moveEvent.clientY - current.offsetY,
            width: current.width,
          });
        }
        return;
      }

      // 列表拖动
      var lane = laneById(store.getSnapshot().board, targetId);
      if (!lane) return;
      var laneNext = computeLaneDrop(moveEvent.clientX);
      if (laneNext) setLaneDrop(laneNext);
      setDragPreview({
        kind: 'lane',
        title: lane.name,
        laneName: laneNext ? '放到第 ' + (laneNext.targetIndex + 1) + ' 栏' : null,
        overLane: false,
        x: moveEvent.clientX - current.offsetX,
        y: moveEvent.clientY - current.offsetY,
        width: current.width,
      });
    }

    function detach() {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey);
      document.body.classList.remove('kanban-dragging');
    }

    function onUp(upEvent) {
      detach();
      var current = draggingRef.current;
      if (!current) return;
      if (!current.moved) {
        clearDrag(); // 没有真正移动：当成一次普通点击，不动数据
        return;
      }

      if (kind === 'card') {
        var target = computeCardDrop(upEvent.clientX, upEvent.clientY);
        var sourceLaneId = store.getSnapshot().board.cards[targetId].laneId;
        clearDrag();
        if (!target) return;
        boardActions.moveCard(targetId, target.laneId, target.beforeId, target.afterId);
        var name = laneNameOf(store.getSnapshot().board, target.laneId);
        flashMoved(targetId);
        setAnnounce(
          target.laneId === sourceLaneId ? '已在「' + name + '」内调整顺序' : '已移动到「' + name + '」'
        );
        return;
      }

      var laneTarget = computeLaneDrop(upEvent.clientX);
      var laneName = laneNameOf(store.getSnapshot().board, targetId);
      clearDrag();
      if (!laneTarget) return;
      boardActions.moveLane(targetId, laneTarget.targetIndex);
      setAnnounce('列表「' + laneName + '」已放到第 ' + (laneTarget.targetIndex + 1) + ' 栏');
    }

    function onCancel() {
      detach();
      clearDrag();
    }

    function onKey(keyEvent) {
      if (keyEvent.key !== 'Escape') return;
      keyEvent.preventDefault();
      onCancel();
    }

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey);
  }

  function moveCardToLane(cardId, laneIndex) {
    var target = board && board.lanes[laneIndex];
    if (!target) return;
    boardActions.moveCard(cardId, target.id, null, null);
    flashMoved(cardId);
    setAnnounce('已移动到「' + target.name + '」');
  }

  function removeCard(cardId) {
    var current = store.getSnapshot().board;
    if (!current || !current.cards[cardId]) return;
    var snapshot = clone(current.cards[cardId]);
    var title = boardActions.deleteCard(cardId);
    setEditingId(null);
    setUndo({ kind: 'card', card: snapshot, title: title });
    setAnnounce('已删除「' + (title || '卡片') + '」，可以撤销');
  }

  function removeLane(laneId) {
    var removed = boardActions.deleteLane(laneId);
    if (!removed) {
      setAnnounce('至少要保留一个列表');
      return;
    }
    setUndo({ kind: 'lane', lane: removed });
    setAnnounce('已删除列表「' + removed.name + '」，可以撤销');
    notify(
      '列表「' + removed.name + '」已删除',
      removed.cards.length > 0 ? '其中的 ' + removed.cards.length + ' 张卡片也一起移除了。' : '该列表原本是空的。',
      'kanban-lane-removed'
    );
  }

  function sendLineToBoard(laneId, title) {
    var cardId = boardActions.addCard(laneId, title, 'normal', null, null);
    if (!cardId) return;
    setAnnounce('已把「' + title + '」加入「' + laneNameOf(store.getSnapshot().board, laneId) + '」');
  }

  function toggleNotify() {
    var prefs = store.getSnapshot().prefs || { notify: true };
    var next = { notify: prefs.notify === false };
    store.set({ prefs: next });
    savePrefsNow(next);
    if (next.notify) {
      dueReminder(store.getSnapshot().board);
      notify('到期提醒已开启', '有卡片到期或逾期时，我会在这个应用里提醒你一次。', 'kanban-notify-on');
    }
  }

  function onRootKeyDown(event) {
    var modifier = event.ctrlKey || event.metaKey;
    if (modifier && (event.key === 'n' || event.key === 'N')) {
      if (view !== 'board') setView('board');
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
      requestAnimationFrame(function () {
        var later = document.querySelector('[data-lane-id="' + first.id + '"] .kanban__composer input');
        if (later) later.focus();
      });
      return;
    }
    if (modifier && (event.key === 'f' || event.key === 'F')) {
      event.preventDefault();
      var search = document.querySelector('.kanban__search input');
      if (search) search.focus();
    }
  }

  // --- 渲染 ---------------------------------------------------------------

  var editing = editingId && board ? board.cards[editingId] : null;
  var prefs = state.prefs || { notify: true };

  var header = h(
    'header',
    { className: 'kanban__header' },
    h(
      'div',
      { className: 'kanban__header-top' },
      h(
        'div',
        { className: 'kanban__title-block' },
        h('h1', { className: 'kanban__title' }, '看板'),
        h(
          'p',
          { className: 'kanban__subtitle' },
          greeting() +
            '。' +
            (countAll === 0
              ? '还没有卡片。'
              : countOverdue > 0
              ? '有 ' + countOverdue + ' 项已经逾期。'
              : countToday > 0
              ? '今天有 ' + countToday + ' 项到期。'
              : '共 ' + countAll + ' 项，其中 ' + countDone + ' 项已完成。')
        )
      ),
      h(
        'div',
        { className: 'kanban__tabs', role: 'tablist', 'aria-label': '视图切换' },
        h(
          'button',
          {
            type: 'button',
            role: 'tab',
            className: 'kanban__tab' + (view === 'board' ? ' is-active' : ''),
            'aria-selected': view === 'board',
            onClick: function () {
              setView('board');
            },
          },
          '看板'
        ),
        h(
          'button',
          {
            type: 'button',
            role: 'tab',
            className: 'kanban__tab' + (view === 'draft' ? ' is-active' : ''),
            'aria-selected': view === 'draft',
            onClick: function () {
              setView('draft');
            },
          },
          '速记'
        )
      ),
      h('span', { className: 'kanban__card-spacer' }),
      h(SaveIndicator, { draftState: draftSave })
    ),
    h(
      'div',
      { className: 'kanban__toolbar' },
      view === 'board'
        ? h(
            'div',
            { className: 'kanban__search' },
            h('span', { className: 'kanban__search-icon', 'aria-hidden': 'true' }, icons.search()),
            h('input', {
              className: 'kanban__input',
              type: 'search',
              value: query,
              placeholder: '搜索（Ctrl + F）',
              'aria-label': '搜索卡片',
              onChange: function (event) {
                setQuery(event.target.value);
              },
            })
          )
        : null,
      view === 'board'
        ? h(
            'div',
            { className: 'kanban__filters', role: 'group', 'aria-label': '筛选' },
            h(
              'button',
              {
                type: 'button',
                className: 'kanban__filter' + (filter === 'all' ? ' is-active' : ''),
                'aria-pressed': filter === 'all',
                onClick: function () {
                  setFilter('all');
                },
              },
              '全部'
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'kanban__filter' + (filter === 'overdue' ? ' is-active is-warn' : ''),
                'aria-pressed': filter === 'overdue',
                disabled: countOverdue === 0,
                onClick: function () {
                  setFilter(filter === 'overdue' ? 'all' : 'overdue');
                },
              },
              '已逾期',
              countOverdue > 0 ? h('span', { className: 'kanban__filter-count' }, String(countOverdue)) : null
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'kanban__filter' + (filter === 'high' ? ' is-active' : ''),
                'aria-pressed': filter === 'high',
                onClick: function () {
                  setFilter(filter === 'high' ? 'all' : 'high');
                },
              },
              '高优先级'
            )
          )
        : null,
      h('span', { className: 'kanban__card-spacer' }),
      view === 'board'
        ? h(
            'span',
            { className: 'kanban__stats' },
            query || filter !== 'all' ? '显示 ' + countMatched + ' / ' + countAll + ' 张' : countAll + ' 张卡片'
          )
        : null,
      h(
        'button',
        {
          type: 'button',
          className: 'kanban__icon-btn' + (prefs.notify ? '' : ' is-off'),
          'aria-label': prefs.notify ? '到期提醒已开启，点击关闭' : '到期提醒已关闭，点击开启',
          'aria-pressed': !!prefs.notify,
          title: prefs.notify ? '到期提醒已开启' : '到期提醒已关闭',
          onClick: toggleNotify,
        },
        prefs.notify ? icons.bell() : icons.bellOff()
      ),
      view === 'board'
        ? h(
            Menu,
            {
              label: '列表操作',
              title: '列表',
              triggerClass: 'kanban__icon-btn',
              trigger: icons.columns(),
            },
            function (close) {
              return [
                h(
                  MenuItem,
                  {
                    key: 'add',
                    onClick: function () {
                      close();
                      setAddingLane(true);
                    },
                  },
                  '添加列表…'
                ),
                h(
                  MenuItem,
                  {
                    key: 'reset',
                    disabled: countAll > 0 && board.lanes.map(function (l) { return l.name; }).join('|') === DEFAULT_LANES.join('|'),
                    onClick: function () {
                      close();
                      var moved = boardActions.resetLanes();
                      if (moved) {
                        setAnnounce('已恢复默认列表；卡片按所在栏与完成状态归位，一张都没有删。');
                        notify(
                          '已恢复默认列表',
                          '「' + DEFAULT_LANES.join('」「') + '」三栏已就绪，卡片按原状态归入，没有删除任何卡片。',
                          'kanban-lanes-reset'
                        );
                      }
                    },
                  },
                  '恢复默认列表'
                ),
              ];
            }
          )
        : null,
      view === 'board' && countDone > 0
        ? h(
            Menu,
            {
              label: '已完成卡片',
              title: '已完成',
              triggerClass: 'kanban__btn kanban__btn--ghost kanban__btn--tight',
              trigger: [
                '已完成 ' + countDone,
                showDone ? null : h('span', { key: 'hint', className: 'kanban__hint' }, '（已隐藏）'),
              ],
            },
            function (close) {
              return [
                h(
                  MenuItem,
                  {
                    key: 'toggle',
                    onClick: function () {
                      close();
                      setShowDone(!showDone);
                    },
                  },
                  showDone ? '隐藏已完成卡片' : '显示已完成卡片'
                ),
                h(
                  MenuItem,
                  {
                    key: 'clear',
                    danger: true,
                    onClick: function () {
                      close();
                      var removed = boardActions.clearDone();
                      if (removed > 0) {
                        setAnnounce('已清除 ' + removed + ' 张已完成卡片');
                        notify('已清除 ' + removed + ' 张已完成卡片', '清除掉的卡片无法找回。', 'kanban-clear-done');
                      }
                    },
                  },
                  '清除这 ' + countDone + ' 张卡片'
                ),
              ];
            }
          )
        : null
    )
  );

  var body;
  if (state.status === 'loading') {
    body = h('p', { className: 'kanban__placeholder' }, '正在读取你的看板…');
  } else if (state.status === 'error') {
    body = h(
      'p',
      { className: 'kanban__placeholder' },
      '数据没能读出来。上面的提示里写了原因；磁盘上的数据没有被改动，修好之后点「重新读取」即可。'
    );
  } else if (view === 'draft') {
    body = h(DraftView, {
      draft: state.draft,
      lanes: lanes,
      onSendToBoard: sendLineToBoard,
      onChange: function (value) {
        store.set({ draft: value });
        setDraftSave('saving');
        if (internal.draftTimer !== null) clearTimeout(internal.draftTimer);
        internal.draftTimer = setTimeout(function () {
          internal.draftTimer = null;
          ctx.storage
            .set(KEY_DRAFT, store.getSnapshot().draft)
            .then(function () {
              setDraftSave('saved');
            })
            .catch(function (err) {
              ctx.logger.warn('保存速记草稿失败', err);
              setDraftSave('error');
              pushNote('速记草稿没能写进存储，下次打开可能看不到它。');
            });
        }, DRAFT_DEBOUNCE_MS);
      },
    });
  } else if (countAll === 0 && !query && filter === 'all') {
    body = h(
      'div',
      { className: 'kanban__empty' },
      h('h2', { className: 'kanban__empty-title' }, '从第一件事开始'),
      h(
        'p',
        { className: 'kanban__empty-text' },
        '写下来，它会落在「待处理」里。之后可以拖动卡片换栏，Alt + 左右方向键也可以；' +
          '按回车打开编辑器补充说明、优先级与截止日。截止日到了会有提醒。'
      ),
      h(
        'div',
        { className: 'kanban__empty-actions' },
        h('input', {
          className: 'kanban__input kanban__empty-input',
          value: firstCard,
          maxLength: CARD_TITLE_MAX,
          placeholder: '例如：把周报写完',
          'aria-label': '第一张卡片的标题',
          onChange: function (event) {
            setFirstCard(event.target.value);
          },
          onKeyDown: function (event) {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            if (!firstCard.trim()) return;
            boardActions.addCard(board.lanes[0].id, firstCard.trim().slice(0, CARD_TITLE_MAX), 'normal', null, null);
            setFirstCard('');
          },
        }),
        h(
          'button',
          {
            type: 'button',
            className: 'kanban__btn kanban__btn--primary',
            disabled: firstCard.trim().length === 0,
            onClick: function () {
              boardActions.addCard(board.lanes[0].id, firstCard.trim().slice(0, CARD_TITLE_MAX), 'normal', null, null);
              setFirstCard('');
            },
          },
          '添加这张卡片'
        )
      ),
      h(
        'p',
        { className: 'kanban__hint kanban__empty-foot' },
        '已经在别处记了？切到「速记」把每一行逐个加进来。'
      )
    );
  } else {
    var laneNodes = lanes.map(function (lane, index) {
      var list = [];
      var all = cardsInLane(board, lane.id);
      for (var n = 0; n < all.length; n += 1) {
        if (matches[all[n].id]) list.push(all[n]);
      }
      list = sortCards(list);
      return h(Lane, {
        key: lane.id,
        lane: lane,
        board: board,
        cards: list,
        laneIndex: index,
        laneCount: lanes.length,
        dragging: activeDrag,
        dropLaneId: drop ? drop.laneId : null,
        dropIndex: drop ? drop.index : 0,
        laneDropBeforeId: laneDrop ? laneDrop.beforeId : null,
        laneDropAfterId: laneDrop ? laneDrop.afterId : null,
        justMovedId: justMovedId,
        hasQuery: query.length > 0 || filter !== 'all',
        onDragStart: function (cardId, event) {
          startDrag('card', cardId, event);
        },
        onLaneDragStart: function (laneId, event) {
          startDrag('lane', laneId, event);
        },
        onAddCard: function (title, priority, due, recurrence) {
          boardActions.addCard(lane.id, title, priority, due, recurrence);
        },
        onRenameLane: function (laneId, name) {
          boardActions.renameLane(laneId, name);
        },
        onToggleCollapsed: function (laneId) {
          boardActions.toggleLaneCollapsed(laneId);
        },
        onMoveLane: function (laneId, targetIndex) {
          boardActions.moveLane(laneId, targetIndex);
          setAnnounce('列表已移动到第 ' + (targetIndex + 1) + ' 栏');
        },
        onRemoveLane: removeLane,
        onEdit: function (cardId) {
          setEditingId(cardId);
        },
        onDelete: removeCard,
        onToggleDone: function (cardId, done) {
          boardActions.toggleDone(cardId, done);
        },
        onSetPriority: function (cardId, priority) {
          boardActions.updateCard(cardId, { priority: priority });
        },
        onSetDue: function (cardId, due) {
          boardActions.updateCard(cardId, { due: due });
          setAnnounce(due ? '截止日已设为 ' + due : '已清除截止日');
        },
        onShiftDue: function (cardId, days) {
          var card = store.getSnapshot().board.cards[cardId];
          if (!card) return;
          var next = addDays(card.due || todayKey(), days);
          boardActions.updateCard(cardId, { due: next });
          setAnnounce('截止日改为 ' + next);
        },
        onMoveCardToLane: moveCardToLane,
      });
    });

    body = h(
      'div',
      { className: 'kanban__board' },
      laneNodes,
      addingLane
        ? h(
            'form',
            {
              className: 'kanban__lane kanban__lane--new',
              onSubmit: function (event) {
                event.preventDefault();
                var value = event.target.elements.laneName.value.trim();
                if (value) boardActions.addLane(value.slice(0, LANE_NAME_MAX));
                setAddingLane(false);
              },
            },
            h('input', {
              className: 'kanban__input',
              name: 'laneName',
              autoFocus: true,
              maxLength: LANE_NAME_MAX,
              placeholder: '新列表叫什么？',
              'aria-label': '新列表名称',
            }),
            h(
              'div',
              { className: 'kanban__composer-row' },
              h('button', { type: 'submit', className: 'kanban__btn kanban__btn--primary' }, '创建列表'),
              h(
                'button',
                {
                  type: 'button',
                  className: 'kanban__btn kanban__btn--ghost',
                  onClick: function () {
                    setAddingLane(false);
                  },
                },
                '取消'
              )
            )
          )
        : h(
            'button',
            {
              type: 'button',
              className: 'kanban__lane-add',
              onClick: function () {
                setAddingLane(true);
              },
            },
            icons.plus(16),
            '添加列表'
          )
    );
  }

  return h(
    'div',
    { className: 'kanban', onKeyDown: onRootKeyDown },
    header,
    h(ErrorBanner),
    state.conflict
      ? h(
          'div',
          { className: 'kanban__banner kanban__banner--warn', role: 'status' },
          h('span', { className: 'kanban__banner-text' }, '另一个看板实例保存了更新的内容，界面已切换成它的版本。')
        )
      : null,
    body,
    h('div', { className: 'kanban__live', role: 'status', 'aria-live': 'polite' }, announce),
    undo
      ? h(
          'div',
          { className: 'kanban__toast' },
          h(
            'span',
            null,
            undo.kind === 'lane'
              ? '已删除列表「' + undo.lane.name + '」' + (undo.lane.cards.length > 0 ? '（含 ' + undo.lane.cards.length + ' 张卡片）' : '')
              : '已删除「' + (undo.title || '卡片') + '」'
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'kanban__btn kanban__btn--ghost kanban__btn--tight',
              onClick: function () {
                if (undo.kind === 'lane') boardActions.restoreLane(undo.lane);
                else boardActions.restoreCard(undo.card);
                setUndo(null);
              },
            },
            icons.undo(13),
            '撤销'
          )
        )
      : null,
    editing
      ? h(CardEditor, {
          card: editing,
          lanes: lanes,
          onClose: function () {
            setEditingId(null);
          },
          onDelete: function () {
            removeCard(editing.id);
          },
          onSave: function (patch) {
            var laneChanged = patch.laneId !== editing.laneId;
            boardActions.updateCard(editing.id, {
              title: patch.title,
              note: patch.note,
              priority: patch.priority,
              due: patch.due,
              recurrence: patch.recurrence,
            });
            if (laneChanged) boardActions.moveCard(editing.id, patch.laneId, null, null);
            setEditingId(null);
          },
        })
      : null,
    dragPreview
      ? h(
          'div',
          {
            className:
              'kanban__drag-preview' + (dragPreview.kind === 'lane' ? ' kanban__drag-preview--lane' : ''),
            'aria-hidden': 'true',
            style: {
              transform: 'translate3d(' + Math.round(dragPreview.x) + 'px,' + Math.round(dragPreview.y) + 'px,0)',
              width: dragPreview.width ? Math.round(dragPreview.width) + 'px' : undefined,
            },
          },
          h(
            'div',
            { className: 'kanban__drag-head' },
            h('span', { className: 'kanban__grip' }, icons.grip()),
            h('span', { className: 'kanban__card-title' }, dragPreview.title)
          ),
          dragPreview.laneName
            ? h(
                'span',
                { className: 'kanban__drag-target' + (dragPreview.overLane ? ' is-over' : '') },
                dragPreview.overLane ? '移到「' + dragPreview.laneName + '」' : dragPreview.laneName
              )
            : null
        )
      : null
  );
}

export { KanbanBoard };
