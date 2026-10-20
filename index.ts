import { Plugin } from "@opencode/plugin"

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// goal-for-opencode - the GOAL watchdog I use for my own long OpenCode runs.
//
// I keep the GOALs in one file per session and let the main agent create and
// close them; I never write a status myself. My goal is narrow: when a session
// with open GOALs stops moving, I send one prompt and let the agent decide
// whether to continue or to close the GOAL with a stop rule.
//
// The four stop rules I accept are done / need_human_decision /
// need_human_action / blocked (with evidence).
//
// I store state in ~/.config/opencode/goal-for-opencode-sessions/<sessionID>.json
// I expose that file only through the `goal` tool below.
// Free-form fields (target, doneCriteria, plan, evidence) accept any language;
// I keep the tool definition itself English-only.

const VERSION = "1.0.5"
const LOG = "goal-for-opencode-debug.log"
const SESSIONS_DIRNAME = "goal-for-opencode-sessions"
const SCAN_INTERVAL_MS = 60000
const MIN_SCAN_GAP_MS = 15000
const NUDGE_COOLDOWN_MS = 10 * 60 * 1000
const PRUNE_AFTER_MS = 7 * 24 * 3600 * 1000
const RECENT_WINDOW = 10

type GoalStatus = "open" | "done"

interface Goal {
  id?: string
  target?: string
  doneCriteria?: string
  plan?: string
  status?: GoalStatus
  doneReason?: string
  evidence?: string
  createdAt?: string
  updatedAt?: string
}

interface GoalFile {
  version?: number
  sessionID?: string
  updatedAt?: string
  lastNudgeAt?: number | null
  pendingChildIDs?: string[]
  digestSince?: number | null
  nudgeStreak?: number
  goals?: Goal[]
}

interface SessionCtx {
  context(input: { sessionID: string }): Promise<unknown>
  prompt(input: { sessionID: string; text: string }): Promise<unknown>
}

function configDir(): string {
  return join(homedir(), ".config", "opencode")
}

function sessionsDir(): string {
  return join(configDir(), SESSIONS_DIRNAME)
}

function ensureSessionsDir(): void {
  try {
    if (!existsSync(sessionsDir())) mkdirSync(sessionsDir(), { recursive: true })
  } catch {}
}

// I keep the scan lock on disk: the host loads me several times per process
// and sometimes in more than one process, so an in-memory flag would not stop
// two scans from overlapping. Directory creation is atomic everywhere I run;
// I treat a lock older than 120 s as abandoned.
function scanLockPath(): string {
  return join(configDir(), "goal-for-opencode.scan.lock.d")
}

function stateDir(): string {
  return join(configDir(), "goal-for-opencode-state")
}

function scanStampPath(): string {
  return join(stateDir(), ".scan.stamp")
}

function busyDir(): string {
  return join(stateDir(), "busy")
}

function ensureStateDirs(): void {
  try { mkdirSync(busyDir(), { recursive: true }) } catch {}
}

function turnFile(sid: string): string {
  return join(stateDir(), `${sid}.turnend`)
}

function noteTurnEndDisk(sid: string): void {
  try { writeFileSync(turnFile(sid), String(Date.now()), "utf-8") } catch {}
}

function turnEndFresh(sid: string): boolean {
  try {
    const t = Number(readFileSync(turnFile(sid), "utf-8").trim())
    return t > 0 && Date.now() - t < ACTIVE_WINDOW_MS
  } catch {
    return false
  }
}

const BUSY_STALE_MS = 30 * 60 * 1000

function busyKey(sid: string, callID: string): string {
  const safe = `${sid}-${callID}`.replace(/[^A-Za-z0-9_-]/g, "_")
  return join(busyDir(), safe)
}

// True while this session has a fresh marker. I delete markers past the stale
// horizon as a side effect, so callers see the same evidence a later sweep
// would.
function hasLiveBusy(sid: string): boolean {
  let dir: string[]
  try {
    dir = readdirSync(busyDir())
  } catch {
    return false
  }
  let live = false
  for (const n of dir) {
    if (!n.startsWith(`${sid}-`)) continue
    try {
      const st = statSync(join(busyDir(), n))
      if (Date.now() - st.mtimeMs > BUSY_STALE_MS) {
        try { unlinkSync(join(busyDir(), n)) } catch {}
        continue
      }
      live = true
    } catch {}
  }
  return live
}

// Deletes every marker of the session. I call this when a call ends without an
// id, or when a finished session is pruned.
function clearBusy(sid: string): void {
  let dir: string[]
  try {
    dir = readdirSync(busyDir())
  } catch {
    return
  }
  for (const n of dir) {
    if (!n.startsWith(`${sid}-`)) continue
    try { unlinkSync(join(busyDir(), n)) } catch {}
  }
}

