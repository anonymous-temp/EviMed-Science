import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { CapsuleTransferPanel } from "./CapsuleTransferPanel";
import * as api from "@/lib/productClient";
vi.mock("@/lib/productClient");
const capsule={id:"capsule-one",revision:1,payload:{title:"My capsule",description:""},createdAt:"2026-09-05T00:00:00Z",updatedAt:"2026-09-05T00:00:00Z",deletedAt:null};
const preview={archiveSha256:"a".repeat(64),snapshotId:"snapshot-one",scopes:["workstyle"],entries:[{id:"entry-one",version:2,factKind:"method_preference",layer:"methods",content:"Preserve uncertainty",path:"methods/entry-one/SKILL.md",sha256:"b".repeat(64)}],issuerTrust:"unverified",issuerId:"foreign",hostedStatus:"unknown",canImport:true,offlineRevocable:false,newerSnapshotId:null};
beforeEach(()=>{vi.resetAllMocks();vi.mocked(api.listCapsuleExports).mockResolvedValue({items:[],nextCursor:null});vi.mocked(api.productErrorMessage).mockReturnValue("操作未完成，请重试。");});

it("previews an uploaded encrypted capsule before explicit candidate import",async()=>{
  const done=vi.fn();vi.mocked(api.previewCapsuleImport).mockResolvedValue(preview);vi.mocked(api.importCapsule).mockResolvedValue(capsule);
  render(<CapsuleTransferPanel capsule={null} onImported={done}/>);
  const file=new File(['{"encrypted":true}'],"methods.evimedcap",{type:"application/json"});Object.defineProperty(file,"text",{value:async()=>'{"encrypted":true}'});
  await userEvent.upload(screen.getByLabelText("选择胶囊文件"),file);
  await userEvent.type(screen.getByLabelText("导入口令"),"test-only-passphrase");
  expect(api.importCapsule).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button",{name:"解密并预览"}));
  expect(await screen.findByText("作者身份未验证（外部自签名）")).toBeInTheDocument();
  expect(screen.getByText("Preserve uncertainty")).toBeInTheDocument();
  expect(api.importCapsule).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button",{name:"确认导入为待确认条目"}));
  await waitFor(()=>expect(api.importCapsule).toHaveBeenCalledWith(expect.objectContaining({expectedDigest:preview.archiveSha256,confirmed:true})));
  expect(done).toHaveBeenCalledWith(capsule);
});

it("revoked hosted snapshots cannot be imported",async()=>{
  vi.mocked(api.previewCapsuleImport).mockResolvedValue({...preview,issuerTrust:"verified",hostedStatus:"revoked",canImport:false});
  render(<CapsuleTransferPanel capsule={capsule} onImported={vi.fn()}/>);
  const file=new File(['{}'],"revoked.evimedcap");Object.defineProperty(file,"text",{value:async()=>"{}"});
  await userEvent.upload(screen.getByLabelText("选择胶囊文件"),file);await userEvent.type(screen.getByLabelText("导入口令"),"test-only-passphrase");
  await userEvent.click(screen.getByRole("button",{name:"解密并预览"}));
  expect(await screen.findByRole("button",{name:"确认导入为待确认条目"})).toBeDisabled();
  expect(screen.getByText(/离线副本无法收回/)).toBeInTheDocument();
});

it("uses workstyle only unless optional sharing scopes are explicitly selected",async()=>{
  vi.mocked(api.exportCapsule).mockRejectedValue(new Error("test-only-export-failure"));
  render(<CapsuleTransferPanel capsule={capsule} onImported={vi.fn()}/>);
  await userEvent.type(screen.getByLabelText("导出口令"),"test-only-passphrase");
  await userEvent.click(screen.getByRole("button",{name:"加密导出当前版本"}));
  await waitFor(()=>expect(api.exportCapsule).toHaveBeenCalledWith(capsule.id,{password:"test-only-passphrase",scopes:["workstyle"]}));
  expect(await screen.findByRole("alert")).toBeInTheDocument();
});
