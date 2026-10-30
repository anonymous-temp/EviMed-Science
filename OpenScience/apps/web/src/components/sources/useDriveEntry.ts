import { useEffect, useState } from "react";
import { getOpenListStatus } from "@/lib/sourceClient";

/**
 * Whether 「从网盘导入」 is worth putting in the 「添加」 menu, from the drive's own status for this account. A drive that is there
 * (`ready`) is offered; so is one that cannot be reached at this moment (`unavailable`), because the panel says so and has a retry
 * and the upload beside it. A deployment with no drive, a drive with no storage mounted and an account the drive does not admit
 * have nothing to open, and a menu entry that always ends in 「请联系管理员」 is a dead end, so it is not shown. While the status is
 * still being asked the entry is not shown either.
 */
export function useDriveEntry(): boolean {
  const [state, setState] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void getOpenListStatus().then(
      (result) => { if (active) setState(result.state); },
      () => { if (active) setState("unavailable"); },
    );
    return () => { active = false; };
  }, []);
  return state === "ready" || state === "unavailable";
}
