import { assertEquals } from "@std/assert";
import { wrapText } from "../engine/core/render.ts";

/** 文字幅 = 文字数 × fontSize × factor のモックフォント。 */
function mockFont(widthFactor = 0.5) {
  return {
    widthOfTextAtSize: (t: string, s: number) => t.length * s * widthFactor,
  };
}

Deno.test("wrapText: 幅を超えないように単語単位で折り返す", () => {
  // fontSize=10, factor=0.5 → 1文字 5pt。maxWidth=60 → 12文字まで。
  const lines = wrapText("hello world foo bar", mockFont(), 60, 10);
  assertEquals(lines, ["hello world", "foo bar"]);
});

Deno.test("wrapText: 1語が幅を超える場合はそのまま置く", () => {
  // 1語 "supercalifragilistic" は 20文字 = 100pt > 40pt でも1行に収まる。
  const lines = wrapText("supercalifragilistic", mockFont(), 40, 10);
  assertEquals(lines, ["supercalifragilistic"]);
});

Deno.test("wrapText: 行頭禁則文字は前の行に引き込む", () => {
  // maxWidth=16 → 4文字(16pt)まで。`、` は行頭禁則なので前行に引き込まれる。
  const lines = wrapText("abcd、efg", mockFont(), 16, 10);
  assertEquals(lines, ["abcd、", "efg"]);
});

Deno.test("wrapText: 閉じ括弧・句読点も前行へ引き込む", () => {
  const lines = wrapText("abcd)efg", mockFont(), 16, 10);
  assertEquals(lines, ["abcd)", "efg"]);
});

Deno.test("wrapText: 改行文字で分割して折り返す", () => {
  const lines = wrapText("first line\nsecond line here", mockFont(), 60, 10);
  assertEquals(lines, ["first line", "second line", "here"]);
});

Deno.test("wrapText: 空文字列は空配列を返す", () => {
  assertEquals(wrapText("", mockFont(), 60, 10), []);
});
