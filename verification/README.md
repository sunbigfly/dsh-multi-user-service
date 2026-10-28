# 当前原生契约验证

- `member-execution-fixture.mjs`：加载本机实际安装的 DSH 原生文件、Bash、PTY 和终端控制器，使用合成私有目录验证成员封装。由 `tests/member-execution.test.js` 调用。
- `public-member-access.mjs`：在实际安装的 DSH 网关及访问服务上验证成员资源归属。由 `tests/public-member-access.test.js` 调用。

通过 `DSH_LAN_CONTRACT_MODULES` 指定宿主的 `node_modules`。这些原生服务/协议测试与正式服务浏览器验收分别记录，不相互替代。旧独立 verifier 插件及一次性 probes 已归档到项目外。
