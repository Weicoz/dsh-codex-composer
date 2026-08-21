# @dsh-external/dsh-codex-composer

保留 DSH 官方输入框主体的 Codex 风格增强插件。插件仅注册 additive slot，不接管 `conversation.composer`，因此官方模型选择、附件、Plan、访问模式等输入框能力保持原样。

## 功能

- `Ctrl+J`：在官方草稿中插入换行。
- `↑` / `↓`：按时间回填本会话已发送消息与当前页面内 Ctrl+C 草稿历史；弹窗右侧显示 `HH:MM`。
- `Ctrl+C`：清空当前草稿并将其保存到本页草稿历史。
- 设置 → General：默认开启，可关闭后完全回到原版输入框行为。

## 构建与注入

```bash
bash scripts/build.sh
# DSH 注入器环境：dev_inject_plugin /绝对路径/dsh-codex-composer
```

构建脚本优先使用本机 DSH 安装包的运行时类型；发布时通过普通 `npm install` 安装开发依赖即可构建。
