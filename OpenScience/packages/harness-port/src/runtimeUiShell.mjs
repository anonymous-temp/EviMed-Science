/**
 * The hosted shell of the kernel's browser application: brand, the left
 * column, the document's identity, and the stylesheet for what no token or
 * slot reaches.
 *
 * The kernel's web client is a slot system: packages declare slots
 * (`sidebar.brand.mark`, `conversation.hero.brand.mark`, ...) and any plugin
 * may occupy one. Its own brand package fills them only in an `official`
 * build, and its README says a deployment with its own identity "composes a
 * different package into the same slots instead". This body is that package,
 * in the same shape as the official one.
 *
 * What it does, and why each is here rather than in our own page:
 *
 *  - The left column. `sidebar` is the whole navigation column, and the layout
 *    package's own contract says occupying it replaces that column rather than
 *    adding to it. The hosted product has one navigation, in the shell around
 *    this frame; the kernel's second one — brand, new session, workspace tree,
 *    session list — was the same information under different words beside it.
 *  - Brand. The EviMed mark occupies the sidebar mark, the sidebar name and
 *    the conversation hero; the kernel's fish and wordmark fall back only
 *    where nothing occupies the slot. The two sidebar brand seats are declared
 *    by the column this body replaces, so they are dead while the column is
 *    shadowed — kept because they are what the page falls back to if that
 *    registration ever does not take, and the kernel's own wordmark appearing
 *    there would be worse than dead code.
 *  - Surfaces the hosted deployment does not offer. The hero's workspace
 *    picker slot is occupied by nothing, because a project's workspace is
 *    bound by the control plane and `workspace/create` is refused for any
 *    other path. Hiding a control is presentation; the refusal lives in
 *    `@evimed/domain`'s runtime-UI surface and does not depend on this body.
 *
 * The language pack is its own body (`runtimeUiLocale.mjs`), so either can be
 * switched off without the other.
 *
 * @module @evimed/harness-port/runtime-ui-shell
 */

/** Services this body needs: the slot registry. */
export const inject = ['slots'];

/**
 * The kernel client version the stylesheet's selectors were read against.
 *
 * The rules below reach the frame's layout through CSS-module class suffixes
 * (`_sidebarCol`) and stable data attributes, none of which the kernel
 * promises. A test holds this pin to the kernel pin in `deps-version.json`, so
 * moving the kernel forces someone to re-read the layout before the rules ship
 * against markup they were not written for.
 */
export const GEOMETRY_KERNEL_PIN = '0.1.7-rc.2';

/**
 * The product's mark as a data URL, for the document's icon.
 *
 * Inline because this module is bundled into the frame's own page and has no
 * asset pipeline behind it; the same geometry as the shell's favicon and its
 * `EviMedMark` (the EviMed molecule, spec §3.2). The teal plus it replaced was
 * the retired 循证青 (audit F-G8).
 *
 * @returns {string}
 */
