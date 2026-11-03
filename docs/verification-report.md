# 独立验收报告：云电脑双向剪贴板 / 每 Bot 定时任务投递路由 / 交互稳定性

- 验收对象：`agentkit-personal-assistant`，分支 `feat/pa-prototype`（task-2 客户端、task-3 Host 已合入后）
- 验收依据：[docs/prototype-implementation-plan.md](./prototype-implementation-plan.md) 第 7 章三项验收口径
- 验收人：verifier（独立验收，不参与功能开发）
- 合入后基线（实测）：`npm test` → tests 369 / pass 367 / fail 0 / skipped 2；`npm run check` → EXIT=0
- 本报告先落阶段 A 的代码审计结论（第 1–4 节），阶段 B 的修复与新增用例实测记录回填在第 5 节。

---

## 1. 云电脑双向复制粘贴

### 1.1 现状（真实链路与消息）

**本机 → 云电脑（粘贴）**

| 步骤 | 位置 | 行为 |
| --- | --- | --- |
| 1 捕获按键 | `src/client/index.mjs:544`、`:637` | keydown 命中 `isPasteShortcut` 后 `preventDefault()` 并调用 `pasteLocalClipboardToCloud`；隐藏 input 另有 `onPaste` 兜底（`pasteTextToCloud`）。两条路径互斥依赖 `preventDefault`，同一按键只会走一条。 |
| 2 读本机剪贴板 | `src/client/index.mjs:295-301` | 先走 Host RPC `personal-assistant.clipboard.read`；失败再退回 `navigator.clipboard.readText()`（Electron 渲染器无剪贴板权限，通常被拒）。 |
| 3 校验与写入云端 | `src/client/components/desktop-clipboard.mjs:176-194` | 空内容 → `CLIPBOARD_EMPTY` 提示；`byteLength > 64 KiB` → `CLIPBOARD_TOO_LARGE` 提示，二者都不会写云端；否则 `writeCloud(text)`。 |
| 4 云端写入 | `runtime/desktop-ws.mjs:292-318` | 校验会话/控制代次/只读（403 `DESKTOP_READ_ONLY`、404 `DESKTOP_SESSION_NOT_FOUND`、409 `DESKTOP_SESSION_IDLE`、409 `DESKTOP_CONTROL_EPOCH_CHANGED`）、字符串类型、`> 64 KiB` 413；随后转 broker `/broker/action`。 |
| 5 落 X11 剪贴板 | `runtime/computer-agentd.mjs:211-219` → `runtime/desktop-session.mjs:609-615` | agentd 二次校验 64 KiB；`xclip` 写入由 owner 进程持有 selection。 |
| 6 合成粘贴键 | `src/client/components/desktop-clipboard.mjs:185-191` | 写成功后发 `Control_L+v`（`pasteShortcutEvents`，Linux 固定 Control，不发 Super）；无控制权时 `CLIPBOARD_KEY_NOT_SENT` 给出「还差接管」提示。 |

**云电脑 → 本机（复制）**

| 步骤 | 位置 | 行为 |
| --- | --- | --- |
| 1 捕获按键 | `src/client/index.mjs:545-550` | 只在非 repeat 的 keydown 触发 `copyCloudClipboardToLocal`，`_copyShortcut` 用来防 150 ms 窗口内重复进入（`src/client/index.mjs:283-292`）。 |
| 2 读云端剪贴板 | `runtime/desktop-ws.mjs:292-318` → `runtime/computer-agentd.mjs:213` → `runtime/desktop-session.mjs:598-607` | `xclip -o` 读取，`maxBuffer 256 KiB`，再按 UTF-8 边界**静默截断**到 64 KiB；读取失败返回空串。 |
| 3 写本机剪贴板 | `src/client/components/desktop-clipboard.mjs:197-208`、`src/client/index.mjs:302-306` | 空内容 → `CLIPBOARD_EMPTY`；否则先 Host RPC `personal-assistant.clipboard.write`，失败才退回 `navigator.clipboard.writeText`。 |
| 4 Host 落系统剪贴板 | `src/host-gateway.mjs:146-164` | `> 64 KiB` → 413 `PERSONAL_ASSISTANT_CLIPBOARD_TOO_LARGE`；否则 `pbcopy`/`Set-Clipboard`/`xclip -i`（2 s 超时）。 |

**已有测试覆盖（11 + 14 + 4 条，全部通过）**

- `test/desktop-clipboard.test.mjs`：云端 `readClipboard` UTF-8 截断（`:76`）、owner 生命周期（`:88`）、xclip 失败 `DESKTOP_CLIPBOARD_FAILED`（`:114`）、broker 暴露读/写与租约（`:157`）、桌面未启用 503（`:175`）、协议透传（`:182`）、客户端 RPC 形状（`:204`）。
- `test/client-desktop-clipboard.test.mjs`：Linux 快捷键口径（`:25`、`:31`、`:37`）、本机读被拒提示（`:48`）、粘贴成功链路（`:60`）、空/超 64 KiB/被拒不写云端（`:77`）、只读旁观提示（`:98`）、复制成功与失败提示（`:111`）、错误码中文化（`:135`、`:209`、`:215`）、通道 requestId/超时/断连（`:147`、`:183`、`:196`）、`controlEpoch`（`:167`）、复制快捷键守卫（`:242`）。
- `test/desktop-clipboard-ws.test.mjs`：WS 读写原样回传（`:86`）、非字符串 400 / 超限 413（`:100`）、未打开 404 / 只读 403（`:117`）、控制代次 409（`:133`）。
- `test/runtime-artifact-imports.test.mjs:38`：三处 64 KiB 上限常量一致。

### 1.2 缺口（G1.x）

