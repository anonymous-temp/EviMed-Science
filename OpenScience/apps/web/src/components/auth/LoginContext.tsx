/** A quiet illustration of the work the platform already supports, never a simulated account or result. */
export function LoginContext() {
  return <div className="auth-context">
    <h2 className="text-heading font-semibold text-text">从一个问题，<br />到一份成果。</h2>
    <svg className="auth-work-illustration" viewBox="0 0 360 252" role="img" aria-label="资料检索、数据分析与文稿写作的工作示意">
      <g fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path className="auth-sketch-link" d="M96 84V46h86M278 96h50v100h-40M68 182v44h130" />
        <circle className="auth-sketch-node" cx="96" cy="46" r="4" />
        <circle className="auth-sketch-node" cx="328" cy="140" r="4" />
        <circle className="auth-sketch-node" cx="130" cy="226" r="4" />
        <rect className="auth-sketch-paper" x="20" y="86" width="118" height="112" rx="8" />
        <path className="auth-sketch-rule" d="M40 111h40m-40 18h77m-77 14h77m-77 14h52" />
        <circle className="auth-sketch-accent" cx="105" cy="169" r="15" />
        <path className="auth-sketch-accent" d="m116 180 12 12" />
        <rect className="auth-sketch-paper" x="152" y="24" width="140" height="102" rx="8" />
        <path className="auth-sketch-rule" d="M173 46h40m-40 58h99m-99-8V62" />
        <path className="auth-sketch-accent" d="m181 88 21-17 20 8 20-24 21 10" />
        <circle className="auth-sketch-point" cx="202" cy="71" r="3" />
        <circle className="auth-sketch-point" cx="242" cy="55" r="3" />
        <path className="auth-sketch-paper" d="M192 146h88l32 32v60a8 8 0 0 1-8 8H192a8 8 0 0 1-8-8v-84a8 8 0 0 1 8-8Z" />
        <path className="auth-sketch-rule" d="M280 146v24a8 8 0 0 0 8 8h24m-108 12h54m-54 15h86m-86 15h72" />
        <path className="auth-sketch-accent" d="M204 168h32" />
      </g>
    </svg>
    <div className="auth-context-labels text-ui text-text-2">
      <span>证据检索</span><span>数据分析</span><span>文稿写作</span>
    </div>
  </div>;
}
