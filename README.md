# goal-for-opencode

Version: 1.1.0
Tested with: opencode v2.0.30 (V2 plugin API)
Repository: https://github.com/FangZhangTNS/goal-for-opencode

I wrote this plugin for my own long OpenCode runs. The agent creates its own
GOALs and closes them itself; I only watch, and I never write a status. When
a session with open GOALs stops making progress, I send one real prompt into
that session. The prompt lands in the transcript as a user message, enters
the model context, and is billed like any other prompt, so I cap it: at most
one nudge per session per 10 minutes by default. The agent can stretch that
per session with `nudgeEvery` (1 minute to 24 hours), or switch it off for a
wait that something outside me will end. I also give up after three nudges in
a row that produce no agent activity. I do not expire open GOALs; an abandoned
GOAL keeps being nudged until the agent closes it or I stop OpenCode.

Why I use it: my long runs are mostly unattended. Two failures kept
happening. First, the agent ends a turn with a report and stops,
because it is waiting for a human who is not there. Second, a tool returns
an error or a long call ends and the session goes quiet with the work
unfinished. In both cases nobody notices and the run sits there until I come
back. I wrote this to close half of that gap: while a GOAL is open, a quiet
session gets one prompt, and the agent either continues or closes the GOAL
with a stop rule. I do not close the other half: I never notify a human, so
a run that needs a decision still waits until someone looks. None of this
works unless the agent created a GOAL; I never open one myself.

If a tool call is still running I stay out on purpose: its return already
wakes the agent, and a nudge in the middle of a long shell only adds noise.
When a call hangs, I stay out until the running mark ages out; I step in
when the session is quiet and nothing is running.

## Requirements

I need an OpenCode build that exposes the V2 plugin API (`Plugin.define`,
`ctx.tool.transform`, `ctx.tool.hook`, `ctx.session.context`,
`ctx.session.prompt`, `ctx.event.subscribe`). I develop and test against
opencode v2.0.30; I have no version check of my own, so an older build shows
up as a failed load (step 4). My import of `@opencode/plugin` is resolved by
the host; I ship no package.json and you do not run npm install.

I resolve my config directory as `join(homedir(), ".config", "opencode")` on
every platform and I never read a custom config path. On Windows that folder
is `.config\opencode` inside the user profile. If your OpenCode reads a
different config root, I still write my state under the path above, and the
log in step 4 is how you see which root I used. I register `goal` through
`ctx.tool.transform`, so the agent calls it; I did not build a human UI, and
none of my code is a shell command.

## Install

1. Create `<config>/plugins/goal-for-opencode/` and copy `index.ts` and
   `nudge.ts` into it. I load as two TypeScript files and there is no build
   step; `nudge.ts` holds the duration parser, which I keep separate so it can
   be tested without a host.
2. Add this entry to `<config>/opencode.json`. If the key already exists,
   add my path to that list:

       "plugins": ["./plugins/goal-for-opencode"]

3. Restart every OpenCode process you use: the desktop app and any
   `opencode serve` or CLI service.
4. Check `<config>/goal-for-opencode-debug.log`:
   - `[INIT] goal-for-opencode v1.1.0 loaded` missing: I did not load.
     Check the path, the file, and the V2 plugin API requirement above.
   - First line present but `[INIT] tool=goal registered` missing: I loaded
     but the tool registration failed. Look for a following `[INIT-FAIL]`
     line; that error is the reason.
   - Both lines present and you want proof the tool works: ask the agent in
     any session to create a GOAL, then check that a new `<sessionID>.json`
     appears under `<config>/goal-for-opencode-sessions/`.

I typecheck with my own `tsconfig.v2check.json`. I did not ship it, because
installing me never touches it. `nudge.test.ts` does ship: `node --test
nudge.test.ts` runs without any dependency, and it is the check I use before
changing the throttle rules.

## Files

I write these files under `<config>`:

- `goal-for-opencode-sessions/<sessionID>.json` - one GOAL file per session:
  target, doneCriteria, plan, status, doneReason, evidence, and the current
  nudge throttle (`nudgeEveryMs`, `nudgeOffAt`).
