<p align="center"><img src="assets/logo-icon.svg?v=initial-010-dsh" width="88" alt="DSH 多用户服务"></p>
<h1 align="center">DSH 多用户服务</h1>
<p align="center">一套 DSH，服务整个团队。</p>
<p align="center">
  <a href="https://github.com/sunbigfly/dsh-multi-user-service/releases/latest">下载</a> ·
  <a href="docs/operations.md">部署指南</a> ·
  <a href="https://github.com/sunbigfly/dsh-multi-user-service/issues">反馈</a>
</p>

把已有的 DSH 扩展为团队服务。成员通过浏览器登录，使用自己的会话与文件；管理员统一分配模型、能力和目录权限，管理账号与用量。

![DSH 多用户服务](https://raw.githubusercontent.com/sunbigfly/dsh-multi-user-service/main/docs/media/demo.gif?v=initial-010-dsh)

## 团队工作区

| 能力 | 提供什么 |
| --- | --- |
| **账号管理** | 创建、邀请、停用、归档、恢复及归档后删除；删除账号保留历史会话、文件和用量。 |
| **权限分配** | 按成员授予模型、功能、Skills、Agent 预设和目录权限；支持按筛选跨页全选、批量设置。 |
| **个人选择** | 成员可在管理员授权范围内，自行选择启用哪些能力，只影响自己的账号。 |
| **会话与文件** | 按账号管理内容；管理员可预览会话，管理文件、共享目录和回收站。 |
| **用量与额度** | 调用与 tokens 统计、筛选和分页；按成员设置并发数及日／月 tokens 额度。 |
| **团队外观** | 登录页、侧栏与首页共用 Logo、名称和标签。 |

模型与执行能力沿用 DSH，宿主凭据保留在服务端。管理员和成员使用同一服务账号入口，身份由服务端角色决定。

## 快速开始

1. 在服务器的 DSH 中，打开 **插件 → 实验性插件 → 自定义插件索引**。
2. 添加以下索引，搜索 **DSH 多用户服务**，安装并启用。

   ```text
   https://github.com/sunbigfly/dsh-multi-user-service/releases/latest/download/index.json
   ```

3. 按首次设置向导创建管理员，确认成员数据目录、可选共享目录和登录入口。
4. 创建或邀请成员，配置权限，并将成员登录地址分发给团队。

成员只需浏览器，通过 `http://服务器地址:端口/lan/` 登录。支持网络中已配置解析的主机名，例如 `team-server.local`，并保留 IP 备用入口。

已有 DSH 可直接安装插件；需要独立服务托管、固定端口和定时备份时，使用 [部署指南](docs/operations.md) 中的服务脚本。

## 部署与安全边界

- **运行环境**：已验证 **DSH 0.2.1-rc.2 · Node.js 22+ · Linux / WSL 服务端**。其他版本与平台尚未验证。
- **目录限制**：成员文件及脚本访问限于本人目录和授权共享目录；使用 DSH 随附的 Landlock 启动器，隔离不可用时拒绝成员执行。
- **资源共享**：共享 MCP 和未验证隔离的工具插件不向成员开放；成员的个人选择只能收窄管理员授权。
- **部署维护**：业务页面不能停用多用户认证组件；宿主系统维护权限仍由可信部署者掌握。目录限制不等于网络隔离，HTTPS 与网络访问由部署环境配置。

[完整权限与执行边界](CONTRACT.md) · [部署、备份与恢复](docs/operations.md) · [兼容性与上架验证](docs/store-verification.md)

[MIT](LICENSE)
