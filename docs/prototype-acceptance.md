# 个人助理面板 · 原型实现验收说明

> 分支 **`feat/pa-prototype`**（未合并到 main，可随时丢弃）
> 基线 `ab94635` → 最新 `a241cb8`，共 7 个提交，43 个文件、+7547 行
> 自测结论：`npm test` **406 项 / 404 通过 / 0 失败 / 2 skipped**，`npm run check` **EXIT=0**，`npm run build:client` 成功（`dist/client.js` 187,794 字节）

---

## 1. 五分钟验收路径

Studio 里装的是 **0.1.13 发布版**，比本分支新（`runtime/*`、`web/welcome.html` 有它自己的改动），所以**不能整包覆盖**。用下面两步只同步面板相关文件，且自动备份、一行回滚。

```bash
cd ~/kingsoft/code/agent-sdk/agentengine/agentkit-personal-assistant

# ① 预演：只打印将同步的 14 个文件，不写任何东西
node scripts/install-dev.mjs --profile ~/.dsh/profiles/desktop-agentkit-studio

# ② 确认后写入（会先备份到 <包目录>/.dev-backup-YYYYMMDDHH）
node scripts/install-dev.mjs --profile ~/.dsh/profiles/desktop-agentkit-studio --apply
```

然后在 Studio 里 **Cmd+R** 重开右侧面板。

**回滚**（脚本会打印完整命令，形如）：

```bash
node scripts/install-dev.mjs --profile ~/.dsh/profiles/desktop-agentkit-studio --rollback <包目录>/.dev-backup-YYYYMMDDHH
```

> 不想动现有环境也可以只看代码：`git diff main..feat/pa-prototype`，所有界面文件在 `src/client/views/`。

---

## 2. 按原型实现了什么

八块画板 → 七个视图，全部可在面板内导航到达：

| 画板 | 视图 | 实现位置 |
| --- | --- | --- |
| 01 开通引导 | 未开通引导（沿用+改造） | `src/client/index.mjs` |
| 02 首次创建 | 四阶段进度、可收起、失败重试 | `src/client/views/create-progress.mjs` |
| 03 Bot 列表 | 主 Bot 卡、其他 Bot、正在发生、快捷入口、历史会话折叠 | `src/client/views/bots-list.mjs` |
| 04 Bot 详情 | 模型切换、记忆增删、能力、云电脑用量、输名确认删除 | `src/client/views/bot-detail.mjs` |
| 05 对话 | 首屏骨架 + 本地快照先回显 + 撤销授权系统提示 | `src/client/conversation.mjs` |
| 06 云电脑 | 桌面回传（沿用） | `src/client/index.mjs` |
| 07 本机授权 | 圆点三态 + 授权弹层 + 取消授权 | `src/client/views/local-access.mjs` |
| 08 设置 | 模型/提示词/环境变量/运行时/危险区 | `src/client/views/settings.mjs` |

公共件 `src/client/views/ui.mjs`（圆点、卡片、开关、骨架、空状态）。

**Host 侧**新增 10 个 operation：`bots.overview`、`bot.detail/create/delete/memory.delete/model.update`、`local-access.status/grant/revoke`、`create.status`。本机授权独立成 `src/local-access.mjs`（持久化 + 作用域校验 + 撤销时中止在途任务）。

**你特别要求的授权模型**：连接 ≠ 授权。圆点三态（已授权/未授权/未连接），未授权时本地控制入口一律 403 `PERSONAL_ASSISTANT_LOCAL_NOT_AUTHORIZED`；撤销有两条路径（圆点弹层、设置页），撤销后对话流会插入「本机授权已撤销」。

---

## 3. 三项专项验收结论

### 3.1 云电脑双向复制粘贴 —— **通过**

- 本机 → 云端：`Ctrl+V` 经 WS 写云端剪贴板并合成粘贴；云端 → 本机：读云端后写 Host 剪贴板。
- 64 KiB 边界：正好 64 KiB 允许，多 1 字节拒绝；超长内容按 UTF-8 边界截断（不会切半个汉字）并明确提示「已复制前 64 KiB」。
- 回声去重：2 秒窗口只拦「读回自己刚写的内容」，不误杀连续主动粘贴。
- 失败可读：Host 侧 413 有中文文案；`sendKeys` 失败提示「手动在云桌面粘贴」，不再静默假成功。
- 侧栏与整页两个变体都会显示提示（验收人发现整页 tab 漏渲染，已修）。

