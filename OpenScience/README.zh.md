# EviMed（OpenScience/）

EviMed 是一套可追溯的智能体平台：首先是通用工作助手，再叠加医学科研的专业层；托管、多租户，每个项目在各自隔离的
运行时里，由 DeepSeek Harness（DSH）智能体内核驱动。本目录就是生产系统。仓库层面的总览见
[`../README.zh-CN.md`](../README.zh-CN.md)，贡献规则见 [`../CONTRIBUTING.md`](../CONTRIBUTING.md)，
本子树内人和智能体共同遵守的规则见 [`AGENTS.md`](./AGENTS.md)。

[English](./README.md)

平台输出仅用于科研辅助，不替代临床诊疗或专业判断；关键结论必须回溯原始证据。

## 目录内容

这是一个 pnpm monorepo（`engines.node >= 22.22.0`，pnpm 9.4.0；工作区为 `apps/*` 与
`packages/*`）。产品只有托管 Web 应用这一种形态。

| 路径 | 说明 |
| --- | --- |
| `apps/web/` | React + TypeScript + Vite 前端（`@ai4s/web`），由服务端托管 |
| `apps/server/` | 纯 Node 控制面（`@ai4s/server`）：HTTP API、认证与租户、运行台账、网关、交付门禁、功能模块 |
| `packages/` | `domain`（共享词汇与交付门禁规则）、`harness-port`（唯一允许导入 `@deepseek-ai/*` 的包）、`socket`（`evimed-universal` 内核组合）、`contracts`、`design-tokens`、`shared` |
| `capabilities/`、`capability-skills/` | 每个能力一个目录（`capability.yaml`、`SKILL.md`、脚本），以及共享的技能正文 |
| `runtime/` | 运行时镜像携带的 MCP 服务与技能库 |
| `deploy/` | 运行时镜像、Docker Compose 栈、专项适配器和主机发布脚本 |
| `evals/` | 评测框架与评测题；与测试分开，会调用真实模型 |
| `scripts/` | 构建生成器、本地开发辅助、运维与发布工具，见 [`scripts/README.md`](./scripts/README.md) |
| `docs/` | 产品、技术、部署、运维与发布文档 |
| `deps-version.json` | 所有上游版本钉的唯一书写处 |

## 总体结构

浏览器从不直接接触智能体内核。它只调用 `apps/server`；服务端持有通往该项目运行时中 DSH
内核的唯一一条 WebSocket（运行时是主机上的容器，或一个 AgentBay 会话），把内核事件解码成
`@evimed/domain` 的词汇，再提供自己的运行事件流。运行时的模型调用走控制面的模型网关，由网关
持有模型服务商凭据；运行时不持有服务商密钥，只能访问工作区。专项分析引擎（`../项目代码/`
下的 Python 智能体）由 `deploy/specialist-adapter/` 前置，作为 `deploy/web/` 托管 Compose 栈
的服务运行；控制面通过 `EVIMED_*_URL` 环境变量找到它们。

内核版本只在 `deps-version.json` 里写一次；它在运行时镜像构建时（`deploy/runtime-dsh/`）
安装成一个版本钉死的 profile，不在这里拉取。[`docs/TECHNICAL_DESIGN.md`](./docs/TECHNICAL_DESIGN.md)
和 [`docs/PRD.md`](./docs/PRD.md) 是 v0.1 桌面时代的原始设计记录，文首已标注为已被取代；
系统当前如何运行，以 [`AGENTS.md`](./AGENTS.md)、[`docs/REQUEST_PATH.md`](./docs/REQUEST_PATH.md)
和 [`docs/WEB_DEPLOYMENT.md`](./docs/WEB_DEPLOYMENT.md) 为准。

## 本地开发

需要 Node.js 22.22.0 或更高版本、pnpm 9.4.0。

```bash
pnpm install
pnpm configure:evimed-local   # 创建本地签名密钥，并报告还缺什么
pnpm dev                      # Web 前端（Vite 开发服务器）
pnpm dev:server               # 控制面 HTTP API
pnpm dev:evimed               # 本地封装：8798 端口、密码登录的控制面
```

`pnpm dev:evimed` 在 `apps/web/dist` 已构建（`pnpm build`）时会托管它。它设置了仅限本地的
开关，允许运行时在主机上、容器沙箱之外启动；托管部署始终保持容器边界。

服务商凭据存放在被跟踪目录之外，即仓库根目录下的 `.evimed-local/secrets/`。禁止提交 API Key、
部署 `.env`、用户工作区、运行日志和生成的发布清单。

`bash scripts/dev/fetch-skills.sh` 会把钉死版本的外部技能包拉到 `runtime/skills/external/`
（已被 git 忽略）。运行时镜像构建和 CI 会自行执行它，只有在本地构建或运行运行时镜像时才需要
手动运行。

核心质量门禁（按改动区域划分的完整清单见 [`../CONTRIBUTING.md`](../CONTRIBUTING.md)）：

```bash
pnpm lint
pnpm ci:web
```

## 部署与运维

- [Web 部署](./docs/WEB_DEPLOYMENT.md)
- [运维手册](./docs/WEB_OPERATIONS_RUNBOOK.md)
- [隐私与合规](./docs/WEB_PRIVACY_AND_COMPLIANCE.md)
- [安全事件响应](./docs/WEB_SECURITY_INCIDENT_RESPONSE.md)
- [发布与交付检查表](./docs/EVIMED_RELEASE_AND_DELIVERY_CHECKLIST.md)

托管 Web 部署是唯一的发布路径。

## 许可证与上游致谢

本目录保留 [LICENSE](./LICENSE) 中的上游 MIT 许可证和第三方声明。EviMed 基于 Open Science
工作台与 DeepSeek Harness（DSH）智能体运行时建设；相关上游名称仅在技术兼容或许可证致谢所需的
位置保留。
