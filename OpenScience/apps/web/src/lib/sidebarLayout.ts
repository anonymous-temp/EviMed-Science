/**
 * Below Tailwind's `lg` the sidebar is a drawer over the page; from `lg` up it is a column beside it. One string, because the shell
 * (which draws it that way) and the store (which keeps only the column's state) must agree on where the line is.
 */
export const SIDEBAR_DRAWER_QUERY = "(max-width: 1023px)";