export function evimedFavicon() {
  // The EviMed molecule mark in brand-600 #0a5dc1 — the shell's favicon and
  // app icons (spec §3.2). Self-contained on purpose: a body may import
  // nothing, so the path is written here.
  return 'data:image/svg+xml,'
    + "%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E"
    + "%3Cpath fill='%230a5dc1' transform='translate(1 0)' d='M25.90815,23.256664C25.054619,23.182293,24.197218,23.349596,23.438427,23.738579C23.411322,23.752701,23.384216,23.766823,23.357563,23.782711C22.534473,24.199753,20.908171,24.509554,19.025724,23.62207C17.077774,22.703695,16.41641,21.627775,16.224869,20.586273C16.221706,20.570385,16.219446,20.554499,16.216736,20.53861C16.206797,20.443727,16.195503,20.349285,16.181952,20.255726C16.050491,18.479437,17.721972,17.884987,18.783587,18.297174C19.26556,18.528656,19.808887,18.609289,20.339489,18.528082C20.87009,18.446875,21.362139,18.207779,21.748552,17.843391C22.134966,17.479004,22.396936,17.007059,22.498745,16.491907C22.600554,15.976755,22.537243,15.443466,22.31745,14.964748C22.097656,14.486031,21.732075,14.085183,21.270552,13.81686C20.809029,13.548537,20.274021,13.425796,19.738478,13.465372C19.202934,13.504949,18.692919,13.704919,18.277967,14.038013C17.863016,14.371108,17.56332,14.821119,17.419748,15.32669C17.091778,16.50853,15.486706,17.312603,14.200571,16.100313C14.131454,16.024406,14.06098,15.950267,13.9887,15.877008C13.369802,15.147516,12.859324,13.470082,13.404137,11.80721C13.95437,10.121831,14.959513,8.8804121,16.148973,8.4426289C16.991545,8.111434,17.711275,7.538054,18.212875,6.7984047C18.714476,6.0587554,18.974283,5.1877217,18.957907,4.3006277C18.94153,3.4135337,18.64974,2.5522194,18.121164,1.8307204C17.592588,1.1092215,16.85216,0.56156796,15.997911,0.26026851C15.143663,-0.041030917,14.215886,-0.081765488,13.337415,0.14345792C12.458943,0.36868134,11.671212,0.84924006,11.078514,1.5215089C10.485816,2.1937778,10.116108,3.0260487,10.018336,3.9081309C9.9205647,4.7902131,10.099341,5.6805029,10.530998,6.4611273C11.366286,7.9823375,10.859874,10.071519,10.175922,11.258213C9.3008804,12.776775,6.8754287,13.396823,5.342186,13.970973C5.342186,13.970973,5.2274413,14.015104,5.2274413,14.015104C5.2274413,14.015104,5.2071123,14.023048,5.2071123,14.023048C5.1700687,14.03717,5.1330252,14.051734,5.0964332,14.06718C5.0964332,14.06718,5.0688767,14.078212,5.0688767,14.078212C4.0736976,14.468721,3.1680443,15.048843,2.404707,15.78476C1.6413695,16.520678,1.0356189,17.397669,0.62276512,18.364614C0.20991135,19.33156,-0.0017865563,20.369114,0.000011356496,21.416798C0.0018092693,22.464481,0.21706709,23.501335,0.63323724,24.466923C1.0494074,25.43251,1.6581641,26.307512,2.4240232,27.040926C3.1898823,27.77434,4.0975218,28.351494,5.0940356,28.738741C6.0905495,29.125988,7.1560016,29.315584,8.2282867,29.296478C9.3005714,29.277372,10.358237,29.049948,11.339633,28.627459C12.661005,28.145544,15.397712,25.910288,17.528622,26.402794C19.091681,26.764231,20.714371,27.658331,21.35631,29.253681C21.65369,29.976336,22.142946,30.608458,22.773657,31.084902C23.404367,31.561346,24.153719,31.864882,24.94449,31.964224C25.735262,32.063568,26.538847,31.955122,27.272434,31.650072C28.006021,31.345022,28.643074,30.854401,29.117945,30.228762C29.592815,29.603123,29.888323,28.865099,29.97402,28.090748C30.059717,27.316397,29.932505,26.53373,29.605484,25.823399C29.278463,25.113068,28.763468,24.500767,28.113571,24.049601C27.463675,23.598434,26.702383,23.324722,25.90815,23.256664ZM11.563702,21.652929C11.505032,22.307665,11.248938,22.930702,10.827804,23.443254C10.40667,23.955807,9.8394098,24.334856,9.1977577,24.532467C8.5561056,24.730078,7.8688779,24.737377,7.2229786,24.553442C6.5770793,24.369507,6.0015168,24.002598,5.5690742,23.499111C5.1366315,22.995625,4.8667302,22.378178,4.7935004,21.724842C4.7202706,21.071507,4.847002,20.411631,5.1576681,19.828657C5.4683342,19.245684,5.9489818,18.765795,6.5388322,18.449675C7.1286826,18.133554,7.8012424,17.995403,8.4714651,18.052689C9.3701944,18.129622,10.200845,18.552124,10.780732,19.227278C11.36062,19.902431,11.642257,20.774946,11.563702,21.652929Z'/%3E"
    + '%3C/svg%3E';
}

/** The same icon, for callers outside the frame. */
export const EVIMED_FAVICON = evimedFavicon();

/**
 * The stylesheet: layout the frame computes from its own store, and controls
 * this deployment does not offer. Presentation only; every rule is a hide or a
 * placement, and a renamed class upstream costs the rule, not the page.
 *
 * @param {string} pin the kernel version the selectors were read against
 * @param {boolean} [operator] whether the host exposes operator statistics
 * @returns {string}
 */
