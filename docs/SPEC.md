# MachuPITA 仕様書 (v1)

論文PDFをレイアウトを極力保持したまま任意の言語へ翻訳するローカルアプリケーション。

## 1. 決定事項サマリ

| 項目 | 決定 |
|---|---|
| アプリ名 | MachuPITA |
| 実行形態 | 対話型CLI (PDFパス指定によるバッチ実行)。Webサーバー/デスクトップ形態は持たない |
| CLI UI | @deno-ink/core (React for CLI、DenoネイティブのInk移植) |
| UI言語 | 日本語固定 |
| PDF解析 | unpdf (同梱のPDF.jsサーバーレスビルド経由で位置情報付きテキスト抽出) |
| PDF再構築 | @cantoo/pdf-lib (+ fontkit によるフォント埋め込み) |
| LLM連携 | @earendil-works/pi-ai (CLIプロセスのみで実行) |
| 出力形式 | 翻訳のみPDF / バイリンガルPDF(原文頁と訳文頁の交互挿入)をジョブ毎に選択 |
| スキャンPDF(OCR) | v1対象外(デジタルPDFのみ) |
| v1機能範囲 | 翻訳実行に必要な最小構成(認証+変換)。履歴・用語集等は未搭載 |

## 2. システムアーキテクチャ

```
[CLI (Deno + @deno-ink/core)]  → [engine: パイプライン]
   main.ts                        ├─ extract: unpdf 解析
   cli/ (画面・コマンド)           ├─ layout/classify
                                  ├─ translate: pi-ai
                                  └─ render: @cantoo/pdf-lib
```

### 2.1 実行モード

- **対話モード**: `deno task cli` でメニューを表示し、翻訳 / 認証 / モデル選択 / 設定を画面遷移で操作する。
- **バッチモード**: `deno task cli <PDF> [options]` でPDFパスを引数に直接実行し、完了後に成果物サマリを出力して終了する(終了コード: 成功0 / エラー・中止1 / 引数エラー2)。サブコマンドは持たず、PDFパスが第一引数の場合に翻訳を実行する。
- **認証フロー**: OAuth等の対話入力を必要とする場合のみ CLI 上でプロンプト(テキスト入力・選択肢)を出し、それ以外は非対話で完結する。

### 2.2 ディレクトリ構成

```
MachuPITA/
├─ deno.json          # tasks / imports / compilerOptions
├─ main.ts            # エントリ (cli/run.ts を呼ぶだけ)
├─ engine/            # パイプライン本体 (旧 engine/。HTTP依存なし)
│  ├─ core/
│  │  ├─ extract.ts   # unpdf によるテキスト抽出
│  │  ├─ layout.ts    # 行/段落/段組解析・読み順決定
│  │  ├─ classify.ts  # 翻訳不要領域の判定
│  │  ├─ translate.ts # pi-ai 実行・バッチング・リトライ
│  │  └─ render.ts    # pdf-lib によるマスク+再描画
│  ├─ jobs.ts         # ジョブ状態管理・進捗イベント
│  ├─ settings.ts     # 設定の読み書き (AppPaths/プリセット)
│  └─ piai/           # pi-ai 接続 (service.ts / 資格情報ストア)
├─ cli/               # CLI UI (@deno-ink/core)
│  ├─ run.ts          # 引数解析・コンテキスト作成・render マウント
│  ├─ app.tsx         # 画面ルーティング (メニュー)
│  ├─ auth-screen.tsx     # プロバイダ認証 (APIキー/OAuth/解除)
│  ├─ model-screen.tsx    # モデル選択 (認証済みプロバイダのみ)
│  ├─ settings-screen.tsx # 既定設定の変更
│  ├─ translate-screen.tsx# 翻訳ウィザード・進捗表示
│  ├─ translate.ts    # 翻訳ドライバ (ジョブ開始/成果物コピー)
│  └─ context.ts      # 共有コンテキスト型
├─ assets/fonts/      # 埋め込み用フォント (Noto Sans 系列)
├─ tests/             # deno test (layout/classify/翻訳モック/CLI E2E/フィクスチャPDF)
└─ docs/SPEC.md
```

## 3. PDF翻訳パイプライン

### 3.1 抽出 (engine/core/extract.ts)

