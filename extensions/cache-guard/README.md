# Cache Guard extension

This is the pi extension entry point shipped by `@arumie/pi-cache-guard`.

It listens for finalized assistant messages, reads their provider usage (`input`, `cacheRead`, `cacheWrite`, and usage cost), and estimates the uncached portion of the shared prompt prefix between adjacent requests. It only begins evaluating misses after cache activity has been observed, avoiding false positives for models and providers that do not expose prompt caching.

The guard ignores misses below 1,024 tokens of breakpoint noise. Larger misses count only when they meet the global significant-miss token or cost setting. A normal cached request clears the consecutive-miss streak but leaves the total-miss and cumulative-cost counters intact.

The `/cache-guard` command stores configuration under `~/.pi/agent/cache-guard-settings.json`; the extension reloads those settings at every session start. The command uses these subcommands:

```text
/cache-guard [status]
/cache-guard on|off
/cache-guard log on|off
/cache-guard reset
/cache-guard consecutive N
/cache-guard max N
/cache-guard cost N
/cache-guard significant-tokens N
/cache-guard significant-cost N
```

When any configured limit is reached, the extension calls `ctx.abort()` to halt the active run and displays a warning. It never changes tools, models, prompts, or project files.
