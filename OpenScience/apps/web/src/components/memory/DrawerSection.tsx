import type { ReactNode } from "react";

/** A small grey label over a section of a memory drawer: 「怎么做」, 「出处」, 「以前的版本」. */
export function DrawerSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-caption text-text-3">{label}</h3>
      {children}
    </section>
  );
}
