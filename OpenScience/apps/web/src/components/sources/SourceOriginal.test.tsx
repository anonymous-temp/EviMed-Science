import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { SourceRecord } from "@/lib/sourceClient";
import { SourceOriginal } from "./SourceOriginal";
vi.mock("@/components/inspector/FilePreviewInspector", () => ({ FilePreviewInspector: ({ data }: { data: { path: string; filename: string } }) => <div data-testid="original-preview">{data.path} · {data.filename}</div> }));
const source = (path: string) => ({
 id: "src_one", projectId: "project-one", display: { origin: "drive", kind: "document" },
 payload: { paths: [path], status: "complete", outputs: { artifactPath: "knowledge-base/.evimed-derived/src_one/index.md" } },
}) as SourceRecord;
it("previews the preserved cloud-drive original instead of parsed Markdown", async () => {
 const path = "knowledge-base/.evimed-revisions/captured/paper.pdf";
 render(<SourceOriginal source={source(path)} onNoteSaved={() => {}} />);
 expect(await screen.findByTestId("original-preview")).toHaveTextContent(`${path} · paper.pdf`);
 expect(screen.getByText("从网盘保存的原件")).toBeInTheDocument();
 expect(screen.queryByText("从网盘文件读出的文本")).toBeNull();
});
it("retains the parsed-text fallback and provenance for legacy remote paths", async () => {
 render(<SourceOriginal source={source("/OpenList/remote/paper.pdf")} onNoteSaved={() => {}} />);
 expect(await screen.findByTestId("original-preview")).toHaveTextContent("knowledge-base/.evimed-derived/src_one/index.md · index.md");
 expect(screen.getByText("从网盘文件读出的文本")).toBeInTheDocument();
 expect(screen.queryByText("从网盘保存的原件")).toBeNull();
});
