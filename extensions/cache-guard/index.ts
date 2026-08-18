import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ---- defaults (all changeable at runtime via /cache-guard, persisted globally) ----
const NOISE_FLOOR_TOKENS = 1024; // below this, ignore entirely (breakpoint granularity noise)
// A miss only counts toward the guard once it's "significant" — mirrors pi's own
// addCacheMissNotice() gate in interactive-mode.js, so the guard's counters match
// what you'd actually see flagged as a yellow "Cache miss" banner in the transcript.
const DEFAULT_SIGNIFICANT_MISS_TOKENS = 20_000;
const DEFAULT_SIGNIFICANT_MISS_COST = 0.1;
const DEFAULT_MAX_CONSECUTIVE_MISSES = 3; // abort after N significant misses in a row
const DEFAULT_MAX_TOTAL_MISSES = 8; // abort after N significant misses total, even if not consecutive
const DEFAULT_MAX_CUMULATIVE_MISS_COST = 0.5; // abort once wasted $ (from significant misses) crosses this
const SETTINGS_DIR = join(homedir(), ".pi", "agent");
const SETTINGS_PATH = join(SETTINGS_DIR, "cache-guard-settings.json");
// -----------------------------------------------------------------------------------

interface PrevRequest {
  promptTokens: number;
  reportedCache: boolean;
}

/** Persisted globally in SETTINGS_PATH, shared across all sessions/projects. */
interface GuardSettings {
  enabled: boolean;
  logging: boolean;
  significantMissTokens: number;
  significantMissCost: number;
  maxConsecutiveMisses: number;
  maxTotalMisses: number;
  maxCumulativeMissCost: number;
}

/** Per-session runtime tracking. Never persisted. */
interface GuardCounters {
  prev?: PrevRequest;
  consecutiveMisses: number;
  totalMisses: number;
  cumulativeMissCost: number;
}

interface GuardState extends GuardSettings, GuardCounters {}

function defaultSettings(): GuardSettings {
  return {
    enabled: true,
    logging: true,
    significantMissTokens: DEFAULT_SIGNIFICANT_MISS_TOKENS,
    significantMissCost: DEFAULT_SIGNIFICANT_MISS_COST,
    maxConsecutiveMisses: DEFAULT_MAX_CONSECUTIVE_MISSES,
    maxTotalMisses: DEFAULT_MAX_TOTAL_MISSES,
    maxCumulativeMissCost: DEFAULT_MAX_CUMULATIVE_MISS_COST,
  };
}

