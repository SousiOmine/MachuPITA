import { useEffect, useState } from "react";
import { Box, SelectInput, Spinner, Text, useInput } from "@deno-ink/core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AppCtx } from "./context.ts";
import { matchesProviderFilter } from "./auth-screen.tsx";
import { SearchableList } from "./searchable-list.tsx";

interface ConfiguredProvider {
  id: string;
  name: string;
  source?: string;
}

/** モデル絞り込み: 名前またはIDの部分一致 (大文字小文字を無視)。 */
export function matchesModelFilter(
  model: Pick<Model<Api>, "id" | "name">,
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    model.name.toLowerCase().includes(q) ||
    model.id.toLowerCase().includes(q)
  );
}

/** モデル選択画面: 認証済みプロバイダのモデルから選んで settings に保存する。 */
export function ModelScreen({
  ctx,
  onBack,
}: {
  ctx: AppCtx;
  onBack: () => void;
}) {
  const [providers, setProviders] = useState<ConfiguredProvider[] | null>(null);
  const [providerId, setProviderId] = useState<string | null>(null);
  const [models, setModels] = useState<Model<Api>[] | null>(null);
  const [current, setCurrent] = useState({ provider: "", model: "" });
  const [notice, setNotice] = useState("");

  useEffect(() => {
    void (async () => {
      const [statuses, settings] = await Promise.all([
        ctx.piai.listAuthStatuses(),
        ctx.settings.get(),
      ]);
      const byId = new Map(statuses.map((s) => [s.id, s]));
      setProviders(
        ctx.piai.listProviders()
          .filter((p) => byId.get(p.id)?.configured)
          .map((p) => ({
            id: p.id,
            name: p.name,
            source: byId.get(p.id)?.source,
          })),
      );
      setCurrent({ provider: settings.provider, model: settings.model });
    })();
  }, [ctx]);

  // 読み込み中・空の状態の Esc のみここで処理する
  // (一覧表示中は SearchableList がクエリ解除と戻るを処理する)
  useInput((_input, key) => {
    if (!key.escape) return;
    const listMounted =
      (!providerId && providers !== null && providers.length > 0) ||
      (providerId !== null && models !== null && models.length > 0);
    if (listMounted) return;
    if (providerId) {
      setProviderId(null);
      setModels(null);
    } else {
      onBack();
    }
  });

  if (providers === null) {
    return (
      <Box flexDirection="row" alignItems="center">
        <Spinner />
        <Box marginLeft={1}>
          <Text>読み込み中...</Text>
        </Box>
      </Box>
    );
  }

  if (providers.length === 0) {
    return (
      <Box flexDirection="column">
        <Text bold>モデル選択</Text>
        <Text>認証済みのプロバイダがありません。</Text>
        <Text dimColor>
          メニューの「プロバイダ認証」で APIキー入力または OAuth ログインを
          済ませてから選択してください。
        </Text>
        <SelectInput
          items={[{ label: "← 戻る", value: "back" as const }]}
          onSelect={() => onBack()}
        />
      </Box>
    );
  }

  if (!providerId) {
    return (
      <Box flexDirection="column">
        <SearchableList
          title="モデルを選択するプロバイダを選択"
          description={
            <>
              <Text dimColor>認証済みのプロバイダのみ表示しています。</Text>
              {current.provider && (
                <Text dimColor>
                  現在: {current.provider} / {current.model}
                </Text>
              )}
            </>
          }
          rows={providers}
          toItem={(p) => ({
            label: `${p.name}${p.id === current.provider ? " (使用中)" : ""}`,
            value: p.id,
          })}
          matches={matchesProviderFilter}
          emptyMessage="該当するプロバイダがありません。"
          onSelect={(p) => {
            setNotice("");
            setProviderId(p.id);
            setModels(null);
            void ctx.piai.listModels(p.id).then(setModels);
          }}
          onBack={onBack}
        />
        {notice && <Text color="green">{notice}</Text>}
      </Box>
    );
  }

  const provider = providers.find((p) => p.id === providerId);
  if (!provider) {
    return <Text>プロバイダが見つかりません。</Text>;
  }

  if (models === null) {
    return (
      <Box flexDirection="row" alignItems="center">
        <Spinner />
        <Box marginLeft={1}>
          <Text>{provider.name} のモデルを読み込み中...</Text>
        </Box>
      </Box>
    );
  }

  if (models.length === 0) {
    return (
      <Box flexDirection="column">
        <Text bold>{provider.name} のモデル</Text>
        <Text dimColor>
          モデルが見つかりません。プロバイダのカタログを確認してください。
        </Text>
        <SelectInput
          items={[{ label: "← 戻る", value: "back" as const }]}
          onSelect={() => {
            setProviderId(null);
            setModels(null);
          }}
        />
        <Text dimColor>Esc で戻る</Text>
      </Box>
    );
  }

  const isCurrent = (m: { id: string }) =>
    current.provider === providerId && current.model === m.id;
  return (
    <Box flexDirection="column">
      <SearchableList
        title={`${provider.name} のモデルを選択`}
        rows={models}
        toItem={(m) => ({
          label: `${m.name || m.id}${isCurrent(m) ? " (使用中)" : ""}`,
          value: m.id,
        })}
        matches={matchesModelFilter}
        emptyMessage="該当するモデルがありません。"
        onSelect={async (m) => {
          await ctx.settings.update({
            provider: providerId,
            model: m.id,
          });
          setCurrent({ provider: providerId, model: m.id });
          setNotice(`${provider.name}: ${m.id} を選択しました`);
          setProviderId(null);
          setModels(null);
        }}
        onBack={() => {
          setProviderId(null);
          setModels(null);
        }}
      />
    </Box>
  );
}