- `unpdf` の `getDocumentProxy(new Uint8Array(bytes))` で PDFDocumentProxy を取得(unpdf 同梱の PDF.js サーバーレスビルドを使用。CMap/標準フォントは unpdf が自動解決)。
- 各頁に対し `page.getTextContent()` を直接呼び出し、テキストアイテム単位で以下を取得する(`extractText` の平文APIではなく位置情報が必要なためプロキシ経由):
  - 変換行列 → PDF座標系(x, y, 幅)に正規化
  - 文字列、フォント名、実効フォントサイズ(変換行列から算出)
- 頁サイズ(viewport)も併せて記録。
- **不可視テキストの除外**: 図の中にはクリップ領域外・白塗りなど「実際には表示されないテキスト」(pdf.js の getTextContent はクリッピングを無視するため抽出されてしまう)が含まれる。オペレータリストを軽量解釈し(CTM/クリップ/Form BBox/レンダリングモード/塗り色の追跡)、表示されないテキストの原点を検出して抽出項目から除外する。検出に失敗した場合は除外なしで続行する。

### 3.2 レイアウト解析 (engine/core/layout.ts)

1. **行組立**: baseline y の近接性(フォントサイズ依存の閾値)でテキストアイテムを行にグルーピング。行内は x 順にソートし、字間ギャップが閾値超なら分割候補とする。上付き・下付き・分数など行内でフォントサイズが混在する項目は、大きい側のフォントサイズに比例した拡張許容差で主行に取り込む。著者グリッド・表など行内に大きい余白(既定 1.2em 以上)を含む行は**セルに分割**し、各セルを独立ブロックとして扱う(段落統合でグリッドが崩れるのを防ぐ)。セル行列全体が数式の体裁を持つ場合は全セルを翻訳対象外にする。
2. **段落組立**: 行間の垂直ギャップ、インデント、フォントサイズ変化から段落を合成。段落 bbox = 構成行 bbox の和集合。分数・数式の極端に小さい短い断片は段落に混入させない。左右両端に接する行が大半の段落(両端揃え)は中央揃え判定から除外する。
3. **段組検出**: 頁全体の行の x 分布からカラム境界を推定(中央縦方向の空白帯検出)。2段/3段に対応。読み順は「カラム単位で上から下」。
4. **スタイル属性**: 段落ごとに代表フォントサイズ(最頻値)、太字判定(フォント名に Bold を含むか)を記録。

### 3.3 分類 (engine/core/classify.ts)

翻訳対象から除外するもの(原文のまま保持):

- 数字・記号のみの行(頁番号、図表ラベル中の純数値等)
- 数式と推定される領域(記号比率、短さ、フォント混在のヒューリスティクス)。加えて、数学演算子(`=` `√` `≤` 等)を含み文の終止符を伴わない短いテキスト(ディスプレイ数式など)は翻訳せず原文を保持する
- DOI / URL / メールアドレスのみの行

段落内の保護対象はプレースホルト化する: 引用 `[12]`, `(Smith et al., 2020)`, 式断片 `x^2 + ...` 等を `{P0}, {P1}...` トークンに置換し、翻訳後に復元。復元不能トークンが残った場合は当該段落のみ原文フォールバック。

### 3.4 翻訳 (engine/core/translate.ts)

- **ユニット**: 段落。文脈のため前後段落の先頭文を参考情報としてプロンプトに付与(出力には含めない)。
- **用語集(グロッサリ)**: 翻訳の前に `glossary` ステージで本文の一部(上限 48,000 字、超過時は文書全体から間引き)を LLM に渡し、専門用語・造語の統一訳語リストを抽出する(engine/core/glossary.ts)。定訳がない語は target=source(英語保持)として登録され、訳文中でも英語のまま残る。抽出した用語集は全バッチのシステムプロンプトに注入して訳語の文書内統一を強制する。使い捨て(キャッシュ・永続化なし)。抽出に失敗した場合は警告を出してグロッサリなしで翻訳を続行する。用語集の内容は `--sidecar` 出力の JSON にも記録される。
- **バッチング**: 文字数予算(既定 3,000 字/リクエスト、設定変更可)で複数段落を1リクエストに束ねる。入出力とも JSON 配列(`[{ "id": ..., "translation": ... }]`)。
- **システムプロンプト**: 学術文書翻訳専用。指示内容: 対象言語への翻訳、学術調レジスタの固定、プレースホルダの保護、説明の追加禁止、JSON以外の出力禁止、同一原語への訳語統一、定訳のない造語・固有名詞は英語保持(初出は `訳語 (Original Term)` 形式の原文併記可)。日本語ターゲット時のみ、文末を常体(だ・である調)で統一し敬体(です・ます調)を使わない旨を明記する。
- **信頼性**: JSON パース失敗時は最大2回リトライ(プロンプト強調+温度低減)。それでも失敗した段落は原文のまま継続し、警告として UI に表示。
- **同時実行**: 並列リクエスト数を設定可能(既定 3)。AbortController によるキャンセル伝播。
- **トークン/コスト**: pi-ai の usage イベントから累計消費を集計し、進捗画面に表示(金額換算は pi-ai の価格メタデータがあれば表示、なければトークン数のみ)。

