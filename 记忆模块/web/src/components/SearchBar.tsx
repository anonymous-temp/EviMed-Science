import { SearchIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useMemoFilterContext } from "@/contexts/MemoFilterContext";
import { useTranslate } from "@/utils/i18n";
import MemoDisplaySettingMenu from "./MemoDisplaySettingMenu";

const SEARCH_DEBOUNCE_MS = 300;

const SearchBar = () => {
  const t = useTranslate();
  const { addFilter, removeFilter } = useMemoFilterContext();
  const [queryText, setQueryText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  // The transient filter applied while typing; tracked so each update replaces the previous one.
  const liveFilterRef = useRef<string | null>(null);

  const clearLiveFilter = useCallback(() => {
    if (liveFilterRef.current !== null) {
      const previous = liveFilterRef.current;
      liveFilterRef.current = null;
      removeFilter((f) => f.factor === "contentSearch" && f.value === previous);
    }
  }, [removeFilter]);

  // Live filtering: the whole trimmed input becomes a single contentSearch term,
  // so languages without spaces (e.g. Chinese) filter as one phrase.
  const applyLiveFilter = useCallback(
    (raw: string) => {
      const text = raw.trim();
      if (text === liveFilterRef.current) return;
      clearLiveFilter();
      if (text !== "") {
        liveFilterRef.current = text;
        addFilter({ factor: "contentSearch", value: text });
      }
    },
    [addFilter, clearLiveFilter],
  );

  // Debounce the live filter while typing.
  useEffect(() => {
    const timer = window.setTimeout(() => applyLiveFilter(queryText), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [queryText, applyLiveFilter]);

  // Global Cmd/Ctrl+K focuses the search input.
  useEffect(() => {
    const handleGlobalKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, []);

  const onTextChange = (event: React.FormEvent<HTMLInputElement>) => {
    setQueryText(event.currentTarget.value);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const trimmedText = queryText.trim();
      if (trimmedText !== "") {
        // Drop the transient live filter first so committed chips don't duplicate it.
        clearLiveFilter();
        const words = trimmedText.split(/\s+/);
        words.forEach((word) => {
          addFilter({
            factor: "contentSearch",
            value: word,
          });
        });
        setQueryText("");
      }
    }
  };

  const handleClear = () => {
    setQueryText("");
    clearLiveFilter();
    inputRef.current?.focus();
  };

  return (
    <div className="relative w-full h-auto flex flex-row justify-start items-center">
      <SearchIcon className="absolute left-2 w-4 h-auto opacity-40 text-sidebar-foreground" />
      <input
        className="w-full text-sidebar-foreground leading-6 bg-sidebar border border-border text-sm rounded-lg p-1 pl-8 outline-0"
        placeholder={t("memo.search-placeholder")}
        aria-label={t("common.search")}
        value={queryText}
        onChange={onTextChange}
        onKeyDown={onKeyDown}
        ref={inputRef}
      />
      {queryText !== "" && (
        <button
          type="button"
          aria-label={t("common.clear")}
          onClick={handleClear}
          className="absolute right-8 top-2 flex items-center justify-center"
        >
          <XIcon className="w-4 h-4 opacity-40 hover:opacity-80 text-sidebar-foreground" />
        </button>
      )}
      <MemoDisplaySettingMenu className="absolute right-2 top-2 text-sidebar-foreground" />
    </div>
  );
};

export default SearchBar;
