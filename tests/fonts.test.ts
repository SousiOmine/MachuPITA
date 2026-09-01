import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import * as fontkitModule from "fontkit";
import {
  convertToTrueTypeIfNeeded,
  convertWoffToTtf,
  type FontTarget,
  isWoff,
} from "../engine/fonts.ts";

const fontkit = ((fontkitModule as Record<string, unknown>).default ??
  fontkitModule) as unknown as {
    create: (bytes: Uint8Array) => Promise<{
      type: string;
      glyphForCodePoint(cp: number): { id: number } | null;
      layout(text: string): { glyphs: { id: number }[] };
      createSubset(): {
        includeGlyph(g: { id: number }): number;
        encode(): Uint8Array;
      };
    }>;
  };

// ---------------------------------------------------------------------------
// 最小の真性 TTF を組み立て、それを WOFF に包んだフィクスチャを作る
// (glyph 0 = .notdef, glyph 1 = 'A'、空グリフ ×8)
// ---------------------------------------------------------------------------

function u16(...values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 2);
  for (let i = 0; i < values.length; i++) {
    out[i * 2] = (values[i] >> 8) & 0xff;
    out[i * 2 + 1] = values[i] & 0xff;
  }
  return out;
}

function u32(...values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 4);
  for (let i = 0; i < values.length; i++) {
    out[i * 4] = (values[i] >>> 24) & 0xff;
    out[i * 4 + 1] = (values[i] >>> 16) & 0xff;
    out[i * 4 + 2] = (values[i] >>> 8) & 0xff;
    out[i * 4 + 3] = values[i] & 0xff;
  }
  return out;
}

function tag(s: string): Uint8Array {
  return new Uint8Array([...s].map((c) => c.charCodeAt(0)));
}

function cat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

function buildHead(): Uint8Array {
  return cat([
    u32(0x00010000, 0x00010000, 0, 0x5f0f3cf5), // version, revision, checkSum, magic
    u16(0, 1000), // flags, unitsPerEm
    u32(0, 0, 0, 0), // created(8), modified(8)
    u16(0, 0, 0, 0), // xMin, yMin, xMax, yMax
    u16(0, 8, 2, 0, 0), // macStyle, lowestRecPPEM, directionHint, locFormat, glyphFormat
  ]);
}

function buildHhea(numGlyphs: number): Uint8Array {
  return cat([
    u32(0x00010000),
    u16(800, -200, 0), // ascent, descent, lineGap
    u16(500, 0, 0, 500), // advanceWidthMax, minLSB, minRSB, xMaxExtent
    u16(1, 0, 0), // caretSlopeRise, caretSlopeRun, caretOffset
    u32(0, 0), // reserved ×4
    u16(0, numGlyphs), // metricDataFormat, numberOfHMetrics
  ]);
}

function buildMaxp(numGlyphs: number): Uint8Array {
  // fontkit は maxp v1.0 の全フィールド(32バイト)をデコードする
  return cat([
    u32(0x00010000),
    u16(numGlyphs),
    u16(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0), // maxPoints..maxComponentDepth
  ]);
}

function buildHmtx(numGlyphs: number): Uint8Array {
  return cat(Array.from({ length: numGlyphs }, () => u16(500, 0)));
}

function buildLoca(offsets: number[]): Uint8Array {
  return u16(...offsets);
}

/** 空グリフ(10バイトのヘッダのみ) × numGlyphs */
function buildGlyf(numGlyphs: number): Uint8Array {
  return new Uint8Array(numGlyphs * 10);
}

/** format 4 の cmap: 'A'(0x41) -> glyph 1 のみ */
function buildCmap(): Uint8Array {
  return cat([
    u16(0, 1), // version, numTables
    u16(3, 1), // platformID, encodingID
    u32(12), // subtable offset
    u16(4, 32, 0, 4, 4, 0, 0), // format, length, language, segCountX2, searchRange, entrySel, rangeShift
    u16(0x41, 0xffff), // endCode
    u16(0), // reservedPad
    u16(0x41, 0xffff), // startCode
    u16(0xffc0, 0x0001), // idDelta (0x41 + (-0x40) = 1)
    u16(0, 0), // idRangeOffset
  ]);
}