**G1.1（高）两端没有回声去重，复制会把刚粘贴的内容再写回本机。**
`pasteToCloud` 写入云端后，云桌面应用若没有真正复制（例如只是剪贴板变了），用户紧接着按 ⌘C/Ctrl+C 会把同一段文本读回并写回本机剪贴板（`desktop-clipboard.mjs:197-208` 无任何比对）；两端来回覆盖，且本机原本的剪贴板内容被静默替换。代码中没有任何 echo/dedup 逻辑（全仓 grep `echo|dedup|lastWrite` 无命中）。第 7 章明确要求「两端不能重复写入或回声」。

**G1.2（中）超长内容策略两端不一致，且云端方向的截断是静默的。**
- 本机读侧：Host `readHostClipboard` 用 `maxBuffer: 64 KiB`（`src/host-gateway.mjs:113-134`），本机剪贴板超过 64 KiB 时 `execFile` 抛 `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`，被外层 catch 统一成 503 `PERSONAL_ASSISTANT_CLIPBOARD_UNAVAILABLE`（「本机剪贴板暂时不可用」），而不是可照做的「内容超过 64 KiB」。已用 `node -e` 复现：`stdout maxBuffer length exceeded, stdout=65536`。
- 客户端随之退回 `navigator.clipboard.readText()`（`src/client/index.mjs:295-301`），被浏览器拒绝后提示「浏览器不允许读取剪贴板」，与真实原因不符。
- 云端读侧：`runtime/desktop-session.mjs:598-607` 先读 256 KiB 再静默截断到 64 KiB 返回，客户端 `copyCloudClipboard` 不做任何长度检查（`desktop-clipboard.mjs:197-208`），用户看到「已复制到本地」但内容已被截断。

**G1.3（中）写入云端成功、合成 Ctrl+V 抛错时完全静默。**
`desktop-clipboard.mjs:185-191`：`sendKeys` 抛异常时直接 `return { ok: true, code: 'CLIPBOARD_KEY_FAILED', error }`，没有 `notify`。用户以为粘贴成功，实际云桌面没有收到 Ctrl+V。

**G1.4（低）Host 剪贴板错误码没有中文化映射。**
`clipboardFriendlyError`（`desktop-clipboard.mjs:75-89`）未覆盖 `PERSONAL_ASSISTANT_CLIPBOARD_TOO_LARGE` / `PERSONAL_ASSISTANT_CLIPBOARD_UNAVAILABLE` / `CLIPBOARD_TIMEOUT` / `CLIPBOARD_UNAVAILABLE`，只能靠 `error.message` 兜底；Host 的「本机剪贴板暂时不可用」会把 G1.2 的 64 KiB 失败说成临时故障。

**G1.5（低）`clipboardTimerRef` 4 秒提示定时器在卸载时未清理。**
`src/client/index.mjs:269-274` 设置 4 s 定时器，`src/client/index.mjs:499-515` 的 effect 清理只取消 rAF/observer/socket/interval/listener，没有 `clearTimeout(clipboardTimerRef.current)`。回调用 `state.current.mounted` 兜底，不会崩，但定时器与闭包在视图卸载后仍存活到 4 s（20 次切换会短暂堆积）。

**G1.6（低）`_copyShortcut` 伪按键可能泄漏成 keyup。**
`src/client/index.mjs:283-292` 把 `_copyShortcut` 塞进 `pressed` 集合，`releaseInputs`（`:234`）在关闭时会把集合里所有键当 keyup 发出去；150 ms 窗口内关闭面板会向云端发一个不存在的按键。只影响剪贴板语义，风险低。

**G1.7（低）缺少的夹具场景**：连续多次粘贴、正好 64 KiB 的边界、端到端「通道错误码 → 用户提示」、Host 侧 64 KiB 写出 413 均无用例。

> 阶段 B 状态：G1.1/G1.3/G1.4/G1.7 已修复并由用例覆盖；G1.2 客户端侧（截断 + 明确提示）已修，Host 读侧 503 误导仍待 E7；G1.5/G1.6 属写域外、未修（E5/E6）。详见 §5.3。

### 1.3 计划新增测试用例（阶段 B）

新增 `test/desktop-clipboard-sync.test.mjs`（注入 `createClipboardEchoGuard` 避免用例互相污染）：

1. `粘贴后立刻复制到同一文本：不回声写回本机，提示未重复复制` — 断言 `writeLocal` 未被调用、`notify` 文案含「未重复」、返回 `{ ok: true, echoed: true }`。
2. `复制云端的不同文本仍然写回本机` — 断言回声守卫不误杀，`writeLocal` 收到该文本。
3. `回声窗口过期后相同文本会重新写回本机` — 注入递增时钟越过 2 s 窗口，第二次复制确实写回。
4. `连续三次粘贴不同文本：各自写云端并按顺序合成 Ctrl+V` — 断言 `writeCloud` 依次收到三段文本、`sendKeys` 调用 3 次、无合并/丢弃。
5. `云端内容超过 64 KiB：按 UTF-8 字符边界截断后写本机并提示已截断` — 断言写本机长度 ≤ 64 KiB、不产生半个汉字、`notify` 含「已截断」、返回 `truncated: true`。
6. `写入云端成功但合成 Ctrl+V 抛错：明确提示需手动粘贴` — 断言 `notify` 被调用且返回 `ok: true, code: 'CLIPBOARD_KEY_FAILED'`（当前为静默，用于验证修复）。
7. `粘贴 64 KiB 边界：正好 64 KiB 允许，多 1 字节拒绝且不写云端` — 断言 `writeCloud` 调用于 65536 字节、不调用于 65537 字节。
8. `通道回复 403/409：粘贴与复制的提示都可照做` — 用 `createClipboardChannel` 接 `pasteToCloud`/`copyCloudClipboard`，令远端回复 `DESKTOP_READ_ONLY` / `DESKTOP_CONTROL_EPOCH_CHANGED`，断言提示含「接管云电脑」且不产生成功文案。
9. `Host 错误码中文化：TOO_LARGE/UNAVAILABLE/TIMEOUT 都有可照做的中文` — 直接断言 `clipboardFriendlyError`。

