import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { ArrowLeft, Receipt, Wallet } from "lucide-react";
import { SIMULATED_TOPUP_PACKAGES, SIMULATED_WALLET_PAGES } from "@evimed/domain";
import {
  fetchWebSimulatedOrders, topUpWebSimulatedWallet, webErrorMessage,
  type WebResearchAllowance, type WebSimulatedOrders, type WebSimulatedTopUp,
} from "@/lib/apiClient";
import { formatDateTime } from "@/lib/format";
import { useResearchBilling } from "@/lib/useResearchBilling";
import { EmptyState } from "@/components/cards/EmptyState";
import { LoadError } from "@/components/cards/LoadError";
import { RunsSkeleton } from "@/components/cards/Skeletons";
import { PageShell } from "@/components/layout/PageShell";
import { AllowanceAmount, SimulatedDataLine, SimulatedMark, allowanceText } from "@/components/settings/SimulatedAllowance";
import { Button, buttonClasses } from "@/components/ui/Button";
import { List, ListRow } from "@/components/ui/ListRow";
import { Panel, PanelRow } from "@/components/ui/Panel";
import { NotFound } from "./NotFound";

type WalletPageName = keyof typeof SIMULATED_WALLET_PAGES;

/** What each page is called. Which pages there are, and where, is the domain's (`SIMULATED_WALLET_PAGES`). */
const TITLES: Record<WalletPageName, string> = {
  recharge: "模拟充值",
  orders: "模拟订单",
};

/** The allowance section of 设置: where these pages are reached from, and where they lead back. */
const ALLOWANCE_PATH = "/app/account?tab=usage";

/** Which page an address names: the one whose path, as the domain writes it, ends in that segment. */
function walletPageNamed(segment: string | undefined): WalletPageName | null {
  const names = Object.keys(SIMULATED_WALLET_PAGES) as WalletPageName[];
  return names.find((name) => SIMULATED_WALLET_PAGES[name].split("/").pop() === segment) ?? null;
}

/**
 * The simulated wallet's commerce pages (2026-10-04): 模拟充值 and 模拟订单, at
 * `/app/account/simulated/:page`.
 *
 * A deployment may bill research from a simulated wallet, so its owner can look
 * at the allowance experience before a real wallet exists. The commerce
 * destinations of such a deployment are these pages of the platform itself
 * rather than anyone's checkout: a top-up here adds simulated credits and the
 * orders page lists them. No page moves money, so each opens with the line that
 * says so, and every amount carries the mark. There were four pages until
 * 2026-10-07; 模拟会员 and 模拟退款 were a sentence saying they were a
 * demonstration, with no plan to open and no money to return, and went (their
 * addresses answer 404).
 *
 * A deployment whose wallet is not simulated has none of this: an address that
 * reaches here says so in one sentence, with the way back to 设置, and offers no
 * top-up. Until the deployment has answered there is a skeleton, and when it
 * cannot be read, the error with its retry.
 */
export function SimulatedWalletPage() {
  const page = walletPageNamed(useParams().page);
  // Keyed: each page is opened for itself, with its own read of the allowance
  // and nothing left over from the page before it.
  return page ? <WalletPage key={page} page={page} /> : <NotFound />;
}

function WalletPage({ page }: { page: WalletPageName }) {
  // The recharge page draws the balance, which moves, so it reads again on
  // opening; the others need only the deployment's answer.
  const { simulated, allowance, loading, error, reload } = useResearchBilling({ fresh: page === "recharge" });
  // The newest top-up made on this visit. Its answer carries the balance, so
  // from then on the page stands on it rather than on the read that follows.
  const [toppedUp, setToppedUp] = useState<WebSimulatedTopUp | null>(null);
  const title = TITLES[page];

  if (!toppedUp) {
    if (error) return <PageShell title={title}><LoadError message={error} onRetry={reload} /></PageShell>;
    if (!allowance || loading) return <PageShell title={title}><RunsSkeleton filter={false} /></PageShell>;
    if (!simulated) {
      return (
        <PageShell title={title}>
          <EmptyState
            icon={Wallet}
            title="这个部署没有开启模拟额度"
            action={<Link to={ALLOWANCE_PATH} className={buttonClasses({ variant: "secondary" })}>返回设置</Link>}
          />
        </PageShell>
      );
    }
  }

  return (
    <PageShell
      title={title}
      actions={(
        <Link to={ALLOWANCE_PATH} className={buttonClasses({ variant: "text" })}>
          <ArrowLeft size={16} aria-hidden="true" />返回科研额度
        </Link>
      )}
    >
      <div className="space-y-6">
        <SimulatedDataLine />
        {page === "recharge" && (
          <Recharge
            allowance={allowance}
            toppedUp={toppedUp}
            onToppedUp={(result) => {
              setToppedUp(result);
              // The balance moved: every surface that holds the allowance follows the read this starts.
              reload();
            }}
          />
        )}
        {page === "orders" && <Orders />}
      </div>
    </PageShell>
  );
}

/**
 * 模拟充值: the balance, and one button per package of the domain's closed list.
 *
 * A top-up is identified by a request id, and the control plane applies an id
 * once. So an id is made when a package is first pressed and kept until that
 * top-up is seen applied: 「重试」 after a failure, or pressing the same package
 * again, sends the same id, and a request whose answer was lost on the way back
 * cannot be applied a second time. Only an applied top-up frees the package for
 * a new id — the next press of it is a new top-up the reader asked for. While a
 * request is on its way no package can be pressed.
 */