### 3.2 每个 Bot 的定时任务投递 —— **通过（含本轮修复）**

- **绑定正确**：任务按创建它的 `botId` 投递，真实 runtime 用例证明不会退化成主助理；借用其它 Bot 的会话被 404 `SESSION_NOT_FOUND` 拒绝。
- **本轮修掉的三个真问题**：
  1. **重复发送**：认领原本非幂等，两个实例共享 state 目录时 `submitTurn` 会被调用 2 次 → 改为只有 `status==='pending'` 才能认领 + 代次轮转，重叠实例只成功发送一次。
  2. **没有重试**：云端不可达直接失败 → 加有限次退避重试，重试前后都走幂等认领，不会重复发。
  3. **Bot 删除后错误码不可读**：原本落到通用 `SCHEDULE_EXECUTION_FAILED` → 改为该 `botId` 的 pending 转 `paused`、保留 `BOT_NOT_FOUND`，Bot 恢复后 re-arm。
- 另修：任务异常不再产生 `unhandledRejection`（可注入 `onTaskError`，默认结构化日志）。

### 3.3 交互稳定性 —— **通过**

- 外壳视图连续切换 20 轮（列表↔详情↔设置↔授权弹层）：每步有内容、`console.error` 0、卸载后定时器归零。
- 对话页挂载/卸载 20 次：卸载后不再发 `session.events`；云电脑面板连接/卸载 20 次：socket 关闭、定时器与监听器归零。
- RPC 失败可恢复：`desktop.ticket` 首次失败仍显示可操作界面，重试可进入就绪。
- 重开面板：先回显上次的 Bot 列表与计数，再后台校准；校准失败保留缓存并提示，不会退回开通报板（本轮修的 G3.5）。

---

## 4. 顺带做的性能优化（对应你最早提的「每次点进去很慢」）

- **binding 短 TTL 缓存（2s）+ 并发合并**：面板一次打开原本串行打 6 次 Studio `configuration`，现在 1 次；缓存只存 `{configured, agentId, studio}`，不含任何凭据，Studio 卸载/换实例/写操作立刻失效。
- **本地快照回显**：对话打开先用 localStorage 里上次的消息渲染，再拉 snapshot 校准（限 50 条/4000 字符/256KB，存储异常静默降级）。
- **打点**：`{event:'personal-assistant.rpc', operation, bindingMs, totalMs}`；`session.events` 轮询只保留慢请求 + 1/20 采样，避免刷屏。

---

## 5. 已知限制（不是 bug，是当前后端没有的能力）

1. **新建/删除 Bot 只写本地 registry**，不同步云端（云端没有对应 RPC，`runtime/**` 也不在本轮写域内）。给本地新建的 Bot 发消息会命中云端 `BOT_NOT_FOUND` —— 要闭环得扩云端 control channel。
2. **目录里有、本机 registry 没有的云端 Bot 删不掉**（404），UI 会提示失败。
3. **`bot.detail.computer` 恒为 `null`**：网关不持 broker 租约，没有只读状态来源。
4. **`create.status` 只有 instance 阶段可观测**，其余阶段如实显示 pending；重启后进行中进度丢失。
5. **定时任务的修复在 `runtime/assistant-runtime.mjs`**，属于云端 desktop 镜像代码 —— 本地测试已证明逻辑，但要真正生效需要重新构建/更新云端镜像。
6. **`dist/` 被 gitignore**，客户端产物不入库；换机器后需要 `npm run build:client`。

---

## 6. 提交链

```
a241cb8 feat(pa-prototype): 定时任务幂等/重试/Bot 删除暂停、剪贴板双向 413、客户端收尾与验收用例（406 用例全绿）
543b4d5 test(verify): 独立验收报告 + 28 条用例；修复剪贴板回声/截断/静默失败与调度器 unhandledRejection
7112ad2 feat(client): 按原型实现 7 视图与面板路由（列表/详情/设置/授权/创建进度/骨架屏）
4925cce feat(host): Bot 概览/详情/授权/创建进度 RPC + 本机授权持久化（新增 13 用例）
b04154e docs: 原型实现契约（视图映射 / RPC 契约 / 写域划分）
ab94635 chore(prototype): 基线快照（既有未提交改动 + 冷启动性能优化 + 8 块原型画板）
```

验证明细（逐条现状、缺口定位、28+ 条用例断言、残留风险）见 `docs/verification-report.md`。