export function shellStylesheet(pin, operator = false) {
  return [
    `/* evimed-shell: selectors read against dsh-client ${pin} */`,
    // Accessible names in both shipped languages, from the kernel's own
    // dictionaries (`workspace.add`).
    'button[aria-label="Add workspace"],button[aria-label="添加工作区"]{display:none !important}',
    // An empty preview badge keeps its pill without this rule.
    '[class$="_previewBadge"]:empty{display:none !important}',
    // The hero's workspace chip. The kernel renders the button itself, outside
    // any slot; only the picker it opens lives in `conversation.hero.workspace`,
    // which this body occupies with nothing. Left alone the chip is a button
    // labelled with the container's directory name that opens nothing — a dead
    // control on the first screen. Hidden by its accessible name
    // (`hero.chooseWorkspace`), and as a button: the composer's own editable
    // carries the same label while it waits for a workspace, and must stay.
    //
    // The whole row used to be hidden instead, which also hid the row's second
    // seat, `conversation.hero.agentPreset` — and that is why an occupant there
    // once "registered nothing and rendered nothing".
    'button[aria-label="选择工作区"],button[aria-label="Choose workspace"]{display:none !important}',
    // The composer's access-mode chip (「项目工作区」). A hosted deployment has
    // exactly one permission preset, so the chip opened a picker with one row
    // in it — a control that chooses nothing, beside the one input box the
    // conversation page should be (2026-09-22). Hidden by its accessible name
    // (`permission.trigger`, 「访问模式，当前：…」) in both shipped languages;
    // the preset itself is enforced by the profile and the method ban, not by
    // this chip.
    'button[aria-label^="访问模式"],button[aria-label^="Access mode"]{display:none !important}',
    // The composer's paperclip is the kernel's own and stays: a file attached to
    // a message goes to the project's attachment store through the frame's
    // upload carrier (`__DSH_FILE_UPLOAD__`, runtimeUiTransport.mjs). It was
    // hidden here until 2026-09-22, when uploads were refused on this surface.

    // Operators retain native statistics by the owner's 2026-09-29 decision.
    // This changes presentation only; the proxy still owns session authorization.
    operator ? '' : '[data-composer-stats]{display:none !important}',
    // A finished turn's footer (`data-turn-tail`) keeps copy, branch and its
    // time. Its usage pill (「用量 860K tok」) and duration pill (「用时 …」,
    // with tok/s and TTFT behind it) are the footer's only dialog triggers,
    // each in a wrapper of its own.
    operator ? '' : '[data-turn-tail] span:has(> button[aria-haspopup="dialog"]){display:none !important}',
    // A tool row that renders nothing — the delivery gate's own calls, which
    // the 运行 view still lists — leaves its call row holding one empty
    // outlet; the flow item goes too, so the transcript keeps no gap for it.
    // Every outlet the renderer draws is a `display:contents` anchor
    // (`div[data-slot]`), which is why the path names two of them; all of it is
    // data attributes the chat and the tool tree document.
    '[data-chat-flow-kind="tool-call"]:has(> [data-slot="conversation.chat.node"] > [data-chat-call-id] > [data-slot="tool.call.toolview"]:only-child:empty){display:none !important}',

    // The left column, which `sidebar` occupies with nothing.
    //
    // Occupying the slot replaces the column's CONTENT; the frame still sizes
    // the column from its own store, so on its own that leaves 280 px of empty
    // gutter between the product's navigation and the conversation (measured
    // on the deployed build, 2026-09-15).
    //
    // Removing the column from flow shifts the remaining items up a track —
    // the conversation landed in the 280 px sidebar track and the right column
    // took the 1fr one, also measured — so each is pinned to the track it
    // belongs in and the conversation spans the two on the left.
    //
    // The two resize handles carry one class and are told apart by position:
    // the frame's children are the three columns, the overlay layer, then the
    // handles, so the sidebar's handle is the one directly after the overlay
    // layer and the right panel's is the one after that. With the panel closed
    // there is only ONE handle in the DOM, and an nth-of-type rule would have
    // hidden the overlay layer instead.
    '[class$="_sidebarCol"]{display:none !important}',
    '[class$="_centerCol"]{grid-column:1 / 3 !important}',
    '[class$="_rightbarCol"]{grid-column:3 !important}',
    '[class$="_overlayLayer"] + [class$="_handle"]{display:none !important}',
    // The conversation never scrolls sideways.
    //
    // Measured at 1440 px with the right panel opening (2026-09-18 walk,
    // screenshot 14): everything inside the conversation's scroll body —
    // messages and composer alike — shifted about 224 px left and was cut at
    // the frame's edge, while the header above it stayed put. That is a
    // horizontal scroll offset on the scroll body, which exists only while
    // something inside overflows it sideways: the transcript's own column is
    // `width:100%` under a max width, but a wide block's bleed is computed
    // from a container width that lags a squeeze reflow by a frame. Clipping
    // at the transcript's own padding box keeps every intended bleed (it is
    // bounded by that box by construction) and removes the offset's cause;
    // the scroll body itself is held to vertical scrolling. `clip` and not
    // `hidden` on the transcript, because `clip` creates no scroll container
    // and so leaves the sticky turn rail and "to bottom" button attached to the
    // real one.
    '[data-conversation-scroll]{overflow-x:hidden !important}',
    '[class$="_scroll"]:has(> [data-chat-flow]){overflow-x:clip !important}',
    // The conversation's reading width is the kernel's own formula and nothing
    // else. The kernel lets a reader widen it by dragging two invisible
    // handles beside the composer (`--dsh-chat-user-width`, kept in local
    // storage), and on 2026-09-22 the owner's composer spanned a 2520 px
    // screen edge to edge (「首页进去的输入框那么宽」) — a drag nobody meant.
    // Pinned on the element that defines the variable, found by the data
    // attribute the kernel puts there (`data-conversation-content`), not by a
    // CSS-module hash. The hash was how this rule was written until 0.1.7, and
    // it failed silently there: the class `wSkVaW_root` survived, but the
    // variable moved to its child (`_body`), so the pin set a value every
    // descendant was already shadowing. The embedded conversation body carries
    // the same attribute with its own narrower formula, and keeps it.
    '[data-conversation-content]:not([class*="_embeddedBody"]){--dsh-chat-content-width:clamp(680px,calc(var(--dsh-conversation-column-width,0px) * .64),920px) !important}',
  ].join('\n');
}