### 3.5 再構築 (engine/core/render.ts)

- `@cantoo/pdf-lib` で元PDFを `PDFDocument.load`。
- 翻訳済み段落ごとに:
  1. 元 bbox を背景色矩形でマスク(既定 白、設定で変更可。v1 は背景色推定を行わない)。
  2. 埋め込みフォント(Noto Sans Regular/Bold、fontkit で `subset: true` 埋め込み)により、bbox 内でワードラップしつつ描画。溢れる場合はフォントサイズを段階的に縮小(下限制御あり)。CJK は任意位置で改行可、欧文は空白区切り。行頭に来せたくない句読点・閉じ括弧は前の行に引き込む(禁則処理)。訳文は bbox の高さに厳密に収め、隣接ブロックとの重複を起こさない。
  3. 太字段落には Bold フォントを使用。
  4. グリフ欠落対策: 文字単位でグリフを持ち、両フォントにない文字(例: `∗` U+2217)は置換表(`*` など)経由で描画する。CJK 訳文中的な欧文・数学記号は Latin/JP フォントを文字単位で切り替えて描画する。
- **バイリンガル出力**: `copyPages` で全頁を複製し、複製側にのみ翻訳を適用、原文頁との交互順で新規ドキュメントに再構成。
- メタデータ(Title 等)は可能な範囲で維持。

### 3.6 制約(v1時点で明示)

- 文字色は黒固定(設定で一括変更可)。PDF.js の getTextContent は塗り色を保持しないため。getOperatorList による色推定は将来改善項目。
- 回転テキスト・複雑な表内テキスト・多段組(4段以上)は誤配置の可能性がある。
- 図・数式は「触らない」ことで保持する(画像化・再組版はしない)。
- マスクした原文テキストは不可視だが内容ストリームに残存する(テキスト抽出では取得可能)。演算子削除は将来改善項目。

## 3a. 実装メモ(v1実装時に確定した事項)

- フォント: Google Fonts CSS API(レガシーUAでTTFを取得)から Noto Sans / Noto Sans JP の Regular/Bold を `deno task setup:fonts` で `assets/fonts/` にダウンロードして使用(fontkit により subset 埋め込み)。
- テキスト抽出時、PDF.js はバッファをワーカーへ移譲するため unpdf へ渡す前にコピーする(extract.ts)。
- 描画検証は unpdf `renderPageAsImage`(canvasImport に @napi-rs/canvas を注入)+ ピクセルサンプリングで自動化(tests/pipeline.test.ts)。
- LLMなしの動作確認用に `MACHUPITA_FAUX=1` 環境変数または `--faux` で起動すると FauxEchoTranslator(`FAUX:` 接頭辞のダミー翻訳)が使われる。
- OAuth ログインは pi-ai の provider 所有フローを CLI プロセス内で駆動する。`AuthInteraction.prompt` を @deno-ink/core の TextInput / SelectInput に直接結線し、auth_url / device_code / 手入力プロンプトは画面内に逐次表示する(HTTP ポーリング等は不要。`PiaiService.getLoginState` の状態オブジェクトを 200ms 間隔の再描画で追跡)。
- デスクトップ・Web配布物は持たない。`deno compile` で単一バイナリ化できる。モデルは SPEC §4 の対応プロバイダだけを個別ファクトリ import で登録するため、`providers/all` による全体登録よりもバンドルを小さく抑えられる。

## 4. LLM連携 (@earendil-works/pi-ai)

