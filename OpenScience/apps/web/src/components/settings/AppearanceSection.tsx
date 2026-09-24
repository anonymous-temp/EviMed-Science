import { ChevronDown } from "lucide-react";
import { isMacPlatform } from "@/lib/platform";
import { useUiStore } from "@/lib/store";
import { Button } from "@/components/ui/Button";
import { Menu } from "@/components/ui/Menu";
import { Panel, PanelRow } from "@/components/ui/Panel";
import { tagClasses } from "@/components/ui/Tag";

const THEMES = [
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
  { value: "system", label: "跟随系统" },
] as const;

/**
 * 「外观」 in 设置 (2026-09-23 plan §5.9): 主题, 语言 as one row that says
 * 简体中文, and the keyboard shortcuts, one per row.
 *
 * The theme is a choice in a menu at the row's end, where a setting's control
 * sits — not a segmented control, which is how a page switches its views. It
 * is this browser's, not the account's. The hints under each card — where the
 * theme is kept, that the language follows the deployment, that 「?」 opens
 * the shortcut list — explained the system and are gone.
 */
export function AppearanceSection() {
  const theme = useUiStore((state) => state.theme);
  const setTheme = useUiStore((state) => state.setTheme);
  const current = THEMES.find((item) => item.value === theme) ?? THEMES[2];
  return (
    <div className="space-y-8">
      <Panel title="外观">
        <PanelRow
          label="主题"
          control={(
            <Menu label="主题" items={THEMES.map((item) => ({ label: item.label, checked: item.value === theme, onSelect: () => setTheme(item.value) }))}>
              <Button variant="secondary" aria-label={`主题：${current.label}`}>
                {current.label}
                <ChevronDown size={16} className="text-text-3" aria-hidden="true" />
              </Button>
            </Menu>
          )}
        />
        <PanelRow label="语言" control="简体中文" />
      </Panel>
      <Panel title="快捷键">
        {shortcuts().map((row) => (
          <PanelRow key={row.keys} label={row.description} control={<kbd className={tagClasses({ className: "font-mono" })}>{row.keys}</kbd>} />
        ))}
      </Panel>
    </div>
  );
}

/**
 * Every key the shell answers to. The composer's own keys belong to the
 * conversation surface and are listed as it has them, so this table and the
 * `?` panel say the same thing.
 */
function shortcuts(): { keys: string; description: string }[] {
  const mod = isMacPlatform() ? "⌘" : "Ctrl+";
  return [
    { keys: "Enter", description: "发送消息" },
    { keys: "Shift+Enter", description: "换行" },
    { keys: `${mod}Enter`, description: "运行中插话" },
    { keys: "/", description: "调用指令或选择科研工具" },
    { keys: "@", description: "引用知识库里的资料或会话" },
    { keys: `${mod}B`, description: "收起 / 展开侧边栏" },
    { keys: "?", description: "打开 / 关闭快捷键清单" },
    { keys: "Esc", description: "关闭弹层" },
  ];
}
