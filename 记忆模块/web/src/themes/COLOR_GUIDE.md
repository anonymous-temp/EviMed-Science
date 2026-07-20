# Color System Guide

This document explains the color system used in the application, built with OKLCH color space for better perceptual uniformity and accessibility.

## How Themes Work

Themes are plain CSS files under `web/src/themes/` that override `:root` custom properties. At runtime `loadTheme()` (`web/src/utils/theme.ts`):

1. Injects the theme file's contents as a `<style id="instance-theme">` element in `<head>` (the `default` theme skips injection — its tokens are the base stylesheet `default.css`).
2. Sets `data-theme="<name>"` on `<html>` so CSS can react to the current theme.
3. Updates the `theme-color` meta tag and `color-scheme` to match.
4. Persists the choice to `localStorage` (`memos-theme`); a logged-in user's theme is also stored in their user settings.

There is **no `.dark` class toggle** — dark themes are separate theme files (`*-dark`) applied through the same injection mechanism. The Tailwind v4 token mapping (`@theme inline` in `default.css`) is compiled once at build time and simply references the `:root` variables, so theme files only need to override the variables.

Available themes (registered in `THEME_OPTIONS` in `web/src/utils/theme.ts`):

| Theme          | File                | Character                                        |
| -------------- | ------------------- | ------------------------------------------------ |
| `default`      | `default.css`       | Light, blue primary on warm off-white            |
| `default-dark` | `default-dark.css`  | Dark graphite, brighter blue primary             |
| `paper`        | `paper.css`         | Warm sepia paper, brown primary                  |
| `evimed`       | `evimed.css`        | EviMed Science brand: terracotta on warm paper   |
| `evimed-dark`  | `evimed-dark.css`   | EviMed brand dark: terracotta on warm graphite   |
| `system`       | —                   | Follows the OS preference (`default`/`default-dark`) |

All colors are defined using OKLCH (Oklab LCH) color space, which provides better perceptual uniformity than traditional RGB/HSL.

## EviMed Brand Theme

The `evimed` / `evimed-dark` themes align the app with the EviMed Science platform design language:

- **Primary (terracotta)**: `#c15f3c` → `oklch(0.5971 0.1352 39.87)` in light; `#d0764f` → `oklch(0.6577 0.125 43.57)` in dark. Also used for `--ring`.
- **Background (warm paper)**: `#f7f5ef` → `oklch(0.97 0.0082 91.48)` in light; warm graphite `oklch(0.235 0.01 60)` in dark.
- **Radius**: `--radius: 0.875rem` (14px cards); derived tiers give 10px `--radius-sm` (inputs) through 18px `--radius-xl`.
- **Fonts**: `--font-sans` leads with `Inter`, `--font-mono` leads with `JetBrains Mono` (system fallbacks when the fonts are not bundled).
- **Shadows**: warm-tinted to match the paper surfaces.

## Color Categories

### 🎨 Primary Brand Colors

| Variable               | Light Theme (`default`) | Dark Theme (`default-dark`) | Usage                          |
| ---------------------- | ----------------------- | --------------------------- | ------------------------------ |
| `--primary`            | Blue `oklch(0.45 0.08 250)` | Brighter blue `oklch(0.66 0.11 250)` | Main brand color, primary CTAs |
| `--primary-foreground` | Warm off-white          | Dark graphite               | Text on primary backgrounds    |

**When to use:**

- Call-to-action buttons
- Active navigation items
- Important links and highlights
- Brand elements

```css
/* Example usage */
.cta-button {
  background: var(--primary);
  color: var(--primary-foreground);
}
```

### 🔘 Secondary Colors

| Variable                 | Light Theme | Dark Theme          | Usage                         |
| ------------------------ | ----------- | ------------------- | ----------------------------- |
| `--secondary`            | Warm gray   | Elevated dark gray  | Supporting actions            |
| `--secondary-foreground` | Dark gray   | Light gray          | Text on secondary backgrounds |

**When to use:**

