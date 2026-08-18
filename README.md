# Cache Guard for pi

`@arumie/pi-cache-guard` is a pi package that watches assistant usage and stops an active run after repeated, significant prompt-cache misses. It helps prevent a transient cache failure, model change, or prompt-prefix change from silently accumulating expensive re-billed input.

> **Security:** pi extensions run with your user permissions. Install this package only from a source you trust.

## Install

Install a pinned Git release:

```sh
pi install git:github.com/arumie/pi-cache-guard@v1.0.0
```

Restart pi (or run `/reload`) after installing. Confirm the package is registered with `pi list`.

For checkout development, load the local package directory:

```sh
pi -e /absolute/path/to/pi-cache-guard
```

Do not run this package alongside the legacy auto-discovered `~/.pi/agent/extensions/cache-guard.ts`; both copies register `/cache-guard`. Move or remove the legacy file before enabling the package-managed copy.

## How it works

The extension compares adjacent assistant requests after the provider has reported cache activity at least once. It estimates the prompt tokens that should have been cache reads but were billed as new input. Small misses are ignored as normal breakpoint granularity noise; a miss counts only when it reaches the configured token or dollar threshold.

When the maximum consecutive misses, total misses, or cumulative re-billed cost is reached, Cache Guard aborts the current pi run and shows a warning. Its counters reset after stopping so you can inspect the cause, recover the cache, and resume deliberately.

Settings are global across pi projects and sessions, stored at `~/.pi/agent/cache-guard-settings.json`. Counters are per session and are never persisted.

## Usage

- `/cache-guard` or `/cache-guard status` — show current settings and session counters.
- `/cache-guard on|off` — enable or disable the guard globally.
- `/cache-guard log on|off` — control routine cache-hit and cache-miss notifications globally.
- `/cache-guard reset` — clear this session's counters.
- `/cache-guard consecutive N` — stop after `N` significant consecutive misses.
- `/cache-guard max N` — stop after `N` significant misses in the session.
- `/cache-guard cost N` — stop after `N` dollars of estimated cumulative re-billed input.
- `/cache-guard significant-tokens N` — count a miss at or above `N` tokens.
- `/cache-guard significant-cost N` — count a miss at or above `N` dollars.

A miss is significant when it meets **either** the token or cost threshold. Defaults are:

| Setting | Default |
| --- | ---: |
| Significant miss tokens | 20,000 |
| Significant miss cost | $0.10 |
| Consecutive misses | 3 |
| Total misses | 8 |
| Cumulative re-billed cost | $0.50 |

If the guard stops a run, inspect likely cache-invalidating changes (such as switching models or thinking level) and wait for cache recovery before using `/cache-guard reset` to start counting again.

## Development and validation

```sh
npm install
npm run release:check
```

The test suite verifies the package manifest. The type check covers the packaged extension entry point.

## Releases and updates

Git tags are the release mechanism:

1. Update `package.json`'s version, `CHANGELOG.md`, and documentation.
2. Run `npm run release:check`.
3. Commit and push `main`.
4. Create and push an annotated semantic-version tag, for example `v1.0.0`.
5. Install that exact revision with `pi install git:github.com/arumie/pi-cache-guard@v1.0.0`.

A Git ref in `pi install` is pinned. `pi update --extensions` reconciles the configured ref but does not advance it to a newer tag; install the new tag explicitly when upgrading. Remove the package with:

```sh
pi remove git:github.com/arumie/pi-cache-guard
```

## License

[MIT](LICENSE)
