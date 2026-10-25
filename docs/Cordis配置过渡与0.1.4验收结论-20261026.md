# Cordis 配置过渡与 0.1.4 验收结论（2026-10-26）

## 交付结论

**云镜像 0.1.4 的创建、网关、目录和连接通路可用；本地 PA 插件须包含 cd996a6，客户端建议同时包含 ad9f8aa 的 12 秒首帧修复。** ws 问题在本机 Host 目录查询端，不需要为这个问题重做 0.1.4 云镜像。0.1.7 保留为已经发布的后续候选，不是修复面板目录的强制升级前提。

Lead 的版本矩阵作为独立证据记录：0.1.2 + 修复后本地插件明确返回目录不支持；0.1.4 + 修复后插件目录与连接成功；0.1.5 + 修复后插件完成面板实拍。版本不能替代本地包的实际构建检查，dist/client.js 不随 Git 提交。

## Lead 的 0.1.4 独立验收

原报告只读保留在 `.scratch/personal-assistant-cloud-computer/releases/0.1.4-20261026-013233/`，AgentId `ar-20261026013234-a54f1401`。本方读取 pod.json 与 e2e-broker.log，确认是登记的 0.1.4 两个镜像，两个容器 Ready；broker 结果 **13/14、1失败**，失败原文：

```text
Your windowmanager claims not to support _NET_ACTIVE_WINDOW, so the attempt to query the active window aborted.
xdo_get_active_window reported an error
```

Lead 报告网关 health 200、ticket 175ms、握手 235ms、ready 280ms，目录为 default/researcher。这里明确记录创建与通信链路可用，同时保留焦点失败，不称整套 GUI 验收通过。

本方随后在指定 b56be622 计算集群只读查询，得到 `Error from server (NotFound): namespaces "ar-20261026013234-a54f1401" not found`，因此不能补推当时 WM 是否存在、启动是否有竞态或是否中途退出。另在完全相同 digest 的 0.1.4 Computer 镜像内查证：`/usr/bin/fluxbox`、`/usr/bin/Xvfb` 均存在，desktop-session.mjs 含 spawnWindowManager 与 spawn('fluxbox')；记录在 `.artifacts/cordis-config-transition-20261026/computer014-wm-source.json`。不能仅凭 _NET_ACTIVE_WINDOW 查询失败断言产品设计为无 WM。

面向本期整桌面GUI产品，WM/焦点属于必验项，不能因为属性暂不可用而记成环境限制或跳过。Lead后续冷启动复验和本方启动回归已将问题定性为WM就绪竞态；源码已补就绪等待与启动失败处理，详见[WM就绪竞态与焦点复验](./WM就绪竞态与焦点复验-20261026.md)。原0.1.4报告仍保留13/14，不用新版本复验改写历史数字。

## OI-8 的短期配置路径

接受 Lead 的过渡方案：profile 的 `cordis.patch.yml` 行配置由 DSH Loader 传给插件 apply()，不要求环境变量，也不要求先实现 Studio 凭据代理。示例仅含占位值：

```yaml
- id: personal-assistant
  name: '@kingsoftcloud/agentkit-personal-assistant'
  config:
    gatewayUrl: 'https://<该实例对应的网关>'
    agentId: '<用户自己的真实实例ID>'
    apiKey: '<仅由本地Host读取的实例凭据>'
```

本方在临时 profile、Node 22.23.4 和真实 DSH CLI 中复核 --dump-config：最终只有一行 PA，三个 config 字段原样保留。只使用假凭据，未修改真实用户 profile 或应用。证据 `.artifacts/cordis-config-transition-20261026/config-dump-proof.json`。真实面板连通的证据来自 Lead 已完成的隔离测试。

因此，OI-8 的配置通路已有短期交付方式；Studio Host 自动注入/代理出票降为后续体验与凭据托管优化，不再阻塞本期可配置预览包。无凭据手填的零配置开通向导仍未交付，不把它计为本次已完成。

原有 Studio 服务代理分支保留为可选能力。服务不存在时使用该 profile 配置；服务存在但拒绝授权时仍拒绝，不偷偷降级到静态 key。

## 安装器的具体复核

安装器由 Lead 负责，位置 `.scratch/personal-assistant-cloud-computer/install-plugin-for-studio.sh`；本方没有修改它。在独立假 HOME、umask 022、假 API key 下运行一次，退出 0、没有输出假 key，但观察到：

- 新 cordis.patch.yml 是 **0644**，备份目录是 **0755**；脚本没有落实注释所称“仅本机用户可读”。写真实凭据前应设置 umask 077、配置 0600、备份目录 0700，并保护已有配置及其备份。
- 当前 --api-key 参数及随后 Python 子进程的 argv 都携带凭据。建议安装器接受受限文件/标准输入，并在子进程中同样避免 key 进入 argv；这与允许 Host 本地持有配置是两件事。
- 假 HOME 没有对应 macOS App，所以脚本自己的 dump 分支未执行。本方另行运行真正 DSH CLI 完成了上述组合验证；不把安装脚本退出 0 本身当成 dump 已通过。

证据为 `.artifacts/cordis-config-transition-20261026/installer-probe.json`，只含权限和布尔元数据。以上是安装器需要交给 Lead 修正的具体结果，不是否定 Cordis 配置方案。真实安装与重启仍由 Lead 执行。
