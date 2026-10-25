# CreateAgent 重放与 0.1.4 状态（2026-10-26）

## 两个 Lead 修复与当前候选的归属

**云镜像 0.1.4 可用；本地 PA 插件须包含 cd996a6，客户端建议同时包含 ad9f8aa 的 12 秒首帧修复。** Lead 已对真实 0.1.4 实例完成创建、双容器、网关、目录和连接验证。ws 问题在本机 Host，不需要为此重做 0.1.4 云镜像。OI-8 可通过 Cordis 行配置过渡，Studio 代理不再是本期前置要求；详见《Cordis配置过渡与0.1.4验收结论-20261026.md》。

Lead 的 `cd996a6bb996eb3200a0f3d485d3edf8b52a1b84` 提供 ws 优先解析与客户端 watch 构建；`ad9f8aa766d8d75508a81538aa2ba309bc2dce19` 将首帧截止从 3 秒改为 12 秒。已分别执行 `git merge-base --is-ancestor <commit> a417e49`，两项均返回 0，确认已包含在新候选源码中，无需重复 cherry-pick。

| catalog 版本 | Runtime 插件构建源码 | 是否含 cd996a6 / ad9f8aa |
| --- | --- | --- |
| 0.1.4 | 5f0a4a9，保持冻结 | 均不含 |
| 0.1.6 | 复用 0.1.4 Runtime，仅更新 Computer | 均不含 |
| 0.1.7 | a417e49，已构建并登记 dev | 均包含 |

上表仅记录镜像内包的来源，不作为强制升级云版本的门槛。配合仍使用 undici 的旧本机 Host 时目录查询会失败；安装含 cd996a6 的本地插件后，0.1.4 服务端已有的 bots.list 可正常使用。此前把“镜像内未含本地修复”与云版本可用性绑定过紧，现按 Lead 的真实矩阵更正。

首帧截止同样由本机加载的 dist/client.js 决定。新 Runtime 或 Git 源码中有 ad9f8aa，不代表用户旧 dist 已更新。当前完整本地包已实际解包核验：优先 ws、客户端 12 秒截止均存在；真实 DSH --dump-config 通过。包为 `/Users/xiayu/Downloads/AgentKit个人助理预览包-20261026-WS修复/kingsoftcloud-agentkit-personal-assistant-0.1.0.tgz`，SHA256 `e6714a90fd0c7f30b4c924db636b95a615deed11f6f9b00e761a10765c6b8ccd`，构建戳 `2026-10-25T20:11:26.348Z`。含 Host 改动，安装后需重开应用；本方未修改用户 profile/App。

可继续使用 `verify-release.sh 0.1.4` 与修复后本地插件验收，不要求因 ws 修复升级云端。0.1.7 保留为另一个后续候选：标签 `0.1.7-candidate-20261026-a417e49`，digest `sha256:1a6905e84f16f75434be68b866aa81b1ee2acff692b070cfd062710e9deb83a3`；Computer 复用 `sha256:3327d446d2118b8b49282b6706e50699eec09eb4873df828794c649b5f72f87e`。完整条目与证据见《0.1.7-WS修复候选交付-20261026.md》。Lead 的 0.1.5 及演示实例保持原样。

Lead 的独立 0.1.4 实例 `ar-20261026013234-a54f1401`：HTTP 200/Code 0、Pod 2/2；网关 health 200、ticket 175ms、握手 235ms、ready 280ms，目录 default/researcher。broker 原报告为13/14，焦点项报`_NET_ACTIVE_WINDOW`不支持，原始失败保留。后续已定性为会话启动时WM尚未就绪的竞态，不记环境限制或跳过；修复和复验见[WM就绪竞态与焦点复验](./WM就绪竞态与焦点复验-20261026.md)。原namespace后续查询NotFound，没有把其他版本的通过结果改写为该原实例14/14。

下文保留最初创建及 0.1.4 构建的历史证据，不把当时镜像、早期本地包或验收状态冒充本次发布状态。

## 01:02 真实创建结果（历史验收）

2026-10-26 北京时间 01:02，通过 dev Server 的 `/agentengine/api/v1/CreateAgent` 仅发送一次创建，沿用此前成功实例的账号与子账号上下文。规格 1 CPU / 4 GiB、20 GiB PVC、personal-assistant 0.1.2。

