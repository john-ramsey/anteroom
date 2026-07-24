// Build the distributable `anteroom` bin: a single-file ESM bundle with a node shebang.
//
// Bakes the production defaults into the bundle via esbuild `--define` so `npx anteroom`
// works with no flags, while `tsx src/index.ts` (this define never runs) stays on
// localhost. Override at build time with env vars; override at runtime with the ANTEROOM_*
// env vars (or --client-id).
//
//   npm run build -w anteroom
//   ANTEROOM_SERVER=wss://staging.example.com npm run build -w anteroom
//   ANTEROOM_GITHUB_CLIENT_ID=Iv1.abc123 npm run build -w anteroom   # bake the OAuth id (deploy day)
import { build } from "esbuild";

const server = process.env.ANTEROOM_SERVER || "wss://play.anteroom.johnramsey.com";

/** @type {Record<string, string>} */
const define = { __ANTEROOM_SERVER__: JSON.stringify(server) };
// Only bake the client id once it exists (after the OAuth app is registered). Until then
// the bundle omits it and the runtime ANTEROOM_GITHUB_CLIENT_ID / --client-id still work.
if (process.env.ANTEROOM_GITHUB_CLIENT_ID) {
  define.__ANTEROOM_CLIENT_ID__ = JSON.stringify(process.env.ANTEROOM_GITHUB_CLIENT_ID);
}

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: "dist/anteroom.mjs",
  banner: { js: "#!/usr/bin/env node" },
  define,
});

console.log(`✓ built dist/anteroom.mjs (server=${server}${define.__ANTEROOM_CLIENT_ID__ ? ", client id baked" : ""})`);
