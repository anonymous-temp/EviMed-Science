import { useEffect, useState } from "react";
import { fetchEvidenceFeatures, type EvidenceFeatures } from "@/lib/evidenceUpkeepClient";

/** Which of the evidence zones' optional features this deployment has switched on; none until the server says so. */
export function useEvidenceFeatures(): EvidenceFeatures {
  const [features, setFeatures] = useState<EvidenceFeatures>({ publicPages: false, upkeep: false });
  useEffect(() => {
    let active = true;
    void fetchEvidenceFeatures().then((value) => {
      if (active) setFeatures(value);
    });
    return () => {
      active = false;
    };
  }, []);
  return features;
}
