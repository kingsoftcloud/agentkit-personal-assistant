# AgentKit 个人助理

`@kingsoftcloud/agentkit-personal-assistant` 是独立的 DSH 插件项目，负责个人助理页面、多逻辑 Bot、会话、记忆、日程，以及用户专属云电脑的工具入口。插件与 Host 使用 Node.js；云电脑中的 Python、Bash 等是供任务调用的工具。

Studio 保留 DSH 宿主、插件中心和通用 Agent 能力。个人助理页面由本插件提供，不写回 Studio 产品代码。新安装默认关闭，也不会自动连接云电脑。

## 本地安装

安装步骤见[本地安装与云电脑连接](docs/本地安装与云电脑连接.md)。开发目录执行：

```sh
npm ci
npm run build:client
npm pack
```

产物包含 Host 入口、DSH ModuleLoader 客户端产物 `dist/client.js` 和中文文档。需要使用包含 Personal Assistant 插件目录条目的 Studio bundle。已存在于 profile 的插件通过 `setBundleEnabled` 启用，不需要重新访问 npm registry。

本地页面加载与云端验收是两项不同的交付。未配置网关时，页面显示配置提示；云端桌面的真实帧率、输入、AppArmor 和多 Bot 冲突需要另行实测。

## 运行架构

一个云上子用户独享一个个人助理 Pod，使用两个独立构建、独立版本的业务镜像：

- `personal-assistant-runtime`：真实 DSH Host、本插件、独立 `DSH_HOME`，承载会话和回合执行。
- `personal-assistant-computer`：Xvfb、fluxbox、Chromium、桌面采集、输入注入和 Computer Broker。

部署沿用 AgentEngine 的 Server → Runtime Service → Operator → AgentRuntime CR 链路；本项目不直接创建 Pod 或 PVC。两容器通过 localhost Broker 通信，持久化路径由 Runtime Service 注入。平台当前额外注入的日志 sidecar 需要在验收中如实计数，不能把三个容器记成两个。

云电脑本期内置 Python 3、Bash/shell、Git、OpenSSH 客户端、Chromium 和终端。DSH 在 runtime 侧调度 skill，skill 的脚本经 Broker 在电脑侧执行；这些常见工具不做用户开关。支持执行不表示允许绕过租约、目录授权或沙箱约束。

## 多逻辑 Bot

每个 Bot 有独立的 `botId`、系统提示词版本、记忆命名空间和工具策略。多个 Bot 可以使用同一台用户专属电脑；控制操作必须持有租约，同一时间只允许一个控制者。其他连接可以只读旁观。发生控制冲突时服务端返回 409。

```js
import { createRuntime } from '@kingsoftcloud/agentkit-personal-assistant';

const runtime = createRuntime(ctx, {
  enabled: true,
  profileId: 'user-profile-1',
  bots: [{
    botId: 'researcher',
    displayName: '研究助理',
    systemPromptRevision: 'researcher@2026-10-23.1',
    memoryNamespace: 'assistant:user-profile-1:bot:researcher',
    toolPolicy: {
      mode: 'allowlist',
      allow: ['browser.search', 'files.read'],
      requireApproval: ['files.write'],
    },
  }],
});
```

此示例只创建 Bot 配置；真实电脑连接必须另外提供 Broker 地址或 transport。

## 桌面与工具通道

浏览器通过 DSH 已鉴权 Connection RPC 向插件 Host 申请短时一次性 ticket，再通过同一云网关的独立 WebSocket 接收二进制 JPEG 帧和发送输入。长期凭据保留在 Host，token 不放在 URL query 中，桌面帧不进入 DSH remotes 白名单、磁盘或遥测。鉴权细节见[桌面通道鉴权](docs/桌面通道鉴权.md)。

runtime 通过 localhost Broker 调用以下操作，租约与动作绑定 `userId`、`assistantId`、`botId`、`computerId`、`taskId`：

- `computer.status`
- `computer.lease.acquire` / `computer.lease.release`
- `computer.action`

浏览器与终端工具由 `createComputerToolset()` 注册，包括受限浏览器动作、`cloud_bash` 和 `cloud_run_code`。runtime 不直接启动电脑侧的 Chromium 或 shell。`createMockComputerBroker()` 仅供契约测试，其返回值明确标记 `simulated: true`。

## 云端回合与持久化

runtime 镜像中的真实 DSH Host 注入公开的 `sessionController`。插件通过 `sessionController.prompt()` 提交回合，并记录会话消息、执行结果和状态。缺少该服务时返回 `DSH_SESSION_CONTROLLER_UNAVAILABLE`，不能用排队记录或模拟回复冒充完成。

HTTP 接口包括 `/v1/sessions`、会话 `messages` / `turns`、`/v1/memory`、`/v1/schedules`。状态保存在注入的工作区和状态目录中，禁用或卸载插件不负责删除 PVC 数据。真实 DSH 宿主验证范围见[云端 DSH 宿主验证](docs/云端DSH宿主验证.md)。

## 开发与校验

```sh
npm test
npm run check
npm run pack:check
npm run build:artifacts
```

`package.json.dsh` 只使用 DSH 支持的 bundle / client 加载字段；`metadata.defaultEnabled` 和 `metadata.autoConnect` 属于本产品元数据，不冒充 DSH 加载器字段。Host 和浏览器分别从包根入口与 `./client` 导出。

## 参考与许可

多 Bot 与持久化设计参考过 DeepSeek-Bot 的公开行为。当前没有复制其项目源码；后续复用代码时需保留对应 Apache-2.0 许可和声明，见 [NOTICE](NOTICE)。
