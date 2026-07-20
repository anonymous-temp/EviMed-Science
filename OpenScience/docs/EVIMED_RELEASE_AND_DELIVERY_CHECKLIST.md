# EviMed 发布与交付检查表

更新日期：2026-07-19

## 当前结论

代码基线可以进入“受控单节点试点”的交付准备阶段，但在下列外部条件完成前，不应宣称
已经可以面向公众正式发布，也不应承诺 9 个专项 Agent 全部可用。现有前端、统一 Harness、
专项 Skill、运行记录、工件溯源、Notebook、知识库、模型网关和安全边界不需要重新设计。

生产 Compose 已启用 `OPEN_SCIENCE_REQUIRE_ALL_SPECIALIST_ADAPTERS=true`。任何一个面向用户
展示的专项适配器缺失时，`/api/ready` 会失败，避免出现“按钮存在、后台没有执行能力”的
假上线。

## 已完成的代码门禁

| 项目 | 状态 | 说明 |
|---|---|---|
| 中文 EviMed 产品界面 | 已完成 | 页面标题、Logo、登录、导航和科研工作流入口已经统一 |
| 统一开放域 Harness | 已完成 | OpenCode、Skills、MCP、文件、Notebook、Runs、Provenance 共用一套底座 |
| 9 个专项入口 | 已完成 | 药品安全性、超说明书、综合评价、药品遴选、Meta、MR、文献计量、科研选题、论文审稿 |
| 生产适配器配置透传 | 已完成 | 服务端注册的 15 个 `EVIMED_*_URL` 均进入 Compose 与环境模板 |
| 专项完整性门禁 | 已完成 | 生产环境缺少任一必需专项适配器时 readiness 失败 |
| Meta 生产服务 | 已完成 | Meta 镜像已纳入 Compose，并使用文件型模型密钥与工作负载签名 |
| 发布质量门禁 | 已完成 | 桌面 tag 构建必须先通过 lint、Web/Server/E2E、依赖审计、合规审计、构建和 Rust 检查 |
| 源码凭据门禁 | 已完成 | `pnpm audit:source-secrets` 检查主仓库、专项源码和接口文档，不输出密钥内容 |
| 发布身份 | 已完成 | 产品名、Bundle ID、安装包工件和 Release Manifest 均使用 EviMed |

## 专项 Agent 生产交付状态

| 专项 Agent | 代码/Skill | 本地执行 | SaaS 生产要求 |
|---|---|---|---|
| 药品安全性分析 | 已有 | 依赖现有业务服务 | 配置病例查询与信号分析两个 HTTPS 适配器 |
| 超说明书用药分析 | 已有 | 依赖现有业务服务 | 部署并配置超说明书证据适配器 |
| 综合药品评价 | 已有 | 依赖现有业务服务 | 部署并配置综合评价适配器 |
| 药品遴选评价 | 已有 | 依赖现有业务服务 | 部署并配置药品遴选适配器 |
| 自动化 Meta 分析 | 已有 | 已有 | Compose 已内置；上线前完成真实模型与端到端验收 |
| 孟德尔随机化 | 已有 | `evimed_runner.py` | 将 Runner 封装成签名校验的 HTTP 服务并配置 URL |
| 文献计量分析 | 已有 | `evimed_runner.py` | 将 Runner 封装成签名校验的 HTTP 服务并配置 URL |
| 科研选题 | 已有 | `evimed_runner.py` | 将 Runner 封装成签名校验的 HTTP 服务并配置 URL |
| 论文审稿 | 已有 | `evimed_runner.py` | 将 Runner 封装成签名校验的 HTTP 服务并配置 URL |

四个 Python Runner 在桌面/本地模式可直接使用宿主路径，但 Docker SaaS 运行时看不到宿主
源码目录，因此必须部署为 HTTP 服务；不能用本地成功代替生产可用性验收。

## 正式发布前的外部阻断项

这些工作需要域名、账号、基础设施或法律/运营负责人，不能由代码仓库自行完成：

1. **轮换已经出现过的全部凭据。** 源码中的明文已移除，但曾写入旧配置、文档、测试、
   本地运行日志或对话的 DeepSeek、数据库、Redis、Elasticsearch、Kafka、OSS、Tavily 等
   凭据都必须在对应控制台撤销并重建。仅删除文本不能使旧密钥失效。
2. **建立正式版本库与不可变版本。** 将清理后的交付范围纳入受控 Git 仓库，完成代码审查，
   以不可变 commit/tag 构建；禁止把 `.env`、运行数据、日志、语料全文、缓存和本地密钥打包。
3. **部署并探活全部专项服务。** 为上表 8 个外部专项能力配置 HTTPS URL、工作负载签名、
   超时、资源限制和健康检查，并用每个页面的真实任务完成一次端到端 smoke。
4. **锁定旧专项服务的构建工具链。** 现有旧服务不是统一 Java 版本：药品安全、超说明书、
   综合评价和药品遴选按其 POM 使用 JDK 8，综合评价 Agent 使用 JDK 21。药品遴选还需要
   提供私有 `com.evimed:parent:1.0.0` Maven 父 POM/仓库及合法的 Aspose 依赖。必须在固定
   工具链中完成编译、镜像构建和容器 smoke，不能用本机较新 JDK 的失败或成功替代验收。
5. **确定生产域名、TLS 和登录方式。** 配置正式域名；在 OIDC 与本地账号中选定一种，关闭
   开发登录；验证 Cookie、反向代理和跨域设置。
6. **生成真实 DeepSeek 发布凭据。** 使用轮换后的 Key 完成兼容性预检和真实 OpenCode 链路，
   保存带配置修订号、时效和签名的 release receipt。
7. **生成并验证发布清单。** 构建固定版本 Web/Runtime/Proxy 镜像，生成
   `release-manifest.json`，验证镜像 ID、Skills 摘要、源码 revision 和构建时间。
8. **落实最低限度运维。** 指定告警接收人，配置加密备份、保留周期，并至少做一次恢复演练。
9. **完成最小法律交付物。** 确认第三方 Skills、连接器和数据源许可证；发布隐私政策、服务条款、
   数据删除/导出渠道和科研辅助免责声明。无需引入临床签署流程。
10. **桌面分发时完成签名。** macOS 需要 Developer ID 签名和 notarization；Windows 需要代码
   签名证书。未签名安装包只适合内部测试，不适合公开下载。

## 上线执行顺序

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm ci:web
pnpm check:tauri

# 在目标主机和真实生产 env 上执行
pnpm preflight:deepseek:release
pnpm release:manifest
pnpm verify:release-manifest
pnpm preflight:host --env-file deploy/web/.env.production
pnpm smoke:deployment
```

上线验收必须确认 `/api/health` 与 `/api/ready` 同时成功，并逐一从 9 个专项页面发起任务、
产生真实工件、检查引用/数据/日志/溯源和失败提示。验收后保留 release manifest、测试报告、
恢复演练记录和镜像摘要，作为本次交付证据。

## 可延期但不阻断首发

- 全量 i18n 框架；当前中文优先即可。
- 列表 `j/k` 导航、分隔条键盘微调、删除撤销等体验增强。
- 多区域主动-主动、自动故障转移等重型容灾；首发先满足加密备份与可恢复。
- 医学、统计、药物警戒三方签署和版本重新验证流程；本产品定位为科研 Agent，不按临床
  签署系统建设。
