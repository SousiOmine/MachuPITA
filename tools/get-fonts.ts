import { join } from "@std/path";
import { PROJECT_ROOT } from "../engine/settings.ts";

interface Target {
  family: string;
  weight: string;
  out: string;
}

const TARGETS: Target[] = [
  { family: "Noto Sans", weight: "400", out: "NotoSans-Regular.ttf" },
  { family: "Noto Sans", weight: "700", out: "NotoSans-Bold.ttf" },
  { family: "Noto Sans JP", weight: "400", out: "NotoSansJP-Regular.ttf" },
  { family: "Noto Sans JP", weight: "700", out: "NotoSansJP-Bold.ttf" },
];

// A legacy user agent makes the Google Fonts CSS API return full TTF urls
// instead of unicode-range sliced woff2.
const LEGACY_UA =
  "Mozilla/5.0 (Windows NT 6.1; rv:8.0) Gecko/20100101 Firefox/8.0";

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

async function download(target: Target): Promise<void> {
  const ttfUrl = await resolveTtfUrl(target.family, target.weight);
  const res = await fetch(ttfUrl);
  if (!res.ok) throw new Error(`download failed ${res.status}: ${ttfUrl}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const outPath = join(PROJECT_ROOT, "assets", "fonts", target.out);
  await Deno.writeFile(outPath, bytes);
  console.log(
    `saved ${target.out} (${(bytes.length / 1024 / 1024).toFixed(2)} MB)`,
  );
}

if (import.meta.main) {
  await Deno.mkdir(join(PROJECT_ROOT, "assets", "fonts"), { recursive: true });
  for (const target of TARGETS) {
    const outPath = join(PROJECT_ROOT, "assets", "fonts", target.out);
    try {
      const stat = await Deno.stat(outPath);
      if (stat.isFile && stat.size > 100_000) {
        console.log(`exists ${target.out}, skipping`);
        continue;
      }
    } catch {
      /* not present */
    }
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await download(target);
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        await new Promise((r) => setTimeout(r, attempt * 1500));
      }
    }
    if (lastError) {
      console.error(`failed ${target.out}:`, lastError);
      Deno.exit(1);
    }
  }
}
