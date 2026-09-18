import { useEffect, useState } from "react";
import { fetchWebMe } from "@/lib/apiClient";

/**
 * Whether this account is one the deployment offers its operator surfaces to.
 *
 * Presentation only, like every other reader of `me.operator`: the server
 * decides from an id allowlist and each operator route authorizes itself, so
 * a browser that flips this gains a disclosure, not access. What it gates on
 * the researcher's pages is raw engine text — a gate sentence in English, a
 * run id — which is support material, not something a researcher should have
 * to read past to find their result (DESIGN_GUIDELINES §6: internal
 * identifiers stay off screen).
 *
 * False until `/api/me` answers, and false when it cannot: an unknown answer
 * shows the researcher's view, never the operator's.
 */
export function useOperator(): boolean {
  const [operator, setOperator] = useState(false);
  useEffect(() => {
    let active = true;
    fetchWebMe()
      .then((me) => { if (active) setOperator(me?.operator === true); })
      .catch(() => { /* the researcher's view is the safe default */ });
    return () => { active = false; };
  }, []);
  return operator;
}
