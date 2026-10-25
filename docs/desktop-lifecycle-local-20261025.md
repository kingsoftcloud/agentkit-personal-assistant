# 桌面会话结束与重连修复记录

2026-10-25，本次只修改独立插件的桌面 WebSocket、插件客户端和对应测试。未修改 Studio 页面、鉴权、租约校验或鼠标坐标算法；未打包产物、构建镜像或操作真实 Pod。

## 原因与行为

服务端收到桌面会话 404 后只发送错误，随后继续轮询；自动申请的租约仍有续租计时器。客户端将所有 WebSocket 关闭都当作断网，且切回页面可再次发起连接。因此空闲回收后的会话会反复重连。

现在的处理如下：

| 事件 | 服务端 | 插件客户端 |
| --- | --- | --- |
| 取帧、输入或续租得到会话 404／租约 409 | 发送带原因的 `closed`，以 1000 关闭，立即停止取帧与续租，清理会话并释放自动租约 | 显示会话或租约已结束，停止重连，等待用户主动连接 |
| 续租遇到 503 等暂时错误 | 保留实际状态码，发送 `retryable: true`，以 1011 关闭并清理资源 | 保留网络重连，最多自动重试五次 |
| 普通网络中断 | 连接关闭时清理资源 | 按原模式重连；首帧超时使用 4000，仍可重试 |
| 用户主动只读旁观 | 保持既有服务端权限限制 | 橙色横幅说明只读状态，不推断“其他 Bot 正在控制” |

会话关闭和租约释放独立发起，前者失联不会挡住后者。断开期间才完成的申请租约／创建会话也会清理；解码中的迟到帧不会重新显示已结束的桌面。调用者传入的既有租约仍按原契约保留，不由此连接自动释放。

## 本地证据

原始日志位于 `.artifacts/desktop-lifecycle-20261025/`。将修改前的两个模块复制到隔离目录，以同一份新增测试运行，结果为 **10 条中 9 条失败**；修改后 **10/10 通过**。测试驱动实际 WebSocket 桥回调与实际面板组件，使用模拟 Socket、React hooks 和可控时钟，不依赖真实集群。

```bash
node --test test/desktop-lifecycle.test.mjs test/desktop-authorization.test.mjs test/desktop-backpressure.test.mjs test/plugin-entry.test.mjs
# tests 24; pass 24; fail 0

npm test
# tests 75; pass 74; skipped 1; fail 0

docker run --rm --platform linux/amd64 --network none \
  -v /Users/xiayu/kingsoft/code/agent-sdk/agentengine/agentkit-personal-assistant:/repo:ro \
  -w /repo node:22.23.4-bookworm-slim \
  node --test test/desktop-lifecycle.test.mjs test/desktop-authorization.test.mjs \
  test/desktop-backpressure.test.mjs test/plugin-entry.test.mjs
# tests 24; pass 24; fail 0
```

全量测试中的一项 Linux 原生沙箱实测在本地 macOS 正常跳过，本次没有运行安全探针。Node 22.23.4 的定时器模拟 API 给出实验特性提示，不影响结果。

上述证据属于本地协议和组件回归，不等同于真实 Studio／Pod 验收。本次未宣称 Studio 内终端 `ls` 输入成功；该焦点问题由另一条真实界面验证继续定位。新客户端和运行时产物需统一重打后再验收空闲关闭行为。
