import { assertEquals } from "@std/assert";
import { getResolvedPDFJS } from "unpdf";
import { findInvisibleTextOrigins } from "../engine/core/visibility.ts";

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