// I return my ownership token on success and null when someone else holds the
// lock. I pass the token back on release, so overlapping scans of the same
// instance can never delete each other's lock. This never throws: every file
// operation inside is guarded.
function acquireScanLock(): string | null {
  const lock = scanLockPath()
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  try {
    mkdirSync(lock)
  } catch {
    // Someone holds the lock; I take over only when it looks stale. My takeover
    // claims the directory with an atomic rename and re-checks freshness
    // afterwards: if I caught a lock that had just been re-created, I put it
    // back and back off instead of double-holding. No recursion, so a failing
    // rename can never overflow the stack.
    let stale = false
    try {
      stale = Date.now() - statSync(lock).mtimeMs > 120000
    } catch {
      return null
    }
    if (!stale) return null
    const claimed = `${lock}.stale-${token}`
    try {
      renameSync(lock, claimed)
    } catch {
      return null
    }
    let stillStale = false
    try {
      stillStale = Date.now() - statSync(claimed).mtimeMs > 120000
    } catch {}
    if (!stillStale) {
      try { renameSync(claimed, lock) } catch {}
      return null
    }
    try { rmSync(claimed, { recursive: true, force: true }) } catch {}
    try {
      mkdirSync(lock)
    } catch {
      return null
    }
  }
  try { writeFileSync(join(lock, "owner"), token, "utf-8") } catch {}
  return token
}

// I only let the owner release: a scan that overran the stale window must not
// delete the lock a newer scan now holds. Any other caller is a no-op.
function releaseScanLock(token: string): void {
  const lock = scanLockPath()
  let owner = ""
  try { owner = readFileSync(join(lock, "owner"), "utf-8").trim() } catch {}
  if (owner !== token) return
  try { rmSync(lock, { recursive: true, force: true }) } catch {}
}

function debugLogLine(msg: string): void {
  try {
    appendFileSync(join(configDir(), LOG), `[${new Date().toISOString()}] [pid=${process.pid}] ${msg}\n`)
  } catch {}
}

function isSessionID(v: unknown): v is string {
  return typeof v === "string" && /^ses_[A-Za-z0-9]+$/.test(v)
}

function goalFilePath(sessionID: string): string | null {
  if (!isSessionID(sessionID)) return null
  return join(sessionsDir(), `${sessionID}.json`)
}

function loadGoalFile(path: string): GoalFile | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown
    if (!parsed || typeof parsed !== "object") return null
    return parsed as GoalFile
  } catch {
    return null
  }
}

function loadOrInit(sessionID: string): { path: string; gf: GoalFile } | null {
  const path = goalFilePath(sessionID)
  if (!path) return null
  ensureSessionsDir()
  const existing = existsSync(path) ? loadGoalFile(path) : null
  const gf: GoalFile = existing ?? { version: 1, sessionID, goals: [], pendingChildIDs: [], lastNudgeAt: 0 }
  if (!Array.isArray(gf.goals)) gf.goals = []
  if (!Array.isArray(gf.pendingChildIDs)) gf.pendingChildIDs = []
  return { path, gf }
}

// I replace GOAL files atomically through a temp file: a reader must never see
// a half-written file, because a torn read used to look like a missing file
// and the next write would wipe the history. If Windows blocks the rename with
// EPERM/EACCES/EBUSY I retry, then fall back to a direct write; only when that
// also fails do I rethrow.
function writeFileAtomic(path: string, content: string): void {
  // I make the temp name unique per write: my instances share one pid, so a
  // pid-only name would collide between concurrent writers.
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
  try {
    writeFileSync(tmp, content, "utf-8")
    for (let attempt = 0; ; attempt++) {
      try {
        renameSync(tmp, path)
        return
      } catch (e) {
        const code = String((e as { code?: unknown })["code"] ?? "")
        const retryable = code === "EPERM" || code === "EACCES" || code === "EBUSY"
        if (!retryable || attempt >= 2) {
          // A concurrent reader can block the rename on Windows, so I fall
          // back to a plain write: losing atomicity beats failing the caller.
          try {
            writeFileSync(path, content, "utf-8")
            return
          } catch {
            throw e
          }
        }
      }
    }
  } finally {
    try { unlinkSync(tmp) } catch {}
  }
}

function saveGoalFile(path: string, gf: GoalFile): void {
  // My scan owns lastNudgeAt/digestSince, so I adopt whatever is on disk now
  // instead of clobbering an update that landed after this copy was loaded.
  // Side effect: writes the whole file atomically; failures propagate.
  const fresh = loadGoalFile(path)
  if (fresh) {
    if (typeof fresh.lastNudgeAt === "number") gf.lastNudgeAt = fresh.lastNudgeAt
    if (fresh.digestSince === null || typeof fresh.digestSince === "number") gf.digestSince = fresh.digestSince
  }
  gf.updatedAt = new Date().toISOString()
  writeFileAtomic(path, JSON.stringify(gf, null, 2))
}

// My scan owns only digestSince/lastNudgeAt, so I merge those two fields into
// the freshest copy; a goal-tool write landing mid-scan stays untouched. All
// errors are swallowed: a failed merge costs one grace window at most.
function mergeWriteScanState(path: string, patch: { digestSince?: number | null; lastNudgeAt?: number; nudgeStreak?: number }): void {
  try {
    const fresh = loadGoalFile(path)
    if (!fresh) return
    if ("digestSince" in patch) fresh.digestSince = patch.digestSince ?? null
    if (typeof patch.lastNudgeAt === "number") fresh.lastNudgeAt = patch.lastNudgeAt
    if (typeof patch.nudgeStreak === "number") fresh.nudgeStreak = patch.nudgeStreak
    fresh.updatedAt = new Date().toISOString()
    writeFileAtomic(path, JSON.stringify(fresh, null, 2))
  } catch {}
}

