# Bot 工具策略与一次性批准（2026-10-25）

本轮把 Bot registry 中的 `toolPolicy` 从配置元数据接到真正 DSH Host 的执行路径。
不修改 Studio 页面、Computer、桌面通道或预发实例；预发部署验证仍由主任务统一安排。

## 策略如何生效

每个 PA Agent 仍先用公开 `tools.restrict({allow:[]})` 屏蔽继承的 Host 工具，再分别安装：

1. `system-prompt/assemble`：仅向模型呈现当前 Bot 允许的工具。
2. `tools/pre-execute`：拒绝不允许的调用；必要时向真实宿主申请一次性批准。
3. 公开 `tools.guard`：在工具执行前再次读取当前 Bot 策略，阻断伪造调用、等待期间的撤权和无批准重放。

策略通过 registry 的当前定义按调用读取，不只在 Agent 创建时复制一次。它仅作用于 PA 的
Agent scope，不改变其他 DSH Agent 的工具。模型工具列表不是安全边界，最终服务端守卫才是。

`allowlist` 只接受 `allow` 中的精确工具名称；空数组表示零权限。
`denylist` 接受固定 PA 安全面内未被 `deny` 拒绝的工具。
两种模式中 `deny` 都优先，`requireApproval` 只增加批准要求，不能授予原本没有的权限。
无效策略、registry 读取失败或未知工具均拒绝，不支持通配符或 Host 工具扩权。

固定安全面的完整名称如下。它是上限，具体 Bot 还要由自己的策略进一步收窄：

```text
cloud_bash
cloud_run_code
cloud_browser_open
cloud_browser_snapshot
cloud_browser_click
cloud_browser_type
cloud_browser_press
cloud_browser_screenshot
cloud_browser_download
cloud_browser_close
bot_memory_search
bot_memory_save
bot_plan_update
```

`bash/read/write/edit/glob/grep/subagent/skill` 等 Host 能力不在上限内，不能通过 Bot 配置开放。
本轮没有把严格的空 allowlist 兼容成全部开放；平台生成默认 Bot 时应显式写入所需名称。

## 批准和失败行为

插件调用真实公开 `approval.request({agent, toolName, callId, reason, signal})`，不会制造批准结果。
只有宿主返回闭集值 `allowed-once` 才获授权。授权记录绑定 DSH 生成的当前执行 `Symbol token`，
由最终守卫消费一次；同一 token 重放、模型重用 callId、新执行重试和下一回合均不能继承。
工具结果事件清理没有消费的授权。等待期间新增拒绝或批准要求，最终守卫仍按新策略执行。
已有上游拒绝或取消不会被批准流程覆盖。

宿主服务缺失、返回 `unavailable`、拒绝、取消、异常或不在闭集内的字符串，均返回明确错误且不执行工具。
等待最多 30 秒，超时撤销本次请求；迟到的答复不补发授权，也不自动重试。
原始异常不直接泄露给模型。错误带有中文操作建议，例如
`BOT_TOOL_APPROVAL_TIMEOUT` 提示连接真实批准通道后重新发起。

实测纯 web Host 即使没有浏览器在线，也会由 remotes 的批准监听器接收请求并等待。
目前公开服务没有“当前存在可答复客户端”的探测接口，因此不能假定会立即返回 `unavailable`。
插件自己的 30 秒截止时间使此分支明确失败，避免无人值守日程无限等待。
本轮没有交付新的批准界面，也没有把受控批准结果当作真人操作验收。

## 已执行的验证

单元测试用受控批准服务覆盖真实接口约定：允许一次、拒绝、不可用、异常、取消、超时、迟到答复、
同 token 重放、同 callId 新 token、策略动态撤权，以及上游拒绝保持。
其中批准成功是接口级受控测试，不是产品批准界面正例。

另外启动了真实 DSH Host 和 Session Controller，使用候选插件源码与独立受控 HTTP 模型端点。
模型端点会故意发出被隐藏或需要批准的工具调用，再检查下一次真实模型输入中的工具错误和持久状态。
这证明了真实 DSH 执行链，但不是预发真实模型或 GUI 的验收。

| 真实 DSH 场景 | 观察到的结果 |
| --- | --- |
| writer：allowlist 允许 save，但 deny 同时拒绝 save | 模型仅见 search；强制 save 返回 `BOT_TOOL_POLICY_DENIED`，未写入 |
| researcher：denylist 拒绝 save | 其他安全工具可见；强制 save 仍被服务端拒绝，未写入 |
| closed：空 allowlist | 模型工具列表为空；强制 search 被服务端拒绝 |
| approval：plan 要求批准，无在线答复者 | 30,529 ms 后收到 `BOT_TOOL_APPROVAL_TIMEOUT`；plan 没有写入，回合结束 |
| writer：允许 search | 工具实际读取当前 Bot 的私有 canary，下一次模型输入包含结果 |

每次验证生成独立 `POLICY_RUN_*`，只检查对应本次回合记录，避免复用旧回合结果。
所有五个回合均完成；“回合完成”表示模型已收到工具拒绝并结束，不表示被拒绝的操作成功。

证据保存在 `.artifacts/bot-policy-20261025/`：

- `actual-turns.json`：本次 run ID、真实 session/turn ID、耗时和副作用检查。
- `verified-inputs.json`：本次真实模型工具列表、拒绝码及允许查询的结果存在性。
- `real-policy-logs.json`：过滤后的宿主批准日志，不含启动登录 token 或环境变量。
- `real-dsh-validation.log`、`all-tests.log`：验收与全套测试输出。
- `provider.mjs`、`drive.mjs`：可重放的受控模型端与真实 API 驱动。

第一次驱动错误地要求缺答复者只能返回 `UNAVAILABLE`，实际观察到宿主等待后超时，断言失败。
原始 `first-actual-turns.json` 和 `first-expectation-failure.txt` 保留；修正验收预期后重新生成独立
run ID，要求无副作用且在 35 秒内结束，没有修改权限或把校验改为直接通过。

在已有本地夹具启动的前提下，可以重放：

```bash
node .artifacts/bot-policy-20261025/drive.mjs
node --test test/bot-tool-policy.test.mjs test/bot-tool-scope.test.mjs
npm test
```

这轮没有重启或改写预发 Pod，也没有验证真人在产品界面点击批准。新的源码需要随下一次统一制品
构建部署后，再对真实云端运行时复验。
