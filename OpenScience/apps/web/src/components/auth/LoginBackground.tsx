/** Quiet document connections frame sign-in without becoming part of the form. */
export function LoginBackground() {
  return <div className="auth-background" aria-hidden="true">
    {(["top", "bottom"] as const).map(corner => <svg key={corner}
      className={`auth-background-corner auth-background-corner--${corner}`}
      viewBox="0 0 460 320" fill="none" focusable="false">
      <g stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round">
        <path d="M32 244h112a28 28 0 0 0 28-28V104a28 28 0 0 1 28-28h42M112 314V192a24 24 0 0 1 24-24h192a24 24 0 0 0 24-24v-24" />
        <rect x="242" y="28" width="132" height="92" rx="12" />
        <path d="M264 52h56m-56 20h88m-88 20h70" />
        <circle cx="32" cy="244" r="4" />
        <circle cx="112" cy="314" r="4" />
        <circle cx="172" cy="144" r="4" />
      </g>
    </svg>)}
  </div>;
}
