# 个人助理启动校验与 AppArmor 绑定

新镜像通过catalog同一版本记录中的显式启动声明启用校验，不根据运行时版本号猜测能力：

```json
{"startup":{"protocol":"agentengine.dsh-startup/v1","templateVersion":"agentkit.personal-assistant.startup/v2","command":["/usr/local/bin/agentkit-runtime"],"port":8080,"healthCheck":{"protocol":"HTTP","path":"/ready"}}}
```

该模板固定使用与主容器同一镜像的`managed-manifest-check`，命令为：

```text
node /opt/agentkit/personal-assistant/plugin/runtime/check-manifest.mjs --manifest /app/code/agentengine.yaml
```

checker仅挂载只读声明ConfigMap，使用UID/GID1000、只读根文件系统、drop ALL、禁止提权，不注入模型key、runtime token或任何SecretKeyRef。声明字节摘要、协议、运行时name/version、模型字段、提示词格式与严格YAML解析共同校验；校验失败不启动主进程。prepare helper复用相同声明读取器，不建立另一套宽松校验。构建脚本将checker明确放入runtime产物中；镜像构建仍需检查该文件存在和语法有效。

`/ready`无需凭据，只有已注入DSH Session Controller且`turnBridge.available === true`时返回200，否则503；不是仅进程存活或网页能打开即健康。Runtime Service投影HTTP `/ready`、固定命令和真实启动摘要，读取CR实际字段及独立checker后才报告observed digest。

未声明startup的冻结0.1.2/0.1.3维持既有启动与Exec readiness，不注入旧镜像不存在的checker；回退至未声明startup的配置会移除新版checker和启动marker。其他DSH框架的既有启动声明及校验路径不变。

Operator的`agentRuntime.dshSandbox.namespaces`由运维配置明确列出目标namespace。配置nil不启用；列表为空、重复、非法名称或通配符均拒绝。范围外保持原行为，不读取用户CR标签选择策略，也不另起重叠controller。范围内PA必须具备真实v2摘要、HTTP `/ready`、同镜像固定checker、无凭据且只读的校验环境及digest绑定声明卷，才能给runtime和computer绑定同一版本化localhost AppArmor策略。

本次只完成源码与测试，没有部署或安装节点策略。目标节点仍需由授权节点管理流程安装审核固定策略、核对摘要与enforce后才attest；当前containerd默认profile不能当作DSH策略验收证据。
