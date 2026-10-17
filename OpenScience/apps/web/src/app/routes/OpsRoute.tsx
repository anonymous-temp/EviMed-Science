import { useCallback, useEffect, useState } from "react";
import { Navigate } from "react-router";
import { LoadError } from "@/components/cards/LoadError";
import { FilesSkeleton } from "@/components/cards/Skeletons";
import { PageShell } from "@/components/layout/PageShell";
import { fetchWebMe } from "@/lib/apiClient";
import { OpsPage } from "./OpsPage";

/**
 * 「运维」, the deployment's console, on a page of its own (`/app/ops`; R19, audit D C4/C7).
 *
 * It was the seventh section of 设置, offered to an operator in a column that is otherwise about the reader's own account — the
 * runtime's state, the configuration check and the ledgers beside 外观 and 通知. The component is the same (`OpsPage`); what moved is
 * where it is: the settings column holds the six settings, and the old `?tab=ops` address lands here.
 *
 * Presentation only. An account that is not an operator is sent to 设置, and every route the cards call keeps its own authorization,
 * so typing the address as anyone else shows the refusals it always did.
 */
export function OpsRoute() {
  const [state, setState] = useState<"loading" | "operator" | "other" | { error: string }>("loading");
  const read = useCallback(() => {
    setState("loading");
    let live = true;
    void fetchWebMe().then(
      (me) => { if (live) setState(me?.operator === true ? "operator" : "other"); },
      () => { if (live) setState({ error: "暂时读不到账户信息，请稍后重试。" }); },
    );
    return () => { live = false; };
  }, []);
  useEffect(() => read(), [read]);

  if (state === "other") return <Navigate to="/app/account" replace />;
  return (
    <PageShell title="运维">
      {state === "loading" ? <FilesSkeleton />
        : state === "operator" ? <OpsPage />
          : <LoadError message={state.error} onRetry={() => { read(); }} />}
    </PageShell>
  );
}
