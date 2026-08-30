import { useRef, useState } from "react";
import type { ReactNode } from "react";
import { Box, Text, useInput } from "@deno-ink/core";
import type { SelectInputItem } from "@deno-ink/core";

/** 一覧の表示行数上限 (超過分はスクロールで表示)。 */
const LIST_LIMIT = 10;

interface SearchableListProps<T> {
  /** 見出し (絞り込み後の件数が付与される)。 */
  title: string;
  /** 見出しの直下に表示する補足。 */
  description?: ReactNode;
  /** 候補行。matches で絞り込まれる。 */
  rows: T[];
  /** 行 → 表示項目。 */
  toItem: (row: T) => SelectInputItem<string>;
  /** 絞り込み判定 (大文字小文字を無視する部分一致など)。 */
  matches: (row: T, query: string) => boolean;
  /** 絞り込みで0件のときに表示するメッセージ。 */
  emptyMessage: string;
  /** 行が選択された (Enter)。 */
  onSelect: (row: T) => void;
  /** 「← 戻る」または Esc (クエリなし時) で呼ばれる。 */
  onBack: () => void;
}

/**
 * 文字入力で絞り込みできる選択リスト。認証画面のプロバイダ一覧と
 * モデル選択画面のプロバイダ・モデル一覧で共用する。
 */
export function SearchableList<T>({
  title,
  description,
  rows,
  toItem,
  matches,
  emptyMessage,
  onSelect,
  onBack,
}: SearchableListProps<T>) {
  const [query, setQuery] = useState("");
  const [listIndex, setListIndex] = useState(0);
  // 一覧操作は ref を介して最新状態を参照する (同一入力バースト内の連続キーでも
  // stale な state を参照しないため。SelectInput では絞り込み前のリストが
  // Enter に使われて先頭項目を選んでしまう問題があった)
  const queryRef = useRef("");
  const indexRef = useRef(0);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  const q = query.trim().toLowerCase();
  const filtered = q ? rows.filter((r) => matches(r, query)) : rows;
  const items: SelectInputItem<string>[] = [
    ...filtered.map(toItem),
    { label: "← 戻る", value: "__back" },
  ];

  useInput((input, key) => {
    const currentQuery = queryRef.current;
    const cq = currentQuery.trim().toLowerCase();
    const currentRows = cq
      ? rowsRef.current.filter((r) => matches(r, currentQuery))
      : rowsRef.current;
    const currentItems: SelectInputItem<string>[] = [
      ...currentRows.map(toItem),
      { label: "← 戻る", value: "__back" },
    ];

    if (key.escape) {
      if (currentQuery) {
        queryRef.current = "";
        setQuery("");
      } else {
        onBack();
      }
      indexRef.current = 0;
      setListIndex(0);
      return;
    }
    if (key.backspace) {
      queryRef.current = currentQuery.slice(0, -1);
      setQuery(queryRef.current);
      indexRef.current = 0;
      setListIndex(0);
      return;
    }
    if (key.upArrow) {
      indexRef.current = currentItems.length === 0
        ? 0
        : (indexRef.current - 1 + currentItems.length) % currentItems.length;
      setListIndex(indexRef.current);
      return;
    }
    if (key.downArrow) {
      indexRef.current = currentItems.length === 0
        ? 0
        : (indexRef.current + 1) % currentItems.length;
      setListIndex(indexRef.current);
      return;
    }
    if (key.return) {
      const sel = Math.min(indexRef.current, currentItems.length - 1);
      const item = currentItems[sel];
      if (!item) return;
      queryRef.current = "";
      setQuery("");
      indexRef.current = 0;
      setListIndex(0);
      if (item.value === "__back") {
        onBack();
      } else {
        onSelect(currentRows[sel]);
      }
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      queryRef.current += input;
      setQuery(queryRef.current);
      indexRef.current = 0;
      setListIndex(0);
    }
  });

  // 選択項目を中央に保つように表示範囲を決める (一覧が縦に伸びないよう上限で切る)
  const sel = Math.min(listIndex, Math.max(0, items.length - 1));
  const maxOffset = Math.max(0, items.length - LIST_LIMIT);
  const scrollOffset = Math.min(
    maxOffset,
    Math.max(0, sel - Math.floor((LIST_LIMIT - 1) / 2)),
  );
  const visible = items.slice(scrollOffset, scrollOffset + LIST_LIMIT);
  const hasMoreUp = scrollOffset > 0;
  const hasMoreDown = scrollOffset + LIST_LIMIT < items.length;

  return (
    <Box flexDirection="column">
      <Text bold>{title} ({filtered.length} 件)</Text>
      {description}
      <Box flexDirection="row">
        <Text color="cyan" bold>検索:</Text>
        {query
          ? <Text>{query}</Text>
          : <Text dimColor>文字入力で絞り込み</Text>}
      </Box>
      {filtered.length === 0 && query && <Text dimColor>{emptyMessage}</Text>}
      {hasMoreUp && <Text dimColor>...</Text>}
      {visible.map((item, i) => {
        const isSelected = scrollOffset + i === sel;
        return (
          <Box key={item.value} flexDirection="row">
            <Box marginRight={1}>
              <Text color={isSelected ? "cyan" : undefined}>
                {isSelected ? ">" : " "}
              </Text>
            </Box>
            <Text color={isSelected ? "cyan" : undefined}>
              {item.label}
            </Text>
          </Box>
        );
      })}
      {hasMoreDown && <Text dimColor>...</Text>}
      <Text dimColor>
        文字入力で絞り込み / ↑↓ 選択 / Enter 決定 / Backspace 編集 / Esc
        解除・戻る
      </Text>
    </Box>
  );
}
