import { useRef, type ReactNode } from 'react';
import { ChevronDown, Loader2 } from 'lucide-react';
import { useContainerNarrow } from '@/lib/useContainerNarrow';
import { useMediaQuery } from '@/lib/useMediaQuery';
import { Button, buttonClasses } from '@/components/ui/Button';
import { ActionLink, Menu, type MenuEntry, type MenuItem } from '@/components/ui/Menu';

/** An action's identity and behavior are declared by its owner, never inferred from rendered text. */
export type PageAction = { id: string; label: string; disabled?: boolean; loading?: boolean; destructive?: boolean; icon?: MenuItem['icon']; checked?: boolean; toggle?: boolean } & (
  { to: string; state?: unknown; onSelect?: () => void } | { to?: never; onSelect(): void }
);
export type PagePrimaryAction = PageAction | { id: string; label: string; items: readonly MenuEntry[]; disabled?: boolean; loading?: boolean };
export interface PageActionPlan {
  primary?: PagePrimaryAction;
  secondary?: readonly PageAction[];
  overflow?: readonly (PageAction | MenuEntry)[];
  overflowLabel?: string;
  /** An immediate reversible preference owned by this page, outside the action budget. */
  preference?: { label: string; control: ReactNode };
}

/**
 * Component: HeaderActions; owner: H; rules: DS22.2/AT52, DS22.4/AT54.
 * Anatomy: Priority action group plus separately bounded preference; labeled overflow shares all collapsed actions.
 * Variants: Read-only plans omit primary; actions are native buttons or router links.
 * States: Owner supplies disabled/loading; Button guards busy activation.
 * Hit area: Shared Button control height and Menu rows.
 * Keyboard: Native button/link behavior and Menu traversal/focus return.
 * Long content: Labels wrap inside available width rather than widening the page.
 * Theme: Shared semantic Button/Menu roles.
 * Responsive: Parent density follows its stable header/toolbar allocation; standalone groups collapse below 1024px viewport or 960px allocation. Primary stays beside overflow; preference owns a separate group.
 * Verification: HeaderActions.test.tsx; DS22.2/AT52; browser width/AT proof belongs to page adoption.
 */
export function HeaderActions({ plan, density }: { plan: PageActionPlan; /** Parent containers own density when actions share a band with navigation. */ density?: "compact" | "full" }) {
  const root = useRef<HTMLDivElement>(null);
  const viewportCompact = useMediaQuery("(max-width: 1023px)");
  const containerCompact = useContainerNarrow(root, 960);
  const compact = density ? density === "compact" : viewportCompact || containerCompact;
  const visible = compact ? [] : plan.secondary?.slice(0, 2) ?? [];
  const overflow = [...(plan.secondary?.slice(compact ? 0 : 2) ?? []), ...(plan.overflow ?? [])];
  const renderAction = (action: PageAction, primary = false) => action.to !== undefined
    ? <ActionLink key={action.id} to={action.to} state={action.state} inert={action.disabled || action.loading} aria-disabled={action.disabled || action.loading || undefined} aria-busy={action.loading || undefined} onClick={action.onSelect} onAuxClick={event => { if (action.disabled || action.loading) event.preventDefault(); }} className={buttonClasses({ variant: primary ? action.destructive ? 'danger' : 'primary' : 'secondary', destructive: action.destructive, className: 'min-w-0 shrink max-w-xs whitespace-normal h-auto min-h-control py-2 text-center' })}>{action.loading && <Loader2 size={16} aria-hidden="true" className="shrink-0 animate-spin" />}{action.icon && <action.icon size={16} aria-hidden="true" className="shrink-0" />}{action.label}</ActionLink>
    : <Button key={action.id} variant={primary ? action.destructive ? 'danger' : 'primary' : 'secondary'} loading={action.loading} disabled={action.disabled} destructive={action.destructive} onClick={action.onSelect} className="h-auto min-h-control min-w-0 shrink max-w-xs whitespace-normal py-2">{action.icon && <action.icon size={16} aria-hidden="true" className="shrink-0" />}{action.label}</Button>;
  const items: MenuEntry[] = overflow.map(action => {
    if (action === 'separator' || 'heading' in action) return action;
    return { ...action, onSelect: () => action.onSelect?.() };
  });
  return <div ref={root} data-header-actions="" data-action-density={compact ? "compact" : "full"} className="flex min-w-0 max-w-full flex-col items-end gap-2">
    <div data-action-priority="" className="flex min-w-0 max-w-full items-center justify-end gap-2">
    {plan.primary && ('items' in plan.primary
      ? <Menu label={plan.primary.label} items={plan.primary.items}><Button loading={plan.primary.loading} disabled={plan.primary.disabled}>{plan.primary.label}<ChevronDown size={16} aria-hidden="true" className="shrink-0" /></Button></Menu>
      : renderAction(plan.primary, true))}
    {visible.map(action => renderAction(action))}
    {items.length > 0 && <Menu label={plan.overflowLabel ?? '更多操作'} items={items}><Button variant="text">{plan.overflowLabel ?? '更多操作'}</Button></Menu>}
    </div>
    {plan.preference && <div role="group" aria-label={plan.preference.label} className="max-w-full min-w-0 break-words">{plan.preference.control}</div>}
  </div>;
}