/**
 * @param {any} ctx Native Cordis client context.
 * @param {any} [_config]
 * @param {any} target Browser global, injectable by the contract suite.
 * @param {(id: string) => any} [_require] The loader's module resolver (React arrives through the kit).
 * @param {any} [kit] The frame kit (`runtimeUiKit.mjs`).
 */
export function apply(ctx, _config, target = globalThis, _require = undefined, kit = undefined) {
  // `__EVIMED_FRAME__` is the control plane's own bootstrap object, so its
  // presence — not the window's position — is what says this page is ours.
  // The guard used to also require `target.parent !== target`, which meant
  // that opening the frame's address in a tab got the kernel unbranded (its
  // whale mark, its `DeepSeek Harness` title, the swimming fish on an empty
  // conversation; 2026-09-16 review, §4.1 item 8). One condition, one
  // uncovered path.
  if (!kit || !kit.ours) return;
  const h = kit.h;

  if (h) {
    /** @param {{size?: number, className?: string}} props */
    const Mark = ({ size, className }) => {
      const px = Number(size) > 0 ? Number(size) : 24;
      // The brand's accent, through the frame's own token so the mark follows
      // the theme layer (and its lighter dark-scheme step) like every other
      // accent on the page. Not the deepseek ramp: under direction A its 500
      // step is the working line's muted grey. As style and not as a
      // presentation attribute: an SVG attribute is not a place `var()`
      // resolves.
      const color = 'var(--dsw-alias-state-business-primary, #00756b)';
      return h('svg', { xmlns: 'http://www.w3.org/2000/svg', viewBox: '0 0 48 48', width: px, height: px,
        role: 'img', 'aria-label': 'EviMed', className: className || undefined },
      h('g', { style: { fill: 'none', stroke: color }, strokeLinecap: 'round', strokeLinejoin: 'round', strokeWidth: 3.5 },
        h('path', { d: 'M18 27 9.5 18.5M18 27 29.5 12.5M18 27l16 7' })),
      h('g', { style: { fill: color } },
        h('circle', { cx: 9, cy: 18, r: 5 }), h('circle', { cx: 18, cy: 27, r: 5.5 }),
        h('circle', { cx: 30, cy: 12, r: 5 }), h('circle', { cx: 35, cy: 34, r: 5 })));
    };
    const Name = () => h('span', { style: { fontWeight: 600 } }, 'EviMed');
    const Nothing = () => null;

    // A single slot renders its LOWEST-priority registration and refuses a
    // second one at the same priority. The kernel's own occupants register at
    // the default 0 — the workspace picker always, the official brand in an
    // official build — so ours sit below them and shadow rather than collide.
    // Registered at 0, the picker slot threw "already has a registration", and
    // that one throw failed the whole loader entry, bridge included: the frame
    // never bound its session (2026-09-09, first release of this file).
    const below = -1;
    kit.guarded('sidebar brand', () => {
      kit.occupy({ slot: 'sidebar.brand.mark', priority: below }, Mark);
      kit.occupy({ slot: 'sidebar.brand.name', priority: below }, Name);
    });
    kit.guarded('hero brand', () => kit.occupy({ slot: 'conversation.hero.brand.mark', priority: below }, Mark));
    // The left column, removed: occupying `sidebar` replaces the column's
    // content, and the stylesheet removes its width. The frame's own room
    // arithmetic still counts the column, though — expanded it is 280 px of
    // the width the right column is weighed against, and with it counted the
    // right column refuses to open below a 980 px frame and sits narrower
    // above. So the column is also told it is collapsed (a 56 px rail in that
    // arithmetic) whenever it says it is not: `ctx.layout.toggleSidebar()` is
    // the layout's own public switch, and the owner props say which way it
    // stands, so this never toggles it open.
    /** @type {any} */
    let layout = null;
    kit.withServices(['layout'], (/** @type {any} */ scope) => { layout = scope.layout; });
    /** @param {{ collapsed?: boolean }} props */
    const LeftColumn = ({ collapsed }) => {
      kit.react.useEffect(() => {
        if (collapsed !== false || !layout || typeof layout.toggleSidebar !== 'function') return;
        try { layout.toggleSidebar(); } catch { /* the column keeps its width; only the room arithmetic suffers */ }
      }, [collapsed]);
      return null;
    };
    kit.guarded('sidebar column', () => kit.occupy({ slot: 'sidebar', priority: below }, kit.react ? LeftColumn : Nothing));
    // The picker is a popup the chip opens; an occupant that renders nothing
    // removes the choice (the chip itself is hidden by the stylesheet).
    kit.guarded('workspace picker', () => kit.occupy({ slot: 'conversation.hero.workspace', priority: below }, Nothing));
    // The draft's attachment strip (`conversation.input.attachments`) is the
    // kernel's own again: it was occupied by nothing here while uploads were
    // refused, and with them allowed it hid every attached file — the upload
    // landed and the composer showed nothing, nor sent (2026-09-22).
  }

  const doc = target.document;
  if (doc && typeof doc.createElement === 'function' && doc.head) {
    // The document's own name and icon.
    //
    // Invisible inside an iframe — the shell's frame carries its own accessible
    // name — and the whole page when the address is opened directly, where the
    // tab read `DeepSeek Harness` under a whale favicon. The kernel's packages
    // are MIT and its brand package documents exactly this substitution;
    // DeepSeek's platform terms §5.2 forbid using their marks without
    // permission and impose no attribution duty, so carrying their mark is the
    // wrong default rather than the polite one.
    try {
      doc.title = 'EviMed 研究会话';
      const icon = doc.querySelector('link[rel~="icon"]') ?? doc.createElement('link');
      icon.setAttribute('rel', 'icon');
      icon.setAttribute('type', 'image/svg+xml');
      icon.setAttribute('href', evimedFavicon());
      if (!icon.parentNode) doc.head.appendChild(icon);
    } catch { /* a document that refuses either is still a working conversation */ }

    const style = doc.createElement('style');
    style.setAttribute('data-evimed-shell', '');
    style.setAttribute('data-evimed-kernel', String(kit.vocabulary?.kernelPin ?? ''));
    style.textContent = shellStylesheet(String(kit.vocabulary?.kernelPin ?? ''), target.__EVIMED_FRAME__?.operator === true);
    doc.head.appendChild(style);
    ctx.effect(() => () => { style.remove(); }, 'evimed-shell: stylesheet');
  }
}

/** The body as the socket's build composes it: its helpers, then `apply`. */
export const BODY = Object.freeze({ name: 'shell', inject, parts: Object.freeze([evimedFavicon, shellStylesheet, apply]) });
