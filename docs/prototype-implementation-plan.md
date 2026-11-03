# 个人助理面板 · 原型实现计划（v1）

> 分支：`feat/pa-prototype`（基线提交 `ab94635`）
> 规格来源：`designs/personal-assistant-panel/project/*.dc.html`（8 块画板，即验收基准）
> 验收：`npm test` 全绿、`npm run check` EXIT=0、`npm run build:client` 成功；界面与画板一致。

## 1. 视图 → 文件映射

| 画板 | 视图 | 归属文件 |
| --- | --- | --- |
| 01 开通引导 | 未开通引导（已存在） | `src/client/index.mjs`（onboarding 分支） |
| 02 首次创建 | 分阶段创建进度 | 新增 `src/client/views/create-progress.mjs` |
| 03 Bot 列表 | 主面板首页 | 新增 `src/client/views/bots-list.mjs` |
| 04 Bot 详情 | 单 Bot 配置 | 新增 `src/client/views/bot-detail.mjs` |
| 05 对话 | 对话视图 | `src/client/conversation.mjs` + `src/client/index.mjs` |
| 06 云电脑 | 桌面回传（已存在） | `src/client/index.mjs`（desktop 分支） |
| 07 本机授权 | 授权弹层 | 新增 `src/client/views/local-access.mjs` |
| 08 设置 | 设置页 | 新增 `src/client/views/settings.mjs` |

公共件：`src/client/views/ui.mjs`（连接状态圆点、分区卡片、行、开关、按钮、骨架块、空状态）。
导航：`src/client/index.mjs` 内新增 `panelView` 状态机：`list | detail | settings | create | chat | desktop`。

> 客户端无框架、手写 `h()`：新视图一律导出纯函数 `renderXxx(props)` 返回 vnode，**不要**引入 hooks 以外的新依赖，不要把业务请求塞进视图文件（视图只接收数据与回调）。

## 2. 连接状态圆点（三态，全局面板页头）

组件 `connectionDot({ state, onOpen })`，state ∈ `authorized | connected | offline`：

- `authorized`：绿 `#067647`，文案「本机已授权」，点击打开本机授权弹层
- `connected`：琥珀 `#946200` + 外发光，文案「本机未授权」，点击= 请求授权
- `offline`：灰 `#9aa4b2`，文案「本机未连接」，点击= 重连

口径：`connected` 由 Host `personal-assistant.local-access.status` 的 `connected` 决定；`authorized` 由 `authorized === true` 决定。**连接不等于授权**，没授权时任何本地控制入口必须禁用。

## 3. 新增 Host RPC 契约（`src/host-gateway.mjs` OPERATIONS）

所有返回必须过白名单字段（沿用 `publicXxx` 模式），不得透传凭据。

### 3.1 Bot 维度

```
personal-assistant.bot.detail   { botId }
  → { bot: { id, name, role: 'primary'|'custom', status: 'running'|'idle'|'offline', model },
      memory: { count, items: [{ id, text, scope }] },
      capabilities: [{ id, label, source: 'builtin'|'mcp', status: 'ready'|'error' }],
      computer: { connected: boolean, resolution: string, usage: { tokens: string, hours: string } } | null,
      createdAt: string }

personal-assistant.bot.create   { name }
  → { bot: { id, name } }

personal-assistant.bot.delete   { botId, confirmName }   // confirmName 必须等于 bot.name
  → { deleted: true }

personal-assistant.bot.memory.delete  { botId, memoryId }
  → { deleted: true }

personal-assistant.bot.model.update   { botId, model }
  → { model }        // 立即生效于下一条消息，不改正在运行的任务
```

### 3.2 本机授权（新增，独立持久化模块 `src/local-access.mjs`）

```
personal-assistant.local-access.status
  → { connected, authorized, scopes: string[], riskConfirm: boolean, grantedAt: string|null, host: { platform, studioVersion } }

personal-assistant.local-access.grant  { scopes: string[], riskConfirm: boolean }
  → { authorized: true, grantedAt }        // scopes 子集：session.create / window.input / file.read-write

personal-assistant.local-access.revoke
  → { authorized: false }                  // 必须同步中止本机在途任务
```

持久化走 `src/persistent-state.mjs`；`authorized=false` 时任何 `local-control.*` 操作返回
`PERSONAL_ASSISTANT_LOCAL_NOT_AUTHORIZED`（403）。

