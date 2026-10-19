import { useEffect, useId, useRef, useState } from "react";
import { addSourceLink, listSources, type SourceRecord } from "@/lib/sourceClient";
import { pickFiles, uploadFilesToWorkspace } from "@/lib/backend";
import { productRequest } from "@/lib/productClient";
import { webErrorMessage } from "@/lib/apiClient";
import { Button } from "@/components/ui/Button";
import { Input, inputClasses } from "@/components/ui/Input";

export interface LiteratureSelection {
  literatureSource: { sourceId: string; generation: number; textSha256: string | null };
  parameterBindings: Array<{ field: string; candidateId: string }>;
  executionProfile?: string;
  title: string;
}
interface SourcePreview {
  sourceId: string; generation: number; textSha256: string | null; title: string; status: string;
  parameters: Array<{ id: string; value: number; unit: string; quote: string; start: number; end: number }>;
  missing: string[];
  supportedProfiles: Array<{ method: string; label: string; fields: Array<{ key: string; label: string; unit: string; required: boolean }> }>;
}

export function VcrLiteratureSource({ studyId, projectId, onChange }: { studyId: string; projectId: string; onChange: (value: LiteratureSelection | null) => void }) {
  const [sources, setSources] = useState<SourceRecord[]>([]);
  const [sourceId, setSourceId] = useState("");
  const [link, setLink] = useState("");
  const [preview, setPreview] = useState<SourcePreview | null>(null);
  const [profile, setProfile] = useState("");
  const [parameterQuery, setParameterQuery] = useState("");
  const [bindings, setBindings] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const selectionId = useId();
  const profileId = useId();
  const request = useRef(0);
  const change = useRef(onChange);
  change.current = onChange;
  const refresh = async () => { const result = await listSources(projectId); setSources(result.items); setLoaded(true); };
  useEffect(() => {
    let active = true;
    setSources([]); setSourceId(""); setPreview(null); setProfile(""); setBindings({}); setError(""); setLoaded(false); setBusy(false);
    change.current(null); request.current += 1;
    void listSources(projectId).then(result => { if (active) { setSources(result.items); setLoaded(true); } }).catch(cause => { if (active) setError(webErrorMessage(cause, { fallback: "文献列表暂时无法读取。" })); });
    return () => { active = false; request.current += 1; };
  }, [projectId, studyId]);
  useEffect(() => {
    if (!preview) { change.current(null); return; }
    change.current({ literatureSource: { sourceId: preview.sourceId, generation: preview.generation, textSha256: preview.textSha256 }, title: preview.title,
      parameterBindings: Object.entries(bindings).filter(([, candidateId]) => candidateId).map(([field, candidateId]) => ({ field, candidateId })), ...(profile ? { executionProfile: profile } : {}) });
  }, [preview, profile, bindings]);
  const load = async () => {
    const token = ++request.current;
    setBusy(true); setError(""); setPreview(null); setBindings({}); setProfile(""); change.current(null);
    try {
      const result = await productRequest<SourcePreview>(`/vcr/studies/${encodeURIComponent(studyId)}/model-sources/${encodeURIComponent(sourceId)}`);
      if (token === request.current) setPreview(result);
    } catch (cause) { if (token === request.current) setError(webErrorMessage(cause, { fallback: "文献尚未读到，可刷新后重试或先登记模型。" })); }
    finally { if (token === request.current) setBusy(false); }
  };
  const intake = async (upload: boolean) => {
    const token = ++request.current;
    setBusy(true); setError("");
    try {
      if (upload) { const files = await pickFiles(); if (files.length) await uploadFilesToWorkspace(files, "knowledge-base", "base", projectId); }
      else { const value = link.trim().replace(/^doi:\s*/i, ""); const result = await addSourceLink(projectId, /^10\.\d{4,9}\//.test(value) ? `https://doi.org/${value}` : value); if (token !== request.current) return; setSourceId(result.source.id); setPreview(null); setBindings({}); setProfile(""); change.current(null); }
      if (token !== request.current) return;
      await refresh();
    } catch (cause) { if (token === request.current) setError(webErrorMessage(cause, { fallback: "文献暂时无法加入，请重试。" })); }
    finally { if (token === request.current) setBusy(false); }
  };
  const parameters = (preview?.parameters ?? []).filter(item => !parameterQuery.trim() || `${item.quote} ${item.value} ${item.unit}`.toLowerCase().includes(parameterQuery.trim().toLowerCase()));
  const selectedProfile = preview?.supportedProfiles.find(item => item.method === profile);
  return <section className="space-y-3" aria-label="文献来源与参数">
    <Input label="文献 DOI 或链接" value={link} onChange={event => setLink(event.target.value)} />
    <div className="flex gap-2"><Button type="button" variant="secondary" disabled={busy || !link.trim()} onClick={() => void intake(false)}>加入文献</Button><Button type="button" variant="secondary" disabled={busy} onClick={() => void intake(true)}>上传文献</Button><Button type="button" variant="ghost" disabled={busy} onClick={() => { setError(""); void refresh().catch(cause => setError(webErrorMessage(cause, { fallback: "文献列表暂时无法读取。" }))); }}>刷新文献</Button></div>
    <div><label htmlFor={selectionId} className="mb-2 block text-ui text-text">已有文献</label><select id={selectionId} className={inputClasses()} value={sourceId} disabled={busy} onChange={event => { request.current += 1; setSourceId(event.target.value); setPreview(null); setProfile(""); setBindings({}); change.current(null); }}><option value="">选择文献</option>{sources.map(source => <option key={source.id} value={source.id}>{source.display.title}</option>)}</select></div>
    {loaded && !sources.length && <p className="text-caption text-text-2">此研究还没有文献，可加入链接或上传文件。</p>}
    {!loaded && !error && <p role="status" className="text-caption text-text-2">正在读取文献…</p>}
    <Button type="button" variant="secondary" disabled={busy || !sourceId} loading={busy} onClick={() => void load()}>读取文献参数</Button>
    {error && <p role="alert" className="text-caption text-error">{error}</p>}
    {preview && <div className="space-y-3 text-caption text-text-2"><p>{preview.title}</p>{!preview.textSha256 && <p>文献仍在解析或尚无可读正文，请稍后刷新重试。</p>}
      <Input label="筛选文献参数" value={parameterQuery} onChange={event => setParameterQuery(event.target.value)} />
      {preview.parameters.length ? <ul className="space-y-2">{parameters.slice(0, 30).map(parameter => <li key={parameter.id}><span>{parameter.value} {parameter.unit || "单位未声明"}</span><blockquote>{parameter.quote}</blockquote></li>)}</ul> : <p>尚未读到可绑定的数值参数，可先登记来源后补充。</p>}
      {preview.missing.length > 0 && <p>待补充：{preview.missing.join("；")}</p>}
      <div><label htmlFor={profileId} className="mb-2 block text-ui text-text">参数化参考场景</label><select id={profileId} className={inputClasses()} value={profile} onChange={event => { setProfile(event.target.value); setBindings({}); }}><option value="">仅登记来源</option>{preview.supportedProfiles.map(item => <option key={item.method} value={item.method}>{item.label}</option>)}</select></div>
      {selectedProfile?.fields.map(field => <div key={field.key}><label htmlFor={`${profileId}-${field.key}`} className="mb-2 block text-ui text-text">{field.label}（{field.unit}）</label><select id={`${profileId}-${field.key}`} className={inputClasses()} value={bindings[field.key] ?? ""} onChange={event => setBindings(previous => ({ ...previous, [field.key]: event.target.value }))}><option value="">尚缺来源参数</option>{parameters.map(parameter => <option key={parameter.id} value={parameter.id}>{parameter.value} {parameter.unit} · {parameter.quote}</option>)}</select></div>)}
      {selectedProfile && <p>输入为所选文献参数及后续配置的样本量，输出为模拟样本。缺失参数须补齐后运行；这是参考场景，尚未经临床验证，不构成个体预测模型。</p>}
    </div>}
  </section>;
}
