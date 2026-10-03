import { Link } from "react-router";
import { Button, buttonClasses } from "@/components/ui/Button";

type Section = "feed" | "zones" | "brief" | "following";
const sections: readonly { key: Section; label: string; to: string }[] = [
  { key: "feed", label: "动态", to: "/app/frontier" },
  { key: "zones", label: "证据专区", to: "/app/frontier/zones" },
  { key: "brief", label: "简报", to: "/app/frontier?view=daily" },
  { key: "following", label: "关注", to: "/app/frontier?view=following" },
];
export function FrontierNavigation({ active, onChange }: {
  active: Section; onChange?: (section: Exclude<Section, "zones">) => void;
}) {
  return <nav aria-label="前沿动态" className="flex min-w-0 gap-2 overflow-x-auto border-b border-border pb-2">
    {sections.map(({ key, label, to }) => key !== "zones" && onChange
      ? <Button key={key} variant="text" className={`shrink-0 whitespace-nowrap ${active === key ? "bg-surface-2 text-text underline underline-offset-4" : ""}`} aria-current={active === key ? "page" : undefined} onClick={() => onChange(key)}>{label}</Button>
      : <Link key={key} to={to} aria-current={active === key ? "page" : undefined} className={buttonClasses({ variant: "text", className: `shrink-0 whitespace-nowrap ${active === key ? "bg-surface-2 text-text underline underline-offset-4" : ""}` })}>{label}</Link>)}
  </nav>;
}
