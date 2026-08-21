# 可配置草稿存档快捷键与历史弹窗修复实现计划

> **For Hermes:** 按任务逐项执行；本次由当前执行线程完成，不派遣子代理。

**Goal:** 保留官方输入框复制语义，增加默认/可配置的 `Ctrl+Shift+K` 草稿存档快捷键，并修复历史弹窗的宽度、皮肤适配和 `Escape` 关闭行为。

**Architecture:** Host 设置 schema 增加 `archiveShortcut`，Client 使用同一 settings scope 读取并保存快捷键。输入增强继续只注册 `conversation.input.dock`，不替换官方 `conversation.composer`；快捷键监听只在启用且 textarea 获得事件时处理，弹窗关闭状态由 React 本地状态维护。

**Tech Stack:** TypeScript、React createElement、Cordis slots/settings、DSH super-injector、ego-browser。

---

### Task 1: 扩展 Host/Client 设置模型

**Objective:** 让快捷键默认值持久化，并向客户端提供稳定的设置字段。

**Files:**
- Modify: `src/index.ts`
- Modify: `src/client/index.ts`

**Steps:**
1. Host schema 将 `{ enabled }` 扩展为 `{ enabled, archiveShortcut }`，默认值分别为 `true` 和 `Ctrl+Shift+K`。
2. Client `ComposerSettings` 同步增加 `archiveShortcut: string`，定义 `DEFAULT_ARCHIVE_SHORTCUT = 'Ctrl+Shift+K'`。
3. 构建并运行 `npm run typecheck`，预期无 TypeScript 错误。
4. 提交：`扩展草稿存档快捷键设置`。

### Task 2: 实现快捷键规范化与监听

**Objective:** 恢复原生 `Ctrl+C`，用默认/自定义组合键执行草稿存档清空。

**Files:**
- Modify: `src/client/index.ts`

**Steps:**
1. 添加 `normalizeShortcut(event)`，将修饰键与主键规范化为 `Ctrl+Shift+K` 风格；Mac 使用 `Meta` 显示为 `Cmd`，匹配时同时支持 Ctrl/Meta。
2. 添加 `isValidShortcut(shortcut)`，拒绝空值、单独修饰键、Esc、Enter、方向键和无 Ctrl/Meta 的组合。
3. 移除 `Ctrl+C` 分支，保留浏览器默认复制行为。
4. 用配置快捷键匹配 `keydown`；匹配成功后保存非空 textarea 草稿并清空官方 draft。
5. `Escape` 在弹窗打开时 `preventDefault()` 并关闭弹窗，不清空 textarea、不修改 historyIndex。
6. 构建、typecheck，并检查生成的 `lib/client.js` 不再包含 `event.key.toLowerCase() === 'c'` 的清空逻辑。
7. 提交：`支持可配置草稿存档快捷键`。

### Task 3: 增加设置页快捷键编辑控件

**Objective:** 用户可以在 General 设置中点击输入框并按键保存自定义组合键。

**Files:**
- Modify: `src/client/index.ts`

**Steps:**
1. 在设置行中加入快捷键捕获 input，显示当前快捷键，使用 `onKeyDown` 捕获并校验组合键。
2. 有效组合调用 `settings.set('archiveShortcut', normalized)`；无效组合仅 `preventDefault()`，保留旧值。
3. 使用 `settings.getSnapshot()` 与现有订阅保持控件即时更新。
4. 设置控件不添加额外说明性快捷键长文，只保留标签和当前值。
5. 运行 typecheck/build，提交：`增加草稿快捷键设置控件`。

### Task 4: 修复历史弹窗尺寸、皮肤与 Esc 状态

**Objective:** 弹窗与官方对话框等宽，能适配皮肤且可通过 Escape 关闭。

**Files:**
- Modify: `src/client/index.ts`
- Modify: `README.md`

**Steps:**
1. 弹窗及 dock 明确 `boxSizing: 'border-box'`、`width: '100%'`、`maxWidth: '100%'`，不设置固定宽度和横向偏移。
2. 背景、边框、选中态使用 `currentColor`、`color-mix` 和 `inherit`，移除 `Canvas`、`var(--surface-color)` 等特定回退。
3. 保留历史时间在行右侧，并确保长文本通过 ellipsis 不撑宽。
4. 更新 README 的快捷键与设置说明。
5. 构建、typecheck，并提交：`修复历史弹窗皮肤和关闭行为`。

### Task 5: 热重载与浏览器验收

**Objective:** 在真实 DSH GUI 中证明新行为生效且官方输入框仍完整存在。

**Files:**
- Verify only: `lib/client.js`, runtime plugin status

**Steps:**
1. 执行 `bash scripts/build.sh`，预期 `build: complete`。
2. 执行 `dev_reload_package`，预期 Client 重载成功、fiber active。
3. 使用 ego-browser 刷新 `http://127.0.0.1:3080/`，验证 textarea 仍存在。
4. 验证默认快捷键清空并生成历史；验证 Ctrl+C 不被 preventDefault；验证 ArrowUp 打开弹窗且时间在右侧；验证 Escape 关闭弹窗并保留草稿。
5. 打开设置页验证快捷键控件可保存自定义组合并恢复默认。
6. 检查 `dev_plugin_status`、`git status`，提交并推送最终修复。
