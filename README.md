# anteroom

The **Anteroom** command-line client — play quick turn-based games (RPS, Four in a Row, Reversi,
Blackjack, Craps, Roulette, Slots) for play-money chips while a long task (a CI build, a long model
turn) runs. Chips have **no monetary value**; this is not gambling.

```bash
npm i -g anteroom      # or: brew install john-ramsey/tap/anteroom  (installs Node too)
anteroom --find --game blackjack --ante 50
```

## This repo is the public source of what `npx anteroom` runs

The npm package ships a single bundled file (`dist/anteroom.mjs`). **This repository is that
bundle's source**, published so you can read exactly what runs on your machine. Every npm release is
built and published **from this repo by GitHub Actions with [npm provenance]** — so npmjs.com shows a
verified link from the published bytes back to the exact commit here. You can also rebuild it
yourself and compare:

```bash
npm install
npm run build          # -> dist/anteroom.mjs
```

## Notes

- **Generated, read-only mirror.** This repo is a clean snapshot of one package of a private
  monorepo; development happens upstream. Issues/PRs are welcome, but changes are integrated
  upstream and re-snapshotted (so please describe the change rather than expecting a direct merge).
- **Vendored protocol.** `src/protocol/` is a verbatim copy of the game's wire-protocol types
  (`@anteroom/protocol`), resolved via a tsconfig `paths` alias. Everything else under `src/`
  is the client, byte-for-byte as upstream.
- **The client enforces nothing.** All money/anti-cheat/rules decisions are server-authoritative;
  the client is a thin renderer. There are no secrets in it (the GitHub OAuth `client_id` is a
  public device-flow id).

[npm provenance]: https://docs.npmjs.com/generating-provenance-statements

MIT © John Ramsey. v1.0.0.