- `goal-for-opencode-debug.log` - append-only; I do not rotate it.
- `goal-for-opencode-state/busy/` - one marker per running tool call.
- `goal-for-opencode-state/<sessionID>.turnend` - last turn-end time.
- `goal-for-opencode-state/.scan.stamp` - last scan time.
- `goal-for-opencode.scan.lock.d/` - my cross-process scan lock.
- `goal-for-opencode-sessions/*.tmp-*` - temp files from my atomic writes.

I write the state files for every session that uses tools, even sessions
that never create a GOAL, and I write `.scan.stamp` on every scan even when
there is nothing to check. I clean up my own stale markers and temp files,
and I delete GOAL files whose GOALs are all closed after 7 days. I do not
archive closed GOALs anywhere else.

My state is global, not per project: every project shares one GOAL pool, so
a GOAL left open in one project can be nudged while you work in another.

## Stop rules

I close nothing myself; the agent closes its own GOAL with one of four
reasons. Only `done` means the work is finished; the other three exist so I
stop nudging:

- `done` - achieved.
- `need_human_decision` - a major human decision is required.
- `need_human_action` - a human must execute it by hand.
- `blocked` - unsolvable blocker, evidence required.

I do not verify a `done`: the agent's own report is all I have, and a model
that wants the nudges to stop can close a GOAL it did not finish.

## Behavior

- I scan every 60 s per plugin instance, and at most once per 15 s across
  all instances.
- I nudge at most once per session per 10 minutes by default. The agent can
  stretch that for its session with `nudgeEvery` (1 minute to 24 hours) or
  switch nudges off for that session; both live in the session GOAL file.
- A throttle belongs to the open-GOAL period. When a session has no open GOAL
  left, my next scan drops the override back to the default, so a later GOAL in
  the same session cannot inherit an off switch.
- I skip the nudge while a tool call is in flight, while a tool part or
  background shell still reports `running` and the newest message is less
  than 6 hours old.
- I stop nudging a session after three nudges in a row that produce no agent
  activity at all: no reasoning, no tool call, no text. The count resets as
  soon as the agent produces anything.
- I treat a session as active for 10 minutes after any tool call, and I give
  a subagent report 5 minutes of grace before the next nudge.
- I report subagents quiet for 30 minutes as possibly stalled.
- I check at most 20 child sessions and list 10 GOALs per cycle.
- I expire per-tool busy evidence after 30 minutes, on disk and in my memory
  counters, so a crashed call cannot block me forever.
- I throttle repeated SKIP-* log lines to one per session per 5 minutes per
  instance.
- I serialize scans across processes with a lock directory
  (`goal-for-opencode.scan.lock.d`, stale after 120 s).
- Each liveness check reads the full transcript of the session through
  `ctx.session.context`: once or twice for the parent (the liveness check,
  then the child report scan) and once per registered child.
- I cannot see an unsent draft, so a nudge can arrive while a human is
  typing.
- All of these timings are constants in `index.ts`, with one exception: the
  per-session nudge interval, which the agent sets through the tool and which I
  store in the session GOAL file.

## Tool

I register `goal` as a host tool that the agent calls; I accept five actions:

- `create` + `target` (+ `doneCriteria`, + `plan`, + `nudgeEvery`) - open a
  GOAL. `plan` holds a short todo list of the concrete steps.
- `list` - show open GOALs and the current nudge throttle.
- `done` + `id` + `doneReason` (+ `evidence` when `blocked`) - close a GOAL.
- `set_children` + `pendingChildIDs` - replace outstanding child session
  IDs after dispatch or when I reap them.
- `set_nudge` + `nudgeEvery` - change how often I may nudge this session.

`nudgeEvery` takes a duration (`30m`, `1h`, `1h30m`, `90s`, or a bare number of
minutes), `off`, or `default`. The range is 1 minute to 24 hours. The value is
per session, not per GOAL: the last call wins, and it lasts while at least one
GOAL is open.

Why it exists: a multi-hour transfer or build used to leave two bad options,
one nudge every 10 minutes or closing the GOAL. Closing it throws away the
tracking, and that is the wrong trade for a task that is still running. With
`nudgeEvery: "2h"` the GOAL stays open and I only knock every two hours.

`off` is different from closing the GOAL: the GOAL stays open, `list` keeps
showing it as unfinished, and I keep maintaining its file. What changes is that
nothing in this plugin will wake that session any more. Set it only when
something outside me (a background process, a message, a polling loop) will
bring the session back, because otherwise the GOAL sits there silently.

