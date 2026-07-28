# Anteroom — Terms & Privacy

_Short, plain-English._

Last updated: 2026-07-28.

## What this is

Anteroom is a free, for-fun game you play while a long task runs. It is a hobby/portfolio
project, provided **as-is, with no warranty**, and may change or go offline at any time.

## Play money — not gambling

Chips have **no monetary value**. You cannot buy them, deposit money, or cash them out, and
they are not redeemable for anything. There is no wager of real money and no prize of real
value — chips exist only to keep score. Anteroom is **not** a gambling service.

## What we collect

- **GitHub identity** (only if you sign in): your GitHub numeric account id and login. The id
  is your stable account key; we never see your GitHub password (sign-in uses GitHub's OAuth
  device flow — an access token you authorize).
- **Display username**: the name you choose (defaults to your GitHub login). It is **public** on
  the in-game tables and the leaderboard.
- **Approximate country**: derived from your connection at the network edge for a flag next to
  your name. We do **not** store your IP address.
- **Game data**: your chip balance and win/loss record, shown publicly on the leaderboard.

You can also play without signing in (a local "dev" name); then we store none of the above
beyond what's needed to run your session.

## What we don't do

No payments. No advertising. No third-party tracking or analytics cookies. No selling or sharing
of data. No collection of any personal data beyond the GitHub login/id and chosen username above.

## The one request that isn't us

At startup the client asks the public npm registry (`registry.npmjs.org`) what the latest published
version is, so it can tell you when your install is out of date. It is the same place `npm install`
already gets the package from. The request is unauthenticated and carries no identity, no username
and no game data, and it is made at most once a day. It does mean npm sees your IP address and
roughly when you launched, so you can turn it off. In the client: **Settings → updates → off**.
Or from your shell, which is handy for scripts and CI:

```bash
export ANTEROOM_NO_UPDATE_CHECK=1
```

Either one means no request is made at all. (`NO_UPDATE_NOTIFIER` and `CI` do the same.)

## Data & deletion

Your account data (chip balance and win/loss record) lives on Anteroom's server infrastructure. To
have your account data removed, open an issue on the public **Anteroom** repository
(`john-ramsey/anteroom`).

## Contact

Questions or removal requests: the public **Anteroom** GitHub repository (`john-ramsey/anteroom`).
