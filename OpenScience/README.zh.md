# EviMed

EviMed 是一套可追溯的医学科研智能体平台。它把开放域科研工作台与多个医学专项科研
Agent 统一在同一套运行时、工件、溯源、Notebook、工具和数据源底座上。

[English](./README.md)

## 产品能力

- **开放域科研**：通过多轮对话完成文献检索、代码与 Notebook 执行、文件分析、图表、
  报告、完整性审查和可复现运行记录。
- **专项科研工作流**：提供药物警戒、超说明书用药证据、药品综合评价、药品遴选、
  Meta 分析、孟德尔随机化、文献计量、科研选题和论文审稿等独立对话入口。专项以
  Skill 进行个性化约束，复用统一 Harness，不重复建设工作流 DSL。
- **个人知识库**：上传的资料和沉淀的知识可以同时作用于开放域问答与专项科研会话。

平台输出仅用于科研辅助，不替代临床诊疗或专业判断；关键结论必须回溯原始证据。

## 技术架构

核心生产形态是托管 SaaS：React/TypeScript 前端统一通过 EviMed Server 访问隔离的
DeepSeek Harness（DSH）运行时、DeepSeek 模型网关、追加式运行记录、工件溯源、
Jupyter 内核、精选科学 Skills 和 EviMed 数据/工具适配器。Tauri 仅用于可选桌面壳，
不是主发布目标。

专项服务通过 `EVIMED_*_URL` 环境变量接入。Meta 分析服务已经纳入托管版 Compose；
其他专项服务需要在生产环境完成独立部署和地址配置后，才能作为正式可用能力对外承诺。
详见[发布与交付检查表](./docs/EVIMED_RELEASE_AND_DELIVERY_CHECKLIST.md)。

## 本地开发

需要 Node.js 20+、pnpm 9、Rust，以及 Tauri 对应平台依赖。

```bash
pnpm install
bash scripts/dev/fetch-uv.sh
bash scripts/dev/fetch-skills.sh
pnpm dev:evimed
```

运行时内核不在这里以二进制形式拉取：DSH 在运行时镜像内安装成一个版本钉死的
profile（`deploy/runtime-dsh/`），版本只有 `deps-version.json` 一处定义。

本地配置脚本会把模型密钥保存到仓库外部。禁止提交 API Key、部署 `.env`、用户工作区、
运行日志和生成的发布清单。

核心质量门禁：

```bash
pnpm lint
pnpm ci:web
pnpm check:tauri
```

## 部署与运维

- [Web 部署](./docs/WEB_DEPLOYMENT.md)
- [运维手册](./docs/WEB_OPERATIONS_RUNBOOK.md)
- [隐私与合规](./docs/WEB_PRIVACY_AND_COMPLIANCE.md)
- [安全事件响应](./docs/WEB_SECURITY_INCIDENT_RESPONSE.md)
- [发布与交付检查表](./docs/EVIMED_RELEASE_AND_DELIVERY_CHECKLIST.md)

托管 Web 是主发布路径。桌面安装包如需生成，仅作为可选草稿工件，并另行完成代码
签名与公证。

## 许可证与上游致谢

本项目保留 [LICENSE](./LICENSE) 中的上游 MIT 许可证和第三方声明。EviMed 基于 Open
Science 工作台与 DeepSeek Harness（DSH）智能体运行时建设；相关上游名称仅在技术兼容
或许可证致谢所需的位置保留。
