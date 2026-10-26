// Pure helpers for the per-session nudge throttle.
//
// These live outside index.ts because index.ts imports "@opencode/plugin", which
// only resolves inside the OpenCode host; a test runner cannot load it. Nothing
// here touches the filesystem or the clock, so a test can pin every value.
//
// Contract for the value stored as nudgeEveryMs in a session GOAL file:
//   null     - no override; I fall back to DEFAULT_EVERY_MS
//   0        - off; I never nudge that session
//   positive - cooldown in ms, kept inside MIN_EVERY_MS..MAX_EVERY_MS

export const DEFAULT_EVERY_MS = 10 * 60 * 1000
export const MIN_EVERY_MS = 60 * 1000
export const MAX_EVERY_MS = 24 * 60 * 60 * 1000

export type NudgeEvery = number | null

const OFF_WORDS = new Set(["off", "none", "never"])
const DEFAULT_WORDS = new Set(["default", "reset"])

// Longest alternatives first: a shared prefix must not win the match, or "500ms"
// would parse as 500 m plus a stray "s".
const TOKEN = /(\d+(?:\.\d+)?)(ms|h|m|s)/g

function outOfRange(ms: number): never {
  if (ms < MIN_EVERY_MS) {
    throw new Error(`nudgeEvery is too small: minimum is 1m, got ${formatEvery(ms)}`)
  }
  throw new Error(`nudgeEvery is too large: maximum is 24h, got ${formatEvery(ms)}`)
}

// I accept the four forms the tool description advertises plus two convenience
// ones: a bare number (minutes) and a number rather than a string, because a
// model that forgets the quotes would otherwise burn a turn on a retry.
// I reject anything else on purpose: a silent fallback would hide a typo and
// leave the caller believing a throttle is in effect when it is not.
export function parseNudgeEvery(raw: unknown): NudgeEvery {
  const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw : ""
  const s = text.trim().toLowerCase().replace(/\s+/g, "")
  if (!s) {
    throw new Error("nudgeEvery needs a duration such as 30m, 1h, 1h30m, 90s, a bare number of minutes, off, or default")
  }
  if (DEFAULT_WORDS.has(s)) return null
  if (OFF_WORDS.has(s)) return 0
  if (/^\d+(?:\.\d+)?$/.test(s)) {
    const ms = Math.round(Number(s) * 60000)
    if (ms <= 0) return 0
    if (ms < MIN_EVERY_MS || ms > MAX_EVERY_MS) outOfRange(ms)
    return ms
  }
  let total = 0
  TOKEN.lastIndex = 0
  for (let m = TOKEN.exec(s); m; m = TOKEN.exec(s)) {
    const n = Number(m[1])
    const unit = m[2]
    const factor = unit === "ms" ? 1 : unit === "h" ? 3600000 : unit === "m" ? 60000 : 1000
    total += n * factor
  }
  const rest = s.replace(TOKEN, "")
  if (rest) throw new Error(`nudgeEvery has an unreadable part "${rest}": use forms such as 30m, 1h, 1h30m, 90s, 45`)
  const ms = Math.round(total)
  if (ms <= 0) return 0
  if (ms < MIN_EVERY_MS || ms > MAX_EVERY_MS) outOfRange(ms)
  return ms
}

// null means "never nudge" (off). I read a corrupt stored value as "no
// override" rather than as off, so a hand-edited file cannot silently mute me.
export function resolveCooldownMs(stored: unknown): number | null {
  if (stored === null || stored === undefined) return DEFAULT_EVERY_MS
  const n = typeof stored === "number" ? stored : NaN
  if (!Number.isFinite(n)) return DEFAULT_EVERY_MS
  if (n <= 0) return null
  if (n < MIN_EVERY_MS) return MIN_EVERY_MS
  if (n > MAX_EVERY_MS) return MAX_EVERY_MS
  return Math.round(n)
}

export function formatEvery(ms: unknown): string {
  const n = typeof ms === "number" && Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : 0
  if (n === 0) return "off"
  const h = Math.floor(n / 3600000)
  const m = Math.floor((n % 3600000) / 60000)
  const s = Math.floor((n % 60000) / 1000)
  const parts: string[] = []
  if (h > 0) parts.push(`${h}h`)
  if (m > 0) parts.push(`${m}m`)
  if (s > 0) parts.push(`${s}s`)
  return parts.length > 0 ? parts.join("") : "0s"
}
