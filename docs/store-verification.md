# 兼容性与上架验证

当前 v0.1.1 源码的检查见 [2026-10-28 完整性检查](completeness-2026-10-28.md)。下文的第三方商城解析与安装生命周期记录来自先前 v0.1.0 发行版；本次源码同步没有重新确认第三方商城准入状态。

本发行版支持 DSH **0.2.1-rc.2**、Node.js **22+**、Linux / WSL 服务端及 `web` Profile。`package.json` 的 `engines.dsh` 保持精确版本；`dsh.compatibility.dshReleases` 仅将 rc.2 声明为 `compatible`，未验证的 rc.1、rc.3 声明为 `unknown`，不授权其安装。

## Bundle 与权限

- 包内声明 `dsh.bundle.patch: ./cordis.patch.yml`，插入的三个入口均属于本包：`multi-user-tool-origins`、`multi-user-service` 和 `member-cli-tools`。三者均提供中英文名称、简介与图标。
- 不安装替代的官方组件，不改变官方入口的包名、实现、配置或启用状态。
- `tools` 入口仅追加 `lanToolOrigins` 服务依赖。它让本插件先记录工具注册的真实 Loader 来源，再启动原生工具及其提供者；成员授权按来源和执行时的账号权限共同校验。不能通过删除这项依赖来获得商城通过状态。
- 工具来源记录器的安装、销毁均由 Cordis effect 管理；卸载时恢复原有注册函数。无法证明来源隔离的工具不向成员开放。
- 本包无 `preinstall`、`install`、`postinstall`、`prepare` 安装脚本。运行依赖和完整权限范围仍需商城独立审阅，不能把兼容声明当作安全审计。

## 商城解析边界

针对 [作者修复通知 #1591](https://github.com/AI-Scarlett/DSH-Store/issues/1591)，Patch 的服务依赖已改成 YAML 块列表，去除未加引号的内联序列歧义。

本次复核的 [DSH STORE 解析器（c18c848）](https://github.com/AI-Scarlett/DSH-Store/blob/c18c8486b96edb8d48f9e840a1298de90461d929/src/bundle-patch-contract.mjs) 对服务注入仅接受新增入口上的 `commands`，仍拒绝本插件对现有 `tools` 入口追加来源记录依赖，返回：

```text
Patch service injection requires an explicit supported additive contract
```

这是需要商城审阅或扩展解析契约的边界，不应将其误报为已通过自动上架。标准 DSH Bundle 安装与商城准入是两项独立结果。

## 可重复的原生生命周期验证

2026-10-27 在 Linux / WSL、Node.js 24.20.0、DSH 0.2.1-rc.2 上验证：

| 检查 | 结果 |
| --- | --- |
| 语法检查及包含原生 DSH 契约的回归 | 455 项通过，0 失败、0 跳过 |
| 通过官方 CLI 安装打包产物（`--ignore-scripts --offline`） | 通过 |
| 原生 Bundle 展开 | 本包两个入口与 `lanToolOrigins` 依赖均保留 |
| 启动与成员登录页 | 配置的成员 Host 返回 HTTP 200，错误 Host 返回 HTTP 403 / `HOST_DENIED` |
| 停止测试进程并由官方 CLI 卸载 | 本包依赖与 Bundle 引用消失；官方 `dsh-base`、`dsh-web-app` 保留 |

上述生命周期验证仅使用一次性 Profile，未调用上游模型；未验证回滚操作。

模型授权回归同时覆盖自定义推理模型的服务商默认档位、原生登录对继承模式的处理，以及仅授权指定等级时对其他等级和默认选项的拒绝。模型选择不触发上游 API 调用。

流式传输回归覆盖超过 2 MiB 的历史快照、后续实时事件、发送背压及输入与输出超限拒绝。客户端输入单帧仍限制为 256 KiB；服务器输出使用独立的 8 MiB 连接缓冲上限，完整转发原生历史格式。

使用临时 `DSH_HOME` 和一次性 `web` Profile，不访问现有账号或 Profile：

```sh
package_dir="$PWD"
test_root="$(mktemp -d)"
cd "$test_root"
npm pack "$package_dir" --ignore-scripts
export DSH_HOME="$test_root/home"
dsh --profile store-check --from-default-profile web --dump-config
dsh plugin --profile store-check add --ignore-scripts "$test_root/sunbigfly-dsh-multi-user-service-0.1.0.tgz"
cat > member-origin.patch.yml <<'YAML'
- id: multi-user-service
  config:
    memberOrigin: http://members.test:18763
YAML
dsh --profile store-check --patch "$test_root/member-origin.patch.yml" --host 127.0.0.1 --port 18763 --no-open
# 在另一个终端只读检查：
# curl -H 'Host: members.test:18763' http://127.0.0.1:18763/lan/
# 仅停止上面启动的测试进程，再执行：
dsh plugin --profile store-check remove @sunbigfly/dsh-multi-user-service
# 验证完成后退出本次测试终端，避免后续命令继续使用临时 DSH_HOME。
```

安装后应有两个独立入口及 `lanToolOrigins` 依赖；启动应能返回登录页；卸载后本包与 Bundle 引用均移除，官方 Web Bundle 保留。账号数据属于独立持久状态，卸载插件不会删除数据。