- Secondary buttons
- Less important actions
- Alternative navigation items
- Subtle highlights

### 📄 Background & Surface Colors

| Variable               | Light Theme      | Dark Theme  | Usage                       |
| ---------------------- | ---------------- | ----------- | --------------------------- |
| `--background`         | Warm off-white   | Dark gray   | Main page background        |
| `--card`               | Near white       | Dark gray   | Card/container backgrounds  |
| `--card-foreground`    | Very dark        | Near white  | Text on card backgrounds    |
| `--popover`            | Pure white       | Darker gray | Overlay backgrounds         |
| `--popover-foreground` | Dark gray        | Light gray  | Text on overlay backgrounds |

**When to use:**

- Page backgrounds (`--background`)
- Content cards and panels (`--card`)
- Tooltips, dropdowns, modals (`--popover`)

### ✏️ Text & Content Colors

| Variable             | Light Theme | Dark Theme   | Usage                    |
| -------------------- | ----------- | ------------ | ------------------------ |
| `--foreground`       | Dark gray   | Light gray   | Primary text color       |
| `--muted`            | Light gray  | Dark gray    | Subtle background areas  |
| `--muted-foreground` | Medium gray | Medium light | Secondary text, captions |

**When to use:**

- Main body text (`--foreground`)
- Helper text, placeholders (`--muted-foreground`)
- Disabled text states
- Subtle background sections (`--muted`)

### 🎯 Interactive Elements

| Variable              | Light Theme  | Dark Theme  | Usage                        |
| --------------------- | ------------ | ----------- | ---------------------------- |
| `--accent`            | Light gray   | Dark gray   | Hover states, selected items |
| `--accent-foreground` | Dark gray    | Light gray  | Text on accent backgrounds   |
| `--border`            | Medium light | Medium dark | Dividers, input borders      |
| `--input`             | Medium light | Medium dark | Form input borders           |

**When to use:**

- Hover states (`--accent`)
- Form field borders (`--border`)
- Input field borders (`--input`)

### ⚠️ Feedback Colors

| Variable                   | Light Theme | Dark Theme    | Usage                               |
| -------------------------- | ----------- | ------------- | ----------------------------------- |
| `--destructive`            | Red         | Brighter red  | Error states, dangerous actions     |
| `--destructive-foreground` | White       | Near white    | Text on destructive backgrounds     |
| `--success`                | Green       | Brighter green| Confirmation states (copied, saved) |
| `--success-foreground`     | Near white  | Near black    | Text on success backgrounds         |
| `--warning`                | Amber       | Brighter amber| Caution states (unused, deprecated) |
| `--warning-foreground`     | Dark        | Dark          | Text on warning backgrounds         |

**When to use:**

- Error messages, delete buttons, validation failures → `--destructive`
- Success confirmations (e.g. "copied ✓", saved) → `--success`
- Non-critical caution (e.g. unused attachments) → `--warning`

For tinted treatments (badges, panels), pair the token with an opacity modifier
the same way `--destructive` is used, e.g. `border-warning/30 bg-warning/10 text-warning`.
This auto-adapts across themes — never hardcode `amber-*` / `green-*` palette classes
or add manual `dark:` overrides for feedback states.

### 🔧 Sidebar System

| Variable                       | Usage                        |
| ------------------------------ | ---------------------------- |
| `--sidebar`                    | Sidebar background           |
| `--sidebar-foreground`         | Sidebar text                 |
| `--sidebar-accent`             | Sidebar hover states         |
| `--sidebar-accent-foreground`  | Text on sidebar hover states |

## Best Practices

### ✅ Do's

1. **Always pair colors correctly:**

   ```css
   /* Correct */
   background: var(--primary);
   color: var(--primary-foreground);
   ```

2. **Use semantic meaning:**
   - Primary = main actions
   - Secondary = supporting actions
   - Destructive = dangerous/delete actions
   - Muted = less important content

3. **Respect the design system:**
   - Use existing color tokens instead of custom colors
   - Maintain consistency across components

### ❌ Don'ts

