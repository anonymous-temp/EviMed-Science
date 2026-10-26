import { useEffect, useState, type ComponentProps } from "react";
import { AmbiguousMutationError, isAmbiguousMutationError } from "@/lib/useMutationState";
import { webErrorMessage } from "@/lib/apiClient";
import { Button } from "./Button";
import { Switch } from "./Switch";

/**
 * Component: AsyncSwitch; owner: H; rules: DS21, DESIGN.md component adoption.
 * Anatomy: switch with explicit authoritative readback recovery.
 * Variants: shares Switch label variants.
 * States: pending, confirmed, rejected and unknown outcome.
 * Hit area: native switch and recovery button.
 * Keyboard: focus remains on pending switch; recovery is separately reachable.
 * Long content: labels wrap using shared controls.
 * Theme: inherited semantic tokens.
 * Responsive: inline controls wrap at caller boundary.
 * Verification: AsyncSwitch.test.tsx; actual persistence/transport and AT remain separate.
 */
export function AsyncSwitch({ checked, onChange, readChecked, ...props }: Omit<ComponentProps<typeof Switch>, "onChange" | "reconciliationKey"> & {
  onChange: (next: boolean) => Promise<unknown>;
  readChecked: () => Promise<boolean>;
}) {
  const [confirmed, setConfirmed] = useState<boolean | null>(null);
  const [uncertain, setUncertain] = useState(false), [reading, setReading] = useState(false), [readError, setReadError] = useState<string | null>(null);
  const [readback, setReadback] = useState(0);
  useEffect(() => { setConfirmed(null); }, [checked]);
  const read = async () => {
    const actual = await readChecked();
    setConfirmed(actual);
    return actual;
  };
  return <>
    <Switch {...props} checked={confirmed ?? checked} reconciliationKey={readback} pending={props.pending || reading} onChange={async next => {
      let written = false;
      try { await onChange(next); written = true; await read(); }
      catch (error) {
        setUncertain(written || isAmbiguousMutationError(error));
        if (written) throw new AmbiguousMutationError(webErrorMessage(error, { fallback: "写入后的状态暂时无法核对。" }));
        throw error;
      }
    }} />
    {uncertain && <Button variant="text" size="sm" loading={reading} onClick={() => {
      setReading(true); setReadError(null);
      void read().then(() => { setReadback(value => value + 1); setUncertain(false); }, error => setReadError(webErrorMessage(error, { fallback: "状态核对未完成，请稍后再刷新。" }))).finally(() => setReading(false));
    }}>刷新核对状态</Button>}
    {readError && <span role="alert" className="text-caption text-error">{readError}</span>}
  </>;
}
