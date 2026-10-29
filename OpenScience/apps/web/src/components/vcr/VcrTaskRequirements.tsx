import { Disclosure } from "@/components/ui/Disclosure";
import { Tag } from "@/components/ui/Tag";
import { VCR_TASKS } from "./frameVcrOptions";

/**
 * Component: VcrTaskRequirements; owner: VCR; rules: show requirements for the selected task.
 * Anatomy: One requirement tag and an optional disclosure.
 * Variants: One per research task.
 * States: Disclosure open or closed.
 * Hit area: Native disclosure control.
 * Keyboard: Native disclosure keyboard interaction.
 * Long content: Requirement text wraps.
 * Theme: Shared tag and text tokens.
 * Responsive: Content fits the available column.
 * Verification: VcrHomePage.test.tsx.
 */
export function VcrTaskRequirements({ task }: { task: typeof VCR_TASKS[number] }) {
  return <div data-vcr-data-requirement={task.id} className="flex flex-col items-start gap-3">
    <Tag>{task.inputLabel}</Tag>
    <Disclosure summary="数据要求"><p className="max-w-measure text-ui text-text-2">{task.minimumFields}</p></Disclosure>
  </div>;
}
