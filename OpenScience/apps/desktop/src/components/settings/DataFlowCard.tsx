import { HardDrive, Send } from "lucide-react";

/**
 * Plain-language disclosure of what stays local vs. what is sent to the model
 * provider (P0-2 / P2-3). Every statement here must stay true to the actual
 * architecture — when behavior changes, change this copy in the same commit.
 */
export function DataFlowCard({
  model,
  workspace,
  hosted = false,
}: {
  model: string | null;
  workspace: string | null;
  hosted?: boolean;
}) {
  return (
    <section className="mt-5 rounded-card border border-border bg-surface shadow-card">
      <header className="border-b border-border px-5 py-3">
        <h2 className="font-serif text-body text-text">隐私与数据流向</h2>
        <p className="mt-0.5 text-xs text-muted">
          {hosted ? "托管工作区的存储与模型提供方流量。" : "哪些数据留在本机，以及究竟哪些会离开本机。"}
        </p>
      </header>
      <div className="grid gap-5 px-5 py-4 sm:grid-cols-2">
        <div>
          <div className="flex items-center gap-1.5 text-ui font-medium text-text">
            <HardDrive size={14} className="text-ok" /> {hosted ? "存储在托管工作区" : "留在本机"}
          </div>
          <ul className="mt-2 list-disc space-y-1.5 pl-4 text-ui leading-relaxed text-muted">
            <li>
              你的工作区文件与原始数据
              {workspace && <span className="font-mono text-xs"> ({workspace})</span>}。
            </li>
            <li>
              {hosted
                ? "代码执行仅在服务端内核沙箱启用时运行。"
                : "代码执行 — Python 内核与 Jupyter 均在本地运行；数据集在本机处理，绝不批量上传。"}
            </li>
            <li>
              {hosted
                ? "会话元数据、溯源记录、审计日志与任务事件都存储在所选托管项目下。"
                : "会话历史与溯源记录保存在应用私有数据目录中。"}
            </li>
            <li>
              {hosted
                ? "模型提供方密钥只保存在服务端密钥边界内，浏览器、工作区、日志与导出内容都不会收到它。"
                : "提供方密钥与登录令牌 — 保存在只有你的账号可读的应用私有文件中；绝不写入工作区、溯源记录、日志或导出内容。"}
            </li>
          </ul>
        </div>
        <div>
          <div className="flex items-center gap-1.5 text-ui font-medium text-text">
            <Send size={14} className="text-warn" /> 发送给你的模型提供方
            <span className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-muted">
              {model ?? "未配置模型"}
            </span>
          </div>
          <ul className="mt-2 list-disc space-y-1.5 pl-4 text-ui leading-relaxed text-muted">
            <li>你的消息，以及智能体为完成你交代的任务而读取的文件内容 / 命令输出。</li>
            <li>
              {hosted
                ? "仅在你发起科研回合时，经服务端模型网关发送；不会由浏览器直连模型提供方。"
                : "不会在后台发送任何数据 — 数据只在对话回合中离开本机。"}
            </li>
            <li>提供方保留哪些数据由其自身数据政策决定。</li>
          </ul>
          <p className="mt-2 text-xs text-muted">
            {hosted
              ? "托管 Skills 与 MCP 由平台审核和统一部署；科学连接器只能通过服务端固定来源网关访问外部数据。"
              : "你添加的技能与 MCP 服务器可能自行发起网络请求 — 安装前请先审查。"}
          </p>
        </div>
      </div>
    </section>
  );
}
