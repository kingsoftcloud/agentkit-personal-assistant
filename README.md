# AgentKit 个人助理

`@kingsoftcloud/agentkit-personal-assistant` 是面向 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）的个人助理插件：在 Studio 右侧提供助理对话面板，并把对话绑定到一台用户专属的云电脑上——助理可以打开浏览器、终端、文件管理器，替用户操作桌面并实时回传画面。

## 能力

- 多逻辑 Bot：同一个助理下管理多个 Bot（不同模型 / 系统提示 / 工具范围）
- 会话与记忆、日程与自动化任务
- 云电脑工具入口：截图、键鼠输入、浏览器导航、剪贴板（仅快捷键路径）
- 桌面接管使用**短期一次性 permit**（`scope=desktop`、可读/可控两种模式、单次 jti、最长 60 秒），不使用长期凭证

## 安装

```sh
npm i @kingsoftcloud/agentkit-personal-assistant
```

插件随 DSH profile 安装；客户端面板产物是 `dist/client.js`（安装时由 `prepack` 构建）。宿主侧要求 Node.js 22.23.4+，DSH 0.2.1。

## 运行架构

插件本身只包含宿主侧入口、面板客户端与云电脑工具协议；云电脑中的桌面进程由配套服务提供。一个云上子用户对应一台个人助理 Pod（`agent-runtime` + `personal-assistant-computer`），插件通过受鉴权的 broker 通道和一次性桌面 permit 访问它，仓库与 Pod 内都不保存长期云凭证。

## 开发

```sh
npm ci
npm run build:client
npm test
npm pack
```

## 安全

见 [SECURITY.md](SECURITY.md)。本仓库不包含任何云凭证；敏感配置全部通过环境变量注入。

## 许可证

Apache-2.0，见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。