新增 `test/host-clipboard-limit.test.mjs`（只测拒绝路径，不触碰真实系统剪贴板）：

10. `Host 拒绝超过 64 KiB 的本机剪贴板写入：413 PERSONAL_ASSISTANT_CLIPBOARD_TOO_LARGE` — 65537 字节在 spawn 之前就被拒，断言 `error.code/status`。
11. `Host 拒绝非字符串剪贴板写入：400 PERSONAL_ASSISTANT_REQUEST_INVALID`。

### 1.4 修复方案（阶段 B 落在 `src/client/components/desktop-clipboard.mjs`）

- **F1.1 回声守卫**：新增 `CLIPBOARD_ECHO_WINDOW_MS = 2000` 与 `createClipboardEchoGuard({ windowMs, now })`：`remember(text)` 记录最近一次成功写入云端的文本；`isEcho(text)` 在窗口内命中则返回 true。`pasteToCloud` 写入成功后 `remember`；`copyCloudClipboard` 读到内容先 `isEcho`，命中则 `notify('云电脑剪贴板里是本机刚粘贴的内容，未重复复制到本地')` 并返回 `{ ok: true, echoed: true, text }`（不写本机）。模块内保留一个默认实例供生产路径使用，测试可注入新实例。守卫不抑制**用户主动的连续粘贴**（每次粘贴都是新意图），只拦截「读回自己刚写的内容」。
- **F1.2 超长策略**：`copyCloudClipboard` 增加 `truncateUtf8(text, MAX_CLIPBOARD_BYTES)`（按码点累加字节，不切半个汉字），超过上限时写截断结果、`notify('云端剪贴板内容超过 64 KiB，已复制前 64 KiB')`、返回 `{ ok: true, truncated: true }`。本机→云端方向维持「拒绝并提示」，与云端 413 口径一致。
- **F1.3 静默失败**：`sendKeys` 抛错时 `notify('文字已写入云电脑剪贴板，但没能自动按 Ctrl+V，请手动在云桌面粘贴')`。
- **F1.4 错误码中文**：`clipboardFriendlyError` 增加 Host 剪贴板四码映射。
- **F1.5/F1.6 属于 `src/client/index.mjs`（他人写域）**：不在本任务修改，按第 4 节提交 Lead 裁决；如批准，由 Lead 或客户端负责人改 2 行（清理时 `clearTimeout(clipboardTimerRef.current)`；关闭前先 `state.current.pressed.delete('_copyShortcut')`）。
- **G1.2 的 Host 读侧（`src/host-gateway.mjs` 他人写域）**：建议把 `maxBuffer` 异常单独识别为 413 `PERSONAL_ASSISTANT_CLIPBOARD_TOO_LARGE`（或在 read 前不设上限、读后按长度判断并在 `readHostClipboard` 内抛 413），客户端 `readHostClipboard` 对 413 不再退回 navigator。按第 4 节提交裁决。

---

## 2. 每 Bot 定时任务投递路由

### 2.1 现状（真实链路）

| 环节 | 位置 | 行为 |
| --- | --- | --- |
| 创建任务 | `runtime/assistant-runtime.mjs:141-152` | `scheduleWrite`：`botId = stateBotId(body.botId)`；输入去空且 ≤ 64 KiB；`runAt` 必须为未来；未给 `sessionId` 时用该 `botId` 新建会话；`requireSession(botId, sessionId)` 校验会话归属；`putSchedule` 持久化 `{ botId, scheduleId, runAt, metadata: { input, sessionId, generation } }`；随后 `patchSchedule(pending)` 并 `armSchedule`。 |
| 持久化 | `src/persistent-state.mjs:187-210` | 记录按 `botId` 隔离；文件级原子 rename + 进程内串行 `mutate`。 |
| 触发 | `runtime/assistant-runtime.mjs:181-193` | 到点后 `patchSchedule(row, { status: 'running' })` 作为「认领」，认领成功才 `turnWrite({ botId: row.botId, input: row.metadata.input, metadata: { scheduleId } }, row.metadata.sessionId)`。 |
| 投递 | `runtime/assistant-runtime.mjs:195-198`、`:261-263` | `turnWrite` 串行化后 `submitCloudTurn`：`requireSession(botId, sessionId)` → `turnBridge.submitTurn`；`src/dsh-session-bridge.mjs:136` `registry.require(botId)` 在 Bot 不存在时抛 `BOT_NOT_FOUND`；`:142` 会话属于别的 Bot 时抛 `DSH_SESSION_BOT_CONFLICT`；`:143` 同会话并发 turn 抛 `DSH_SESSION_BUSY`。 |
| 重启恢复 | `runtime/assistant-runtime.mjs:304-307` | 启动时把 `running` 改 `interrupted`，只重新 arm `pending`（不重放已中断任务，避免重复副作用）。 |
| 客户端 | `src/client/index.mjs:55-57` | **死 RPC**：`personal-assistant.schedules.list/create/delete` 是复数命名，Host 的 `OPERATIONS`（`src/host-gateway.mjs:102-106`）与 `SESSION_OPERATIONS` 只有单数 `personal-assistant.schedule.create`，面板调用必然 404「当前面板不支持此操作」。当前 UI 没有创建入口（`views/bots-list.mjs:139` 只显示计数），所以尚未暴露给用户；一旦接线就会失败。 |

