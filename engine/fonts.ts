import { join } from "@std/path";

export interface FontTarget {
  family: string;
  weight: string;
  out: string;
}

export const FONT_TARGETS: FontTarget[] = [
  { family: "Noto Sans", weight: "400", out: "NotoSans-Regular.ttf" },
  { family: "Noto Sans", weight: "700", out: "NotoSans-Bold.ttf" },
  { family: "Noto Sans JP", weight: "400", out: "NotoSansJP-Regular.ttf" },
  { family: "Noto Sans JP", weight: "700", out: "NotoSansJP-Bold.ttf" },
];

// A legacy user agent makes the Google Fonts CSS API return full TTF urls
// instead of unicode-range sliced woff2.
const LEGACY_UA =
  "Mozilla/5.0 (Windows NT 6.1; rv:8.0) Gecko/20100101 Firefox/8.0";

const MIN_FILE_SIZE = 100_000;

function fontPath(fontsDir: string, target: FontTarget): string {
  return join(fontsDir, target.out);
}

/** 指定ディレクトリにフォントファイルが揃っているか(サイズが異常に小さければ未取得扱い)。 */
export async function isFontInstalled(
  fontsDir: string,
  target: FontTarget,
): Promise<boolean> {
  try {
    const stat = await Deno.stat(fontPath(fontsDir, target));
    return stat.isFile && stat.size > MIN_FILE_SIZE;
  } catch {
    return false;
  }
}

async function resolveTtfUrl(family: string, weight: string): Promise<string> {
  const url = `https://fonts.googleapis.com/css2?family=${
    encodeURIComponent(family)
  }:wght@${weight}`;
  const res = await fetch(url, { headers: { "user-agent": LEGACY_UA } });
  if (!res.ok) throw new Error(`css2 ${res.status} for ${family}`);
  const css = await res.text();
  const matches = [...css.matchAll(/url\((https:[^)]+)\)/g)].map((m) => m[1]);
  const ttf = matches.find((u) => u.includes(".ttf")) ?? matches.at(-1);
  if (!ttf) throw new Error(`no font url found for ${family} ${weight}`);
  return ttf;
}

/** 1フォントをダウンロードして保存する。3回リトライし、失敗時は Error を投げる。 */
async function downloadFont(
  fontsDir: string,
  target: FontTarget,
): Promise<number> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const ttfUrl = await resolveTtfUrl(target.family, target.weight);
      const res = await fetch(ttfUrl);
      if (!res.ok) throw new Error(`download failed ${res.status}: ${ttfUrl}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      await Deno.writeFile(fontPath(fontsDir, target), bytes);
      return bytes.length;
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, attempt * 1500));
    }
  }
  throw new Error(
    `failed ${target.out}: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

/**
 * 指定ディレクトリに埋め込みフォントを揃える。
 * 不足分のみダウンロードし、ダウンロードしたフォントの一覧を返す(全て揃っていれば空配列)。
 */
export async function ensureFonts(fontsDir: string): Promise<FontTarget[]> {
  await Deno.mkdir(fontsDir, { recursive: true });
  const downloaded: FontTarget[] = [];
  for (const target of FONT_TARGETS) {
    if (await isFontInstalled(fontsDir, target)) continue;
    await downloadFont(fontsDir, target);
    downloaded.push(target);
  }
  return downloaded;
}
