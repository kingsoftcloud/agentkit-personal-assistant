# Studio Host 桌面代理契约 v1

> 当前定位：这是后续可选的凭据托管与自动绑定方案，不再是本期安装预览包的阻塞项。短期允许由安装器写入 profile 的 Cordis config，DSH 会将 gatewayUrl/agentId/apiKey 传给 apply()；机制已通过真实 CLI 组合验证。脚本权限与凭据输入修正见《Cordis配置过渡与0.1.4验收结论-20261026.md》。下文“不在配置存 key”的约束仅指未来代理模式。

## 分工与调用路径

Studio 侧由 Lead 实现：使用现有云登录与凭据，解析当前账号拥有的 PA 实例及其网关，通过网关签发短时票据；向同一个 DSH Host 的其他插件提供下述服务。插件侧由本方实现：动态取得服务、检查公开绑定、查询助理目录、向页面提供短时桌面授权。双方不同时修改 Studio 文件。

`hostRemote.assistantDesktopTicket` 可作为 Studio 客户端动作，但它本身不能被另一个插件 Host 调用。因此请同时在 Studio Host 的活跃 Cordis fiber 中提供公开服务：

```javascript
ctx.provide('studioPersonalAssistantDesktop', {
  async configuration({ agentId } = {}, signal) {
    // 读取已认证账号与 Host 持久化的实例选择；可选 agentId 仍须查归属。
    // 未登录、未选择或未开通：return { configured: false }。
    return { configured: true, agentId: selectedAgentId };
  },
  async issueTicket({ agentId, botId, mode, leaseId }, signal) {
    // 校验当前账号、实例归属/框架/状态，再通过相应网关出票。
    // 两个入口共享实现，不复制鉴权或把密钥交给插件。
    return {
      ticket, expiresAt, agentId, botId,
      wsUrl, protocol: 'agentkit.personal-assistant.desktop.v1',
      leaseId: leaseId ?? null, readOnly: mode === 'read',
    };
  },
});
```

插件使用 DSH 公开的 `ctx.get('studioPersonalAssistantDesktop')`。这个服务是可选服务，不加入 PA 的强制 inject；云端 PA 的纯 DSH profile 不安装 Studio，仍能启动。每次请求重读服务与绑定，因此服务晚加载或重新选择实例不要求重启插件。服务卸载后拒绝新授权；已建立的桌面连接仍由其短时票据、云端会话与租约生命周期管理。

## 数据与安全约束

- `configuration(input, signal)`：返回 `{configured: boolean, agentId?: string}`。配置为 false 时不返回伪造实例。`agentId` 如由本地显式配置提出，仅是候选值，Studio 仍须校验归属；不能相信浏览器或 localStorage 的选中值。
- `issueTicket(input, signal)`：输入为 `{agentId, botId, mode, leaseId?}`，mode 仅 read/control。插件会给目录查询申请 `botId: '__directory__', mode: 'read'`，这个保留身份必须可透传，不能误判为未知普通助理。返回规范化的小写字段对象，不返回 Server 的 Code/Data 包装。
- 签票走实例对应网关的 `/IssuePersonalAssistantDesktopTicket`。API key/AK/SK 只在 Studio Host 内取得并使用，不写 PA 配置，不放到返回值、页面、URL、日志或遥测。
- 票据一次使用，`expiresAt` 为可被 Date.parse 解析的绝对时间，尚未过期且剩余有效期不超过 60 秒。`wsUrl` 是完整 WSS 地址，路径严格为 `/personal-assistant/desktop/ws`，不能含 query、fragment 或用户名密码。非本机 WS 仅允许显式开发配置放行，不作为产品默认。
- 页面与插件不会接受任意 HTTP 头；返回给页面的字段仅为上例中的公开授权字段。`readOnly` 必须与请求 mode 一致，Agent/Bot 必须与请求一致。
- 签票不代表已获得电脑控制租约。leaseId 只是已绑定授权的可选上下文，电脑 Broker 仍在 open/input 时执行租约互斥与所有权检查。
- 失败抛出带 `status` 或 `details.status` 的异常（401/403/409/5xx），不能返回一个“成功但空 ticket”的对象。插件保留错误状态，替换异常文案，防止上游错误携带凭据进入页面。
- 存在 Studio 服务时绝不走 PA 静态密钥分支；服务返回未配置、拒绝授权、异常或卸载，均不降级使用旧凭据。仅完全没有 Studio 服务的独立开发 Host 保留原有显式连接配置。

## 当前完成范围与验收

本方已完成插件代理分支，仍使用原有 owner-only Connection Fetch RPC；未修改 DSH remotes，也不增加浏览器凭据通道。目录查询继续使用现有只读 WSS 协议，页面不自动连接云电脑。

测试先复现空配置仍返回 configured:false 的断点，再验证空配置经 Studio 代理出票、目录查询、晚加载/换实例/卸载、401/403/409/5xx 不降级、异常脱敏及返回票据的绑定/有效期/地址校验。

2026-10-26 本方验证结果：新增 5 项回归测试修复前全部失败，修复后相关 17 项通过；固定 Node 22.23.4 全量 115 项中 114 通过、1 项真实 Linux 沙箱测试因缺少显式环境跳过、0 失败。另在现有 Runtime 镜像内使用真正的 Cordis 4.0.5，以两个兄弟插件复验无 Studio 可启动、服务晚加载可出票、切实例即时生效、卸载停止授权及关闭消费者清理 RPC 路由，共 5 项通过。该实测的 Studio 服务是协议夹具，不是 Lead 尚待实现的正式凭据代理。

Studio 侧必须同时解决 Host 可读取的选中实例：旧页面仅写 localStorage 的选择不会自动变成 Host 绑定。实例选择应通过已鉴权动作在 Host 保存并验证；没有选择时返回 false，不能假称已开通。此文不表示 Studio 服务已经实现，也不把夹具测试当作安装版用户闭环验收。

未来代理模式联合验收时，PA cordis 配置及进程环境中应没有 gatewayUrl/agentId/apiKey：启用 Studio 与 PA 后 configuration 可返回合法绑定，目录可读取，浏览器通过票据连桌面；换实例及注销后新授权必须使用新绑定或被拒绝。短期 Cordis 配置模式不按该零配置目标判失败。两种模式全程均不得输出实际票据或凭据。
