/// <reference path="../../types/modulith.d.ts" />
// src/kanban/env.ts
//
// 看板插件的**共享环境**：宿主对象、React 的简写、以及全插件共用的常量。
//
// 为什么单独一个文件，而不是每个文件各自取一遍：`Modulith.createContext()`
// **只能在加载期调用一次**。每个模块各调一次会拿到多个上下文 —— 通知的可用性、
// 事件的订阅表、设置的读写都会分叉，而那种分裂在界面上表现为"有时候收不到提醒"，
// 极难归因。
//
// 这份文件从 plugins/kanban/index.js 的 IIFE 头部搬运而来，**常量与取值方式
// 一字未改**。

const Modulith = globalThis.Modulith as ModulithHost | undefined;
if (!Modulith) {
  // 原文件在这里 `console.error` 之后 `return`（它是 IIFE，可以就地退出）。
  // 拆成模块之后没有"退出整个插件"这种东西，而**抛错的效果是一样的**：
  // 入口不会执行，模块不会注册。区别只是它更显眼 —— 而宿主连 Modulith 都没注入，
  // 这本来就是该响一声的事。
  throw new Error('[kanban] 未找到 window.Modulith，插件无法加载');
}

const React = Modulith.React;
const h = React.createElement;
const useEffect = React.useEffect;
const useMemo = React.useMemo;
const useRef = React.useRef;
const useState = React.useState;
const useSyncExternalStore = React.useSyncExternalStore;

// createContext() 只能在加载期调用，因此在这里取一次并长期持有。
const ctx = Modulith.createContext();

/** 存储键。只允许字母数字与 . _ -，最长 128 字符 */
const KEY_BOARD = 'board';
const KEY_DRAFT = 'draft';
const KEY_PREFS = 'prefs';

/** 看板数据结构版本。读到更高版本时只读不写，免得把新版数据写坏。 */
const SCHEMA_VERSION = 1;

/** 事件主题名只能用小写字母、数字与 . _ -，最长 64 字符 */
const TOPIC_CHANGED = 'kanban.board.changed';

const DEFAULT_LANES = ['待处理', '进行中', '已完成'];
const LANE_NAME_MAX = 18;
const CARD_TITLE_MAX = 120;
const CARD_NOTE_MAX = 500;
const DRAFT_MAX = 4000;
const LANE_AUTO_DONE = '完成'; // 名字里带这两个字的列表，拖进去自动标记为已完成
const UNDO_MS = 8000;
const DRAFT_DEBOUNCE_MS = 400;
const SAVE_DEBOUNCE_MS = 400;
const DRAG_THRESHOLD = 6;
const NOTIFICATION_ID_MAX = 200;

const PRIORITY_LABEL = { low: '低', normal: '中', high: '高' };
const PRIORITY_ORDER = { high: 0, normal: 1, low: 2 };
const RECURRENCE_LABEL = { daily: '每天', weekly: '每周', monthly: '每月' };

/**
 * 类名写成查表而不是字符串拼接：拼接出来的类名在全仓库搜索里找不到，
 * 改样式时无法确认「这个类还有没有人在用」，静态检查也会把它当成没人用的废弃规则。
 */
const PRIORITY_CLASS = {
  low: 'kanban__pill--low',
  normal: 'kanban__pill--normal',
  high: 'kanban__pill--high',
};
const DUE_CLASS = {
  normal: 'kanban__due--normal',
  soon: 'kanban__due--soon',
  today: 'kanban__due--today',
  overdue: 'kanban__due--overdue',
  done: 'kanban__due--done',
};

export {
  Modulith,
  React,
  h,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  ctx,
  KEY_BOARD,
  KEY_DRAFT,
  KEY_PREFS,
  SCHEMA_VERSION,
  TOPIC_CHANGED,
  DEFAULT_LANES,
  LANE_NAME_MAX,
  CARD_TITLE_MAX,
  CARD_NOTE_MAX,
  DRAFT_MAX,
  LANE_AUTO_DONE,
  UNDO_MS,
  DRAFT_DEBOUNCE_MS,
  SAVE_DEBOUNCE_MS,
  DRAG_THRESHOLD,
  NOTIFICATION_ID_MAX,
  PRIORITY_LABEL,
  PRIORITY_ORDER,
  RECURRENCE_LABEL,
  PRIORITY_CLASS,
  DUE_CLASS,
};
