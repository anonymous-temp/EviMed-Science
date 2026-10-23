import { useEffect, useRef, useState } from "react";
import { WebApiError, webErrorMessage } from "@/lib/apiClient";
import { getGeoDiagnosis, type GeoDiagnosis, type GeoErrorFilters, type GeoErrorRow } from "@/lib/geoClient";
import { type GeoReadScope } from "@/lib/geoReadScope";

/** Continuations must belong to one frozen observation selection, and duplicate pages remain idempotent. */
export function appendErrorPage(rows: GeoErrorRow[], page: GeoDiagnosis, reference: string | undefined): GeoErrorRow[] {
  if (reference && page.selection?.reference !== reference) throw new Error("测量范围已变化，请刷新清单。");
  return [...new Map([...rows, ...page.errors].map(row => [row.id, row])).values()];
}

export function useGeoErrorPages(geoId: string, diagnosis: GeoDiagnosis, filters: GeoErrorFilters, refresh: () => void) {
  const key = JSON.stringify([geoId, diagnosis.selection?.reference, filters]);
  const [value, setValue] = useState<{ key: string; data: GeoDiagnosis | null; loading: boolean; error: string | null; stale: boolean }>({ key, data: null, loading: true, error: null, stale: false });
  const epoch = useRef(0);
  const reference = diagnosis.selection?.reference;
  const fetchPage = (offset = 0) => {
    const mine = ++epoch.current;
    setValue(old => ({ ...old, key, loading: true, error: null, stale: false }));
    const scope: GeoReadScope = reference ? { selectionRef: reference } : { ...diagnosis.scope };
    void getGeoDiagnosis(geoId, scope, { ...filters, errorOffset: offset, errorLimit: 20 }).then(page => {
      const errors = appendErrorPage(offset ? value.data?.errors ?? [] : [], page, reference);
      if (mine === epoch.current) setValue({ key, data: { ...page, errors }, loading: false, error: null, stale: false });
    }).catch(error => {
      if (mine === epoch.current) setValue(old => ({ ...old, key, data: offset ? old.data : null, loading: false,
        error: webErrorMessage(error, { fallback: "无法读取讲错清单，请重试。" }), stale: error instanceof WebApiError && error.status === 409 }));
    });
  };
  useEffect(() => { fetchPage(); return () => { epoch.current += 1; }; }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = value.key === key ? value : { ...value, data: null, loading: true, error: null };
  return { ...shown, more: () => { if (!shown.loading && shown.data?.errorPage?.nextOffset != null) fetchPage(shown.data.errorPage.nextOffset); },
    retry: () => { if (value.stale) refresh(); else fetchPage(); } };
}