1. **Don't mix incompatible pairs:**

   ```css
   /* Incorrect - poor contrast */
   background: var(--primary);
   color: var(--foreground);
   ```

2. **Don't use colors outside their intended purpose:**
   - Don't use destructive colors for positive actions
   - Don't use primary colors for secondary elements

3. **Don't hardcode color values:**

   ```css
   /* Bad */
   color: #333333;

   /* Good */
   color: var(--foreground);
   ```

## Adding or Changing Themes

1. Create a new CSS file in `web/src/themes/` that overrides the `:root` variables (see `paper.css` or `evimed.css` for the full variable list; dark variants only need the surface/color tokens, see `default-dark.css`).
2. Register it in `web/src/utils/theme.ts`: add the name to `VALID_THEMES`, import the file as `?raw` into `THEME_CONTENT`, add its background hex to `THEME_COLORS`, and add a `THEME_OPTIONS` entry. Name dark variants `*-dark` so `color-scheme` is set correctly.
3. The theme then appears in the UserMenu theme picker and `ThemeSelect` automatically.

## Accessibility

- All color pairs meet WCAG contrast requirements
- Color is never the only means of conveying information

## Implementation Examples

### Button Variants

```css
/* Primary button */
.btn-primary {
  background: var(--primary);
  color: var(--primary-foreground);
  border: 1px solid var(--primary);
}

/* Secondary button */
.btn-secondary {
  background: var(--secondary);
  color: var(--secondary-foreground);
  border: 1px solid var(--border);
}

/* Destructive button */
.btn-destructive {
  background: var(--destructive);
  color: var(--destructive-foreground);
  border: 1px solid var(--destructive);
}
```

### Form Elements

```css
/* Input field */
.input {
  background: var(--input);
  color: var(--foreground);
  border: 1px solid var(--border);
}
```

### Cards and Containers

```css
/* Content card */
.card {
  background: var(--card);
  color: var(--card-foreground);
  border: 1px solid var(--border);
}

/* Popover/Modal */
.popover {
  background: var(--popover);
  color: var(--popover-foreground);
  box-shadow: var(--shadow-lg);
}
```

## Color Testing

To ensure proper contrast and accessibility:

1. Test both light and dark themes
2. Verify readability at different zoom levels
3. Check with colorblind simulation tools
4. Validate WCAG contrast ratios

## Z-Index Hierarchy

The layering tiers are defined once as Tailwind tokens in `default.css`
(`--z-index-overlay/dropdown/tooltip`) and consumed via named utilities — do not
hardcode `z-[60]`-style literals.

| Component Type    | Utility       | Value | Usage                                 |
| ----------------- | ------------- | ----- | ------------------------------------- |
| **Base Content**  | `z-0`         | 0     | Normal page content                   |
| **Sticky chrome** | `z-10`        | 10    | Sticky headers above page content     |
| **Overlays**      | `z-overlay`   | 50    | Dialog/Sheet backgrounds              |
| **Modal Content** | `z-overlay`   | 50    | Dialog/Sheet content                  |
| **Dropdowns**     | `z-dropdown`  | 60    | Select, DropdownMenu, Popover content |
| **Tooltips**      | `z-tooltip`   | 70    | Tooltip content (highest priority)    |

### Rules

1. **Dialog/Sheet**: Use `z-overlay` for both overlay and content
2. **Interactive Elements**: Use `z-dropdown` for dropdowns inside dialogs
3. **Tooltips**: Use `z-tooltip` to appear above all other elements
4. **Within a component**: Stack local layers with the standard `z-0`/`z-10`/`z-20` utilities (e.g. media tile gradient < badge < overflow mask); the theme tokens are reserved for chrome-level layering above page content.
5. **Always test**: Ensure Select/DropdownMenu works inside Dialog/Sheet

These are already the defaults baked into the `ui/` primitives, so a `Select`
inside a `Dialog` renders above the overlay without any extra `z-*` class.

---

_This color system is designed to provide a consistent, accessible, and beautiful user experience across all themes and components._
