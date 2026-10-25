# CreateAgent 重放与 0.1.4 状态（2026-10-26）

## 当前真实创建结果

2026-10-26 北京时间 01:02，通过 dev Server 的 `/agentengine/api/v1/CreateAgent` 仅发送一次创建，沿用此前成功实例的账号与子账号上下文。规格 1 CPU / 4 GiB、20 GiB PVC、personal-assistant 0.1.2。

- HTTP 200，Code 0，RequestId：`req-20261026010246-rhaoka`。
- AgentId：`ar-20261026010246-312961ac`。
- 初次 120 秒跟踪未到终态，保留了超时记录，没有重复创建。
- 随后 GetAgent 为 `RUNNING / Running`，RequestId：`req-20261026010613-sbtniw`，Message 为空。
- 同名 AgentRuntime Running；Pod 两个容器均 Ready、零重启；运行时 `/health` 为 200 且 `dshSessionController:true`。

当前能够正常创建；不能据此推断 Lead 在 22:02–22:22 的每一条 503 都是同一原因。已单独定位的 `ar-20261025221906-pa-e2e-0` 缺模型 endpoint，详见《创建通道核查-20261025.md》。这次真实请求与脱敏响应保存在 `.artifacts/create-replay-20261026/`。

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

当前有效配置来自 dev 环境变量 fallback，DB 未配置覆盖；本次按已有预发 canary 方式追加，未迁移配置来源。准入 capabilityDigest 沿用同协议 0.1.2 的 `e53a4981…`，7 项能力词表未变。Server 业务镜像仍为此前的 `7265d036` 修复构建；本次只滚动 catalog 环境变量。

## 已完成与未完成的验收

同镜像 manifest checker 在 UID 1000、drop ALL、只读 rootfs、无凭据/无网络条件下成功。配对容器的 Computer `/health` 与 Runtime `/ready` 均为 200，后者证明确有 DSH Session Controller；本地这一步使用模型测试夹具，没有执行真实模型回合。

本地 Docker GUI 冒烟**首次帧接口失败：HTTP 400、响应 40 字节**。当时测试没有保留响应正文，这个证据缺口不能推测补齐；原始失败结果保存在 `smoke-pair-result.json`。为补取正文再次运行同镜像、同配置时，返回 HTTP 200，得到 1280×800、20912 字节整桌面 JPEG，随后正常关闭会话并释放租约。生产代码、2.5 秒采集等待、帧上限、租约与沙箱校验均未修改。第一次失败仍作为待定位的不稳定项保留，不能以第二次通过宣布完成验收。

需要 Lead 现在使用**新建 0.1.4 独立实例**运行对照 E2E。创建模板同时修改 `RuntimeVersion` 和 YAML 的 `runtime.version` 为 0.1.4，其余保持一致。重点记录冷启动首帧，以及空闲后客户端退出控制态、停止抓帧与续租。

客户端需要配套的新插件 tarball：`/Users/xiayu/Downloads/AgentKit个人助理预览包-20261026-面板评审/kingsoftcloud-agentkit-personal-assistant-0.1.0.tgz`，SHA256 为 `5b9fb50dd5b50b54010fe228d7946994138fdfe757fe5d7cfaf921d258193cf1`，面板构建戳为 `2026-10-25T16:26:44.055Z`。这份预览包包含 Host 变更，安装后需重开应用；仅刷新旧客户端不足以验证新 idle 状态机。

0.1.4 尚未声明 startup v2，Operator 的新 namespace 沙箱配置与目标 AppArmor 验收也尚未完成。镜像含 checker 的本地证据不等于 Pod 已启用该 init，也不等于 DSH 沙箱验收通过。Lead 已完成的直接 broker 桌面证据继续保留；Studio 页面完整验收与本方失败实例对照仍需分别记录。

Lead 的 `scripts/build-client.mjs`、`package.json` 与《本地安装与云电脑连接.md》保持原样；云端产物来自干净 Git 导出，没有覆盖或提交这三个未提交改动。
