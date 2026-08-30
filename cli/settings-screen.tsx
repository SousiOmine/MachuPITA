import { useEffect, useState } from "react";
import { Box, SelectInput, Text, TextInput, useInput } from "@deno-ink/core";
import type { SelectInputItem } from "@deno-ink/core";
import { LANGUAGE_PRESETS } from "../engine/settings.ts";
import type { Settings } from "../engine/settings.ts";
import type { AppCtx } from "./context.ts";

type FieldKey =
  | "lang"
  | "lang-free"
  | "format"
  | "concurrency"
  | "batch"
  | "mask"
  | "font-scale";

const FIELD_LABEL: Record<Exclude<FieldKey, "lang" | "format">, string> = {
  "lang-free": "翻訳先の自由記述",
  concurrency: "同時実行数",
  batch: "バッチ予算(文字)",
  mask: "マスク色",
  "font-scale": "フォント縮小下限",
};

function langLabel(s: Settings): string {
  if (s.targetLanguage === "free") {
    return `自由記述: ${s.targetLanguageFree ?? ""}`;
  }
  return LANGUAGE_PRESETS.find((l) => l.code === s.targetLanguage)?.label ??
    s.targetLanguage;
}

export function SettingsScreen({
  ctx,
  onBack,
}: {
  ctx: AppCtx;
  onBack: () => void;
}) {
  const [draft, setDraft] = useState<Settings | null>(null);
  const [editing, setEditing] = useState<FieldKey | null>(null);
  const [textValue, setTextValue] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    void ctx.settings.get().then(setDraft);
  }, [ctx]);

  useInput((_input, key) => {
    if (key.escape && editing) {
      setEditing(null);
      setNotice("");
    }
  });

  if (!draft) {
    return <Text>設定を読み込み中...</Text>;
  }

  // 個別フィールドの編集画面
  if (editing === "lang") {
    const items: SelectInputItem<string>[] = [
      ...LANGUAGE_PRESETS.map((l) => ({ label: l.label, value: l.code })),
      { label: "自由記述", value: "free" },
      { label: "← 戻る", value: "__back" },
    ];
    return (
      <Box flexDirection="column">
        <Text bold>翻訳先言語を選択</Text>
        <SelectInput
          items={items}
          onSelect={(item) => {
            if (item.value === "__back") {
              setEditing(null);
            } else if (item.value === "free") {
              setDraft({ ...draft, targetLanguage: "free" });
              setEditing(null);
            } else {
              setDraft({
                ...draft,
                targetLanguage: item.value,
                targetLanguageFree: undefined,
              });
              setEditing(null);
            }
          }}
        />
        <Text dimColor>Esc で戻る</Text>
      </Box>
    );
  }

  if (editing === "format") {
    const items: SelectInputItem<"mono" | "dual" | "__back">[] = [
      { label: "翻訳のみ", value: "mono" },
      { label: "交互バイリンガル", value: "dual" },
      { label: "← 戻る", value: "__back" },
    ];
    return (
      <Box flexDirection="column">
        <Text bold>出力形式を選択</Text>
        <SelectInput
          items={items}
          onSelect={(item) => {
            if (item.value === "__back") {
              setEditing(null);
            } else {
              setDraft({ ...draft, outputFormat: item.value });
              setEditing(null);
            }
          }}
        />
        <Text dimColor>Esc で戻る</Text>
      </Box>
    );
  }

  if (
    editing === "lang-free" || editing === "concurrency" ||
    editing === "batch" || editing === "mask" || editing === "font-scale"
  ) {
    const commit = (value: string) => {
      if (editing === "lang-free") {
        setDraft({
          ...draft,
          targetLanguage: "free",
          targetLanguageFree: value,
        });
        setEditing(null);
        return;
      }
      if (editing === "mask") {
        if (!/^#[0-9a-fA-F]{6}$/.test(value)) {
          setNotice("マスク色は #rrggbb 形式で入力してください");
          return;
        }
        setDraft({ ...draft, maskColor: value });
        setEditing(null);
        return;
      }
      const n = Number(value);
      if (!Number.isFinite(n)) {
        setNotice("数値で入力してください");
        return;
      }
      if (editing === "concurrency") {
        if (n < 1) {
          setNotice("同時実行数は 1 以上にしてください");
          return;
        }
        setDraft({ ...draft, concurrency: Math.floor(n) });
      } else if (editing === "batch") {
        if (n < 100) {
          setNotice("バッチ予算は 100 文字以上にしてください");
          return;
        }
        setDraft({ ...draft, batchSizeChars: Math.floor(n) });
      } else {
        setDraft({ ...draft, minFontScale: n });
      }
      setEditing(null);
      setNotice("");
    };

    const placeholder = editing === "lang-free"
      ? "例: ビジネス文書調の中国語"
      : editing === "mask"
      ? "#ffffff"
      : editing === "concurrency"
      ? String(draft.concurrency)
      : editing === "batch"
      ? String(draft.batchSizeChars)
      : String(draft.minFontScale);

    return (
      <Box flexDirection="column">
        <Text bold>{FIELD_LABEL[editing]}</Text>
        <TextInput
          value={textValue}
          onChange={setTextValue}
          onSubmit={commit}
          placeholder={placeholder}
        />
        <Text dimColor>Enter で確定、Esc でキャンセル</Text>
        {notice && <Text color="yellow">{notice}</Text>}
      </Box>
    );
  }

  const items: SelectInputItem<string>[] = [
    { label: `翻訳先言語: ${langLabel(draft)}`, value: "lang" },
    ...(draft.targetLanguage === "free"
      ? [{
        label: `自由記述: ${draft.targetLanguageFree ?? ""}`,
        value: "lang-free",
      }]
      : []),
    {
      label: `出力形式: ${
        draft.outputFormat === "dual" ? "交互バイリンガル" : "翻訳のみ"
      }`,
      value: "format",
    },
    { label: `同時実行数: ${draft.concurrency}`, value: "concurrency" },
    { label: `バッチ予算(文字): ${draft.batchSizeChars}`, value: "batch" },
    { label: `マスク色: ${draft.maskColor}`, value: "mask" },
    { label: `フォント縮小下限: ${draft.minFontScale}`, value: "font-scale" },
    { label: "保存して戻る", value: "save" },
    { label: "戻る(保存しない)", value: "back" },
  ];

  return (
    <Box flexDirection="column">
      <Text bold>設定</Text>
      <Text dimColor>
        翻訳の既定値です。translate コマンドのオプションで上書きできます。
      </Text>
      <SelectInput
        items={items}
        onSelect={async (item) => {
          if (item.value === "save") {
            const next: Settings = { ...draft };
            if (next.targetLanguage !== "free") {
              delete next.targetLanguageFree;
            }
            await ctx.settings.update(next);
            onBack();
          } else if (item.value === "back") {
            onBack();
          } else {
            setTextValue("");
            setNotice("");
            setEditing(item.value as FieldKey);
          }
        }}
      />
      {notice && <Text color="green">{notice}</Text>}
    </Box>
  );
}
