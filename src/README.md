# src/

插件的**多文件源码**。放一个 `<插件名>/` 目录、里面写 `index.tsx`（也认 `.ts` /
`.jsx` / `.js`），`pnpm build` 会把它编译成 `plugins/<插件名>/index.js`。

## 这个目录是可选的

没有它，插件就是手写的单文件 `plugins/<插件名>/index.js` —— 那条路一直有效，
门槛最低（不需要任何工具链）。这里是**快车道**：

- 可以拆成多个文件
- 可以写 JSX（不必再 `React.createElement`）
- 可以用 TypeScript —— 但只做**类型擦除**，不做类型检查，那一步自己跑 `tsc`

## 约定

| | |
| --- | --- |
| 源码 | `src/<插件名>/index.tsx`（也认 `.ts` / `.jsx` / `.js`） |
| 产物 | `plugins/<插件名>/index.js` —— 首行有 banner，**不要手改** |
| 清单与资源 | 仍然**手写**在 `plugins/<插件名>/`：`manifest.json`、`index.css`、`icon.svg`、`README.md` |

产物是单文件 IIFE，与手写时完全一样 —— 宿主只要求清单的 `main` 指向一个可执行
的 JS 文件，它不关心那是怎么来的。因此打包 zip 与生成索引的流程一个字都没改。

## 两条硬约束

**一、`react` 只能是 external。** 宿主给的是**它自己那个 React 实例**
（`Modulith.React`），插件不能打包一份进去：两个 React 实例互相不认识，context
取不到、hook 调用错乱。所以：

```ts
import React, { useState } from 'react';   // ✔ 接到宿主实例上
import lodash from 'lodash';               // ✘ 构建直接报错
```

引第三方库会让包体积与审核成本一起失控，而**插件的审核是人工读代码**。

**二、产物不压缩。** 它同时是要被人读的代码。

## 忘了重新构建会怎样

`pnpm check` 会报出来：它把源码重新编译一遍、与磁盘上的产物比对，不一致就失败，
并且指出是哪个插件。它同时会揪出"有产物但没有源码"的目录 —— 那会让一个源码已经
不存在的插件继续出现在索引里。