function openGoals(gf: GoalFile): Goal[] {
  if (!Array.isArray(gf.goals)) return []
  return gf.goals.filter((g) => g && g.status !== "done" && typeof g.target === "string" && g.target.length > 0)
}

function toArray(msgs: unknown): unknown[] {
  if (Array.isArray(msgs)) return msgs
  const o = msgs as Record<string, unknown> | null
  if (o && Array.isArray(o["data"])) return o["data"] as unknown[]
  return []
}

// Stringifying a whole history once per registered child is expensive on
// multi-MB sessions, so I cache by object identity for the scan.
const jsonCache = new WeakMap<object, string>()

function toJsonCached(v: unknown): string {
  if (v && typeof v === "object") {
    const hit = jsonCache.get(v as object)
    if (hit !== undefined) return hit
  }
  let s = ""
  try {
    s = JSON.stringify(v)
  } catch {
    return ""
  }
  if (v && typeof v === "object") jsonCache.set(v as object, s)
  return s
}

// V2 carries the role in `type` ("user"/"assistant"/...); V1 used
// {info:{role}} or a flat `role`. I accept every shape I have seen.
function msgRole(m: unknown): string {
  const o = m as Record<string, unknown> | null
  if (!o || typeof o !== "object") return ""
  const info = o["info"] as Record<string, unknown> | undefined
  if (info && typeof info["role"] === "string") return info["role"] as string
  if (typeof o["role"] === "string") return o["role"] as string
  const t = o["type"]
  if (t === "user" || t === "assistant" || t === "system") return t
  return ""
}

// V1 holds parts under `parts`; V2 assistant messages hold them under
// `content`. I read both.
function msgParts(m: unknown): unknown[] {
  const o = m as Record<string, unknown> | null
  if (!o || typeof o !== "object") return []
  const p = o["parts"]
  if (Array.isArray(p)) return p
  const c = o["content"]
  return Array.isArray(c) ? c : []
}

function partText(p: unknown): string {
  const o = p as Record<string, unknown> | null
  if (!o || typeof o !== "object") return ""
  if (typeof o["text"] === "string") return o["text"] as string
  return ""
}

function hasRunningTool(msgs: unknown, n: number): boolean {
  for (const m of toArray(msgs).slice(-n)) {
    for (const p of msgParts(m)) {
      const po = p as Record<string, unknown> | null
      if (!po || typeof po !== "object") continue
      const t = typeof po["type"] === "string" ? (po["type"] as string).toLowerCase() : ""
      if (t !== "tool" && t !== "tool_use" && t !== "tool-call" && !("state" in po)) continue
      try {
        const st = (po["state"] ?? po["status"]) as unknown
        const s = typeof st === "string"
          ? st.toLowerCase()
          : typeof (st as Record<string, unknown> | null)?.["status"] === "string"
            ? String((st as Record<string, unknown>)["status"]).toLowerCase()
            : ""
        if (s === "running" || s === "streaming" || s === "pending" || s === "in_progress" || s === "in-progress") return true
      } catch {}
    }
  }
  return false
}

// V2 exposes long-lived shell jobs as their own message type. While one is
// running I treat the session as waiting, not idle.
function hasRunningShell(msgs: unknown, n: number): boolean {
  for (const m of toArray(msgs).slice(-n)) {
    const o = m as Record<string, unknown> | null
    if (!o || typeof o !== "object") continue
    if (o["type"] !== "shell") continue
    const st = o["status"]
    if (st === "running" || st === "streaming" || st === "started") return true
  }
  return false
}

function lastUserText(msgs: unknown): string {
  const arr = toArray(msgs)
  for (let i = arr.length - 1; i >= 0; i--) {
    if (msgRole(arr[i]) !== "user") continue
    // V2 user messages carry the body in a top-level `text` string; I read
    // that before falling back to parts.
    const o = arr[i] as Record<string, unknown> | null
    let t = o && typeof o["text"] === "string" ? `${o["text"]}\n` : ""
    for (const p of msgParts(arr[i])) t += partText(p) + "\n"
    t = t.trim()
    if (t) return t
  }
  return ""
}

const ACTIVE_WINDOW_MS = 3 * 60 * 1000
// I treat these markers as my own messages: "goal watchdog" is mine, and
// "auto retry" comes from another plugin of mine that also injects prompts;
// neither should count as a human speaking or as a child report.
const OWN_NUDGE_MARKERS = ["goal watchdog", "auto retry"]

function messageTime(m: unknown): number {
  const o = m as Record<string, unknown> | null
  if (!o || typeof o !== "object") return 0
  const cands: unknown[] = []
  try {
    const info = o["info"] as Record<string, unknown> | undefined
    const t1 = o["time"] as Record<string, unknown> | undefined
    const t2 = info?.["time"] as Record<string, unknown> | undefined
    cands.push(t1?.["created"], t1?.["completed"], t2?.["created"], t2?.["completed"])
    cands.push(info?.["created"], o["created"], o["timestamp"], o["time_created"])
  } catch {}
  for (const c of cands) {
    if (typeof c === "number" && c > 1e11) return c
    if (typeof c === "string" && c) {
      const p = Date.parse(c)
      if (!Number.isNaN(p)) return p
    }
  }
  return 0
}

