import { join } from "@std/path";
import { ensureFonts } from "../engine/fonts.ts";
import { PROJECT_ROOT } from "../engine/settings.ts";

// 埋め込み用フォントのダウンロード(初回起動時にも自動実行される。手動更新はこのツールで)。
if (import.meta.main) {
  const fontsDir = join(PROJECT_ROOT, "assets", "fonts");
  try {
    const { downloaded, converted } = await ensureFonts(fontsDir);
    if (downloaded.length === 0 && converted.length === 0) {
      console.log("all fonts are present, skipping");
    } else {
      for (const target of downloaded) console.log(`saved ${target.out}`);
      for (const target of converted) {
        console.log(`converted ${target.out} to TrueType`);
      }
    }
  } catch (err) {
    console.error(
      err instanceof Error ? err.message : String(err),
    );
    Deno.exit(1);
  }
}