- HTTP 200，Code 0，RequestId：`req-20261026010246-rhaoka`。
- AgentId：`ar-20261026010246-312961ac`。
- 初次 120 秒跟踪未到终态，保留了超时记录，没有重复创建。
- 随后 GetAgent 为 `RUNNING / Running`，RequestId：`req-20261026010613-sbtniw`，Message 为空。
- 同名 AgentRuntime Running；Pod 两个容器均 Ready、零重启；运行时 `/health` 为 200 且 `dshSessionController:true`。

该次创建正常；不能据此推断 Lead 在 22:02–22:22 的每一条 503 都是同一原因。已单独定位的 `ar-20261025221906-pa-e2e-0` 缺模型 endpoint，详见《创建通道核查-20261025.md》。这次真实请求与脱敏响应保存在 `.artifacts/create-replay-20261026/`。

## 成功请求的可重放版本

`docs/examples/personal-assistant-create-agent.json` 与此前 `ar-20261025222804-4df266ad` 的成功 JSON 相同，仅把名称和 InstanceId 换成待生成值。没有 ApiKey、AK/SK；模型为 `glm-5.1`，明确传入 `OPENAI_BASE_URL`，模型 key 由 Server 自动申请。`/data` 是请求中的存储配置，电脑容器的 `/workspace` 挂载由 runtime-service 按部署契约处理。

下面命令使用有 Kubernetes 权限的预发 **Server 调试口**，重放网关已验证的身份上下文。`X-Ksc-*` 不是公网认证；通过公网网关时应沿用正常签名/鉴权，由网关注入这些头。

先在一个终端启动只监听本机的转发：

```bash
kubectl --kubeconfig ~/.kube/agentengine-pre -n agentengine \
  port-forward --address 127.0.0.1 svc/agentengine-dev 18881:8081
```

再在另一个终端执行。每次都会生成新 Name、新 InstanceId，并同步更新 YAML 的 name；不要原样重放已成功实例的 InstanceId。

```bash
export PA_ACCOUNT_ID='<已授权账号ID>'
export PA_SUB_ACCOUNT_ID='<对应子账号ID>'
export PA_SERVER_BASE='http://127.0.0.1:18881'
export PA_REQUEST_PATH='/tmp/pa-create-agent-replay.json'

python3 - <<'PY'
import datetime, json, os, pathlib, uuid
template = pathlib.Path('/Users/xiayu/kingsoft/code/agent-sdk/agentengine/agentkit-personal-assistant/docs/examples/personal-assistant-create-agent.json')
body = json.loads(template.read_text())
instance = uuid.uuid4()
name = 'pa-replay-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d%H%M%S') + '-' + instance.hex[:6]
body['Name'] = name
body['InstanceId'] = str(instance)
body['ManagedRuntimeConfig']['Manifest'] = body['ManagedRuntimeConfig']['Manifest'].replace('name: pa-replay-template', 'name: ' + name, 1)
pathlib.Path(os.environ['PA_REQUEST_PATH']).write_text(json.dumps(body, ensure_ascii=False, indent=2) + '\n')
print(name, instance)
PY

curl --silent --show-error --fail-with-body \
  "${PA_SERVER_BASE%/}/agentengine/api/v1/CreateAgent" \
  -H 'Content-Type: application/json' \
  -H "X-Ksc-Account-Id: ${PA_ACCOUNT_ID:?填写已授权账号}" \
  -H "X-Ksc-User-uuid: ${PA_SUB_ACCOUNT_ID:?填写对应子账号}" \
  -H 'X-Ksc-Region: cn-beijing-6' \
  -H 'X-Ksc-Data-Region: cn-beijing-6' \
  -H 'X-Ksc-Product: agent' \
  -H 'X-Ksc-Source: console' \
  -H 'X-Ksc-Custom-Source: pre' \
  -H 'X-Env: dev' \
  --data-binary "@${PA_REQUEST_PATH}"
```

状态接口为同一路径前缀下的 `GetAgent`，POST body 为 `{"AgentId":"<创建返回值>","IncludeApiKey":false}`；保持相同账号和子账号上下文。Code 0 只表示创建调用已接受，仍需等 GetAgent RUNNING 与 Pod 各容器 Ready。失败时保存 HTTP 状态、RequestId 和原始错误，不能换新 InstanceId 静默重试。

## 0.1.4 候选

本方候选固定插件提交 `5f0a4a9e086755b4b212f0cde7f586b4f8511308`，使用 Node 22.23.4 两次重建产物，摘要一致：

