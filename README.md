# machupita

PDFをレイアウトを維持したまま翻訳するCLIアプリ。
任意のLLMプロバイダに接続することで、ある程度いい感じに翻訳してくれます。

動作にはdenoが必要です。

AIにコーディングを丸投げし作成されました。

クローンしてから
```
deno task install:global
```
でインストールできます。

```
machupita
```
で設定したり色々

```
machupita 翻訳したいPDFのパス
```
で翻訳できます。