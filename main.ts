import { runCli } from "./cli/run.ts";

if (import.meta.main) {
  await runCli(Deno.args);
}
