/**
 * 一覧の絞り込み判定: 名前またはIDの部分一致(大文字小文字を無視)。
 * 認証画面のプロバイダ一覧とモデル選択画面のプロバイダ・モデル一覧で共用する。
 */
export function matchesNameOrId(
  row: { id: string; name: string },
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    row.name.toLowerCase().includes(q) ||
    row.id.toLowerCase().includes(q)
  );
}
