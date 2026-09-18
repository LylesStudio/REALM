# REALM macOS unsigned preview

当前提供两种架构包：

- `darwin-arm64`：Apple Silicon，主发布线；
- `darwin-x64`：Intel，experimental 构建线。

## 安装

1. 下载与 Mac 架构匹配的 `.dmg`。
2. 双击 DMG，将 `REALM.app` 拖到 `Applications`。
3. 第一次打开时，如果 macOS 提示无法验证开发者：在 Finder 中右键 `REALM.app`，选择“打开”，再确认一次。
4. REALM 会自动初始化本地 PostgreSQL/pgvector，并在浏览器打开本机页面。

这是 **unsigned preview**：没有 Developer ID 签名或 notarization。不要关闭 Gatekeeper，也不要执行删除 quarantine 的命令。

## 数据与模型

用户数据保存在：

```text
~/Library/Application Support/REALM/
```

删除 `REALM.app` 不会自动删除世界、设置或本地数据库。交付演示前请自行备份这个目录。

安装包不包含任何模型 API key。首次进行创世或新回合时，在设置页配置自己的 LM Studio、OpenRouter、DeepSeek、Kimi Coding 或自定义 OpenAI-compatible provider。

## 当前边界

- 无模型时可以浏览演示种子世界；创世和新回合需要配置模型服务。
- 首发没有自动更新、菜单栏常驻、Developer ID 签名或 notarization。
- macOS runner 构建通过不等于干净 Mac 真机验收；正式对外演示前仍需在目标 Mac 上实际安装一次。
