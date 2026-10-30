import { useEffect, useState, type ComponentProps } from "react";
import { isAmbiguousMutationError } from "@/lib/mutationOutcome";
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
 *
 * The write settles the switch: `onChange` resolves once the server confirmed it, with the confirmed state when the answer carries
 * one (otherwise the state asked for), and the switch shows that until the page's own `checked` moves. Nothing is read back after a
 * confirmed write — the caller's own reload or the write's answer is already the authority, and a second read only doubled the
 * request and could contradict a success. `readChecked` is for the other case: a write whose outcome is unknown (the request
 * timed out, the connection dropped), where the switch locks and 「刷新核对状态」 reads the authoritative state to unlock it. A
 * caller reports a failure through the switch's own inline message by throwing; it does not also toast it.
 */
export function AsyncSwitch({ checked, onChange, readChecked, ...props }: Omit<ComponentProps<typeof Switch>, "onChange" | "reconciliationKey"> & {
  /** Resolves when the write is confirmed, optionally with the confirmed state; throws what went wrong. */
  onChange: (next: boolean) => Promise<boolean | void>;
  /** The authoritative state, read only to settle a write whose outcome is unknown. */
  readChecked: () => Promise<boolean>;
}) {
  const [confirmed, setConfirmed] = useState<boolean | null>(null);
  const [uncertain, setUncertain] = useState(false), [reading, setReading] = useState(false), [readError, setReadError] = useState<string | null>(null);
  const [readback, setReadback] = useState(0);
  useEffect(() => { setConfirmed(null); }, [checked]);
  return <>
    <Switch {...props} checked={confirmed ?? checked} reconciliationKey={readback} pending={props.pending || reading} onChange={async next => {
      try {
        const answered = await onChange(next);
        setConfirmed(typeof answered === "boolean" ? answered : next);
      } catch (error) {
        setUncertain(isAmbiguousMutationError(error));
        throw error;
      }
    }} />
    {uncertain && <Button variant="text" size="sm" loading={reading} onClick={() => {
      setReading(true); setReadError(null);
      void readChecked().then(actual => { setConfirmed(actual); setReadback(value => value + 1); setUncertain(false); }, error => setReadError(webErrorMessage(error, { fallback: "状态核对未完成，请稍后再刷新。" }))).finally(() => setReading(false));
    }}>刷新核对状态</Button>}
    {readError && <span role="alert" className="text-caption text-error">{readError}</span>}
  </>;
}