- 実行は完全に CLI プロセス内。APIキー・トークンは端末に露出しない(入力はマスク表示)。
- `Models` コレクションに必要なプロバイダのみ登録(バンドルサイズ最適化のため個別ファクトリ import)。
- 対応プロバイダ(v1):
  - APIキー型: OpenAI, Anthropic, Google, OpenRouter, xAI, Mistral, Groq, DeepSeek, DeepInfra, Azure OpenAI, Amazon Bedrock ほか
  - OAuth型(サブスク利用): **OpenAI Codex(ChatGPT Plus/Pro)**, GitHub Copilot
  - カスタム: OpenAI互換エンドポイント(baseUrl + key)で Ollama / LM Studio / vLLM 等に接続(CLI v1 では APIキー型プロバイダとして auth.json に保存)
- 認証フロー (cli/auth-screen.tsx):
  - 一覧: `auth` 画面に全プロバイダを認証方式・接続状態つきで表示。APIキーとOAuthの両方を持つプロバイダは `both` として両方の選択肢を表示する。
  - APIキー型: マスク付き TextInput で入力 → `FileCredentialStore`(pi-ai の CredentialStore 互換形式、auth.json)に保存。
  - OAuth型: `PiaiService.startLogin` でブラウザ/デバイスコードフローを起動。イベント(認証URL・デバイスコード・進捗)を画面上に表示し、プロンプト(text / secret / select / manual_code)を TextInput / SelectInput で応答。ログイン完了後はアクション一覧へ戻る(モデル選択は `model` 画面で実施)。トークンは自動リフレッシュ。
  - 解除: 一覧の「認証を解除」で `logout`。状態は `listAuthStatuses` で確認。
- モデル選択フロー (cli/model-screen.tsx): `model` 画面は **認証済みプロバイダのみ**を一覧表示(未認証は案内のみ)。プロバイダ選択 → pi-ai のレジストリ(`getModels` 相当)からモデル一覧を取得し、SelectInput で選択 → settings.json の `provider` / `model` に保存。現在の設定値には「(使用中)」マークを付ける。

## 5. CLIインターフェース設計

| コマンド | 内容 |
|---|---|
| `machupita` (引数なし) | 対話メニュー(翻訳 / 認証 / モデル選択 / 設定)を @deno-ink/core で表示 |
| `machupita auth` | プロバイダ認証画面を直接開く |
| `machupita model` | モデル選択画面(認証済みプロバイダのみ)を直接開く |
| `machupita settings` | 既定設定(言語/出力形式/同時実行数/バッチ予算/マスク色/フォント縮小下限)を変更 |
| `machupita <PDF> [options]` | PDF翻訳を実行(非対話で完結可能。未指定の設定は既定値を利用) |
| `machupita --help` | ヘルプ表示 |

翻訳オプション:

| オプション | 内容 |
|---|---|
| `--lang <code>` | 翻訳先プリセット (ja, en, zh-CN, zh-TW, ko, de, fr, es, pt, it, ru) |
| `--lang-free <text>` | 自由記述の翻訳指示(コードは `free` 扱い) |
| `--format <mono\|dual>` | mono: 翻訳のみ / dual: 交互バイリンガル |
| `--out-dir <dir>` | 成果物出力先(既定: カレントディレクトリ) |
| `--concurrency <n>` / `--batch-size <n>` | 並列実行数 / バッチ文字予算 |
| `--mask-color <color>` / `--min-font-scale <n>` | マスク色 / フォント縮小下限 |
| `--provider <id>` / `--model <id>` | 設定を上書きしてプロバイダ/モデル指定 |
| `--faux` | ダミー翻訳で実行(環境変数 `MACHUPITA_FAUX=1` と同等) |
| `--sidecar` / `--original` | 追加成果物(段落対応JSON / 元PDFコピー)も出力 |

- 進捗はステージ(extract/analyze/translate/render)、頁単位 ProgressBar、段落カウント、token 集計を画面表示。`q` キーでジョブ中止。
- 成果物は既定では翻訳のみPDF `{名前}_translated.pdf` のみを `--out-dir`(既定: カレントディレクトリ)にコピーする。出力形式が dual の場合は `{名前}_bilingual.pdf` も生成され、`--sidecar` / `--original` 指定時のみ `{名前}_sidecar.json`(段落対応JSON: id, page, bbox, original, translation) / `{名前}_original.pdf` もコピーされる。ジョブの一時ファイルは OS 一時ディレクトリ配下に置き、OS が掃除する。
- 終了コード: 成功0 / エラー・中止1 / 引数エラー2。

## 6. UI仕様 (@deno-ink/core)