### 3.3 设置

复用已有 `personal-assistant.settings.inspect / settings.update / settings.versions`，
扩展 `inspect` 返回 `{ configured, model, prompt, environmentVariables: [{ key, value, sensitive }], runtime: { version, image }, status }`。

### 3.4 列表与创建进度

```
personal-assistant.bots.overview
  → { bots: [{ id, name, role, status, model, memoryCount, capabilityCount, computer: 'connected'|'idle' }],
      active: [{ kind: 'turn'|'approval', botId, title, detail, approvalId? }],
      recent: [{ id, title, status: 'done'|'failed', at }],
      counts: { schedules, memories, files } }

personal-assistant.create.status
  → { instanceId, stage: 'instance'|'runtime'|'computer'|'assistant'|'done'|'failed',
      stages: [{ id, status: 'done'|'active'|'pending'|'failed', detail }],
      elapsedMs, estimatedRemainingMs, error? }
```

`bots.overview` 优先复用 `personal-assistant.bots.list`（目录）数据，缺的字段用本地 registry 补齐；
云端不可达时返回 `degraded: true` 而不是抛错，UI 显示「部分数据暂不可用」。

## 4. 客户端行为要求

1. **骨架屏**：列表/详情/设置首次进入先渲染骨架（`Skeleton` 块），数据到后替换；不得整页 spinner。
2. **stale-while-revalidate**：`bots.overview`、`bot.detail`、`settings.inspect` 结果写 `localStorage`（key 前缀 `personal-assistant.cache.`），下次进入先回显再校准。
3. **首次创建**：`create.status` 1s 轮询直到 `done|failed`；`done` 自动切到列表；可收起（停止轮询但保留状态）。
4. **授权撤销**：撤销后立即把所有本地控制入口置灰，并在对话流插入一条系统提示「本机授权已撤销」。
5. **历史会话**：仅列表页底部「历史会话」入口按需打开，不作为主视图。
6. 所有文案、层级、间距对齐画板；颜色取 DSH token（见画板 CSS）。

## 5. 写域（并行时不重叠）

- `client-ui`：`src/client/**`（含新视图、index.mjs 外壳、conversation.mjs 增量）
- `host-rpc`：`src/host-gateway.mjs`、`src/local-access.mjs`、`src/bot-registry.mjs`、`src/persistent-state.mjs`、`test/**`
- Lead：`docs/**`、`scripts/**`、构建与最终验收；冲突时 Lead 裁决

## 6. 验收清单

- [ ] 7 个新增/改造视图均可在面板内导航到达，刷新后状态保持
- [ ] 圆点三态可复现（断开 Studio → offline）
- [ ] 未授权时本地控制入口全部禁用；授权后可点；撤销后恢复禁用
- [ ] `npm test` 0 fail（新增用例覆盖 local-access 授权/撤销/作用域）
- [ ] `npm run check` EXIT=0
- [ ] `npm run build:client` 产物更新且被 `dist/client.js` 引用

## 7. 追加验收项（用户指定，须由独立验收子代理完成）

- [ ] **云电脑双向复制粘贴**：本机 → 云电脑、云电脑 → 本机 两个方向都必须在真实面板里可用；
      覆盖纯文本、超长文本（>64KB 截断/拒绝策略）、空内容、连续多次粘贴、剪贴板被占用/权限被拒的降级提示。
      本机侧只能走 Host 的 `personal-assistant.clipboard.read/write`（Electron 渲染器无 clipboard 权限），
      云端侧走桌面 WS 的 clipboard 帧；两端不能重复写入或回声。
- [ ] **每 Bot 定时任务投递路由**：定时任务必须按 `botId` 绑定到创建它的 Bot；
      触发时由该 Bot（且仅该 Bot）发起会话，消息投递给该 Bot 对应的用户/会话，
      不得串到主助理或其它 Bot。覆盖：多 Bot 并存、Bot 被删除后任务降级（暂停而非乱发）、
      任务触发时云端不可达的重试与幂等（不得重复发送同一条消息）。
- [ ] **交互稳定性**：连续在 列表 → 详情 → 设置 → 授权 → 对话 → 云电脑 之间切换 20 次无白屏、无控制台报错、
      无内存泄漏式轮询堆积；任一 RPC 失败时视图降级可恢复；面板关闭重开后状态一致（授权、当前 Bot、会话指针）。