function newestMessageTime(msgs: unknown): number {
  let best = 0
  for (const m of toArray(msgs)) {
    const t = messageTime(m)
    if (t > best) best = t
  }
  return best
}

// Timestamp of the newest assistant message that carries real content: text,
// reasoning or a tool part. Empty or failed assistant messages do not count,
// so a model that keeps failing without producing anything cannot reset my
// silence counter.
function newestAgentActivityTime(msgs: unknown): number {
  const arr = toArray(msgs)
  for (let i = arr.length - 1; i >= 0; i--) {
    if (msgRole(arr[i]) !== "assistant") continue
    let hasContent = false
    for (const p of msgParts(arr[i])) {
      const po = p as Record<string, unknown> | null
      if (!po || typeof po !== "object") continue
      const pt = typeof po["type"] === "string" ? (po["type"] as string).toLowerCase() : ""
      if (pt === "tool" || pt === "tool_use" || pt === "tool-call") {
        hasContent = true
        break
      }
      if ((pt === "text" || pt === "reasoning") && typeof po["text"] === "string" && (po["text"] as string).length > 0) {
        hasContent = true
        break
      }
    }
    if (hasContent) return messageTime(arr[i])
  }
  return 0
}

function isOwnNudge(text: string): boolean {
  const t = text.toLowerCase()
  return OWN_NUDGE_MARKERS.some((m) => t.includes(m))
}

// My own nudge prompts must never count as activity or as child completion
// reports; the "GOAL watchdog" prefix is the only marker I need.
function isWatchdogOwnMessage(s: string): boolean {
  return s.includes("GOAL watchdog")
}
// I only accept semantic completion signals: tool parts carry status
// "completed"/"error", subagent reports carry state "completed"/"error"/
// "cancelled". I stopped matching a bare `"completed"` string because it also
// hit `time.completed` keys of ordinary messages and gave me 63 false "child
// finished" hits in five days.
function hasCompletionSignal(s: string): boolean {
  return /"(?:status|state)"\s*:\s*"(?:completed|error|cancelled)"/i.test(s)
}
function parentAwaitingReply(parentMsgs: unknown, childIDs: string[]): boolean {
  const arr = toArray(parentMsgs)
  let lastReportIdx = -1
  arr.forEach((m, i) => {
    const s = toJsonCached(m)
    if (!s) return
    if (isWatchdogOwnMessage(s)) return
    // Prose may say "subagent", so I only count structured fields as child
    // mentions. JSON escaping makes `"name":"subagent"` / `"source":"subagent"`
    // impossible to fake from inside message text.
    const mentionsChild =
      childIDs.some((c) => c && s.includes(c)) || /"(?:name|source)"\s*:\s*"subagent"/i.test(s)
    if (!mentionsChild) return
    if (!hasCompletionSignal(s)) return
    lastReportIdx = i
  })
  if (lastReportIdx < 0) return false
  for (let i = lastReportIdx + 1; i < arr.length; i++) {
    if (msgRole(arr[i]) === "assistant") return false
  }
  return true
}

const GOAL_TOOL_INPUT = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["create", "list", "done", "set_children"],
      description: "create: open a new GOAL. list: show open GOALs. done: close a GOAL with a stop reason. set_children: replace pendingChildIDs.",
    },
    target: { type: "string", description: "Goal objective, any language. Required for create." },
    doneCriteria: { type: "string", description: "What counts as achieved, any language. Optional for create." },
    plan: { type: "string", description: "PLAN summary / todo list of the concrete steps to reach the GOAL, any language. Recommended on create." },
    id: { type: "string", description: "GOAL id such as g1. Required for done." },
    doneReason: {
      type: "string",
      enum: ["done", "need_human_decision", "need_human_action", "blocked"],
      description: "Stop rule. done: achieved. need_human_decision: a major human decision is required. need_human_action: a human must execute it. blocked: unsolvable blocker, evidence required.",
    },
    evidence: { type: "string", description: "Evidence, any language. Required when doneReason is blocked." },
    pendingChildIDs: {
      type: "array",
      items: { type: "string" },
      description: "Replacement list of outstanding child session IDs, e.g. [ses_xxx]. Required for set_children.",
    },
  },
  required: ["action"],
} as const

