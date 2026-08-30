/**
 * LLM 応答テキストから JSON 配列を抽出する。
 * マークダウ fences や前置きテキストが混在するケースに対応し、
 * 先頭の `[` から末尾の `]` までを切り出してパースする。
 */
export function extractJsonArray(raw: string): unknown[] {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start < 0 || end <= start) {
    throw new Error("response is not a JSON array");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch (err) {
    throw new Error(`invalid JSON in response: ${String(err)}`);
  }
  if (!Array.isArray(parsed)) throw new Error("response is not a JSON array");
  return parsed;
}
