# MachuPITA

論文PDFをレイアウトを極力保持したまま任意の言語へ翻訳するローカルアプリケーション。
Deno + [@deno-ink/core](https://jsr.io/@deno-ink/core)(React for CLI) による対話型CLIです。

仕様の詳細は [docs/SPEC.md](docs/SPEC.md) を参照してください。

## 構成

- CLI UI: Deno + @deno-ink/core (React for CLI、日本語UI固定)
- パイプライン: unpdf によるPDF解析、@earendil-works/pi-ai によるLLM翻訳、@cantoo/pdf-lib による再構築
- 認証情報・設定はアプリデータディレクトリの JSON に保存(APIキーは外部送信なし)

## セットアップ

```powershell
# 依存の解決
deno install

# 埋め込み用フォント(Noto Sans / Noto Sans JP)のダウンロード
# 初回起動時に自動実行されるため通常は不要(手動更新したい場合のみ実行)
deno task setup:fonts
```

## インストール (グローバルコマンド)

Deno が入っていれば、リポジトリ直下で1コマンドで `machupita` をグローバル登録できます:

```powershell
deno task install:global   # = deno install -g -A -c deno.json -n machupita main.ts
machupita --help           # どこからでも実行可能
```

- 初回起動時に埋め込みフォントが自動ダウンロードされます(失敗時は `deno task setup:fonts` を実行)
- インストール先は `~/.deno/bin`(Windows: `%USERPROFILE%\.deno\bin`)。PATH に無い場合は追加してください
- 解除は `deno uninstall -g machupita`。設定ファイルを変更した場合は再インストールしてください

## 実行

グローバルインストール済みなら、以下の `deno task cli ...` は `machupita ...` に置き換えられます。

```powershell
deno task cli                # 対話メニュー (翻訳 / 認証 / モデル選択 / 設定)
deno task cli auth           # プロバイダ認証 (APIキー入力 / OAuth ログイン / 解除)
deno task cli model          # モデル選択 (認証済みプロバイダから選択)
deno task cli settings       # 既定設定の表示・変更
deno task cli <PDF>          # PDF翻訳を直接実行 (既定設定を使用)
deno task cli --help         # ヘルプ表示
```

単一バイナリにコンパイルする場合:

```powershell
deno task compile            # machupita(.exe) を生成
```

### PDF翻訳の直接実行

PDFパスを指定すると既定設定で翻訳を実行します(設定は `deno task cli settings` で変更):

```powershell
deno task cli paper.pdf --lang en --format dual --out-dir out
```

主なオプション(すべて任意。未指定時は設定値を利用):

| オプション | 内容 |
|---|---|
| `--lang <code>` | 翻訳先プリセット (ja, en, zh-CN, zh-TW, ko, de, fr, es, pt, it, ru) |
| `--lang-free <text>` | 自由記述の翻訳指示(例: ビジネス文書調の中国語) |
| `--format <mono\|dual>` | mono: 翻訳のみ / dual: 交互バイリンガル |
| `--out-dir <dir>` | 成果物の出力先(既定: カレントディレクトリ) |
| `--concurrency <n>` / `--batch-size <n>` | 翻訳の並列数 / 1リクエストの文字予算 |
| `--mask-color <color>` / `--min-font-scale <n>` | マスク色 / フォント縮小下限 |
| `--provider <id>` / `--model <id>` | プロバイダ / モデルを明示指定 |
| `--faux` | LLMを使わずダミー翻訳で動作確認 |
| `--sidecar` | 段落対応JSON(`{名前}_sidecar.json`)も出力 |
| `--original` | 元PDFのコピー(`{名前}_original.pdf`)も出力 |

成果物は既定では翻訳のみPDFの `{名前}_translated.pdf` だけがカレントディレクトリに出力されます(出力形式が dual の場合は `{名前}_bilingual.pdf` も生成)。

## 使い方

1. `auth` でプロバイダを接続(APIキー入力、または ChatGPTサブスク/OpenAI Codex・GitHub Copilot の OAuth ログイン)
2. `model` で認証済みプロバイダからモデルを選択
3. PDFパスを指定して翻訳を実行(進捗は画面に表示)
4. 完了後、出力ディレクトリから翻訳PDFを取得

## テスト

```powershell
deno test -A       # 59テスト(解析/分類/翻訳モック/描画の視覚検証/可視性判定/CLI E2E/ジョブ管理)
deno task check    # 型チェック
deno lint          # 静的検査
```

LLMなしでパイプライン全体を試すには `MACHUPITA_FAUX=1` 環境変数か `--faux` を付けて実行してください(`FAUX:` で始まるダミー翻訳を流し込みます)。

## 既知の制限(v1)

- スキャンPDF(OCR必要)は非対応
- マスクした原文のテキストは不可視だが内容ストリームに残る(コピー&ペーストで出現しうる)
- 文字色は黒固定(マスク色は設定可能)
- 回転テキスト・極端な多段組では配置が崩れる場合がある
