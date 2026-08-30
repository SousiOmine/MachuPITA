import { useCallback, useEffect, useRef, useState } from "react";
import {
  Badge,
  Box,
  SelectInput,
  Spinner,
  Text,
  TextInput,
  useInput,
} from "@deno-ink/core";
import type { SelectInputItem } from "@deno-ink/core";
import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";
import type { AppCtx } from "./context.ts";

interface ProviderRow {
  id: string;
  name: string;
  authType: "api_key" | "oauth";
  hasInteractiveLogin: boolean;
  configured: boolean;
  source?: string;
}

type View = "list" | "actions" | "api-key" | "oauth";

/** プロバイダ絞り込み: 名前またはIDの部分一致 (大文字小文字を無視)。 */
export function matchesProviderFilter(
  provider: Pick<ProviderRow, "id" | "name">,
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    provider.name.toLowerCase().includes(q) ||
    provider.id.toLowerCase().includes(q)
  );
}

/** プロバイダ一覧の表示行数上限 (超過分はスクロールで表示)。 */
const PROVIDER_LIST_LIMIT = 10;

/** プロバイダ一覧の表示項目 (絞り込み済みリスト + 「← 戻る」)。 */
export function buildProviderItems(
  providers: Pick<ProviderRow, "id" | "name" | "authType" | "configured">[],
  query: string,
): SelectInputItem<string>[] {
  const q = query.trim().toLowerCase();
  const filtered = q
    ? providers.filter((p) => matchesProviderFilter(p, q))
    : providers;
  return [
    ...filtered.map((p) => ({
      label: `${p.name} [${p.authType === "oauth" ? "OAuth" : "APIキー"}]` +
        (p.configured ? " ✓接続済み" : " 未設定"),
      value: p.id,
    })),
    { label: "← 戻る", value: "__back" },
  ];
}

