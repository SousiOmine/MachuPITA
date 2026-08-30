import { useState } from "react";
import { Box, SelectInput, Text, useApp } from "@deno-ink/core";
import type { SelectInputItem } from "@deno-ink/core";
import { AuthScreen } from "./auth-screen.tsx";
import { SettingsScreen } from "./settings-screen.tsx";
import { ProgressScreen, TranslateSetupScreen } from "./translate-screen.tsx";
import type { AppCtx } from "./context.ts";
import type {
  TranslateRequest,
  TranslateResult,
  TranslatorMode,
} from "./translate.ts";

export type Screen =
  | { kind: "menu" }
  | { kind: "auth" }
  | { kind: "settings" }
  | { kind: "translate-setup"; initialFile?: string }
  | { kind: "progress"; request: TranslateRequest; mode: TranslatorMode };

/** CLI 実行全体の結果 (run.ts が終了コードを決めるために共有) */
export interface CliOutcome {
  status: "running" | "done" | "error" | "cancelled";
  artifacts?: TranslateResult;
  error?: string;
}

export interface AppProps {
  ctx: AppCtx;
  initial: Screen;
  autoExit: boolean;
  outcome: CliOutcome;
}

export function App({ ctx, initial, autoExit, outcome }: AppProps) {
  const [screen, setScreen] = useState<Screen>(initial);
  const go = (next: Screen) => setScreen(next);

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="magenta">MachuPITA — 論文PDF翻訳 CLI</Text>
      {screen.kind === "menu" && <MenuScreen onNavigate={go} />}
      {screen.kind === "auth" && (
        <AuthScreen
          ctx={ctx}
          onBack={() => go({ kind: "menu" })}
        />
      )}
      {screen.kind === "settings" && (
        <SettingsScreen
          ctx={ctx}
          onBack={() => go({ kind: "menu" })}
        />
      )}
      {screen.kind === "translate-setup" && (
        <TranslateSetupScreen
          ctx={ctx}
          initialFile={screen.initialFile}
          onBack={() => go({ kind: "menu" })}
          onStart={(request, mode) => go({ kind: "progress", request, mode })}
        />
      )}
      {screen.kind === "progress" && (
        <ProgressScreen
          ctx={ctx}
          request={screen.request}
          mode={screen.mode}
          autoExit={autoExit}
          outcome={outcome}
          onBack={() => go({ kind: "menu" })}
        />
      )}
    </Box>
  );
}

type MenuValue = "translate" | "auth" | "settings" | "quit";

function MenuScreen({
  onNavigate,
}: {
  onNavigate: (screen: Screen) => void;
}) {
  const { exit } = useApp();
  const items: SelectInputItem<MenuValue>[] = [
    { label: "翻訳を実行", value: "translate" },
    { label: "プロバイダ認証・モデル選択", value: "auth" },
    { label: "設定", value: "settings" },
    { label: "終了", value: "quit" },
  ];
  return (
    <Box flexDirection="column">
      <Text dimColor>上下キーで選択、Enter で決定</Text>
      <SelectInput
        items={items}
        onSelect={(item) => {
          if (item.value === "quit") {
            exit();
          } else if (item.value === "translate") {
            onNavigate({ kind: "translate-setup" });
          } else {
            onNavigate({ kind: item.value });
          }
        }}
      />
    </Box>
  );
}
