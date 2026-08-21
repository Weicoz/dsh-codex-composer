# 可配置草稿存档快捷键与历史弹窗修复设计

## 目标

保留官方 DSH 输入框和复制行为，同时修复输入历史弹窗的宽度、皮肤适配和关闭行为。

## 交互

- `Ctrl+C` 完全交还浏览器和官方输入框，插件不再监听或改变复制行为。
- 默认 `Ctrl+Shift+K` 将非空草稿写入当前页面内的草稿历史并清空官方草稿。
- 用户可在 Settings → General 的插件设置中点击快捷键输入项，然后按下新的组合键保存。
- 无效配置：单独修饰键、`Escape`、`Enter`、方向键，以及没有 Ctrl 或 Meta 的组合键。无效按键不会覆盖现有配置。
- 设置未保存、读取失败或被清空时，回退至默认 `Ctrl+Shift+K`。
- 上下键打开历史弹窗；`Escape` 只关闭弹窗，保留草稿和历史浏览位置。

## 布局与皮肤

- 弹窗容器保持 `width: 100%`，不额外施加横向偏移，随官方输入区宽度收缩或扩展。
- 弹窗使用继承的文本颜色和 `color-mix(in srgb, currentColor 6%, transparent)` 形成低对比背景与描边，避免依赖特定皮肤变量。
- 选中历史行使用相同的 `currentColor` 低透明度底色。

## 设置模型

设置命名空间维持 `dsh-codex-composer`，schema 增加：

```ts
{
  enabled: boolean,
  archiveShortcut: string,
}
```

默认值为 `Ctrl+Shift+K`。

## 验收

1. `Ctrl+C` 在 textarea 中不被 preventDefault。
2. 默认和自定义快捷键均可存档并清空草稿。
3. 无效快捷键不会保存。
4. 历史弹窗宽度等于其 dock 容器宽度，并随皮肤切换保持可读。
5. `Escape` 关闭已打开的历史弹窗，不清空草稿。
6. `npm run typecheck`、构建、热重载和本地 DSH 浏览器验证均通过。