Examples:

    goal({ action: "create", target: "Ship v1.2", doneCriteria: "tests green",
           plan: "1. fix parser 2. run tests", nudgeEvery: "2h" })
    -> GOAL g1 opened. 1 open in session ses_.... Nudges throttled to one per 2h.

    goal({ action: "list" })
    -> Nudges throttled to one per 2h.
       [g1] Ship v1.2 (done when: tests green)
         plan: 1. fix parser 2. run tests

    goal({ action: "set_nudge", nudgeEvery: "off" })
    -> Nudges off for session ses_.... Nothing in this plugin will wake it.

    goal({ action: "done", id: "g1", doneReason: "done" })
    -> GOAL g1 closed (done). 0 open remaining.

`target`, `doneCriteria`, `plan` and `evidence` accept any language; I keep
the tool definition itself English-only. I only accept session IDs made of
`ses_` plus letters and digits, and I reject anything else as an invalid
session.

## What the agent is told

I put my operating rule into the tool description itself: "While any GOAL
is open the session is not finished: never go idle with nothing pending."
The same description tells the model that it must close the GOAL itself
before ending a turn. That text is visible in every session where I am
loaded, not only in sessions that use GOALs.

The description is a reminder, not an enforcement: I never make the agent
create a GOAL. If a GOAL must exist for a task, say so in the prompt.

My nudge goes through `ctx.session.prompt`, so it lands in the transcript as
a user message. The wording matters, so I keep the essence here: it opens
with `GOAL watchdog:`, says "keep going instead of waiting for a human",
tells the agent to close the GOAL itself with the matching doneReason if a
stop condition holds, and states that I never close GOALs on my own.

That "keep going" line is deliberate: I exist for runs where the agent stops
and nobody is watching. It also means that if the agent forgot to close a
GOAL and has just handed a decision to a person, my nudge pushes it past
that checkpoint. The stop rules are how the agent prevents this; I cannot
tell the two situations apart.

## Uninstall

Uninstalling me means deleting `plugins/goal-for-opencode/` and my
`opencode.json` entry, then restarting OpenCode. I never delete my own state
on uninstall, so these files stay on disk until someone removes them:
`goal-for-opencode-sessions/`, `goal-for-opencode-state/`,
`goal-for-opencode-debug.log`, `goal-for-opencode.scan.lock.d/`.

To close GOALs without uninstalling, ask the agent in that session to close
them with the tool, or edit the session JSON by hand.

## Notes

- I store GOAL text and evidence as plain text, so anything I keep there is
  readable on disk; I would not put a secret in a GOAL.
- My nudges are real prompts: each one is a user message, so the context is
  re-sent and a full inference runs. At the 10-minute default an open GOAL costs
  a turn every 10 minutes for as long as OpenCode stays up; `nudgeEvery` is how
  I keep that cost bounded on a long wait.
- `off` is the only way to stop the nudges without closing the GOAL, and it is
  a real silence: nothing in this plugin fires for that session until the
  throttle is cleared, the session has no open GOAL left, or a human writes.

## Changes

- 1.1.0 - added the per-session nudge interval: `nudgeEvery` on `create` and a
  `set_nudge` action accept 1m..24h, `off`, or `default`. The interval is stored
  in the session GOAL file, shown by `list`, and dropped when the session has no
  open GOAL left. The duration parser lives in `nudge.ts` with `nudge.test.ts`.
- 1.0.5 - I stop after three unanswered nudges so a wedged session cannot be
  spammed; added LICENSE and a repository link.
- 1.0.4 - renamed everything from goal-watch to goal-for-opencode, including
  the state directories and the log; no behavior change.
- 1.0.3 - added the optional `plan` field and printed it in `list`.
- 1.0.2 - the tool description and the nudge now say explicitly that the
  agent must close its own GOAL and that I never close one.
- 1.0.1 - stopped the false nudges during long shell waits: a running tool
  part or shell job keeps a session active for up to 6 hours, and a second
  nudge waits until the agent has produced a message since the first.
- 1.0.0 - first version: `goal` tool, one GOAL file per session, watchdog
  scan, digest grace, four stop rules.
