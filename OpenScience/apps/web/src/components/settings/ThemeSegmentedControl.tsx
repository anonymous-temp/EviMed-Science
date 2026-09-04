import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { useUiStore } from "@/lib/store";

/** Appearance switch. The preference is this browser's, not the account's. */
export function ThemeSegmentedControl() {
  const theme = useUiStore((s) => s.theme);
  const setTheme = useUiStore((s) => s.setTheme);
  return (
    <SegmentedControl
      aria-label="外观主题"
      value={theme}
      onChange={setTheme}
      options={[
        { value: "light", label: "浅色" },
        { value: "dark", label: "深色" },
        { value: "system", label: "跟随系统" },
      ]}
    />
  );
}