**结论：投递路由本身是 botId 绑定的、跨 Bot 安全的。** 触发时用的是 `row.botId`（创建任务时的 Bot），`requireSession` 与 `submitTurn` 双重校验会话归属，Bot 不存在时抛 `BOT_NOT_FOUND` 不会退化为「主助理」。

**已有覆盖**：`test/bots-lifecycle.test.mjs`（两 Bot 同 scheduleId 并存、计时器数量、关闭取消、重启 re-arm、空输入 400）、`test/schedule-workspace.test.mjs`（`ScheduleManager` 成功路径）。

### 2.2 缺口（G2.x）

**G2.1（中）Bot 删除后没有「暂停」语义，任务是「失败」而不是「暂停」。**
`src/bot-registry.mjs:166 remove()` 只从内存注册表移除；`src/host-gateway.mjs` 的 `deleteBot` 只写 Host 侧 `deleted:true`，不通知云端 runtime（`runtime/assistant-runtime.mjs:39-50` 启动时一次性加载 `BOT_REGISTRY_PATH`）。到点后 `requireSession` 抛 `BOT_NOT_FOUND` → 任务被标 `failed`、输出告警日志，不会乱发到别的 Bot（这点合格），但用户重新建回同名 Bot 后任务不会自动恢复，也没有「已暂停等待 Bot 恢复」的可读状态。
**阶段 B 补测发现**：Bot 删除后 runtime 在 `stateBotId()` 处就抛出裸 `Error('BOT_NOT_FOUND: writer')`（无 `code`），`armSchedule` 的 catch 只能记成通用 `SCHEDULE_EXECUTION_FAILED`，持久化状态里看不到「Bot 已删除」；同时 bridge 一次都不会被调用（比「投递给别的 Bot」安全）。见 `test/schedule-bot-routing.test.mjs` 第 4 条与 §5.3 G2.1。

**G2.2（高）没有任何重试；且「认领」不是幂等的，多实例/重启重叠会重复发送。**
- 无重试：`runtime/assistant-runtime.mjs:181-193` 单次 `turnWrite`，云端不可达时直接 `failed`，`runAt` 不会顺延。第 7 章要求「重试与幂等」，重试缺失。
- 幂等缺口：认领只比对 `metadata.generation`（`:175-179`），不检查当前 `status`；两个 runtime 实例（滚动重启重叠、共享同一 state 目录）都会在启动时 arm 同一条 `pending` 记录，到点后各自认领成功并各自提交一次。**已实测复现**：临时探针启动两个 `startAssistantRuntime` 共享 state 目录，到点后 `submitTurn` 被调用 2 次、产生 2 个 turn 行、`schedules` 最终都是 `completed`（`submitTurn calls = 2`；turn rows = 2）。修复需要 `runtime/assistant-runtime.mjs` 的认领改为「状态前置条件 + 代次轮转」（例如 `if (row.status !== 'pending') return null`，认领时换新 generation），属于写域外，按第 4 节提交裁决。

**G2.3（低）`ScheduleManager` 的任务异常会变成未处理拒绝（unhandledRejection）。**
`src/schedule-manager.mjs:23-42` 定时器回调 `async () => { ... await task(...) }` 没有 try/catch；`task` 抛错时 Promise 无人 await → Node 默认策略下进程退出（`--unhandled-rejections=throw`）。runtime 的 task 内部有 catch，但 catch 里的 `patchSchedule`（状态文件写失败、`interrupt` 等）再抛错就会穿透到调度器。第 7 章「云端不可达」场景下，这会把「一次任务失败」放大成「助理进程崩溃」。

**G2.4（低）客户端定时任务 RPC 命名与 Host 白名单不一致**（`src/client/index.mjs:55-57` vs `src/host-gateway.mjs:102-106`），见 2.1 表末行；属他人写域，提交裁决。

### 2.3 计划新增测试用例（阶段 B）

新增 `test/schedule-bot-routing.test.mjs`（`startAssistantRuntime` + 注入假 `ScheduleManager` 定时器，用真实 HTTP 创建任务）：

1. `定时任务触发时用创建它的 botId 与该 Bot 会话投递，不退化为主助理` — 两 Bot 并存，为 writer 建会话与任务；触发后断言 `submitTurn` 收到 `{ botId: 'writer', sessionId: writer 会话 }`，且没有 researcher 的调用。
2. `同一时刻两个 Bot 的任务各自投递，不串会话` — 两个 Bot 各一条任务同时到点；断言 2 次提交分别对应正确 botId/session，会话 turn 行各 1 条。
3. `任务不能借用其它 Bot 的会话` — 用 writer 的 sessionId 为 researcher 建任务 → 404/`SESSION_NOT_FOUND`，不 arm 定时器。
4. `Bot 删除后任务不投递给其它 Bot` — 触发前 `registry.remove('writer')`；断言 `submitTurn` 未被调用、任务 `failed`、错误码 `BOT_NOT_FOUND`、researcher 无副作用（验证「不乱发」；暂停语义缺口在报告注明）。
5. `云端不可达：单次触发只尝试一次并标记失败（当前无重试）` — `submitTurn` 抛 `ECONNREFUSED`；断言只调用 1 次、任务 `failed`，用于锁定「不重复发送」现状并暴露无重试。
6. `任务输入超 64 KiB 或为空被拒绝：400，不建会话、不 arm 定时器`。

新增 `test/schedule-manager-errors.test.mjs`：

7. `任务异步抛错不会产生 unhandledRejection，且 onTaskError 收到错误与调度信息`。
8. `任务同步抛错同样被隔离，onTaskError 自身抛错也不泄漏`。
9. `失败后同一 scheduleId 可以重新调度，旧记录已释放`。
10. `dispose 后所有未触发定时器被清空`。