function Recharge({ allowance, toppedUp, onToppedUp }: {
  allowance: WebResearchAllowance | null;
  toppedUp: WebSimulatedTopUp | null;
  onToppedUp: (result: WebSimulatedTopUp) => void;
}) {
  const identities = useRef(new Map<string, string>());
  const inFlight = useRef(false);
  const [pending, setPending] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ packageId: string; message: string } | null>(null);

  const topUp = (packageId: string) => {
    // A second click lands before the first render can disable the button.
    if (inFlight.current) return;
    inFlight.current = true;
    const requestId = identities.current.get(packageId) ?? crypto.randomUUID();
    identities.current.set(packageId, requestId);
    setFailure(null);
    setPending(packageId);
    topUpWebSimulatedWallet(packageId, requestId).then((result) => {
      identities.current.delete(packageId);
      onToppedUp(result);
    }, (caught: unknown) => {
      setFailure({ packageId, message: webErrorMessage(caught, { fallback: "模拟充值没有完成，请重试。" }) });
    }).finally(() => {
      inFlight.current = false;
      setPending(null);
    });
  };

  // A balance that could not be read is said so, never drawn as zero.
  const available = toppedUp ? toppedUp.available : allowance?.status === "ready" ? allowance.available : null;
  return (
    <>
      {toppedUp && (
        <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-2 text-ui text-text">
          <SimulatedMark />
          <span>{toppedUp.duplicate ? "这笔模拟充值此前已经入账，没有重复入账。" : `模拟充值 ${allowanceText(toppedUp.order.amount, "nearest")}已入账。`}</span>
          <Link to={SIMULATED_WALLET_PAGES.orders} className={buttonClasses({ variant: "secondary", size: "sm" })}>查看模拟订单</Link>
        </div>
      )}
      <Panel title="科研额度">
        {available === null
          ? <PanelRow label="科研额度暂不可用" />
          : <PanelRow label="可用科研额度" control={<AllowanceAmount value={available} simulated className="text-title font-semibold" />} />}
      </Panel>
      <section aria-labelledby="simulated-topup-packages">
        <div className="mb-2 flex items-center gap-2">
          <h2 id="simulated-topup-packages" className="text-ui font-semibold text-text">充值额度</h2>
          <SimulatedMark />
        </div>
        <div className="flex flex-wrap gap-2">
          {SIMULATED_TOPUP_PACKAGES.map((item) => (
            <Button key={item.id} variant="secondary" loading={pending === item.id} disabled={pending !== null} onClick={() => topUp(item.id)}>
              {item.credits} 灵豆
            </Button>
          ))}
        </div>
        {/* Both halves are true: a pressed amount is booked at once, and a purchased lot never expires (gifts do). */}
        <p className="mt-2 text-caption text-text-3">点选金额后，模拟额度立即入账；充值额度不会过期。</p>
      </section>
      {failure && <LoadError message={failure.message} onRetry={() => topUp(failure.packageId)} />}
    </>
  );
}

/** When an order was made, to the minute; nothing for a value that is not a time. */
function orderTime(value: string): string | undefined {
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? undefined : formatDateTime(at, { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/**
 * 模拟订单: the simulated top-ups, newest first, a page at a time — the statement
 * list's shape, down to the one column width that lines the marks up.
 */
function Orders() {
  const [page, setPage] = useState<WebSimulatedOrders | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback((cursor?: string) => {
    setError(null);
    setLoading(true);
    fetchWebSimulatedOrders(cursor).then((next) => {
      setPage((previous) => ({ ...next, items: cursor && previous ? [...previous.items, ...next.items.filter((item) => !previous.items.some((old) => old.id === item.id))] : next.items }));
    }, (caught: unknown) => setError(webErrorMessage(caught))).finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);
  return (
    <div>
      {page === null && !error ? <RunsSkeleton filter={false} />
        : page?.items.length === 0 ? (
          <EmptyState
            icon={Receipt}
            title="还没有模拟充值订单"
            action={<Link to={SIMULATED_WALLET_PAGES.recharge} className={buttonClasses({ variant: "secondary" })}>去模拟充值</Link>}
          />
        ) : page && (
          <List label="模拟充值订单" divided>
            {page.items.map((order) => (
              <ListRow
                key={order.id}
                title={order.title || "模拟充值"}
                meta={orderTime(order.at)}
                trailing={(
                  <>
                    <SimulatedMark />
                    <div className="min-w-20 text-right text-ui">
                      <span className="block text-text-2">已入账</span>
                      <span className="tabular-nums">{allowanceText(order.amount, "nearest") || "暂不可用"}</span>
                    </div>
                  </>
                )}
              />
            ))}
          </List>
        )}
      {error && <LoadError message={error} onRetry={() => load(page?.nextCursor ?? undefined)} />}
      {page?.nextCursor && !error && <div className="mt-3"><Button variant="secondary" loading={loading} onClick={() => load(page.nextCursor ?? undefined)}>加载更多</Button></div>}
    </div>
  );
}
