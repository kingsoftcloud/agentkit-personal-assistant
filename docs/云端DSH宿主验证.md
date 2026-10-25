# 云端 DSH 宿主与插件 API

## 运行结构

`personal-assistant-runtime` 容器启动独立 DSH 进程，使用用户状态盘内的 `ASSISTANT_STATE_PATH/dsh` 作为 `DSH_HOME`。独立 Personal Assistant 插件通过 DSH 注入的公开 `sessionController` 创建会话、提交回合和读取真实会话日志。

同一进程中有两个监听入口：

- `8080`：Personal Assistant 插件的受鉴权 API 和桌面 WebSocket；平台 Service 继续指向此端口。
- `127.0.0.1:8081`：DSH 自带网页载体，仅在 Pod 回环可达，用户无需打开它。

不依赖用户本机 Studio 进程。关闭 Studio 后，受权的 HTTP 请求仍可在此 DSH Host 提交回合。

入口脚本校验挂载 manifest 的实际 SHA-256、runtime 名称与版本，从 `manifest.model` 和平台注入的 `OPENAI_BASE_URL` 生成 DSH 模型路由。配置只引用 `AGENTKIT_MODEL_API_KEY` 的变量名，不把密钥写入配置。

`GET /health` 仅在插件已取得真实 DSH Session Controller 时返回 200；独立启动没有 Host 注入的 API 服务时返回 503。401、404 和单纯 TCP 可连均不作为 readiness 成功。其余 `/v1/*` 路由必须持有 `Authorization: Bearer <runtime token>`。

## 2026-10-25 实测证据

验证使用本地 Linux/amd64 容器、镜像 `pa-runtime-dsh:0.1.2` 和只读挂载的本次插件源码、入口脚本。它证明真实 DSH Host 与 API 接线，不是最终镜像或预发集群验收。受控 OpenAI 流式服务只用于提供模型响应；它不是一次真实商业模型调用。

没有模型配置的初次实测得到真实错误：

```text
MISSING_CREDENTIAL
llm-deepseek: no API key for provider route "deepseek-official"
```

补齐平台模型路由后，DSH 在独立容器完成了 API 触发的回合。此过程没有打开 Studio：

```text
GET /health → 200
{"status":"ready","assistantId":"a1","computerId":"c1","bots":1,"dshSessionController":true}

GET /v1/bots（无 token）→ 401
{"error":"RUNTIME_UNAUTHORIZED"}

POST /v1/sessions → 201
sessionId=session-84c421bd-f4a6-4d8d-a7ec-c04e2bd68d3e

POST /v1/sessions/<sessionId>/turns → 202
execution=dsh-session-controller
requestId=turn-936b7356-a03e-4a13-8416-cfe5d0bb95b9

GET /v1/sessions/<sessionId>/turns?botId=b1 → 200
status=completed
result=CLOUD_DSH_OK

GET /v1/sessions/<sessionId>/messages?botId=b1 → 200
role=assistant
content=CLOUD_DSH_OK
```

容器日志：

```json
{"event":"personal-assistant.host.ready","assistantId":"a1","port":8080,"dshSessionController":true}
{"event":"personal-assistant.turn.finished","botId":"b1","sessionId":"session-84c421bd-f4a6-4d8d-a7ec-c04e2bd68d3e","turnId":"turn-936b7356-a03e-4a13-8416-cfe5d0bb95b9","status":"completed"}
```

最终 assistant 消息来自 DSH 的 `assistant/message` 事件；completed 状态来自相应 `turn/end` 事件。代码不把 prompt 的 accepted 回执当作回合已完成，也不会用本地假推理生成最终消息。

## 回归检查

```sh
node --test test/cloud-runtime-http.test.mjs test/plugin-entry.test.mjs
npm test
```

针对 HTTP 路由的回归检查包含缺少 DSH 时 readiness/turn 的 503、无 token 的 401、跨 Bot Session 的 404，以及 DSH 回合结果写入。最终发布仍需真实制品重建、不可变镜像摘要、预发 Pod 与真实模型验证；本文件不替代这些证据。
