import { extractPages } from "./engine/core/extract.ts";
import { analyzePage } from "./engine/core/layout.ts";
import { renderTranslatedPdf } from "./engine/core/render.ts";
const bytes = await Deno.readFile("../work/jstage/ast46_2_e24.58.pdf");
const pages = await extractPages(bytes as unknown as Uint8Array, () => {});
const layouts = pages.slice(0, 3).map((p) => analyzePage(p));
let n = 0;
for (const l of layouts) for (const b of l.blocks) {
  if (!b.originalText.trim()) continue;
  b.translation = `テスト翻訳 ${++n}: ${b.originalText.slice(0, 20)}`;
  b.status = "translated";
}
const out = await renderTranslatedPdf(bytes as unknown as Uint8Array, layouts, { maskColor: "#ffffff", minFontScale: 0.55 });
await Deno.writeFile("/tmp/fixed2.pdf", out);
console.log("ok", out.length);
