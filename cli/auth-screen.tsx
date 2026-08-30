import { useCallback, useEffect, useState } from "react";
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
import { matchesNameOrId } from "./filter.ts";
import { SearchableList } from "./searchable-list.tsx";

interface ProviderRow {
  id: string;
  name: string;
  authType: "api_key" | "oauth" | "both";
  hasInteractiveLogin: boolean;
  configured: boolean;
  source?: string;
}

type View = "list" | "actions" | "api-key" | "oauth";

/** 認証種別の表示ラベル(api_key / oauth / both)。 */
function authTypeLabel(type: ProviderRow["authType"]): string {
  switch (type) {
    case "oauth":
      return "OAuth";
    case "both":
      return "OAuth / APIキー";
    default:
      return "APIキー";
  }
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

  // 各画面のキー操作 (Esc で戻る / OAuth 中断)
  // プロバイダ一覧の絞り込みと選択は SearchableList が処理する
  useInput((_input, key) => {
    if (view === "list") return;
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
      }
      return;
    }
  });

  const selected = providers.find((p) => p.id === providerId);

  if (view === "list") {
    return (
      <Box flexDirection="column">
        <SearchableList
          title="プロバイダを選択"
          rows={providers}
          toItem={(p) => ({
            label: `${p.name} [${authTypeLabel(p.authType)}]` +
              (p.configured ? " ✓接続済み" : " 未設定"),
            value: p.id,
          })}
          matches={matchesNameOrId}
          emptyMessage="該当するプロバイダがありません。"
          onSelect={(p) => {
            setProviderId(p.id);
            setNotice("");
            setView("actions");
          }}
          onBack={onBack}
        />
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
  if (selected.authType === "api_key" || selected.authType === "both") {
    actions.push({ label: "APIキーを入力", value: "key" });
  }
  if (selected.authType === "oauth" || selected.authType === "both") {
    if (selected.hasInteractiveLogin) {
      actions.push({ label: "OAuth ログイン", value: "oauth" });
    }
  }
  if (selected.configured) {
    actions.push({ label: "認証を解除", value: "logout" });
  }
  actions.push({ label: "← 戻る", value: "back" });

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" alignItems="center">
        <Text bold>{selected.name}</Text>
        <Box marginLeft={1} flexDirection="row">
          {(selected.authType === "oauth" || selected.authType === "both") && (
            <Badge color="cyan">OAuth</Badge>
          )}
          {(selected.authType === "api_key" || selected.authType === "both") &&
            (
              <Box marginLeft={1}>
                <Badge color="blue">APIキー</Badge>
              </Box>
            )}
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
