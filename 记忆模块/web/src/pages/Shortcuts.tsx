import { create } from "@bufbuild/protobuf";
import { FieldMaskSchema } from "@bufbuild/protobuf/wkt";
import {
  CheckCircle2Icon,
  ClipboardCheckIcon,
  Clock3Icon,
  ExternalLinkIcon,
  FilterIcon,
  LucideIcon,
  MoreVerticalIcon,
  PencilIcon,
  PinIcon,
  PlusIcon,
  SaveIcon,
  SearchIcon,
  ShieldIcon,
  TagsIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { useLocation, useNavigate } from "react-router-dom";
import ConfirmDialog from "@/components/ConfirmDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { shortcutServiceClient } from "@/connect";
import { useAuth } from "@/contexts/AuthContext";
import useCurrentUser from "@/hooks/useCurrentUser";
import useLoading from "@/hooks/useLoading";
import { handleError } from "@/lib/error";
import { cn } from "@/lib/utils";
import { Shortcut, ShortcutSchema } from "@/types/proto/api/v1/shortcut_service_pb";
import { useTranslate } from "@/utils/i18n";

// Example filters are CEL expressions and stay in code; titles/descriptions come from the locale files.
const shortcutExampleDefs = [
  { key: "pinned", filter: "pinned", icon: PinIcon },
  { key: "recent-notes", filter: 'created_ts >= now - duration("1h")', icon: Clock3Icon },
  { key: "public-memos", filter: 'visibility == "PUBLIC"', icon: ShieldIcon },
  { key: "project-tags", filter: 'tag in ["work", "personal"]', icon: TagsIcon },
  { key: "untagged", filter: "size(tags) == 0", icon: TagsIcon },
  { key: "archive-tree", filter: 'tags.exists(t, t.startsWith("archive"))', icon: TagsIcon },
  { key: "open-tasks", filter: "has_task_list && has_incomplete_tasks", icon: ClipboardCheckIcon },
  { key: "links-or-code", filter: "has_link || has_code", icon: FilterIcon },
  { key: "content-search", filter: 'content.contains("TODO")', icon: SearchIcon },
  { key: "starts-with", filter: 'content.startsWith("TODO")', icon: SearchIcon },
  { key: "regex-match", filter: 'content.matches("v[0-9]+")', icon: FilterIcon },
  { key: "all-tags-match", filter: 'tags.all(t, t.startsWith("work/"))', icon: TagsIcon },
  { key: "one-project-tag", filter: 'tags.exists_one(t, t.startsWith("project/"))', icon: TagsIcon },
  { key: "any-of-these-tags", filter: 'sets.intersects(tags, ["work", "urgent"])', icon: TagsIcon },
  { key: "exactly-these-tags", filter: 'sets.equivalent(tags, ["inbox"])', icon: TagsIcon },
  { key: "memos-from-2024", filter: "created_ts.getFullYear() == 2024", icon: Clock3Icon },
  { key: "weekend-notes", filter: "created_ts.getDayOfWeek() == 0 || created_ts.getDayOfWeek() == 6", icon: Clock3Icon },
  { key: "long-notes", filter: "size(content) > 280", icon: FilterIcon },
] as const;

type ShortcutExampleKey = (typeof shortcutExampleDefs)[number]["key"];

interface ShortcutExample {
  key: ShortcutExampleKey;
  filter: string;
  title: string;
  description: string;
  icon: LucideIcon;
}

const useShortcutExamples = (): ShortcutExample[] => {
  const t = useTranslate();
  return shortcutExampleDefs.map((def) => ({
    ...def,
    title: t(`shortcut.examples.${def.key}.title` as Parameters<typeof t>[0]),
    description: t(`shortcut.examples.${def.key}.description` as Parameters<typeof t>[0]),
  }));
};

// Field reference: CEL syntax tokens stay untranslated; only the prose annotations are localized.
const filterFieldDefs: { code: string; note?: "month-note" | "weekday-note" }[] = [
  { code: "content.contains(...)" },
  { code: "content.startsWith(...)" },
  { code: "content.endsWith(...)" },
  { code: "content.matches(...)" },
  { code: "visibility" },
  { code: "pinned" },
  { code: "tag in [...]" },
  { code: "tags.exists(...)" },
  { code: "tags.all(...)" },
  { code: "tags.exists_one(...)" },
  { code: "sets.contains(tags, [...])" },
  { code: "sets.intersects(tags, [...])" },
  { code: "sets.equivalent(tags, [...])" },
  { code: "size(tags) == ..." },
  { code: "size(content) > ..." },
  { code: "has_task_list" },
  { code: "has_incomplete_tasks" },
  { code: "has_link" },
  { code: "has_code" },
  { code: 'created_ts >= now - duration("24h")' },
  { code: "created_ts.getFullYear() == ..." },
  { code: "created_ts.getMonth() == ...", note: "month-note" },
  { code: "created_ts.getDayOfWeek() == ...", note: "weekday-note" },
  { code: "updated_ts" },
  { code: "now" },
  { code: 'timestamp("2025-01-01T00:00:00Z")' },
];

const getShortcutId = (name: string): string => {
  const parts = name.split("/");
  return parts.length === 4 ? parts[3] : name;
};

const createEmptyShortcut = () =>
  create(ShortcutSchema, {
    name: "",
    title: "",
    filter: "",
  });

interface ShortcutGuideProps {
  onUseExample: (example: ShortcutExample) => void;
}

interface ShortcutsRouteState {
  openCreate?: boolean;
  shortcut?: Shortcut;
}

const ShortcutGuide = ({ onUseExample }: ShortcutGuideProps) => {
  const t = useTranslate();
  const examples = useShortcutExamples();

  return (
    <aside className="flex flex-col gap-5">
      <div className="rounded-lg border border-border p-4">
        <h2 className="text-sm font-semibold text-foreground">{t("shortcut.guide.examples-title")}</h2>
        <div className="mt-3 flex flex-col gap-2">
          {examples.map((example) => {
            const Icon = example.icon;
            return (
              <button
                type="button"
                key={example.filter}
                className="group cursor-pointer rounded-md border border-transparent p-2 text-left transition-colors hover:border-border hover:bg-muted/50"
                onClick={() => onUseExample(example)}
              >
                <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                  <Icon className="h-4 w-4 text-muted-foreground group-hover:text-primary" />
                  {example.title}
                </span>
                <span className="mt-1 block font-mono text-xs leading-5 text-muted-foreground">{example.filter}</span>
                <span className="mt-1 block text-xs leading-5 text-muted-foreground">{example.description}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="rounded-lg border border-border p-4">
        <h2 className="text-sm font-semibold text-foreground">{t("shortcut.guide.fields-title")}</h2>
        <div className="mt-3 flex flex-wrap gap-2">
          {filterFieldDefs.map((field) => (
            <Badge key={field.code} variant="secondary" className="font-mono">
              {field.code}
              {field.note ? ` ${t(`shortcut.guide.${field.note}` as Parameters<typeof t>[0])}` : ""}
            </Badge>
          ))}
        </div>
      </div>
    </aside>
  );
};

const Shortcuts = () => {
  const t = useTranslate();
  const location = useLocation();
  const navigate = useNavigate();
  const user = useCurrentUser();
  const { shortcuts, refetchSettings } = useAuth();
  const [isCreateFormOpen, setIsCreateFormOpen] = useState(false);
  const [draft, setDraft] = useState<Shortcut>(createEmptyShortcut());
  const [deleteTarget, setDeleteTarget] = useState<Shortcut | undefined>();
  const createState = useLoading(false);
  const validateState = useLoading(false);
  const updateState = useLoading(false);
  const isEditing = draft.name !== "";
  const isSaving = createState.isLoading || updateState.isLoading;

  useEffect(() => {
    const state = location.state as ShortcutsRouteState | null;
    if (!state) return;

    if (state.shortcut) {
      setDraft(
        create(ShortcutSchema, {
          name: state.shortcut.name,
          title: state.shortcut.title,
          filter: state.shortcut.filter,
        }),
      );
      setIsCreateFormOpen(true);
    } else if (state.openCreate) {
      setDraft(createEmptyShortcut());
      setIsCreateFormOpen(true);
    }

    navigate(location.pathname, { replace: true, state: null });
  }, [location.key, location.pathname, location.state, navigate]);

  const setDraftState = (state: Partial<Shortcut>) => {
    setDraft((current) => ({ ...current, ...state }));
  };

  const handleUseExample = (example: ShortcutExample) => {
    setDraft(
      create(ShortcutSchema, {
        name: draft.name,
        title: draft.title || example.title,
        filter: example.filter,
      }),
    );
    setIsCreateFormOpen(true);
  };

  const handleOpenCreateForm = () => {
    setDraft(createEmptyShortcut());
    setIsCreateFormOpen(true);
  };

  const handleCloseForm = () => {
    setDraft(createEmptyShortcut());
    setIsCreateFormOpen(false);
  };

  const handleEditShortcut = (shortcut: Shortcut) => {
    setDraft(
      create(ShortcutSchema, {
        name: shortcut.name,
        title: shortcut.title,
        filter: shortcut.filter,
      }),
    );
    setIsCreateFormOpen(true);
  };

  const validateDraft = async () => {
    if (!draft.title || !draft.filter) {
      toast.error(t("shortcut.toast.title-filter-required"));
      return false;
    }
    if (!user?.name) {
      toast.error(t("shortcut.toast.no-current-user"));
      return false;
    }

    try {
      validateState.setLoading();
      await shortcutServiceClient.createShortcut({
        parent: user.name,
        shortcut: { name: "", title: draft.title, filter: draft.filter },
        validateOnly: true,
      });
      validateState.setFinish();
      toast.success(t("shortcut.toast.filter-valid"));
      return true;
    } catch (error: unknown) {
      await handleError(error, toast.error, {
        context: "Validate shortcut filter",
        onError: () => validateState.setError(),
      });
      return false;
    }
  };

  const handleCreateShortcut = async () => {
    if (!draft.title || !draft.filter) {
      toast.error(t("shortcut.toast.title-filter-required"));
      return;
    }
    if (!user?.name) {
      toast.error(t("shortcut.toast.no-current-user"));
      return;
    }

    try {
      createState.setLoading();
      await shortcutServiceClient.createShortcut({
        parent: user.name,
        shortcut: { name: "", title: draft.title, filter: draft.filter },
      });
      await refetchSettings();
      createState.setFinish();
      setDraft(createEmptyShortcut());
      setIsCreateFormOpen(false);
      toast.success(t("shortcut.toast.create-success"));
    } catch (error: unknown) {
      await handleError(error, toast.error, {
        context: "Create shortcut",
        onError: () => createState.setError(),
      });
    }
  };

  const handleUpdateShortcut = async () => {
    if (!draft.title || !draft.filter) {
      toast.error(t("shortcut.toast.title-filter-required"));
      return;
    }

    try {
      updateState.setLoading();
      await shortcutServiceClient.updateShortcut({
        shortcut: draft,
        updateMask: create(FieldMaskSchema, { paths: ["title", "filter"] }),
      });
      await refetchSettings();
      updateState.setFinish();
      setDraft(createEmptyShortcut());
      setIsCreateFormOpen(false);
      toast.success(t("shortcut.toast.update-success"));
    } catch (error: unknown) {
      await handleError(error, toast.error, {
        context: "Update shortcut",
        onError: () => updateState.setError(),
      });
    }
  };

  const handleSaveShortcut = async () => {
    if (isEditing) {
      await handleUpdateShortcut();
      return;
    }

    await handleCreateShortcut();
  };

  const confirmDeleteShortcut = async () => {
    if (!deleteTarget) return;

    try {
      await shortcutServiceClient.deleteShortcut({ name: deleteTarget.name });
      await refetchSettings();
      toast.success(t("setting.shortcut.delete-success", { title: deleteTarget.title }));
      setDeleteTarget(undefined);
    } catch (error: unknown) {
      await handleError(error, toast.error, {
        context: "Delete shortcut",
      });
    }
  };

  return (
    <section className="mx-auto flex w-full max-w-6xl flex-col gap-6 pb-10">
      <div className="flex flex-col gap-2 border-b border-border pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-muted-foreground">
            <FilterIcon className="h-4 w-4" />
            <span className="text-sm font-medium">{t("common.shortcuts")}</span>
          </div>
          <h1 className="text-2xl font-semibold tracking-normal text-foreground">{t("shortcut.page.title")}</h1>
          <p className="max-w-2xl text-sm leading-6 text-muted-foreground">{t("shortcut.page.description")}</p>
        </div>
        <Button onClick={isCreateFormOpen ? handleCloseForm : handleOpenCreateForm}>
          {isCreateFormOpen ? <XIcon className="h-4 w-4" /> : <PlusIcon className="h-4 w-4" />}
          {isCreateFormOpen ? t("common.cancel") : `${t("common.create")} ${t("common.shortcuts")}`}
        </Button>
      </div>

      <div className={cn("grid grid-cols-1 gap-6", isCreateFormOpen && "xl:grid-cols-[minmax(0,1fr)_20rem]")}>
        <div className="flex min-w-0 flex-col gap-6">
          <div
            className={cn(
              "overflow-hidden rounded-lg border border-border bg-background transition-[max-height,opacity] duration-200",
              isCreateFormOpen ? "max-h-[48rem] opacity-100" : "max-h-0 border-transparent opacity-0",
            )}
          >
            <div className="grid gap-5 p-4 sm:p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold text-foreground">
                    {isEditing ? t("shortcut.form.edit-title") : t("shortcut.form.create-title")}
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground">{t("shortcut.form.description")}</p>
                </div>
                <a
                  className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
                  href="https://www.usememos.com/docs/usage/shortcuts"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {t("shortcut.form.docs")}
                  <ExternalLinkIcon className="h-3.5 w-3.5" />
                </a>
              </div>

              <div className="grid gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="shortcut-title">{t("common.title")}</Label>
                  <Input
                    id="shortcut-title"
                    value={draft.title}
                    placeholder={t("shortcut.form.title-placeholder")}
                    onChange={(event) => setDraftState({ title: event.target.value })}
                  />
                  <p className="text-xs leading-5 text-muted-foreground">{t("shortcut.form.title-help")}</p>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="shortcut-filter">{t("common.filter")}</Label>
                  <Textarea
                    id="shortcut-filter"
                    rows={5}
                    className="font-mono text-sm"
                    value={draft.filter}
                    placeholder='pinned && tag in ["work"]'
                    onChange={(event) => setDraftState({ filter: event.target.value })}
                  />
                  <p className="text-xs leading-5 text-muted-foreground">
                    {t("shortcut.form.filter-help-combine")} {t("shortcut.form.filter-help-time")} {t("shortcut.form.filter-help-tags")}
                  </p>
                </div>
              </div>

              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button variant="outline" disabled={validateState.isLoading || isSaving} onClick={validateDraft}>
                  <CheckCircle2Icon className="h-4 w-4" />
                  {t("shortcut.form.validate")}
                </Button>
                <Button disabled={isSaving || validateState.isLoading} onClick={handleSaveShortcut}>
                  <SaveIcon className="h-4 w-4" />
                  {t("common.save")}
                </Button>
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-foreground">{t("shortcut.list.title")}</h2>
              <Badge variant="outline">{shortcuts.length}</Badge>
            </div>

            {shortcuts.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border px-4 py-10 text-center">
                <p className="text-sm font-medium text-foreground">{t("shortcut.list.empty-title")}</p>
                <p className="mt-1 text-sm text-muted-foreground">{t("shortcut.list.empty-description")}</p>
              </div>
            ) : (
              <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
                {shortcuts.map((shortcut) => (
                  <div
                    key={shortcut.name}
                    className="grid gap-3 bg-background px-4 py-3 sm:grid-cols-[minmax(10rem,14rem)_minmax(0,1fr)_2rem]"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-foreground">{shortcut.title}</div>
                      <div className="mt-1 font-mono text-xs text-muted-foreground">{getShortcutId(shortcut.name)}</div>
                    </div>
                    <pre className="min-w-0 overflow-x-auto rounded-md bg-muted/50 px-3 py-2 font-mono text-xs leading-5 text-muted-foreground">
                      {shortcut.filter}
                    </pre>
                    <DropdownMenu>
                      <DropdownMenuTrigger render={<Button variant="ghost" size="icon" className="justify-self-end" />}>
                        <MoreVerticalIcon className="h-4 w-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => handleEditShortcut(shortcut)}>
                          <PencilIcon className="h-4 w-4" />
                          {t("common.edit")}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setDeleteTarget(shortcut)}>
                          <Trash2Icon className="h-4 w-4" />
                          {t("common.delete")}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {isCreateFormOpen ? <ShortcutGuide onUseExample={handleUseExample} /> : null}
      </div>

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(undefined)}
        title={t("setting.shortcut.delete-confirm", { title: deleteTarget?.title ?? "" })}
        confirmLabel={t("common.delete")}
        cancelLabel={t("common.cancel")}
        onConfirm={confirmDeleteShortcut}
        confirmVariant="destructive"
      />
    </section>
  );
};

export default Shortcuts;