### 2.4 修复方案

- **F2.3（本任务写域，`src/schedule-manager.mjs`）**：定时器回调内 `try/catch` 包住 `await task(...)`；新增可注入 `onTaskError(error, { scheduleId, scheduledAt })`，默认实现输出一行 JSON 错误日志（不静默吞错、不中断进程）；保证任务失败后记录已释放、可重新调度。
- **F2.1/F2.2（写域外，`runtime/assistant-runtime.mjs`）**：建议（a）认领改为 `if (row.status !== 'pending') return null` 并在认领时轮转 `metadata.generation`（幂等令牌）；（b）云不可达时按次数退避重试（例如 3 次、间隔 30 s/2 min），重试同样走幂等认领，超过上限标 `failed` 并通过事件告知用户；（c）Bot 删除时把该 `botId` 的 `pending` 任务改 `paused`，Bot 恢复后重新 arm。第 4 节请 Lead 裁决是否授权修改。
- **F2.4（写域外，`src/client/index.mjs`）**：改成 Host 白名单里的单数 operation（或 Host 补复数别名）。第 4 节请 Lead 裁决。

---

## 3. 交互稳定性

### 3.1 现状（清理点盘点）

| 资源 | 位置 | 卸载/切换时是否清理 |
| --- | --- | --- |
| 云桌面 WS、AbortController、rAF、1 s fps interval、document/window 监听 | `src/client/index.mjs:499-515` | 是（`close(false)`、`controller.abort()`、`clearInterval`、`removeEventListener`、`mounted=false`） |
| 连接重试/首帧超时 timer | `src/client/index.mjs:234`、`:352`、`:364` | 是（`close()`/`ended()`/`markIdle` 内 `clearTimeout`） |
| 桌面 ticket 请求的 abort | `src/client/index.mjs:499-515` | 是 |
| 剪贴板通道在途请求 | `src/client/index.mjs:239`、`:433`（`rejectAll`） | 是 |
| 剪贴板 4 s 提示 timer | `src/client/index.mjs:272-273` | **否**（G1.5） |
| 外壳开通报板 1 s 轮询 | `src/client/index.mjs:1204-1213`、`:1406-1443` | 是（`clearCreateTimer`） |
| 会话轮询 200/600 ms、cursor 校准、`SESSION_CURSOR_STALE` 重开 | `src/client/conversation.mjs:557-588` | 是（`cancelled` + `clearTimeout`） |
| 会话重试 timer | `src/client/conversation.mjs:537-545`、`:420` | 是 |
| 队列自动发送 timer | `src/client/conversation.mjs:727-731` | 是（effect 返回 `clearTimeout`） |
| `beforeunload` 拦截 | `src/client/conversation.mjs:735-740` | 是（`removeEventListener`） |
| 概览/详情/设置缓存（重开回显） | `src/client/index.mjs:765-790`、`:1164-1173` | 持久化（localStorage，stale-while-revalidate） |

**已有覆盖**：`test/client-conversation-session.test.mjs`（会话打开/轮询/失败）、`test/client-conversation-queue.test.mjs`（队列串行/退避）、`test/client-onboarding.test.mjs`（开通引导）、`test/bots-overview.test.mjs`（Host 概览合并与降级）。**没有**「20 次视图切换」「卸载后无轮询堆积」「重开面板缓存回显」类用例。

### 3.2 缺口（G3.x）

**G3.1（中）没有 20 次视图切换的稳定性用例**：白屏、控制台报错、轮询堆积都没有回归防线。外壳视图状态机 `panelView`（`src/client/index.mjs:972` 起）目前靠人工点验。

**G3.2（低）卸载后剪贴板 4 s 定时器存活**（同 G1.5），20 次切换会短暂堆积定时器；虽有 `mounted` 兜底不会 setState，但属于「轮询/定时器堆积」范畴。

**G3.3（低）effect 依赖 `[request]` 身份**：外壳 boot（`src/client/index.mjs:1211`）与桌面主 effect（`:515`）只依赖 `request`。宿主若在每次渲染传入新函数，会反复 abort/重连；当前调用方（`apply()` 注册层）传入稳定引用，风险存在但可控。用例可用「同一 request 引用 20 次切换只建立 1 条 WS」锁定契约。

**G3.4（低）RPC 失败降级恢复无端到端用例**：桌面面板 ticket 失败 → `phase='error'` + 「重新连接」按钮（`src/client/index.mjs:651`、`:666`）的人工恢复路径无测试；外壳概览失败降级到缓存/目录（`:1127-1150`）无重开回显用例。

**G3.5（低，待裁决）重开面板时「列表首帧」仍要等 configuration RPC。**
`boot()` 已同步 `setOverview(cachedOverview.value)`（`src/client/index.mjs:1167-1172`），但列表体在 `!configured` 时直接返回开通报板/加载态（`:1670`、`:1689` 两处 `if (!configured) return renderOnboarding();`），而 `configured` 只在 `configuration` RPC 返回后才有。阶段 B 用例实测：网络挂起时首屏文本是「正在读取开通状态…」，缓存只贡献了底部「1 个 Bot」计数与诊断行，**Bot 名称/选中态并未立即回显**。验收原文是「已加载过的 Bot 列表、当前选中 Bot、授权状态保持一致，不因缓存或请求顺序出现空白或错位」，当前不空白、但「列表立即回显」未达成。若要满足，应把 `configured` 纳入缓存（或 `overview` 有缓存时先渲染列表骨架再校正）。是否按缺口修由 Lead 裁决。

### 3.3 计划新增测试用例（阶段 B）

