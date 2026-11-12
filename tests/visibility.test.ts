import { assertEquals } from "@std/assert";
import { getResolvedPDFJS } from "unpdf";
import {
  analyzePagePaint,
  findInvisibleTextOrigins,
} from "../engine/core/visibility.ts";

/** オペレータリストを返すだけのモックページ。 */
function mockPage(
  fnArray: number[],
  argsArray: unknown[][],
): {
  getOperatorList: () => Promise<{ fnArray: number[]; argsArray: unknown[][] }>;
} {
  return {
    getOperatorList: async () => ({ fnArray, argsArray }),
  };
}

Deno.test("findInvisibleTextOrigins: クリップ領域外のテキスト原点を検出する", async () => {
  const pdfjs = await getResolvedPDFJS();
  const OPS = pdfjs.OPS as Record<string, number>;
  // クリップ領域は原点(100,100)-(200,200)。テキストは原点(0,0)で領域外。
  const page = mockPage(
    [OPS.transform, OPS.transform, OPS.clip, OPS.constructPath, OPS.showText],
    [
      [1, 0, 0, 1, 0, 0],
      [1, 0, 0, 1, 0, 0],
      [],
      [[], [], [100, 100, 200, 200]],
      [["x"]],
    ],
  );
  const origins = await findInvisibleTextOrigins(page);
  assertEquals(origins.length, 1);
  assertEquals(origins[0].x, 0);
  assertEquals(origins[0].y, 0);
});

Deno.test("findInvisibleTextOrigins: クリップ内のテキストは検出しない", async () => {
  const pdfjs = await getResolvedPDFJS();
  const OPS = pdfjs.OPS as Record<string, number>;
  // クリップ領域(100,100)-(200,200)の内側(150,150)にテキストを描く。
  const page = mockPage(
    [OPS.transform, OPS.clip, OPS.constructPath, OPS.transform, OPS.showText],
    [
      [1, 0, 0, 1, 0, 0],
      [],
      [[], [], [100, 100, 200, 200]],
      [1, 0, 0, 1, 150, 150],
      [["x"]],
    ],
  );
  const origins = await findInvisibleTextOrigins(page);
  assertEquals(origins.length, 0);
});

Deno.test("findInvisibleTextOrigins: 非表示レンダリングモード(3)を検出する", async () => {
  const pdfjs = await getResolvedPDFJS();
  const OPS = pdfjs.OPS as Record<string, number>;
  const page = mockPage(
    [OPS.setTextRenderingMode, OPS.showText],
    [[3], [["x"]]],
  );
  const origins = await findInvisibleTextOrigins(page);
  assertEquals(origins.length, 1);
});

Deno.test("findInvisibleTextOrigins: 白塗りテキストを検出する", async () => {
  const pdfjs = await getResolvedPDFJS();
  const OPS = pdfjs.OPS as Record<string, number>;
  const page = mockPage(
    [OPS.setFillRGBColor, OPS.showText],
    [[[1, 1, 1]], [["x"]]],
  );
  const origins = await findInvisibleTextOrigins(page);
  assertEquals(origins.length, 1);
});

Deno.test("findInvisibleTextOrigins: 通常テキストは検出しない", async () => {
  const pdfjs = await getResolvedPDFJS();
  const OPS = pdfjs.OPS as Record<string, number>;
  const page = mockPage(
    [OPS.setTextMatrix, OPS.showText],
    [[1, 0, 0, 1, 10, 20], [["x"]]],
  );
  const origins = await findInvisibleTextOrigins(page);
  assertEquals(origins.length, 0);
});

Deno.test("findInvisibleTextOrigins: エラー時は空配列を返す(除外なしで続行)", async () => {
  const page = {
    getOperatorList: async () => {
      throw new Error("op list unavailable");
    },
  };
  const origins = await findInvisibleTextOrigins(page);
  assertEquals(origins.length, 0);
});

Deno.test("analyzePagePaint: 後から塗られた矩形に覆われたテキストを不可視にする", async () => {
  const pdfjs = await getResolvedPDFJS();
  const OPS = pdfjs.OPS as Record<string, number>;
  const page = mockPage(
    [
      OPS.setFillRGBColor,
      OPS.setTextMatrix,
      OPS.showText,
      OPS.setFillRGBColor,
      OPS.constructPath,
    ],
    [
      [[0, 0, 0]],
      [1, 0, 0, 1, 10, 10],
      [["x"]],
      [[1, 1, 1]],
      [OPS.fill, [], [0, 0, 100, 100]],
    ],
  );
  const origins = await findInvisibleTextOrigins(page);
  assertEquals(origins.length, 1);
  assertEquals(origins[0], { x: 10, y: 10 });
});

Deno.test("analyzePagePaint: 色帯の上の白文字は可視とし、色を記録する", async () => {
  const pdfjs = await getResolvedPDFJS();
  const OPS = pdfjs.OPS as Record<string, number>;
  const page = mockPage(
    [
      OPS.setFillRGBColor,
      OPS.constructPath,
      OPS.setFillRGBColor,
      OPS.setTextMatrix,
      OPS.showText,
    ],
    [
      [[0, 0, 0.6]],
      [OPS.fill, [], [0, 0, 200, 40]],
      [[1, 1, 1]],
      [1, 0, 0, 1, 10, 10],
      [["Title"]],
    ],
  );
  const { invisibleOrigins, styles } = await analyzePagePaint(page);
  assertEquals(invisibleOrigins.length, 0);
  assertEquals(styles.length, 1);
  assertEquals(styles[0].textColor, { r: 1, g: 1, b: 1 });
  assertEquals(styles[0].backgroundColor.r, 0);
  assertEquals(styles[0].backgroundColor.b, 0.6);
});

Deno.test("analyzePagePaint: 同一位置に訳文を描き直した場合は消さない", async () => {
  const pdfjs = await getResolvedPDFJS();
  const OPS = pdfjs.OPS as Record<string, number>;
  const page = mockPage(
    [
      OPS.setTextMatrix,
      OPS.showText,
      OPS.setFillRGBColor,
      OPS.constructPath,
      OPS.setFillRGBColor,
      OPS.setTextMatrix,
      OPS.showText,
    ],
    [
      [1, 0, 0, 1, 10, 10],
      [["原文"]],
      [[1, 1, 1]],
      [OPS.fill, [], [0, 0, 100, 30]],
      [[0, 0, 0]],
      [1, 0, 0, 1, 10, 10],
      [["訳文"]],
    ],
  );
  const { invisibleOrigins } = await analyzePagePaint(page);
  assertEquals(invisibleOrigins.length, 0);
});