export function AuthScreen({
  ctx,
  onBack,
}: {
  ctx: AppCtx;
  onBack: () => void;
}) {
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [view, setView] = useState<View>("list");
  const [providerId, setProviderId] = useState<string | null>(null);
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [promptAnswer, setPromptAnswer] = useState("");
  const [notice, setNotice] = useState("");
  const [tick, setTick] = useState(0);
  const [filterQuery, setFilterQuery] = useState("");
  const [listIndex, setListIndex] = useState(0);
  const queryRef = useRef("");
  const indexRef = useRef(0);
  const providersRef = useRef(providers);
  providersRef.current = providers;

  const reload = useCallback(async () => {
    const statuses = await ctx.piai.listAuthStatuses();
    const byId = new Map(statuses.map((s) => [s.id, s]));
    setProviders(
      ctx.piai.listProviders().map((p) => ({
        ...p,
        configured: byId.get(p.id)?.configured ?? false,
        source: byId.get(p.id)?.source,
      })),
    );
  }, [ctx]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // OAuth フロー中はポーリングして状態遷移を拾う
  useEffect(() => {
    if (view !== "oauth" || !providerId) return;
    const t = setInterval(() => setTick((x) => x + 1), 200);
    return () => clearInterval(t);
  }, [view, providerId]);

  // ログイン完了 → アクション一覧へ / 失敗 → アクション一覧へ
  useEffect(() => {
    if (view !== "oauth" || !providerId) return;
    const st = ctx.piai.getLoginState(providerId);
    if (st?.phase === "done") {
      void reload();
      setNotice(
        "認証が完了しました。モデルはメニューの「モデル選択」から選べます",
      );
      setView("actions");
    } else if (st?.phase === "error") {
      setNotice(st.error ?? "ログインに失敗しました");
      setView("actions");
    }
  }, [view, providerId, tick]);

  // 各画面のキー操作 (Esc で戻る / OAuth 中断 / プロバイダ一覧の絞り込みと選択)
  // 一覧操作は ref を介して最新状態を参照する (同一入力バースト内の連続キーでも
  // stale な state を参照しないため。SelectInput では絞り込み前のリストが
  // Enter に使われて先頭プロバイダを選んでしまう問題があった)
  useInput((input, key) => {
    if (view === "oauth" && providerId) {
      if (key.escape) {
        ctx.piai.cancelLogin(providerId);
        setPromptAnswer("");
        setView("actions");
      }
      return;
    }
    if (view === "api-key") {
      if (key.escape) setView("actions");
      return;
    }
    if (view === "actions") {
      if (key.escape) {
        setProviderId(null);
        setView("list");
        indexRef.current = 0;
        setListIndex(0);
      }
      return;
    }
    if (view !== "list") return;

    const items = buildProviderItems(providersRef.current, queryRef.current);

    if (key.escape) {
      if (queryRef.current) {
        queryRef.current = "";
        setFilterQuery("");
      } else {
        onBack();
      }
      indexRef.current = 0;
      setListIndex(0);
      return;
    }
    if (key.backspace) {
      queryRef.current = queryRef.current.slice(0, -1);
      setFilterQuery(queryRef.current);
      indexRef.current = 0;
      setListIndex(0);
      return;
    }
    if (key.upArrow) {
      indexRef.current = items.length === 0
        ? 0
        : (indexRef.current - 1 + items.length) % items.length;
      setListIndex(indexRef.current);
      return;
    }
    if (key.downArrow) {
      indexRef.current = items.length === 0
        ? 0
        : (indexRef.current + 1) % items.length;
      setListIndex(indexRef.current);
      return;
    }
    if (key.return) {
      const item = items[indexRef.current] ?? items[0];
      if (!item) return;
      if (item.value === "__back") {
        onBack();
      } else {
        setProviderId(item.value);
        queryRef.current = "";
        setFilterQuery("");
        indexRef.current = 0;
        setListIndex(0);
        setNotice("");
        setView("actions");
      }
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      queryRef.current += input;
      setFilterQuery(queryRef.current);
      indexRef.current = 0;
      setListIndex(0);
    }
  });

  const selected = providers.find((p) => p.id === providerId);

  if (view === "list") {
    const items = buildProviderItems(providers, filterQuery);
    // 選択項目を中央に保つように表示範囲を決める (一覧が縦に伸びないよう上限で切る)
    const sel = Math.min(listIndex, Math.max(0, items.length - 1));
    const maxOffset = Math.max(0, items.length - PROVIDER_LIST_LIMIT);
    const scrollOffset = Math.min(
      maxOffset,
      Math.max(0, sel - Math.floor((PROVIDER_LIST_LIMIT - 1) / 2)),
    );
    const visible = items.slice(
      scrollOffset,
      scrollOffset + PROVIDER_LIST_LIMIT,
    );
    const hasMoreUp = scrollOffset > 0;
    const hasMoreDown = scrollOffset + PROVIDER_LIST_LIMIT < items.length;
    const providerCount = filterQuery
      ? providers.filter((p) => matchesProviderFilter(p, filterQuery)).length
      : providers.length;
    return (
      <Box flexDirection="column">
        <Text bold>プロバイダを選択 ({providerCount} 件)</Text>
        <Box flexDirection="row">
          <Text color="cyan" bold>検索:</Text>
          {filterQuery
            ? <Text>{filterQuery}</Text>
            : <Text dimColor>文字入力で絞り込み</Text>}
        </Box>
        {items.length === 1 && filterQuery && (
          <Text dimColor>該当するプロバイダがありません。</Text>
        )}
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

  if (!selected) {
    return <Text>プロバイダが見つかりません。</Text>;
  }

  if (view === "api-key") {
    return (
      <Box flexDirection="column">
        <Text bold>{selected.name} の APIキーを入力</Text>
        <TextInput
          value={apiKeyDraft}
          onChange={setApiKeyDraft}
          mask="*"
          placeholder="sk-..."
          onSubmit={async (value) => {
            const key = value.trim();
            if (!key) {
              setNotice("APIキーが空です");
              return;
            }
            await ctx.piai.saveApiKey(selected.id, key);
            await reload();
            setApiKeyDraft("");
            setNotice(
              "APIキーを保存しました。モデルはメニューの「モデル選択」から選べます",
            );
            setView("actions");
          }}
        />
        <Text dimColor>Enter で保存、Esc でキャンセル</Text>
        {notice && <Text color="yellow">{notice}</Text>}
      </Box>
    );
  }

  if (view === "oauth") {
    const st = ctx.piai.getLoginState(selected.id);
    return (
      <Box flexDirection="column">
        <Text bold>{selected.name} の OAuth ログイン</Text>
        {!st ? <Text>ログイン状態を取得できませんでした。</Text> : (
          <OAuthFlow
            state={st}
            promptValue={promptAnswer}
            onPromptChange={setPromptAnswer}
            onAnswer={(value) => {
              ctx.piai.answerPrompt(selected.id, value);
              setPromptAnswer("");
            }}
          />
        )}
      </Box>
    );
  }

  const actions: SelectInputItem<string>[] = [];
  if (selected.authType === "api_key") {
    actions.push({ label: "APIキーを入力", value: "key" });
  }
  if (selected.authType === "oauth" && selected.hasInteractiveLogin) {
    actions.push({ label: "OAuth ログイン", value: "oauth" });
  }
  if (selected.configured) {
    actions.push({ label: "認証を解除", value: "logout" });
  }
  actions.push({ label: "← 戻る", value: "back" });

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" alignItems="center">
        <Text bold>{selected.name}</Text>
        <Box marginLeft={1}>
          {selected.authType === "oauth"
            ? <Badge color="cyan">OAuth</Badge>
            : <Badge color="blue">APIキー</Badge>}
        </Box>
        {selected.configured && (
          <Box marginLeft={1}>
            <Badge color="green">接続済み</Badge>
          </Box>
        )}
      </Box>
      {selected.source && <Text dimColor>認証ソース: {selected.source}</Text>}
      <SelectInput
        items={actions}
        onSelect={(item) => {
          switch (item.value) {
            case "key":
              setNotice("");
              setView("api-key");
              break;
            case "oauth":
              setNotice("");
              ctx.piai.startLogin(selected.id);
              setView("oauth");
              break;
            case "logout":
              void ctx.piai.logout(selected.id).then(async () => {
                await reload();
                setNotice("認証を解除しました");
              });
              break;
            case "back":
              setProviderId(null);
              setView("list");
              break;
          }
        }}
      />
      {notice && <Text color="green">{notice}</Text>}
      <Text dimColor>Esc でプロバイダ一覧へ</Text>
    </Box>
  );
}

function OAuthFlow({
  state,
  promptValue,
  onPromptChange,
  onAnswer,
}: {
  state: {
    phase: "idle" | "in_progress" | "awaiting_input" | "done" | "error";
    events: (AuthEvent & { at: number })[];
    pendingPrompt?: {
      kind: AuthPrompt["type"];
      message: string;
      options?: readonly { id: string; label: string; description?: string }[];
    };
  };
  promptValue: string;
  onPromptChange: (value: string) => void;
  onAnswer: (value: string) => void;
}) {
  const events = state.events.slice(-4);
  const prompt = state.pendingPrompt;

  if (state.phase === "awaiting_input" && prompt) {
    if (prompt.kind === "select") {
      const items: SelectInputItem<string>[] = (prompt.options ?? []).map(
        (o) => ({
          label: o.description ? `${o.label} (${o.description})` : o.label,
          value: o.id,
        }),
      );
      return (
        <Box flexDirection="column">
          <Text>{prompt.message}</Text>
          <SelectInput
            items={items}
            onSelect={(item) => onAnswer(item.value)}
          />
        </Box>
      );
    }
    return (
      <Box flexDirection="column">
        <Text>{prompt.message}</Text>
        <TextInput
          value={promptValue}
          onChange={onPromptChange}
          onSubmit={onAnswer}
          mask={prompt.kind === "secret" ? "*" : undefined}
        />
        <Text dimColor>Enter で送信、Esc で中断</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" alignItems="center">
        <Spinner />
        <Box marginLeft={1}>
          <Text>
            {state.phase === "done"
              ? "完了処理中..."
              : state.phase === "error"
              ? "失敗しました"
              : "ログイン中... ブラウザまたは端末で認証してください"}
          </Text>
        </Box>
      </Box>
      {events.map((e, i) => <Text key={i} dimColor>{formatAuthEvent(e)}</Text>)}
      <Text dimColor>Esc で中断</Text>
    </Box>
  );
}

function formatAuthEvent(e: AuthEvent & { at: number }): string {
  switch (e.type) {
    case "info":
      return e.message + (e.links?.map((l) => ` ${l.url}`).join("") ?? "");
    case "auth_url":
      return `認証URL: ${e.url}${e.instructions ? ` (${e.instructions})` : ""}`;
    case "device_code":
      return `デバイスコード: ${e.userCode} — ${e.verificationUri}`;
    case "progress":
      return e.message;
  }
}