新增 `test/client-stability.test.mjs`（复用 `test/client-conversation-session.test.mjs`、`test/client-onboarding.test.mjs` 的 fake-React 夹具，统计 WebSocket/timer/请求数）：

1. `视图连续切换 20 次：每次都有内容渲染，没有 console.error` — 外壳列表↔详情↔设置↔授权弹层↔创建面板↔对话↔云电脑来回 20 次，断言每次渲染树含可读文案、`console.error` 0 次。
2. `视图切换 20 次后没有轮询/定时器堆积` — 统计挂载期间创建的 `setTimeout/setInterval`，卸载后断言活跃数量为 0（或不超过基线），WS 全部 `close()`。
3. `会话页卸载后不再轮询：20 次挂载/卸载后 session.events 请求数有界` — 每次挂载 1 次快照 + ≤2 次 events，卸载并推进假时钟后请求数不再增长。
4. `RPC 失败可降级恢复：desktop.ticket 首次失败 → 显示可操作错误 → 点「重新连接」后进入 ready`。
5. `重开面板状态一致：概览缓存立即回显，当前 Bot 与选中态保持` — 首次挂载写入缓存，卸载后重挂载，断言首帧即渲染缓存 Bot 名称、`selectedBotId` 不变。
6. `宿主 request 引用稳定时，20 次切换只建立 1 条云桌面 WS`（锁定 `[request]` 依赖契约）。

> 说明：用例 2 若发现「活跃定时器 > 0」且根因是 G1.5（他人写域），用例以「除剪贴板提示 timer 外为 0」断言并在报告标注；不为了让用例变绿而放宽断言。

---

## 4. 需 Lead 裁决的写域外问题

| 编号 | 文件（写域外） | 问题 | 建议 | 影响验收 |
| --- | --- | --- | --- | --- |
| E1 | `runtime/assistant-runtime.mjs:175-193` | 认领非幂等：多实例/重启重叠重复发送同一条消息（已实测 2 次提交） | 认领加 `status === 'pending'` 前置条件 + 代次轮转 | 第 2 项「幂等（不得重复发送）」 |
| E2 | `runtime/assistant-runtime.mjs:181-193` | 云端不可达无重试，任务直接 `failed` | 退避重试 + 幂等认领 + 上限告警 | 第 2 项「重试」 |
| E3 | `runtime/assistant-runtime.mjs:304-307`、`src/bot-registry.mjs:166`、`src/host-gateway.mjs` `deleteBot` | Bot 删除后任务 `failed` 而非 `paused`，重名 Bot 恢复后不自动续跑 | 删除时把该 botId 的 pending 改 `paused`，注册表恢复后 re-arm | 第 2 项「Bot 删除后降级为暂停」 |
| E4 | `src/client/index.mjs:55-57` | 复数 `schedules.*` RPC 不在 Host 白名单，恒 404 | 改单数 operation（或 Host 补别名） | 定时任务面板可用性（当前无 UI 入口，未暴露） |
| E5 | `src/client/index.mjs:272-273`、`:514` | 剪贴板 4 s timer 卸载未清理 | 清理时 `clearTimeout(clipboardTimerRef.current)` | 第 3 项「无轮询堆积」 |
| E6 | `src/client/index.mjs:283-292`、`:234` | `_copyShortcut` 伪按键可能以 keyup 泄漏 | 关闭前从 `pressed` 删除该伪键 | 第 1 项健壮性 |
| E7 | `src/host-gateway.mjs:113-134` | 本机剪贴板 > 64 KiB 读失败报 503「暂时不可用」，且客户端退回 navigator 报「浏览器拒绝」，与真实原因不符 | Host 对 maxBuffer 超限抛 413 `PERSONAL_ASSISTANT_CLIPBOARD_TOO_LARGE`；客户端对 413 不退回 navigator | 第 1 项「超长文本策略」 |

## 5. 阶段 B 执行记录

### 5.1 改动清单（全部在本任务写域内；未执行任何 git 操作）

| 文件 | 类型 | 内容 |
| --- | --- | --- |
| `src/client/components/desktop-clipboard.mjs` | 修复 | F1.1 回声守卫、F1.2 云端方向 UTF-8 截断、F1.3 sendKeys 失败提示、F1.4 Host 错误码中文映射 |
| `src/schedule-manager.mjs` | 修复 | F2.3 任务异常隔离 + 可注入 `onTaskError` + 默认结构化错误日志 |
| `test/desktop-clipboard-sync.test.mjs` | 新增 | 9 条剪贴板用例 |
| `test/host-clipboard-limit.test.mjs` | 新增 | 3 条 Host 剪贴板拒绝路径用例（不触碰真实系统剪贴板） |
| `test/schedule-bot-routing.test.mjs` | 新增 | 6 条真实 runtime + 真实 HTTP 的投递路由用例 |
| `test/schedule-manager-errors.test.mjs` | 新增 | 5 条调度器异常隔离用例 |
| `test/client-stability.test.mjs` | 新增 | 5 条交互稳定性用例（fake React / 假 WS / 计数定时器） |
| `docs/verification-report.md` | 报告 | 本文件（现状、缺口、用例、修复、执行记录） |

写域外文件（`src/client/index.mjs`、`src/client/views/**`、`runtime/**`、`src/host-gateway.mjs`、`src/bot-registry.mjs`、`src/persistent-state.mjs`）一律未改，问题按 §4 提交裁决。

### 5.2 新增用例与断言（28 条，全部真实执行）

**剪贴板（`test/desktop-clipboard-sync.test.mjs`，9 条）**

