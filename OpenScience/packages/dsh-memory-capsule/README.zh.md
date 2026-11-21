# DSH 记忆胶囊插件

中文 · [English](README.md)

这是连接 EviMed 账号记忆服务的薄插件，通过公共接口 `/api/agent-memory/v1`
取回记忆、事实和做法。它没有本地记忆库，不调用模型，不收集对话，不依赖 EviMed
的 socket 或 universal preset，也没有 npm 运行时依赖；Cordis 注入工具和提示词服务，
模块只导入 Node 的文件 API，并使用原生 fetch。

在包目录运行 `npm pack --ignore-scripts`，用生成的 tgz 在独立配置中安装验证。业主可用自己的 npm 账号运行
`npm publish ./evimed-dsh-memory-capsule-0.2.0.tgz --access public`，再填写实际发布时间，校验并提交市场索引。

## 从零到可回忆

1. 使用 DSH `0.2.2-rc.1`、Node `>=24.9.0`。兼容范围只写这个精确预览版，来自
   `OpenScience/deps-version.json` 的已批准版本和本轮读取的接口契约，不承诺其他版本。
2. 登录已开启外部记忆 API 的 EviMed 部署，打开 `/app/account` → “外部智能体访问
   （API 密钥）” → “创建密钥”，填写名称。勾选“读取记忆与做法”；需要提议记忆时
   再勾选“提出待确认的记忆”。本插件不需要管理记忆或记录处方修改的权限。
3. 将只显示一次的密钥用文本编辑器保存到本机文件，再关闭显示。文件放在代码仓库
   之外，只允许你的系统账号读取（Unix 可运行 `chmod 600 /absolute/path/evimed-key.txt`）。
   配置中只写文件的绝对路径，不把密钥写进命令或 YAML。
4. 所有者发布后，向你实际使用的 profile 安装：

   ```sh
   dsh plugin --profile web add @evimed/dsh-memory-capsule@0.2.0
   ```

   发布前可用相同命令的 `add <local-path>` 形式安装提供的本地包目录或所有者提供的
   压缩包作评审。安装可能由 DSH 的包管理器访问网络，本仓库的检查脚本不会安装。
5. 在 `$DSH_HOME/profiles/web/cordis.patch.yml` 添加覆盖项（换成你的 profile）。
   bundle 已插入一个插件，不要再次插入：

   ```yaml
   - id: evimed-memory-capsule
     config:
       baseUrl: 'https://your-evimed-deployment.example'
       apiKeyFile: '/absolute/path/evimed-key.txt'
   ```

   `baseUrl` 默认不设置；填写部署源地址，也接受加上 `/api/agent-memory/v1` 的地址。
   HTTP 只支持 localhost。每次请求重新读取文件，因此更换文件即可轮换密钥。
   拒绝其他配置字段及内联密钥；本候选插件通过 YAML 配置，没有配置表单。
6. 重启该 profile，或等待已启用的 HMR 重载。请智能体先调用 `capsule_status`，
   再用 `capsule_recall` 查询具体的既往工作。空结果也是有效结果。状态返回连通性、
   权限、项目限制以及“密钥创建账号”；公共 API 不返回账号姓名或 ID。

密钥在同一账户设置区撤销；重新创建并更换本机文件可恢复访问。撤销后无法恢复或重看。

## 能力与边界

- `capsule_recall`：查询记忆与胶囊事实，列出做法摘要及 API 提供的 `whenToUse`；
  不把做法正文放进回忆结果。可选 `projectId` 和 `limit` 沿用服务端权限。
- `capsule_propose`：向 `/note` 提交 `factKind`、`content` 和可选 `projectId`，
  一直待确认，由本人在网页记忆页确认后才生效；工具不确认、不激活记忆。
- `capsule_method`：重新请求当前回忆目录，按 `digest` 或精确 `name`（ID、标题或名称）
  返回一个做法正文。同名时要求 digest；同时提供两个选择条件时使用 digest。
- `capsule_status`：检查配置、服务连通性和密钥允许的范围。

现有公共 recall 会在有预算限制的目录内返回正文。插件在回忆结果中去掉正文，读取
一个做法时重新取当前目录，没有缓存旧正文，也没有虚构按摘要取正文的 HTTP 路由。
不在当前目录或预算内的做法暂时不可读。

工具与服务端 OpenAPI 一致。经本人授权的宿主可用 `capsule_conversations` 转交真实对话，
用 `capsule_work_events` 引用该对话中的人类反馈，用 `capsule_sharing` 分享或接收胶囊。
设置、确认、恢复等操作分别使用对应权限。集成密钥由宿主在配置里绑定 `subject`。
原文检索要显式传 `include: ["history"]` 并持有两项读取权限。

未配置时说明配置步骤并指向密钥页。断网、401、403、429、关闭或不可用的 503 都用
一句话说明，不显示服务端错误正文和堆栈。请求 15 秒超时，不跟随重定向，不自动重试
写入；卸载释放 Cordis 工具和提示词，并中止进行中的请求。不会记录密钥。

## 示例索引与检查

`market-index.example.json` 是 DSH format 1 的示例，**不是线上市场条目**；其中 npm
目标尚未发布，时间戳仅作示例。发布后由所有者决定是否托管自定义索引；按包名安装
无需索引。DSH 的实验性市场发现另需开启并配置索引，本包不替用户开启或托管。

```sh
node --test test/plugin.test.mjs
node scripts/check-index.mjs [absolute-path-to-dsh-install]
node scripts/check-bundle.mjs [absolute-path-to-dsh-install]
```

后两个脚本读取获准的 DSH 安装，用上游真实索引验证器及只读启动读取器验证索引、
导出的翻译、YAML 插入与配置覆盖、精确兼容范围，不安装、不发布、不启动 profile。
单元测试只使用本机假 HTTP 服务和临时测试密钥。