function loadSettings(): GuardSettings {
  const defaults = defaultSettings();
  try {
    const raw = readFileSync(SETTINGS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return {
      enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : defaults.enabled,
      logging: typeof parsed.logging === "boolean" ? parsed.logging : defaults.logging,
      significantMissTokens:
        Number.isFinite(parsed.significantMissTokens) && parsed.significantMissTokens >= 0
          ? parsed.significantMissTokens
          : defaults.significantMissTokens,
      significantMissCost:
        Number.isFinite(parsed.significantMissCost) && parsed.significantMissCost >= 0
          ? parsed.significantMissCost
          : defaults.significantMissCost,
      maxConsecutiveMisses:
        Number.isFinite(parsed.maxConsecutiveMisses) && parsed.maxConsecutiveMisses > 0
          ? parsed.maxConsecutiveMisses
          : defaults.maxConsecutiveMisses,
      maxTotalMisses:
        Number.isFinite(parsed.maxTotalMisses) && parsed.maxTotalMisses > 0
          ? parsed.maxTotalMisses
          : defaults.maxTotalMisses,
      maxCumulativeMissCost:
        Number.isFinite(parsed.maxCumulativeMissCost) && parsed.maxCumulativeMissCost > 0
          ? parsed.maxCumulativeMissCost
          : defaults.maxCumulativeMissCost,
    };
  } catch {
    return defaults;
  }
}

function saveSettings(settings: GuardSettings) {
  try {
    mkdirSync(SETTINGS_DIR, { recursive: true });
    writeFileSync(
      SETTINGS_PATH,
      JSON.stringify(
        {
          enabled: settings.enabled,
          logging: settings.logging,
          significantMissTokens: settings.significantMissTokens,
          significantMissCost: settings.significantMissCost,
          maxConsecutiveMisses: settings.maxConsecutiveMisses,
          maxTotalMisses: settings.maxTotalMisses,
          maxCumulativeMissCost: settings.maxCumulativeMissCost,
        },
        null,
        2,
      ),
    );
  } catch {
    // Best-effort; if the write fails, in-memory settings still apply for this session.
  }
}

function freshState(): GuardState {
  return {
    ...loadSettings(),
    prev: undefined,
    consecutiveMisses: 0,
    totalMisses: 0,
    cumulativeMissCost: 0,
  };
}

function resetCounters(state: GuardState) {
  state.prev = undefined;
  state.consecutiveMisses = 0;
  state.totalMisses = 0;
  state.cumulativeMissCost = 0;
}

function statusLine(state: GuardState): string {
  if (!state.enabled) return "cache-guard: disabled (global)";
  return (
    `cache-guard: on (global, logging ${state.logging ? "on" : "off"}) | significant miss >= ${state.significantMissTokens} tok or $${state.significantMissCost.toFixed(2)} | ` +
    `streak ${state.consecutiveMisses}/${state.maxConsecutiveMisses} | ` +
    `total ${state.totalMisses}/${state.maxTotalMisses} | ` +
    `$${state.cumulativeMissCost.toFixed(2)}/$${state.maxCumulativeMissCost.toFixed(2)}`
  );
}

export default function (pi: ExtensionAPI) {
  let state = freshState();

  // Pick up changes made by other pi processes/sessions since we last loaded.
  pi.on("session_start", async () => {
    state = { ...loadSettings(), prev: undefined, consecutiveMisses: 0, totalMisses: 0, cumulativeMissCost: 0 };
  });

  function persist() {
    saveSettings(state);
  }

  function log(
  ctx: { ui: { notify: (msg: string, kind?: "info" | "warning" | "error") => void } },
  message: string,
  kind: "info" | "warning" | "error" = "info",
) {
    if (!state.logging) return;
    ctx.ui.notify(message, kind);
  }

  function setEnabled(
  ctx: { ui: { notify: (msg: string, kind?: "info" | "warning" | "error") => void } },
  enabled: boolean,
) {
    state.enabled = enabled;
    resetCounters(state);
    persist();
    // Enable/disable is a deliberate user action, not a status-change log line —
    // always confirm it regardless of the logging setting.
    ctx.ui.notify(enabled ? "cache-guard enabled globally" : "cache-guard disabled globally", enabled ? "info" : "warning");
  }

  const SUBCOMMANDS = ["status", "on", "off", "log", "reset", "consecutive", "max", "cost", "significant-tokens", "significant-cost"];

  pi.registerCommand("cache-guard", {
    description:
      "Configure the global prompt-cache-miss guardrail (status|on|off|log on|off|reset|consecutive N|max N|cost N|significant-tokens N|significant-cost N)",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const items = SUBCOMMANDS.map((s) => ({ value: s, label: s }));
      const filtered = items.filter((i) => i.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      const [sub, ...rest] = (args ?? "").trim().split(/\s+/).filter(Boolean);

      switch (sub) {
        case undefined:
        case "status": {
          ctx.ui.notify(`${statusLine(state)}\nsettings file: ${SETTINGS_PATH}`, "info");
          return;
        }
        case "on": {
          setEnabled(ctx, true);
          return;
        }
        case "off": {
          setEnabled(ctx, false);
          return;
        }
        case "log": {
          const value = rest[0]?.toLowerCase();
          if (value !== "on" && value !== "off") {
            ctx.ui.notify("Usage: /cache-guard log <on|off>", "error");
            return;
          }
          state.logging = value === "on";
          persist();
          // Deliberate user action, not a status-change log line — always confirm.
          ctx.ui.notify(`cache-guard logging turned ${value} (global)`, "info");
          return;
        }
        case "reset": {
          resetCounters(state);
          ctx.ui.notify("cache-guard counters reset for this session", "info");
          return;
        }
        case "consecutive": {
          const n = Number(rest[0]);
          if (!Number.isFinite(n) || n < 1) {
            ctx.ui.notify("Usage: /cache-guard consecutive <positive integer>", "error");
            return;
          }
          state.maxConsecutiveMisses = Math.floor(n);
          persist();
          ctx.ui.notify(`consecutive-miss threshold set to ${state.maxConsecutiveMisses} (global)`, "info");
          return;
        }
        case "max": {
          const n = Number(rest[0]);
          if (!Number.isFinite(n) || n < 1) {
            ctx.ui.notify("Usage: /cache-guard max <positive integer>", "error");
            return;
          }
          state.maxTotalMisses = Math.floor(n);
          persist();
          ctx.ui.notify(`total-miss threshold set to ${state.maxTotalMisses} (global)`, "info");
          return;
        }
        case "cost": {
          const n = Number(rest[0]);
          if (!Number.isFinite(n) || n <= 0) {
            ctx.ui.notify("Usage: /cache-guard cost <positive dollar amount>", "error");
            return;
          }
          state.maxCumulativeMissCost = n;
          persist();
          ctx.ui.notify(`cumulative-cost threshold set to $${n.toFixed(2)} (global)`, "info");
          return;
        }
        case "significant-tokens": {
          const n = Number(rest[0]);
          if (!Number.isFinite(n) || n < 0) {
            ctx.ui.notify("Usage: /cache-guard significant-tokens <tokens, e.g. 20000>", "error");
            return;
          }
          state.significantMissTokens = Math.floor(n);
          persist();
          ctx.ui.notify(
            `a miss now counts once it's >= ${state.significantMissTokens} tokens OR >= $${state.significantMissCost.toFixed(2)} (global)`,
            "info",
          );
          return;
        }
        case "significant-cost": {
          const n = Number(rest[0]);
          if (!Number.isFinite(n) || n < 0) {
            ctx.ui.notify("Usage: /cache-guard significant-cost <dollar amount, e.g. 0.10>", "error");
            return;
          }
          state.significantMissCost = n;
          persist();
          ctx.ui.notify(
            `a miss now counts once it's >= ${state.significantMissTokens} tokens OR >= $${state.significantMissCost.toFixed(2)} (global)`,
            "info",
          );
          return;
        }
        default: {
          ctx.ui.notify(`Unknown subcommand '${sub}'. Try: ${SUBCOMMANDS.join(", ")}`, "error");
        }
      }
    },
  });

  pi.on("message_end", async (event, ctx) => {
    if (!state.enabled) return;

    const msg = event.message;
    if (msg.role !== "assistant") return;
    const usage = (msg as any).usage;
    if (!usage) return;

    const input = usage.input ?? 0;
    const cacheRead = usage.cacheRead ?? 0;
    const cacheWrite = usage.cacheWrite ?? 0;
    const promptTokens = input + cacheRead + cacheWrite;
    const reportedCacheNow = cacheRead + cacheWrite > 0;

    if (promptTokens <= 0) return;

    // Only count once a provider has shown cache activity at least once
    // (avoids false positives on providers/models that never cache).
    if (state.prev && (reportedCacheNow || state.prev.reportedCache)) {
      const missed = Math.min(state.prev.promptTokens, promptTokens) - cacheRead;
      if (missed > NOISE_FLOOR_TOKENS) {
        const cost = usage.cost ?? {};
        const paidTokens = input + cacheWrite;
        const paidCost = (cost.input ?? 0) + (cost.cacheWrite ?? 0);
        const paidPerToken = paidTokens > 0 ? paidCost / paidTokens : 0;
        const readPerToken = cacheRead > 0 ? (cost.cacheRead ?? 0) / cacheRead : 0;
        const missedCost = missed * Math.max(0, paidPerToken - readPerToken);

        // Only count it if it's "significant" — same bar pi itself uses before
        // showing a Cache miss banner. Smaller misses are real waste too, but
        // ignoring them here keeps the guard's counters matching what's visible
        // in the transcript instead of tripping on misses you never saw flagged.
        const isSignificant = missed >= state.significantMissTokens || missedCost >= state.significantMissCost;
        if (!isSignificant) {
          state.prev = { promptTokens, reportedCache: reportedCacheNow };
          return;
        }

        state.consecutiveMisses += 1;
        state.totalMisses += 1;
        state.cumulativeMissCost += missedCost;

        log(
          ctx,
          `cache-guard: significant miss (~$${missedCost.toFixed(2)}, ${missed} tokens) — ${statusLine(state)}`,
          "warning",
        );

        const tripped =
          state.consecutiveMisses >= state.maxConsecutiveMisses ||
          state.totalMisses >= state.maxTotalMisses ||
          state.cumulativeMissCost >= state.maxCumulativeMissCost;

        if (tripped) {
          const reason =
            state.consecutiveMisses >= state.maxConsecutiveMisses
              ? `${state.consecutiveMisses} consecutive misses`
              : state.totalMisses >= state.maxTotalMisses
                ? `${state.totalMisses} total misses (non-consecutive)`
                : `$${state.cumulativeMissCost.toFixed(2)} cumulative re-billed`;

          ctx.abort();
          // The trip itself is a hard stop, not a routine status update — always show it.
          ctx.ui.notify(
            `cache-guard: stopped the run — ${reason}. Inspect before continuing ` +
              `(check thinking level / model / idle gaps), then '/cache-guard reset' once caching recovers.`,
            "warning",
          );
          resetCounters(state);
          return;
        }
      } else {
        // A properly-cached turn breaks the consecutive streak but not the total count.
        if (state.consecutiveMisses > 0) {
          state.consecutiveMisses = 0;
          log(ctx, `cache-guard: cache hit — streak reset (${statusLine(state)})`, "info");
        }
      }
    }

    state.prev = { promptTokens, reportedCache: reportedCacheNow };
  });
}