1. `粘贴后立刻复制到同一文本：不把回声写回本机，并提示没有新内容` — `writeLocal` 0 次、`notify` 含「没有可复制的新内容」、返回 `{ ok: true, echoed: true }`。
2. `复制云端的不同文本仍然写回本机：回声守卫不误杀真正的复制` — `writeLocal` 收到该文本。
3. `回声窗口过期后相同文本会重新写回本机` — 注入 `now`，跨过 `CLIPBOARD_ECHO_WINDOW_MS` 后 `writeLocal` 被调用。
4. `连续三次粘贴不同文本：各自写云端并按顺序合成 Ctrl+V` — `writeCloud` 依次收到 3 段文本、`sendKeys` 3 次（每次都 `Control_L`+`v`）。
5. `粘贴 64 KiB 边界：正好 64 KiB 允许，多 1 字节拒绝且不写云端` — `writeCloud` 只在 65536 字节调用；65537 字节时拒绝且不调用。
6. `云端内容超过 64 KiB：按 UTF-8 边界截断后写本机，并明确提示只复制了前 64 KiB` — 写本机 ≤ 64 KiB、无半个汉字、`notify` 含「已复制前 64 KiB」、`truncated: true`。
7. `写入云端成功但合成 Ctrl+V 抛错：明确提示需要手动粘贴，不静默假成功` — `notify` 被调用且文案含「手动在云桌面粘贴」、返回 `ok: true, code: 'CLIPBOARD_KEY_FAILED'`。
8. `权限/占用失败端到端：通道回复 403/409 时粘贴与复制都给出可照做的提示` — 走真实 `createClipboardChannel`，断言错误码 `CLIPBOARD_WRITE_FAILED` / `CLIPBOARD_READ_FAILED` 与「需要先点画面接管云电脑」。
9. `Host 剪贴板错误码有可照做的中文：超长/不可用/超时/未连接都不显示技术原文` — 4 个码逐一断言中文文案。

**Host 剪贴板限额（`test/host-clipboard-limit.test.mjs`，3 条）**

10. `Host 拒绝超过 64 KiB 的本机剪贴板写入：413 PERSONAL_ASSISTANT_CLIPBOARD_TOO_LARGE` — 65537 字节在 spawn 前被拒。
11. `Host 本机剪贴板写入参数校验：非字符串 400，不进入系统命令` — `42/null/undefined/{text}/['a']` 全部 400 `PERSONAL_ASSISTANT_REQUEST_INVALID`。
12. `本机剪贴板读写属于 Host 支持的 operation，且在绑定之前处理` — 未绑定实例时也返回 413 而非 404。

**定时任务投递路由（`test/schedule-bot-routing.test.mjs`，6 条）**

13. `定时任务触发时用创建它的 botId 与该 Bot 会话投递，不退化为主助理` — bridge 收到 `{ botId: 'writer', sessionId: writer 会话 }`，`requestId` 来自真实 turn。
14. `同一时刻两个 Bot 的任务各自投递，不串会话` — 2 次提交分别对应正确 botId/session，每个会话各 1 条 turn。
15. `任务不能借用其它 Bot 的会话：404 SESSION_NOT_FOUND 且不 arm 定时器` — 用 writer 的 sessionId 为 researcher 建任务被 404 拒绝。
16. `Bot 被删除后任务不投递给其它 Bot，任务以 BOT_NOT_FOUND 失败且不重发` — bridge 一次都未被调用；持久化状态 `failed`（错误码现状为通用 `SCHEDULE_EXECUTION_FAILED`，见 §2.2）；researcher 无副作用。
17. `云端不可达：单次触发只尝试一次并标记失败，不重复发送（当前无重试）` — `ECONNREFUSED` 后 bridge 仅 1 次、turn 行 1 条、任务 `failed`。
18. `任务输入为空或超过 64 KiB：400 且不建会话、不 arm 定时器` — 空串/纯空白/65 KiB 全 400 `SCHEDULE_INPUT_REQUIRED`。

**调度器异常隔离（`test/schedule-manager-errors.test.mjs`，5 条）**

19. `任务异步抛错不会产生 unhandledRejection，且 onTaskError 收到错误与调度信息` — `process.on('unhandledRejection')` 探针 0 次；上下文含 `{ scheduleId, scheduledAt }`。
20. `任务同步抛错同样被隔离，onTaskError 自身抛错也不会泄漏`。
21. `未注入 onTaskError 时默认输出结构化错误日志，而不是静默吞掉` — 断言一行 JSON（`event: personal-assistant.schedule.task-failed`）。
22. `任务失败后同一 scheduleId 可以重新调度，旧定时器不残留`。
23. `dispose 清空所有未触发的定时器，避免关闭后仍触发投递`。

**交互稳定性（`test/client-stability.test.mjs`，5 条）**

24. `会话页连续挂载/卸载 20 次：每次卸载监听归零，之后不再发起 session.events` — 每次挂载确认轮询 timer > 0（证明真的卸载了活轮询），卸载后活跃 timer = 0；再等 260 ms 断言 `session.events` 请求数不再增长；`console.error` 0 次。
25. `云电脑面板连续连接并卸载 20 次：每次 socket 关闭、定时器归零、无控制台错误` — 每次 `desktop.ticket` 只建 1 条 WS、`open` 帧已发、卸载 `close(1000)`、活跃 timer 0、`pointerdown`/`visibilitychange` 监听器归零；20 次共 20 条 WS 且 20 次 ticket。
26. `RPC 失败可降级恢复：desktop.ticket 首次失败后仍显示可操作界面，重试可进入就绪` — 首次失败无半条连接、界面仍有「连接云电脑」入口，第二次成功建连并可在卸载时关闭。
27. `外壳视图连续切换 20 轮（列表↔详情↔设置↔本机授权）：每步有内容、无报错、卸载后定时器归零` — 每轮 6 次切换（设置→返回→详情→返回→授权弹层开→关），每步断言渲染树非空、`data-panel-view` 正确，20 轮后 timer 0、`console.error` 0。
28. `重开面板状态一致：上次概览缓存先回显，网络恢复后换成真实数据` — 网络挂起时首屏非空白且缓存计数「1 个 Bot」已回显；恢复后显示真实 Bot 名、重新拉取 `bots.overview`、并把新数据回写 `personal-assistant.cache.overview`。

