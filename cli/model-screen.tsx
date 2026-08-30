import { useEffect, useState } from "react";
import { Box, SelectInput, Spinner, Text, useInput } from "@deno-ink/core";
import type { SelectInputItem } from "@deno-ink/core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AppCtx } from "./context.ts";

interface ConfiguredProvider {
  id: string;
  name: string;
  source?: string;
}

/** モデル選択画面のプロバイダ一覧 (認証済みのみ + 使用中マーク + 「← 戻る」)。 */
export function buildModelProviderItems(
  providers: Pick<ConfiguredProvider, "id" | "name">[],
  currentProvider: string,
): SelectInputItem<string>[] {
  return [
    ...providers.map((p) => ({
      label: `${p.name}${p.id === currentProvider ? " (使用中)" : ""}`,
      value: p.id,
    })),
    { label: "← 戻る", value: "__back" },
  ];
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

  useInput((_input, key) => {
    if (!key.escape) return;
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
    const items = buildModelProviderItems(providers, current.provider);
    return (
      <Box flexDirection="column">
        <Text bold>モデルを選択するプロバイダを選択</Text>
        <Text dimColor>認証済みのプロバイダのみ表示しています。</Text>
        {current.provider && (
          <Text dimColor>
            現在: {current.provider} / {current.model}
          </Text>
        )}
        <SelectInput
          items={items}
          onSelect={(item) => {
            if (item.value === "__back") {
              onBack();
              return;
            }
            setNotice("");
            setProviderId(item.value);
            setModels(null);
            void ctx.piai.listModels(item.value).then(setModels);
          }}
        />
        {notice && <Text color="green">{notice}</Text>}
        <Text dimColor>Esc で戻る</Text>
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
  const items: SelectInputItem<string>[] = models.map((m) => ({
    label: `${m.name || m.id}${isCurrent(m) ? " (使用中)" : ""}`,
    value: m.id,
  }));
  return (
    <Box flexDirection="column">
      <Text bold>{provider.name} のモデルを選択</Text>
      <SelectInput
        items={items}
        onSelect={async (item) => {
          await ctx.settings.update({
            provider: providerId,
            model: item.value,
          });
          setCurrent({ provider: providerId, model: item.value });
          setNotice(`${provider.name}: ${item.value} を選択しました`);
          setProviderId(null);
          setModels(null);
        }}
      />
      {notice && <Text color="green">{notice}</Text>}
      <Text dimColor>Esc でプロバイダ一覧へ</Text>
    </Box>
  );
}
