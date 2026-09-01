import { join } from "@std/path";
import * as fontkitModule from "fontkit";

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

const fontkit = ((fontkitModule as Record<string, unknown>).default ??
  fontkitModule) as unknown as {
    create: (bytes: Uint8Array) => Promise<WoffFont>;
  };

/** fontkit が解釈するフォント(WOFF のデコードに必要な面のみ) */
interface WoffFont {
  type: string;
  directory: {
    tables: Record<string, { length: number }>;
  };
  _getTableStream(tag: string): { readBuffer(length: number): Uint8Array };
}

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

// ---------------------------------------------------------------------------
// WOFF -> 真の TTF 変換
//
// Google Fonts が返す .ttf は実体が WOFF(圧縮フォント)のことがある。fontkit は
// WOFF を開くたびに glyf テーブル(数MB)をアクセスのたびに解凍するため、
// 描画(wrap の幅計測・PDF 保存時のサブセット化)が数十秒単位で遅くなる。
// ここで一度だけ真の SFNT(TTF/OTF)に変換しておくことで問題を根本解決する。
// ---------------------------------------------------------------------------

/** 先頭4バイトのタグを読む。短い場合は空文字。 */
function readTag(bytes: Uint8Array, offset = 0): string {
  if (bytes.length < offset + 4) return "";
  return String.fromCharCode(
    bytes[offset],
    bytes[offset + 1],
    bytes[offset + 2],
    bytes[offset + 3],
  );
}

/** WOFF / WOFF2 (圧縮フォント) かどうか。 */
export function isWoff(bytes: Uint8Array): boolean {
  const tag = readTag(bytes);
  return tag === "wOFF" || tag === "wOF2";
}

/**
 * WOFF / WOFF2 を SFNT(TTF/OTF) に変換する。
 * 圧縮された各テーブルは fontkit のデコード結果をそのまま使い、sfnt ヘッダと
 * テーブルディレクトリを組み立て直す。
 */
export async function convertWoffToTtf(bytes: Uint8Array): Promise<Uint8Array> {
  const font = await fontkit.create(bytes);
  if (font.type !== "WOFF" && font.type !== "WOFF2") {
    throw new Error(`unexpected font type: ${font.type}`);
  }
  const tables: { tag: string; data: Uint8Array }[] = [];
  for (const tag of Object.keys(font.directory.tables)) {
    const table = font.directory.tables[tag];
    const stream = font._getTableStream(tag);
    tables.push({ tag, data: stream.readBuffer(table.length) });
  }
  tables.sort((a, b) => (a.tag < b.tag ? -1 : 1));
  const numTables = tables.length;
  // sfnt ヘッダ(12バイト)。フレーバーは元 WOFF ヘッダのものを引き継ぐ。
  const header = new Uint8Array(12);
  header.set(bytes.slice(4, 8), 0);
  const view = new DataView(header.buffer);
  view.setUint16(4, numTables);
  const entrySelector = Math.max(0, Math.floor(Math.log2(numTables)));
  view.setUint16(6, 16 * (1 << entrySelector));
  view.setUint16(8, entrySelector);
  view.setUint16(10, 16 * numTables - 16 * (1 << entrySelector));
  // テーブルレコード(ヘッダ直後)
  let dataOffset = 12 + 16 * numTables;
  const parts: Uint8Array[] = [header];
  for (const { tag, data } of tables) {
    const record = new Uint8Array(16);
    record.set([...tag].map((c) => c.charCodeAt(0)), 0);
    const rv = new DataView(record.buffer);
    rv.setUint32(8, dataOffset);
    rv.setUint32(12, data.length);
    parts.push(record);
    dataOffset += data.length + ((4 - (data.length % 4)) % 4);
  }
  // テーブルデータ(4バイトアライン)
  for (const { data } of tables) {
    const pad = (4 - (data.length % 4)) % 4;
    const padded = new Uint8Array(data.length + pad);
    padded.set(data);
    parts.push(padded);
  }
  const out = new Uint8Array(parts.reduce((total, p) => total + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/**
 * ファイルが WOFF なら真の TTF に変換して上書きする。変換したら true。
 * 変換結果が fontkit で開けない場合(壊れた WOFF 等)は既存ファイルを保持したまま
 * Error を投げる。
 */
export async function convertToTrueTypeIfNeeded(
  fontsDir: string,
  target: FontTarget,
): Promise<boolean> {
  const path = fontPath(fontsDir, target);
  let bytes: Uint8Array;
  try {
    bytes = await Deno.readFile(path);
  } catch {
    return false;
  }
  if (!isWoff(bytes)) return false;
  const ttf = await convertWoffToTtf(bytes);
  // 変換結果が fontkit で開けることを確認してから上書きする
  const check = await fontkit.create(ttf);
  if (!check.directory?.tables) {
    throw new Error("converted font is not a valid sfnt");
  }
  await Deno.writeFile(path, ttf);
  return true;
}

export interface EnsureFontsResult {
  /** 今回ダウンロードしたフォント */
  downloaded: FontTarget[];
  /** WOFF だったため TTF に変換したフォント */
  converted: FontTarget[];
}

/**
 * 指定ディレクトリに埋め込みフォントを揃える。
 * 不足分のダウンロードに加え、実体が WOFF のファイルは真の TTF に変換する
 * (変換失敗時は警告して続行。遅いだけで動作自体は可能なため)。
 */
export async function ensureFonts(
  fontsDir: string,
): Promise<EnsureFontsResult> {
  await Deno.mkdir(fontsDir, { recursive: true });
  const downloaded: FontTarget[] = [];
  for (const target of FONT_TARGETS) {
    if (await isFontInstalled(fontsDir, target)) continue;
    await downloadFont(fontsDir, target);
    downloaded.push(target);
  }
  const converted: FontTarget[] = [];
  for (const target of FONT_TARGETS) {
    try {
      if (await convertToTrueTypeIfNeeded(fontsDir, target)) {
        converted.push(target);
      }
    } catch (err) {
      console.warn(
        `警告: ${target.out} を TTF に変換できませんでした (${
          err instanceof Error ? err.message : String(err)
        })`,
      );
    }
  }
  return { downloaded, converted };
}