- @deno-ink/core(React for CLI、react@18 系)で構築。日本語UI文字列固定。絵文字は一切使用しない。
- 操作: 上下キー + Enter (SelectInput)、テキスト入力 (TextInput)、Esc で前画面へ戻る/中断。

### 6.1 画面一覧

1. **メニュー**: 翻訳を実行 / プロバイダ認証 / モデル選択 / 設定 / 終了。
2. **翻訳ウィザード**: PDFパス入力 → 翻訳先言語(プリセット+自由記述) → 出力形式(翻訳のみ/交互バイリンガル) → 実行内容の確認 → 進行画面。
3. **進行画面**: ステージ表示(解析→翻訳→描画)、頁単位 ProgressBar、段落カウント(失敗数含む)、累計 token / コスト表示、警告一覧、`q` キーで中止。完了後は成果物パスを表示してメニューへ戻る(バッチモードではサマリを出力して終了)。
4. **認証画面**: プロバイダ一覧(認証方式・接続状態バッジ)。一覧上部の入力欄に文字を打つと名前/IDの部分一致で即時絞り込み(Backspace で編集、Esc で解除)。選択後は個別アクション(APIキー入力 / OAuthログイン / 認証解除)→ OAuth 中はイベント表示+プロンプト応答。認証の完了・解除の状態はその場で反映される。
5. **モデル選択画面**: 認証済みプロバイダのみを一覧表示(未認証の場合は案内を表示)。プロバイダ選択 → モデル一覧(現在の設定値には「(使用中)」マーク)→ 選択で settings.json に保存してプロバイダ一覧へ戻る。
6. **設定画面**: 翻訳先言語 / 出力形式 / 同時実行数 / バッチ予算 / マスク色 / フォント縮小下限を編集し保存。

主要コンポーネント: Box / Text / TextInput / SelectInput / ProgressBar / Spinner / Badge。

## 7. 非機能要件

- **セキュリティ**: ネットワーク待受なし(ローカルファイルのみ操作)。API キーはローカルディスク保存のみ(外部送信は翻訳先プロバイダのみ)。auth.json は可能な範囲でパーミッション 0600 に設定。
- **パフォーマンス**: 抽出と解析は頁単位ストリーミング処理。翻訳は並列制御あり。100頁規模のPDFを目標に含む。
- **テスト**: `deno test`。layout/classify は純関数としてユニットテスト、translate は pi-ai をモック、render はフィクスチャPDFの生成物検査(テキスト抽出で再検証)、CLI は faux モードのサブプロセス E2E(tests/cli.test.ts)。
- **配布**: `deno run -A main.ts` または `deno task compile` による単一バイナリ(Windows優先)。

## 8. v1スコープ外(将来拡張)

履歴/ジョブ一覧、用語集・翻訳メモリ、部分再翻訳、カスタムプロンプト編集、OCR、文字色推定、見開き(side-by-side)PDF出力、i18n(日英切替)、auto-update。

## 9. 主要リスクと対策

| リスク | 影響 | 対策 |
|---|---|---|
| CJKフォントの埋め込みサイズ | 出力PDF肥大・初回同梱物増 | subset 埋め込み必須。フォントは Noto Sans / Noto Sans JP 等の必要グリフ版を assets に同梱 |
| 段落誤判定(複雑レイアウト) | 配置崩れ | sidecar JSON と元PDF(`{名前}_original.pdf`)を並べて確認可能。classify の閾値を設定で調整可能に |
| LLMのJSON破損 | 段落欠落 | バッチ分割+リトライ+原文フォールバック |
| pi-ai の OAuth 依存変更 | ChatGPT/Copilot接続不能 | pi-ai バージョンを固定し、更新は計画的に。カスタムOpenAI互換経路を常設の退路とする |
| unpdf 同梱PDF.jsの仕様変更 | 抽出不良 | バージョン固定。フィクスチャPDFの回帰テスト |

## 10. マイルストーン

1. M1 骨格: deno.json/main.ts、CLI フレームワーク(@deno-ink/core)導入、メニューと画面遷移
2. M2 抽出+解析: unpdf 抽入、layout/classify、unit tests
3. M3 翻訳: pi-ai 接続、auth/settings 画面の認証フロー、バッチ実行、進捗表示、キャンセル
4. M4 再構築: mono PDF 出力(マスク+再描画)
5. M5 完成: dual 出力、成果物コピー、CLI E2E テスト、README/SPEC 更新
6. M6 (将来) deno compile による単一バイナリ配布
