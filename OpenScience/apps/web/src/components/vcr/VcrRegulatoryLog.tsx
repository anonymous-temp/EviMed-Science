import { useRef, useState } from "react";
import { addVcrRegulatoryContact, type VcrRegulatoryContact } from "@/lib/vcrClient";
import { webErrorMessage } from "@/lib/apiClient";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/Button";
import { DataTable } from "@/components/ui/DataTable";
import { Input, Textarea } from "@/components/ui/Input";
import { Section } from "@/components/ui/Section";
import { Tag } from "@/components/ui/Tag";

/**
 * 监管沟通: the study's log of contacts with a regulator — when, with which agency, what kind, what was discussed, what the agency
 * concluded in its own words and what it left. A record: it is added to and never edited, so a correction is another entry; it is
 * part of the study package. It is one of the three kinds of record the trial tab switches between, drawn as a table; the first entry,
 * and the next, are added from the band (R19), so the log has no button of its own.
 */
export function VcrRegulatoryLog({ contacts }: { contacts: readonly VcrRegulatoryContact[] }) {
  return (
    <Section title="监管沟通" count={contacts.length}>
      <DataTable
        label="监管沟通"
        minWidth="min-w-[44rem]"
        columns={[
          { key: "date", header: "日期", rowHeader: true, width: "w-28", cell: (contact) => <span className="tabular-nums text-text-2">{contact.date ?? "日期未记"}</span> },
          {
            key: "agency",
            header: "机构",
            cell: (contact) => (
              <span className="flex flex-wrap items-center gap-2">
                <span className="text-text">{contact.agency}</span>
                {contact.type && <Tag>{contact.type}</Tag>}
              </span>
            ),
          },
          { key: "summary", header: "讨论", isEmpty: (contact) => !contact.summary, cell: (contact) => <span className="whitespace-pre-wrap break-words text-text-2">{contact.summary}</span> },
          { key: "outcome", header: "机构的结论", isEmpty: (contact) => !contact.outcome, cell: (contact) => <span className="whitespace-pre-wrap break-words text-text">{contact.outcome}</span> },
          { key: "attachments", header: "附件", isEmpty: (contact) => contact.attachments.length === 0, cell: (contact) => <span className="break-words text-caption text-text-3">{contact.attachments.join("；")}</span> },
        ]}
        rows={contacts}
        rowKey={(contact) => contact.id}
        rowAttrs={(contact) => ({ "data-vcr-regulatory-contact": contact.id })}
      />
    </Section>
  );
}

/**
 * The form of 添加: the day and the agency are what a record of a contact cannot do without; the rest is as much as the researcher has.
 * One request at a time — a contact written twice in a tap is two lines on the log (the server answers an exact repeat with the line
 * that is already there).
 */
export function RegulatoryContactForm({ studyId, onAdded }: { studyId: string; onAdded: () => void }) {
  const [date, setDate] = useState("");
  const [agency, setAgency] = useState("");
  const [type, setType] = useState("");
  const [summary, setSummary] = useState("");
  const [outcome, setOutcome] = useState("");
  const [attachments, setAttachments] = useState("");
  const [busy, setBusy] = useState(false);
  const holding = useRef(false);
  const ready = date !== "" && agency.trim() !== "";

  const save = () => {
    if (!ready || holding.current) return;
    holding.current = true;
    setBusy(true);
    void addVcrRegulatoryContact(studyId, { date, agency, type, summary, outcome, attachments: attachments.split("\n") })
      .then(() => {
        toast.success("已添加监管沟通记录。");
        onAdded();
      })
      .catch((error: unknown) => toast.error(webErrorMessage(error, { fallback: "监管沟通记录暂时无法添加，请稍后重试。" })))
      .finally(() => {
        holding.current = false;
        setBusy(false);
      });
  };

  return (
    <form data-vcr-regulatory-form="" className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); save(); }}>
      <Input id="vcr-regulatory-date" type="date" label="日期" value={date} onChange={(event) => setDate(event.target.value)} required />
      <Input
        id="vcr-regulatory-agency"
        label="机构"
        value={agency}
        onChange={(event) => setAgency(event.target.value)}
        maxLength={120}
        placeholder="例如：药审中心（CDE）、FDA、EMA"
        required
      />
      <Input
        id="vcr-regulatory-type"
        label="沟通类型"
        value={type}
        onChange={(event) => setType(event.target.value)}
        maxLength={120}
        placeholder="例如：Pre-IND 沟通交流、科学建议"
      />
      <Textarea id="vcr-regulatory-summary" label="讨论摘要" value={summary} onChange={(event) => setSummary(event.target.value)} rows={3} maxLength={4000} />
      <Textarea id="vcr-regulatory-outcome" label="结论" value={outcome} onChange={(event) => setOutcome(event.target.value)} rows={3} maxLength={4000} placeholder="按对方的原话记录" />
      <Textarea
        id="vcr-regulatory-attachments"
        label="附件"
        value={attachments}
        onChange={(event) => setAttachments(event.target.value)}
        rows={2}
        placeholder="每行一条：文件名、路径或链接"
      />
      <div>
        <Button type="submit" disabled={!ready || busy} loading={busy}>添加</Button>
      </div>
    </form>
  );
}
