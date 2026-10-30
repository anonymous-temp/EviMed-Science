import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Button } from "@/components/ui/Button";
import { Combobox, type ComboboxOption } from "@/components/ui/Combobox";
import { getOpenListStatus } from "@/lib/sourceClient";
import { useOperator } from "@/lib/useOperator";
import { DriveImportDrawerBody } from "./DriveImport";

export function LibraryDriveImport({ projectId, destinations, refreshToken, onImported, onFolderRegistered, onUpload }: {
 projectId: string | null; destinations: ComboboxOption[]; refreshToken: number;
 onImported(): void; onFolderRegistered(): void; onUpload(): void;
}) {
 const operator = useOperator();
 const [target, setTarget] = useState(projectId);
 const [state, setState] = useState("loading");
 const [attempt, setAttempt] = useState(0);
 useEffect(() => { let active = true; setState("loading"); void getOpenListStatus().then(result => { if (active) setState(result.state); }, () => { if (active) setState("unavailable"); }); return () => { active = false; }; }, [attempt]);
 const messages: Record<string, string> = { unconfigured: "尚未连接网盘。", storage_missing: "网盘尚未添加可用的存储空间。", permission_denied: "当前账号没有访问网盘的权限。", unavailable: "暂时无法连接网盘，请稍后重试。" };
 return <div className="space-y-4">
  {state === "loading" ? <div role="status">正在检查网盘连接</div> : state !== "ready" ? <div className="space-y-4">
   <div role="status">{messages[state]}可以先通过“上传文件”添加本地资料。{!operator && "如需连接网盘，请联系管理员。"}</div>
   <div className="flex flex-wrap gap-2"><Button onClick={onUpload}>上传文件</Button><Button variant="secondary" onClick={() => setAttempt(value => value + 1)}>重试连接</Button></div>
   {operator && <Link className="text-accent underline" to="/app/ops">查看网盘接入状态</Link>}
  </div> : <>
   <Combobox label="保存位置" value={target} onChange={setTarget} options={destinations} clearable={false} />
   {target ? <DriveImportDrawerBody projectId={target} refreshToken={refreshToken} onImported={onImported} onFolderRegistered={onFolderRegistered} /> : <div role="status">请先选择保存资料的项目。</div>}
  </>}
 </div>;
}