### 5.3 缺口状态

| 缺口 | 状态 | 证据 / 说明 |
| --- | --- | --- |
| G1.1 回声去重 | 已修复 | F1.1 + 用例 1/2/3 |
| G1.2 超长策略不一致 | 客户端侧已修；Host 读侧仍待 E7 | F1.2 + 用例 5/6；Host `maxBuffer` 503 误导仍是 E7 |
| G1.3 sendKeys 失败静默 | 已修复 | F1.3 + 用例 7 |
| G1.4 错误码无中文 | 已修复 | F1.4 + 用例 9 |
| G1.5 剪贴板 4 s timer 泄漏 | 未修（写域外 E5） | 稳定性用例未触发剪贴板提示路径，不能据此认为已修复 |
| G1.6 `_copyShortcut` keyup 泄漏 | 未修（写域外 E6） | 同上 |
| G1.7 缺夹具 | 已补 | 用例 1–12 |
| G2.1 Bot 删除→失败而非暂停 | 未修（写域外 E3）；已补现状用例 | 用例 16：不乱发、不重发，但错误码退化为 `SCHEDULE_EXECUTION_FAILED`、无 paused 状态 |
| G2.2 无重试 + 认领非幂等 | 未修（写域外 E1/E2）；已补现状用例 | 用例 17 锁定「当前单次投递」；双实例重复发送的探针证据见 §2.2 |
| G2.3 调度器 unhandledRejection | 已修复 | F2.3 + 用例 19/20/21/22/23 |
| G2.4 客户端复数 schedule RPC | 未修（写域外 E4）；当前无 UI 入口 | 未新增用例 |
| G3.1 无 20 次切换用例 | 已补 | 用例 24/25/27 |
| G3.2 卸载后 timer 存活（同 G1.5） | 未修，但已建立防线 | 用例 25/27 的 timer 归零断言会在任何新增泄漏时立即失败 |
| G3.3 `[request]` 身份依赖 | 已锁定契约 | 用例 25/27：同一 request 引用下每轮只 1 条 WS、无重复 boot 请求 |
| G3.4 RPC 失败降级恢复无用例 | 已补 | 用例 26（面板）+ 用例 28（外壳缓存/降级） |
| G3.5 重开列表首帧仍等 configuration | 待裁决 | 用例 28 实测：缓存只回显计数，列表主体仍显示「正在读取开通状态…」；见 §3.2 G3.5 |

### 5.4 真实命令输出（仓库根目录执行）

`npm test`（`node --test test/*.test.mjs`）：

```
ℹ tests 397
ℹ suites 0
ℹ pass 395
ℹ fail 0
ℹ cancelled 0
ℹ skipped 2
ℹ todo 0
ℹ duration_ms 5873.971
```

`npm run check`（`node --check` 全链路 + 上述测试）：

```
EXIT=0
ℹ pass 395
ℹ fail 0
ℹ cancelled 0
ℹ skipped 2
ℹ todo 0
ℹ duration_ms 6856.799542
```

基线为 369 项 / 367 通过 / 0 失败 / 2 skipped；阶段 B 新增 28 条用例后为 397 项 / 395 通过 / 0 失败 / 2 skipped，无回归。

### 5.5 未覆盖与残留风险

1. **真实云桌面未跑通**：本机无 Xvfb/xclip/xdotool 环境，剪贴板用例用假通道验证协议、策略与提示，未验证云端 `desktop-ws` + xclip 的真实行为；合并前建议在集成分支做一次人工冒烟（粘贴、复制、超长、只读旁观四种）。
2. **双实例重复发送仍可复现**（E1）：仓库内没有「两个 runtime 共享 state 目录」的可重复夹具，仅用临时探针复现（`submitTurn calls = 2`）；E1 修复后应补「重叠实例只成功发送一次」用例。
3. **无重试不满足第 2 项验收原文**（E2）：当前用例只锁定「不重复发送」，云端恢复后自动补发仍缺失；E2 修复后需补「首次 ECONNREFUSED → 退避重试成功且只成功一次」用例。
4. **Bot 删除的错误码可读性**（E3 附带）：`failed` 状态只留 `SCHEDULE_EXECUTION_FAILED`，用户无法从状态里看出「Bot 被删了」，建议 E3 修复时保留 `BOT_NOT_FOUND`。
5. **G3.5 列表首帧**：重开面板时缓存未真正承担列表渲染（只暖计数），是否需要把 `configured` 一并缓存请 Lead 裁决。
6. **视图切换覆盖范围**：外壳覆盖列表/详情/设置/授权弹层；对话页与云电脑面板是独立组件，各自用 20 次挂载/连接用例覆盖，未做「外壳内 chat↔desktop 嵌套切换」；创建进度页轮询路径未在 20 轮内触发（其 timer 清理逻辑在 `clearCreateTimer`，未纳入本轮断言）。
7. **E5/E6 未修**：剪贴板提示 timer 与 `_copyShortcut` 伪按键仍按 §4 等裁决；这两条不阻塞「无白屏/无堆积」主结论，但属于第 1 项健壮性尾项。
8. **用例耗时**：全量测试从基线约 4.5 s 增至约 5.9 s（`npm test`），新增用例含 260 ms 真实等待与会话轮询清理验证，属可接受范围。