export default Plugin.define({
  id: "goal-for-opencode",
  async setup(ctx) {
    const cx = ctx as unknown as { session: SessionCtx }
    ensureSessionsDir()
    ensureStateDirs()
    debugLogLine(`[INIT] goal-for-opencode v${VERSION} loaded. scan=60s cooldown=10min/session`)

    // I declare these before registering any hook: my callbacks must never run
    // inside their temporal dead zone.
    const STALL_MS = 30 * 60 * 1000
    // A tool part or shell job still reporting "running" is live evidence to
    // me. I cap it generously so a part wedged at "running" forever can age
    // out, while long builds and polling wait loops stay covered.
    const RUNNING_PART_MAX_MS = 6 * 3600 * 1000
    const DIGEST_GRACE_MS = 5 * 60 * 1000
    const inFlight = new Map<string, number>()
    const inFlightAt = new Map<string, number>()
    const lastTurnEnd = new Map<string, number>()
    const skipLogAt = new Map<string, number>()

    // I drop an in-memory call counter after the same stale horizon I use for
    // the disk markers, so a call whose after hook never fired cannot silence
    // this instance forever.
    function liveInFlight(sid: string): number {
      const n = inFlight.get(sid) ?? 0
      if (n <= 0) return 0
      const at = inFlightAt.get(sid) ?? 0
      if (at > 0 && Date.now() - at > BUSY_STALE_MS) {
        inFlight.delete(sid)
        inFlightAt.delete(sid)
        return 0
      }
      return n
    }

    // Repeated SKIP lines from every instance drowned my log, so I keep at
    // most one per session and kind every 5 minutes.
    function logSkipThrottled(sid: string, kind: string, msg: string): void {
      const key = `${sid}|${kind}`
      const last = skipLogAt.get(key) ?? 0
      if (Date.now() - last < 5 * 60 * 1000) return
      skipLogAt.set(key, Date.now())
      debugLogLine(msg)
    }

    try {
      await ctx.tool.transform(async (editor) => {
        editor.add({
          name: "goal",
          description: "GOAL tracker for long tasks. The main agent sets its own GOALs and closes them itself; I never close a GOAL. Actions: create opens a GOAL with target and an optional plan; list shows open GOALs; done closes a GOAL with a stop reason (done, need_human_decision, need_human_action, blocked with evidence); set_children replaces pendingChildIDs after dispatching or reaping subagents. On create, also write a short PLAN summary (a todo list of the concrete steps) into the plan field. While any GOAL is open the session is not finished: never go idle with nothing pending. If any of the four stop conditions holds (done, need_human_decision, need_human_action, blocked), you must close the GOAL yourself with action done and the matching doneReason before ending the turn. I only prompt; I never close anything.",
          input: GOAL_TOOL_INPUT,
          execute: async (input, context) => {
            const args = (input ?? {}) as Record<string, unknown>
            const action = typeof args["action"] === "string" ? (args["action"] as string) : ""
            const sessionID = (context as unknown as Record<string, unknown>)["sessionID"]
            if (typeof sessionID !== "string" || !sessionID) throw new Error("missing sessionID in tool context")
            const loaded = loadOrInit(sessionID)
            if (!loaded) throw new Error("invalid sessionID")
            const { path, gf } = loaded
            if (!Array.isArray(gf.goals)) gf.goals = []
            if (action === "create") {
              const target = typeof args["target"] === "string" ? (args["target"] as string).trim() : ""
              if (!target) throw new Error("create requires target")
              const doneCriteria = typeof args["doneCriteria"] === "string" ? (args["doneCriteria"] as string) : ""
              const plan = typeof args["plan"] === "string" ? (args["plan"] as string).trim() : ""
              const id = `g${gf.goals.length + 1}`
              const now = new Date().toISOString()
              gf.goals.push({ id, target, doneCriteria, plan, status: "open", createdAt: now, updatedAt: now })
              saveGoalFile(path, gf)
              return { content: `GOAL ${id} opened. ${openGoals(gf).length} open in session ${sessionID}.` }
            }
            if (action === "list") {
              const open = openGoals(gf)
              if (open.length === 0) return { content: "No open GOALs." }
              return { content: open.map((g) => `[${g.id ?? "?"}] ${g.target ?? ""}${g.doneCriteria ? ` (done when: ${g.doneCriteria})` : ""}${g.plan ? `\n  plan: ${g.plan}` : ""}`).join("\n") }
            }
            if (action === "done") {
              const id = typeof args["id"] === "string" ? (args["id"] as string) : ""
              const doneReason = typeof args["doneReason"] === "string" ? (args["doneReason"] as string) : ""
              const evidence = typeof args["evidence"] === "string" ? (args["evidence"] as string) : ""
              const valid = ["done", "need_human_decision", "need_human_action", "blocked"]
              if (!id) throw new Error("done requires id")
              if (!valid.includes(doneReason)) throw new Error("done requires doneReason: done, need_human_decision, need_human_action, blocked")
              if (doneReason === "blocked" && !evidence.trim()) throw new Error("blocked requires evidence")
              const g = gf.goals.find((x) => x && x.id === id)
              if (!g) throw new Error(`GOAL ${id} not found`)
              g.status = "done"
              g.doneReason = doneReason
              if (evidence) g.evidence = evidence
              g.updatedAt = new Date().toISOString()
              saveGoalFile(path, gf)
              return { content: `GOAL ${id} closed (${doneReason}). ${openGoals(gf).length} open remaining.` }
            }
            if (action === "set_children") {
              const ids = args["pendingChildIDs"]
              if (!Array.isArray(ids) || ids.some((x) => typeof x !== "string")) throw new Error("set_children requires pendingChildIDs: string[]")
              if (!ids.every((x) => isSessionID(x))) throw new Error("pendingChildIDs must be ses_... session ids")
              gf.pendingChildIDs = ids as string[]
              saveGoalFile(path, gf)
              return { content: `pendingChildIDs updated: ${(ids as string[]).length} outstanding.` }
            }
            throw new Error("unknown action: use create, list, done, set_children")
          },
        })
      })
      debugLogLine("[INIT] tool=goal registered")
    } catch (e) {
      debugLogLine(`[INIT-FAIL] tool register failed: ${String(e).slice(0, 200)}`)
    }

    try {
      await ctx.tool.hook("execute.before", async (event) => {
        try {
          const sid = hookSessionID(event)
          if (sid) {
            inFlight.set(sid, (inFlight.get(sid) ?? 0) + 1)
            inFlightAt.set(sid, Date.now())
            const ev = event as Record<string, unknown>
            const cid = typeof ev["id"] === "string" && ev["id"] ? (ev["id"] as string) : ""
            // Without a call id my marker could never be removed by a matching
            // after hook, so I skip it and let the running-tool check cover it.
            if (cid) {
              try { writeFileSync(busyKey(sid, cid), String(Date.now()), "utf-8") } catch {}
            }
          }
        } catch {}
      })
      await ctx.tool.hook("execute.after", async (event) => {
        try {
          const sid = hookSessionID(event)
          if (sid) {
            inFlight.set(sid, Math.max(0, (inFlight.get(sid) ?? 1) - 1))
            inFlightAt.set(sid, Date.now())
            lastTurnEnd.set(sid, Date.now())
            noteTurnEndDisk(sid)
            const ev = event as Record<string, unknown>
            if (typeof ev["id"] === "string" && ev["id"]) {
              try { unlinkSync(busyKey(sid, ev["id"] as string)) } catch {}
            } else {
              clearBusy(sid)
            }
            // I self-heal after this call's own marker is gone: a leaked
            // counter from an interrupted call must not outlive its markers.
            if (!hasLiveBusy(sid)) {
              inFlight.delete(sid)
              inFlightAt.delete(sid)
            }
          }
        } catch {}
      })
      debugLogLine("[INIT] tool hooks armed")
    } catch (e) {
      debugLogLine(`[INIT-FAIL] tool hook failed: ${String(e).slice(0, 200)}`)
    }

function hookSessionID(ev: unknown): string | null {
  const o = ev as Record<string, unknown> | null
  if (!o || typeof o !== "object") return null
  // I never fall back to `id`: on tool events that is the call id. My
  // whitelist also keeps junk out of turnend file names.
  const v = o["sessionID"] ?? o["sessionId"]
  return isSessionID(v) ? v : null
}

interface Liveness {
  state: "active" | "idle" | "gone"
  newest: number
}

function childFinishedInParent(parentMsgs: unknown, childID: string): boolean {
  for (const m of toArray(parentMsgs)) {
    if (msgRole(m) === "assistant") {
      // I only look at structured tool parts here: an unrelated completed tool
      // in the same message, or model prose quoting tool JSON, must not fake a
      // report.
      for (const p of msgParts(m)) {
        const po = p as Record<string, unknown> | null
        const pt = po && typeof po["type"] === "string" ? (po["type"] as string).toLowerCase() : ""
        if (pt !== "tool" && pt !== "tool_use" && pt !== "tool-call") continue
        const ps = toJsonCached(p)
        if (!ps) continue
        if (isWatchdogOwnMessage(ps)) continue
        if (!ps.includes(childID)) continue
        if (hasCompletionSignal(ps)) return true
      }
      continue
    }
    const s = toJsonCached(m)
    if (!s) continue
    if (isWatchdogOwnMessage(s)) continue
    if (!s.includes(childID)) continue
    if (hasCompletionSignal(s)) return true
  }
  return false
}

// Reads the session transcript and answers active, idle or gone. A failed read
// means gone. This is the expensive call of a scan: it pulls the full history,
// so I only reach it after the cheap checks.
async function checkLiveness(sessionID: string): Promise<Liveness> {
  let msgs: unknown
  try {
    msgs = await cx.session.context({ sessionID })
  } catch {
    return { state: "gone", newest: 0 }
  }
  const arr = toArray(msgs)
  if (arr.length === 0) return { state: "idle", newest: 0 }
  if (liveInFlight(sessionID) > 0) return { state: "active", newest: Date.now() }
  if (hasLiveBusy(sessionID)) return { state: "active", newest: Date.now() }
  const turnEnd = lastTurnEnd.get(sessionID) ?? 0
  if (turnEnd > 0 && Date.now() - turnEnd < ACTIVE_WINDOW_MS) return { state: "active", newest: turnEnd }
  if (turnEndFresh(sessionID)) return { state: "active", newest: Date.now() }
  const newest = newestMessageTime(msgs)
  // A part or shell job still reporting "running" keeps the session active
  // for me. The cap is deliberate: a part wedged at "running" forever must not
  // lock the session, but multi-hour builds and polling waits stay covered.
  if (newest > 0 && Date.now() - newest < RUNNING_PART_MAX_MS && (hasRunningTool(msgs, RECENT_WINDOW) || hasRunningShell(msgs, RECENT_WINDOW))) return { state: "active", newest }
  if (newest > 0 && Date.now() - newest < ACTIVE_WINDOW_MS) return { state: "active", newest }
  // A user message only means "the human's turn" to me while it is the newest
  // message and only for a bounded window. An answered task message several
  // messages back must not keep the session active forever: my old last-5
  // window did exactly that and locked me out of the stalls I exist to catch.
  const last = arr[arr.length - 1]
  if (msgRole(last) === "user" && newest > 0 && Date.now() - newest < STALL_MS) {
    const t = lastUserText(msgs).slice(0, 60)
    if (t && !isOwnNudge(t)) return { state: "active", newest }
  }
  return { state: "idle", newest }
}

    // One scan pass: take the lock, honor the global scan gap, sweep stale
    // state, check every GOAL file, and send at most one nudge per session. I
    // return void and log my own errors instead of throwing.
    async function scanOnce(reason: string): Promise<void> {
      const lockToken = acquireScanLock()
      if (!lockToken) return
      try {
      // I allow one scan per MIN_SCAN_GAP across all instances. The host loads
      // me several times per process; without this, 4-8 timers would multiply
      // scans, log lines and context() reads.
      try {
        const stamp = Number(readFileSync(scanStampPath(), "utf-8").trim())
        if (stamp > 0 && Date.now() - stamp < MIN_SCAN_GAP_MS) return
      } catch {}
      try { writeFileSync(scanStampPath(), String(Date.now()), "utf-8") } catch {}
      let files: string[] = []
      try {
        files = readdirSync(sessionsDir())
          .filter((f) => f.startsWith("ses_") && f.endsWith(".json"))
          .map((f) => join(sessionsDir(), f))
      } catch {
        return
      }
      try {
        const now = Date.now()
        for (const n of readdirSync(stateDir())) {
          if (!n.endsWith(".turnend")) continue
          try {
            const p = join(stateDir(), n)
            if (now - statSync(p).mtimeMs > PRUNE_AFTER_MS) unlinkSync(p)
          } catch {}
        }
      } catch {}
      // I sweep markers globally: orphans whose session has no goal file never
      // pass through the per-session checks and would linger forever.
      try {
        const now = Date.now()
        for (const n of readdirSync(busyDir())) {
          try {
            const p = join(busyDir(), n)
            if (now - statSync(p).mtimeMs > BUSY_STALE_MS) unlinkSync(p)
          } catch {}
        }
      } catch {}
      // I also remove lock directories left behind by an interrupted takeover
      // of mine.
      try {
        const now = Date.now()
        for (const n of readdirSync(configDir())) {
          if (!n.startsWith("goal-for-opencode.scan.lock.d.stale-")) continue
          try {
            const p = join(configDir(), n)
            if (now - statSync(p).mtimeMs > 24 * 3600 * 1000) rmSync(p, { recursive: true, force: true })
          } catch {}
        }
      } catch {}
      // I remove temp files left behind by an interrupted atomic write of mine.
      try {
        const now = Date.now()
        for (const n of readdirSync(sessionsDir())) {
          if (!n.includes(".tmp-")) continue
          try {
            const p = join(sessionsDir(), n)
            if (now - statSync(p).mtimeMs > 3600 * 1000) unlinkSync(p)
          } catch {}
        }
      } catch {}
      for (const path of files) {
        try {
          const gf = loadGoalFile(path)
          if (!gf) continue
          const sid = isSessionID(gf.sessionID) ? gf.sessionID : null
          if (!sid) continue
          const open = openGoals(gf)
          if (open.length === 0) {
            // I capture mtime before the cleanup write below so a pending
            // prune is not postponed by my digest cleanup.
            let preMtime = 0
            try { preMtime = statSync(path).mtimeMs } catch {}
            // A leftover digest marker would skip the grace window of the
            // session's next GOAL, so I clear it while the file is quiet.
            if (gf.digestSince) mergeWriteScanState(path, { digestSince: null })
            try {
              if (preMtime > 0 && Date.now() - preMtime > PRUNE_AFTER_MS) {
                unlinkSync(path)
                try { unlinkSync(turnFile(sid)) } catch {}
                clearBusy(sid)
                debugLogLine(`[PRUNE] ${sid} all done, file removed`)
              }
            } catch {}
            continue
          }
          const lastNudge = typeof gf.lastNudgeAt === "number" ? gf.lastNudgeAt : 0
          if (Date.now() - lastNudge < NUDGE_COOLDOWN_MS) continue
          if (liveInFlight(sid) > 0 || hasLiveBusy(sid)) {
            logSkipThrottled(sid, "busy", `[SKIP-BUSY] ${sid} tool running`)
            continue
          }
          const parent = await checkLiveness(sid)
          if (parent.state === "active") continue
          if (parent.state === "gone") continue
          let parentMsgs: unknown = []
          try {
            parentMsgs = await cx.session.context({ sessionID: sid })
          } catch {}
          const children = Array.isArray(gf.pendingChildIDs) ? gf.pendingChildIDs.filter((c) => isSessionID(c)) : []
          // Digest grace is about children only: with none registered a report
          // cannot exist, so I skip the awaiting-reply check.
          if (children.length > 0 && parentAwaitingReply(parentMsgs, children)) {
            const since = typeof gf.digestSince === "number" ? gf.digestSince : 0
            if (!since) {
              mergeWriteScanState(path, { digestSince: Date.now() })
              logSkipThrottled(sid, "digest-start", `[SKIP-DIGESTING] ${sid} awaiting-reply, grace starts`)
              continue
            }
            if (Date.now() - since < DIGEST_GRACE_MS) {
              logSkipThrottled(sid, "digest-grace", `[SKIP-DIGESTING] ${sid} awaiting-reply in grace`)
              continue
            }
          } else if (gf.digestSince) {
            mergeWriteScanState(path, { digestSince: null })
          }
          let childActive = false
          let outstanding = 0
          let stalled: string[] = []
          for (const cid of children.slice(0, 20)) {
            if (liveInFlight(cid) > 0 || hasLiveBusy(cid)) { childActive = true; break }
            const child = await checkLiveness(cid)
            if (child.state === "active") { childActive = true; break }
            if (childFinishedInParent(parentMsgs, cid)) continue
            outstanding++
            const quietSince = Math.max(child.newest, parent.newest)
            if (quietSince > 0 && Date.now() - quietSince > STALL_MS) stalled.push(cid)
          }
          if (childActive) continue
          if (outstanding > 0 && stalled.length === 0) {
            logSkipThrottled(sid, "outstanding", `[SKIP-OUTSTANDING] ${sid} outstanding=${outstanding}`)
            continue
          }
          // I stop after three nudges in a row that produce no agent activity
          // at all: no reasoning, no tool call, no text. At that point the
          // session is wedged in a way a prompt cannot fix, and repeating the
          // prompt only burns tokens. The count resets as soon as the agent
          // produces anything.
          const actedAt = newestAgentActivityTime(parentMsgs)
          let streak = typeof gf.nudgeStreak === "number" ? gf.nudgeStreak : 0
          if (actedAt > 0 && actedAt > lastNudge) {
            if (streak !== 0) {
              streak = 0
              mergeWriteScanState(path, { nudgeStreak: 0 })
            }
          } else if (streak >= 3) {
            logSkipThrottled(sid, "capped", `[SKIP-CAPPED] ${sid} silent after ${streak} nudges`)
            continue
          }
          const stallNote = stalled.length > 0 ? `\nPossibly stalled children (no signal anywhere for 30+ min): ${stalled.slice(0, 5).join(", ")}.` : ""
          const moreNote = children.length > 20 ? `\nNote: ${children.length - 20} more registered children were not checked in this cycle.` : ""
          const lines = open.slice(0, 10).map((g, i) => `${i + 1}. [${g.id ?? "g"}] ${g.target}`).join("\n")
          const text = `GOAL watchdog: open GOALs detected with no progress in parent or child sessions (${reason}). Main agent, keep going instead of waiting for a human.\nopen GOALs:\n${lines}${stallNote}${moreNote}\nIf any of the four stop conditions holds (done, need_human_decision, need_human_action, blocked), close the corresponding GOAL yourself right now with the goal tool: action done, the matching doneReason, and evidence for blocked. I never close GOALs on my own. Otherwise keep working and update pendingChildIDs with the goal tool.`
          try {
            await cx.session.prompt({ sessionID: sid, text })
            debugLogLine(`[NUDGE] ${sid} open=${open.length} reason=${reason}`)
            // I start the cooldown only when the nudge actually went out.
            mergeWriteScanState(path, { lastNudgeAt: Date.now(), digestSince: null, nudgeStreak: streak + 1 })
          } catch (e) {
            logSkipThrottled(sid, "nudge-fail", `[NUDGE-FAIL] ${sid} err=${String(e).slice(0, 200)}`)
          }
        } catch (e) {
          debugLogLine(`[SCAN-ERROR] ${path} err=${String(e).slice(0, 200)}`)
        }
      }
      } catch (e) {
        debugLogLine(`[SCAN-FATAL] ${reason} err=${String(e).slice(0, 200)}`)
      } finally {
        releaseScanLock(lockToken)
      }
    }

    const controller = new AbortController()
    let lastEventScanAt = 0
    const EVENT_SCAN_MIN_GAP_MS = 15000
    const timer = setInterval(() => { void scanOnce("interval") }, SCAN_INTERVAL_MS)
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          try {
            const ev = event as { type?: string }
            const t = typeof ev?.type === "string" ? ev.type : ""
            // V2 emits no session.idle, so I treat session.step.ended and
            // session.execution.succeeded/failed as turn ends. All of them
            // trigger a scan, throttled to one per 15 s against event storms
            // (I keep "idle" in the pattern in case upstream restores it).
            const isTurnEnd = /idle|step\.ended|execution\.(succeeded|failed)/i.test(t)
            if (isTurnEnd) {
              try {
                // V2 keeps the event payload in `data` (properties is V1), and
                // session events also carry the session id in
                // durable.aggregateID. My old code read only `properties`,
                // which made this branch dead.
                const evx = ev as {
                  data?: Record<string, unknown>
                  properties?: Record<string, unknown>
                  durable?: { aggregateID?: unknown }
                }
                const props = (evx.data ?? evx.properties ?? {}) as Record<string, unknown>
                const esid = props["sessionID"] ?? props["sessionId"] ?? evx.durable?.aggregateID
                if (isSessionID(esid)) {
                  lastTurnEnd.set(esid, Date.now())
                  noteTurnEndDisk(esid)
                }
              } catch {}
            }
            if (isTurnEnd && Date.now() - lastEventScanAt >= EVENT_SCAN_MIN_GAP_MS) {
              lastEventScanAt = Date.now()
              void scanOnce(`event:${t}`)
            }
          } catch {}
        }
      } catch (e) {
        debugLogLine(`[EVENT-FAIL] ${String(e).slice(0, 200)}`)
      }
    })()

    return () => { controller.abort(); clearInterval(timer) }
  },
})
