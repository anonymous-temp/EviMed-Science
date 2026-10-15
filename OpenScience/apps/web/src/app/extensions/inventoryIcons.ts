import { Brain, Globe, Layers, Network, PenLine, Puzzle, Quote, Repeat, Wrench, type LucideIcon } from "lucide-react";

/**
 * The icons the plugins page draws for the platform's items. The vocabulary (`runtime-inventory-zh.json`) names an icon by
 * its name in this set, so the domain package stays free of the UI library; a test holds every name it uses to a component
 * here, and a name that is not here is drawn as the plain piece.
 */
export const INVENTORY_ICONS = { Brain, Globe, Layers, Network, PenLine, Quote, Repeat, Wrench } as const satisfies Record<string, LucideIcon>;

export const inventoryIcon = (name: string): LucideIcon => (INVENTORY_ICONS as Record<string, LucideIcon>)[name] ?? Puzzle;