async function zlibCompress(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes.buffer as ArrayBuffer]).stream().pipeThrough(
    new CompressionStream("deflate"),
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function buildTtf(): Uint8Array {
  const numGlyphs = 8;
  const head = buildHead();
  const hhea = buildHhea(numGlyphs);
  const maxp = buildMaxp(numGlyphs);
  const hmtx = buildHmtx(numGlyphs);
  const glyf = buildGlyf(numGlyphs);
  const loca = buildLoca(
    Array.from({ length: numGlyphs + 1 }, (_, i) => i * 5), // 空グリフ10バイト = short offset 5
  );
  const cmap = buildCmap();
  const tables = new Map<string, Uint8Array>([
    ["cmap", cmap],
    ["glyf", glyf],
    ["head", head],
    ["hhea", hhea],
    ["hmtx", hmtx],
    ["loca", loca],
    ["maxp", maxp],
  ]);
  const sorted = [...tables.keys()].sort();
  let dataOffset = 12 + 16 * sorted.length;
  const parts: Uint8Array[] = [
    u32(0x00010000),
    u16(sorted.length),
    u16(16 * (1 << Math.max(0, Math.floor(Math.log2(sorted.length))))),
    u16(Math.max(0, Math.floor(Math.log2(sorted.length)))),
    u16(16 * sorted.length),
  ];
  const records: Uint8Array[] = [];
  for (const name of sorted) {
    const data = tables.get(name)!;
    const record = cat([tag(name), u32(0), u32(dataOffset), u32(data.length)]);
    records.push(record);
    dataOffset += data.length + ((4 - (data.length % 4)) % 4);
  }
  for (const r of records) parts.push(r);
  for (const name of sorted) {
    const data = tables.get(name)!;
    const pad = (4 - (data.length % 4)) % 4;
    parts.push(cat([data, new Uint8Array(pad)]));
  }
  return cat(parts);
}

/** WOFF フィクスチャ。glyf(ゼロバイト列)は deflate で圧縮して格納する。 */
async function buildWoff(): Promise<Uint8Array> {
  const ttf = buildTtf();
  const numTables = 7; // cmap, glyf, head, hhea, hmtx, loca, maxp
  const tableNames = ["cmap", "glyf", "head", "hhea", "hmtx", "loca", "maxp"];
  const ttfView = new DataView(
    ttf.buffer,
    ttf.byteOffset,
    ttf.byteLength,
  );
  const tableData = new Map<string, Uint8Array>();
  let dataOffset = 44 + 20 * numTables;
  const totalSfntSize = 12 + 16 * numTables + tableNames.reduce(
    (sum, name) => {
      const len = ttfView.getUint32(12 + tableNames.indexOf(name) * 16 + 12);
      return sum + len + ((4 - (len % 4)) % 4);
    },
    0,
  );
  const records: Uint8Array[] = [];
  for (const name of tableNames) {
    const recOffset = 12 + tableNames.indexOf(name) * 16;
    const len = ttfView.getUint32(recOffset + 12);
    const raw = ttf.slice(
      ttfView.getUint32(recOffset + 8),
      ttfView.getUint32(recOffset + 8) + len,
    );
    const compressed = name === "glyf" ? await zlibCompress(raw) : raw;
    const stored = compressed.length < raw.length ? compressed : raw;
    tableData.set(name, stored);
    const record = cat([
      tag(name),
      u32(dataOffset, stored.length, raw.length, 0),
    ]);
    records.push(record);
    dataOffset += stored.length + ((4 - (stored.length % 4)) % 4);
  }
  const header = cat([
    tag("wOFF"),
    u32(0x00010000), // flavor
    u32(0), // length (後で埋める)
    u16(numTables, 0),
    u32(0), // totalSfntSize (後で埋める)
    u16(1, 0), // majorVersion, minorVersion
    u32(0, 0, 0, 0, 0), // metaOffset, metaLength, metaOrigLength, privOffset, privLength
  ]);
  const dataParts: Uint8Array[] = [];
  for (const name of tableNames) {
    const stored = tableData.get(name)!;
    const pad = (4 - (stored.length % 4)) % 4;
    dataParts.push(cat([stored, new Uint8Array(pad)]));
  }
  const body = cat([...records, ...dataParts]);
  const out = cat([header, body]);
  // length と totalSfntSize を埋める
  const view = new DataView(out.buffer);
  view.setUint32(8, out.length);
  view.setUint32(16, totalSfntSize);
  return out;
}

// ---------------------------------------------------------------------------

Deno.test("isWoff detects WOFF and WOFF2 signatures", () => {
  assertEquals(isWoff(new Uint8Array([0x77, 0x4f, 0x46, 0x46, 1, 2, 3])), true); // wOFF
  assertEquals(isWoff(new Uint8Array([0x77, 0x4f, 0x46, 0x32, 1, 2, 3])), true); // wOF2
  assertEquals(isWoff(new Uint8Array([0, 1, 0, 0, 1, 2, 3])), false); // sfnt
  assertEquals(isWoff(new Uint8Array([0x77, 0x4f])), false); // 短すぎる
  assertEquals(isWoff(new Uint8Array()), false); // 空
  assertEquals(isWoff(new Uint8Array([0x74, 0x72, 0x75, 0x65])), false); // 'true'
});

Deno.test("convertWoffToTtf converts to a usable TrueType font", async () => {
  const woff = await buildWoff();
  assertEquals(isWoff(woff), true);

  const ttf = await convertWoffToTtf(woff);
  // フレーバー(0x00010000)が引き継がれている
  assertEquals([...ttf.slice(0, 4)], [0, 1, 0, 0]);
  assertEquals(isWoff(ttf), false);

  // fontkit で開いて実際に使えることを確認する
  const font = await fontkit.create(ttf);
  assertEquals(font.type, "TTF");
  assertEquals(font.glyphForCodePoint(0x41)?.id, 1);
  const run = font.layout("A");
  assertEquals(run.glyphs.length, 1);
  assertEquals(run.glyphs[0].id, 1);
  // サブセット化(pdf-lib の save 相当)も通る
  const subset = font.createSubset();
  subset.includeGlyph(run.glyphs[0]);
  assert(subset.encode().length > 0);
});

Deno.test("convertToTrueTypeIfNeeded converts WOFF, skips TTF and missing", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const target: FontTarget = { family: "X", weight: "400", out: "x.ttf" };
    const path = join(dir, target.out);
    // ファイルが無い場合は false
    assertEquals(await convertToTrueTypeIfNeeded(dir, target), false);
    // 真性 TTF は対象外
    await Deno.writeFile(path, new Uint8Array([0, 1, 0, 0, 1, 2, 3]));
    assertEquals(await convertToTrueTypeIfNeeded(dir, target), false);
    // WOFF は変換され、中身が TTF になる
    await Deno.writeFile(path, await buildWoff());
    assertEquals(await convertToTrueTypeIfNeeded(dir, target), true);
    const after = await Deno.readFile(path);
    assertEquals(isWoff(after), false);
    assertEquals([...after.slice(0, 4)], [0, 1, 0, 0]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
