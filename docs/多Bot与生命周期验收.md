# 多 Bot、提示词与生命周期验收（2026-10-25）

本轮是独立插件的实现及候选验证。目标预发实例为 `ar-20261025215911-7ef6c6f5`，
没有为本轮测试重启该 Pod。下面把真实 Pod 的只读证据、本地真实 DSH 证据和待部署项分开记录。

## 提示词、记忆与工具边界

云端从原始挂载 manifest 校验 SHA-256、协议、运行时三元组后读取平台 `prompt`，
不依赖 Studio。每个 Bot 激活真正的 DSH Agent 后，在 `agent.ctx` 中分别注册：

- 平台提示词 section，顺序 10250。
- Bot 独立提示词 section，顺序 10300；未配置时仍给出包含 Bot 标识的独立身份提示词。
- 当前 Bot 的私有记忆 context，每次回合刷新，最多 16 KiB。

这些内容均设置 `interpolate:false`。用户提示词中的 `{{unknown}}` 保持原文。
记忆以资料上下文呈现，不成为新的操作授权。写入记忆、搜索记忆和保存计划的工具通过闭包固定
当前 Bot，参数中没有文件路径、Bot ID 或 namespace 扩权入口。

PA Agent 调用公开 `tools.restrict({allow:[]})` 隐藏继承的 Host 工具。
真实测试发现 DSH 自己在 Agent scope 注册的 `subagent` 不受继承层过滤影响，因此还增加：

1. 同一 Agent scope 的单调 `tools.guard`，执行层只允许明确列出的电脑与私有工具。
2. 同一 scope 的 `system-prompt/assemble` 工具呈现过滤。

这不是只靠提示词隐藏工具。服务端会拒绝伪造的 `subagent` 调用。限制仅在 PA 的
`setupAgent` 中施加，不写 Host 全局工具配置。Host 原生文件、shell、Skill 与子代理都不能
作为访问 runtime 私有状态或绕过电脑租约的捷径。Skill 的执行应由电脑工具承接，后续专用
wrapper 需要独立定义允许面。

最终真实模型输入中仅有以下工具：

```text
bot_memory_save, bot_memory_search, bot_plan_update
cloud_bash, cloud_run_code
cloud_browser_open, cloud_browser_snapshot, cloud_browser_click,
cloud_browser_type, cloud_browser_press, cloud_browser_screenshot,
cloud_browser_download, cloud_browser_close
```

## 单次调度与恢复语义

之前 `/v1/schedules` 只落盘。本轮将它接到常驻 runtime 的计时器和真实 DSH turn bridge。
每个任务固定 Bot、会话、输入与持久状态；两个 Bot 可以使用同名 schedule ID。
任务执行前先写入 `running`，完成后关联实际 turn ID 与结果。

进程重启后恢复尚未执行的任务，过期的 pending 任务在启动后执行；`running` 任务标记为
`interrupted`，不会自动重放未知结果。它不承诺机器故障下的 exactly-once，也不假装已经
恢复中断操作。长期未来的任务分段等待，避免 Node 定时器溢出后提前触发。
关闭 runtime 会停止计时器，不删除会话、记忆、任务或 DSH 历史。

HTTP 的消息读取、追加与 turn 访问现在都验证持久化的 Bot/session 归属；重建 bridge 后
也会查询持久归属，不仅依赖进程内 Map。

## 已有证据

目标预发 Pod 的只读结果：runtime 挂 PVC 根目录到 `/data`；computer 仅挂
`workspace`、`files`、`computer-state`、`computer-home` 四个 subPath。
`/data/assistant-state/dsh` 在 runtime 可见，在 computer 不存在；两容器的 PID 和 mount
namespace 也不同。因此 GUI shell 看不到 runtime 的所有 Bot 私有 JSON/DSH 状态。
该证据不单独证明 Host 工具安全，后者由上述 scope 限制另行保证。

本地使用同一固定 DSH 镜像启动独立 Host，挂载本轮候选源码，模型端是独立受控 HTTP provider。
它是真的 DSH Session Controller 和 agent loop，但**不是预发真实模型验收**。已确认：

| 检查 | 结果 |
| --- | --- |
| writer 的实际模型请求 | 平台提示词、writer 提示词及 writer 记忆存在；researcher 私有内容不存在 |
| researcher 的实际模型请求 | 反向隔离成立 |
| 提示词花括号 | `{{platform_unknown}}`、Bot 字面量完整保留 |
| 单次日程 | 到期后真实 DSH 回合完成并持久化结果 |
| 真实 Host/容器重启 | 原会话、消息和两 Bot 记忆保留；原会话可继续完成新回合 |
| 重启前 pending 日程 | 新 DSH 进程恢复并完成，对应实际 turn ID |
| 工具输入面 | 模型只得到上列安全工具，无 Host 文件/shell/subagent |
| 伪造隐藏 subagent 调用 | 服务端 guard 拒绝；下一次模型输入包含 `PERSONAL_ASSISTANT_HOST_TOOL_FORBIDDEN`，没有启动子代理 |

受控 provider 只保存模型名称、工具名称、提示词 hash 和 canary 存在性，不保存凭据。
记录中的 DSH 辅助模型请求不作为 PA 目标回合的正例；正例与已完成的目标 turn 对照。

原始证据目录：`.artifacts/bots-lifecycle-20261025/`。
关键文件为 `real-dsh-completed-turns.json`、`real-dsh-restart-result.json`、
`scoped-tool-model-input.json`、`real-guard-denial-model-input.json`、`real-tool-denial-logs.json`、
`pvc-mounts-current-pod.json` 和 `pvc-namespace-isolation.json`。
首次只做继承限制时 `subagent` 残留导致强断言失败，此记录保留在模型请求序列中，修复后再通过。

## 预发部署后仍需做的生命周期检查

共享电脑租约可复用新 Pod 已有 `startup-fix-20261025/pod-computer-probes.jsonl` 的
双 Bot acquire 409、release 后 acquire 证据，不在 GUI 测试中抢占控制权。

下一次统一制品部署前，由主任务通知后再写入独立 canary：两个 Bot 同名记忆键、各自会话、
一条未来任务及其输入。经正式 API Update/重建后核对原记录、DSH 原会话继续回合以及任务结果。
目前本轮没有直接重启预发 Pod，也不把本地 volume 重启等同于预发 PVC 验收。

本地插件禁用/卸载应只移除本地面板、连接和插件代码，不调用云端 Agent 删除接口；
云端数据保留通过另一条已认证 API 对照 canary 验证。云端执行进程停用则应先停止调度与回合，
保留 PVC 后重启读取相同记录。删除云端 Agent/PVC 是另一种生命周期操作，不能混作插件卸载。
真实 Studio 禁用/卸载和上述预发重建仍待主任务安排；本轮单测已覆盖 runtime close 停止计时器、
同一状态目录恢复记录及待执行任务。