- Runtime tar：`e2a195288cc505a1ac2583e6c44281d4d10b278ec92ca2ef49297f5e56bc08ff`。
- Computer tar：`343f4954c8c72e5431047e758ed91c934dfb6f2fe3e126c6accec064890ebdb1`。

images 构建输入提交为 `e6c01a6`，已补 checker/profile 脚本的构建断言、严格 `/ready` 与产物完整性检查。两个 linux/amd64 镜像已真实构建并推送；registry manifest 核对成功，config digest 与本机构建结果匹配：

| 角色 | Registry manifest digest |
| --- | --- |
| `agent-runtime-personal-assistant` | `sha256:054a7d9be9f82022db6e6df92225b95c7396e673d56caf13da218185b19f4510` |
| `agent-runtime-personal-assistant-computer` | `sha256:18239bacccff47eafc70736ba5e1c381aad8369cb46524649b14c4ffc8f998f8` |

两个镜像的 registry 前缀均为 `hub-vpc-cn-beijing-6.kce.ksyun.com/agentengine-public/`，推送标签为 `0.1.4-candidate-20261026-5f0a4a9`。上述是镜像 manifest digest，不是前面的 tar 摘要或本地 image config ID。

dev catalog 已追加 **0.1.4**，Server 滚动成功，真实 resolver 返回非空 computer（port 8787、workspace `/workspace`）与相同镜像摘要。已逐项核对保留 0.1.0、0.1.1、0.1.2、Lead 的 0.1.3 和另一路的 0.1.5；没有改变默认版本。完整条目为 `docs/examples/personal-assistant-0.1.4-catalog-entry.json`，source values 的单行变更提交为 Server `2b88919d`。

该次登记时有效配置来自 dev 环境变量 fallback，DB 未配置覆盖；当时按已有预发 canary 方式追加，未迁移配置来源。准入 capabilityDigest 沿用同协议 0.1.2 的 `e53a4981…`，7 项能力词表未变。当时 Server 业务镜像为 `7265d036` 修复构建，仅滚动 catalog 环境变量；后续 Server 灰度见各次交付记录。

## 已完成与未完成的验收

同镜像 manifest checker 在 UID 1000、drop ALL、只读 rootfs、无凭据/无网络条件下成功。配对容器的 Computer `/health` 与 Runtime `/ready` 均为 200，后者证明确有 DSH Session Controller；本地这一步使用模型测试夹具，没有执行真实模型回合。

本地 Docker GUI 冒烟**首次帧接口失败：HTTP 400、响应 40 字节**。当时测试没有保留响应正文，这个证据缺口不能推测补齐；原始失败结果保存在 `smoke-pair-result.json`。为补取正文再次运行同镜像、同配置时，返回 HTTP 200，得到 1280×800、20912 字节整桌面 JPEG，随后正常关闭会话并释放租约。生产代码、2.5 秒采集等待、帧上限、租约与沙箱校验均未修改。第一次失败仍作为待定位的不稳定项保留，不能以第二次通过宣布完成验收。

最初请求 Lead 新建 0.1.4 对照实例的工作现已有上述独立报告，不再重复要求创建。继续复验时，创建模板仍须同时修改 RuntimeVersion 和 YAML runtime.version；冷启动、空闲生命周期与焦点项分开记录。

当时面板预览包为 `/Users/xiayu/Downloads/AgentKit个人助理预览包-20261026-面板评审/kingsoftcloud-agentkit-personal-assistant-0.1.0.tgz`，SHA256 `5b9fb50dd5b50b54010fe228d7946994138fdfe757fe5d7cfaf921d258193cf1`、构建戳 `2026-10-25T16:26:44.055Z`。此处只保留历史来源；验证 ws/12秒修复应使用本页开头的新完整包，不能沿用这个早期预览包。

0.1.4 尚未声明 startup v2，Operator 的新 namespace 沙箱配置与目标 AppArmor 验收也尚未完成。镜像含 checker 的本地证据不等于 Pod 已启用该 init，也不等于 DSH 沙箱验收通过。Lead 已完成的直接 broker 桌面证据继续保留；Studio 页面完整验收与本方失败实例对照仍需分别记录。

原0.1.4产物来自5f0a4a9的干净 Git 导出，没有夹带当时尚未提交的 Lead 改动。上述构建脚本、package.json 与安装文档后来已由 Lead 在 cd996a6 中提交；本方当前版本与该提交中的这三个文件逐字相同。
