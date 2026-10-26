// Regression check for the nudge throttle. Run: node --test nudge.test.ts
// Every accepted form must map to the documented milliseconds, and every
// rejected form must throw: a silent fallback would let a typo pass as a real
// throttle. The last block pins the gate itself, because that arithmetic decides
// whether I stay quiet.

import { test } from "node:test"
import assert from "node:assert/strict"
import { DEFAULT_EVERY_MS, MIN_EVERY_MS, MAX_EVERY_MS, formatEvery, parseNudgeEvery, resolveCooldownMs } from "./nudge.ts"

test("durations parse to milliseconds", () => {
  assert.equal(parseNudgeEvery("10m"), 600000)
  assert.equal(parseNudgeEvery("1h"), 3600000)
  assert.equal(parseNudgeEvery("1h30m"), 5400000)
  assert.equal(parseNudgeEvery("90s"), 90000)
  assert.equal(parseNudgeEvery("45"), 2700000)
  assert.equal(parseNudgeEvery(45), 2700000)
  assert.equal(parseNudgeEvery("1.5h"), 5400000)
  assert.equal(parseNudgeEvery("2h15m30s"), 8130000)
  assert.equal(parseNudgeEvery(" 1H 30M "), 5400000)
})

test("off and default are distinct from a duration", () => {
  assert.equal(parseNudgeEvery("off"), 0)
  assert.equal(parseNudgeEvery("OFF"), 0)
  assert.equal(parseNudgeEvery("0"), 0)
  assert.equal(parseNudgeEvery("0m"), 0)
  assert.equal(parseNudgeEvery(0), 0)
  assert.equal(parseNudgeEvery("default"), null)
  assert.equal(parseNudgeEvery("DEFAULT"), null)
})

test("bad input throws instead of falling back", () => {
  assert.throws(() => parseNudgeEvery(""), /duration/)
  assert.throws(() => parseNudgeEvery("   "), /duration/)
  assert.throws(() => parseNudgeEvery("abc"), /unreadable|duration/)
  assert.throws(() => parseNudgeEvery("-5"), /unreadable|duration/)
  assert.throws(() => parseNudgeEvery("2d"), /unreadable/)
  assert.throws(() => parseNudgeEvery("30s"), /too small/)
  assert.throws(() => parseNudgeEvery("25h"), /too large/)
  assert.throws(() => parseNudgeEvery("500ms"), /too small/)
  assert.throws(() => parseNudgeEvery(null), /duration/)
  assert.throws(() => parseNudgeEvery({}), /duration/)
})

test("the stored value resolves to a cooldown, with off as null", () => {
  assert.equal(resolveCooldownMs(undefined), DEFAULT_EVERY_MS)
  assert.equal(resolveCooldownMs(null), DEFAULT_EVERY_MS)
  assert.equal(resolveCooldownMs("nonsense"), DEFAULT_EVERY_MS)
  assert.equal(resolveCooldownMs(0), null)
  assert.equal(resolveCooldownMs(3600000), 3600000)
  assert.equal(resolveCooldownMs(1), MIN_EVERY_MS)
  assert.equal(resolveCooldownMs(MAX_EVERY_MS * 2), MAX_EVERY_MS)
})

test("formatting round-trips the advertised forms", () => {
  assert.equal(formatEvery(0), "off")
  assert.equal(formatEvery(600000), "10m")
  assert.equal(formatEvery(3600000), "1h")
  assert.equal(formatEvery(5400000), "1h30m")
  assert.equal(formatEvery(90000), "1m30s")
  assert.equal(formatEvery(2700000), "45m")
  assert.equal(formatEvery(Number.NaN), "off")
})

test("gate: off never fires, a custom interval waits for its own window", () => {
  const fired = (stored: unknown, lastNudgeAgoMs: number): boolean => {
    const cooldown = resolveCooldownMs(stored)
    if (cooldown === null) return false
    return lastNudgeAgoMs >= cooldown
  }
  assert.equal(fired(0, 24 * 3600 * 1000), false)
  assert.equal(fired(undefined, 5 * 60 * 1000), false)
  assert.equal(fired(undefined, 11 * 60 * 1000), true)
  assert.equal(fired(2 * 3600 * 1000, 11 * 60 * 1000), false)
  assert.equal(fired(2 * 3600 * 1000, 2 * 3600 * 1000 + 1000), true)
})
