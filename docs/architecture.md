# Architecture

In-process: workers are `AgentSession`s from `createAgentSession()`; no CLI, tmux or daemon. Each worker reuses the host session's model runtime (providers + auth) and loads only an inline guard extension (`noExtensions`, avoids recursion).

## Modules (`src/`)
| File | Role |
|---|---|
| `index.ts` | `msg` tool, `/msg` command, hooks, lobby, widget/status |
| `bus.ts` | File bus: registry, inbox, reservations, claims, completions, feed, runs |
| `presence.ts` | Guard (blocks edit/write on others' reservations, tracks activity), stuck sweep |
| `plan.ts` | Validation (ids, deps, cycles, files), waves, planner prompt, `splitTask` |
| `run.ts` | DAG scheduler (no barrier between waves), report, resume |
| `worker.ts` | One task: claim, reserve (waits if blocked), run agent, verify loop |
| `agent.ts` | Session wrapper |
| `team.ts`, `skills.ts`, `ui.ts` | Team layer, skill index, overlay panel |

## State: `.pi/msg/`
`registry/<name>.json`, `inbox/<name>/*.json`, `reservations.json`, `feed.jsonl`, `runs/<id>.json`, `claims/`, `completions/`, `team/`, `skills/`, `config.json`. Writes are atomic (tmp+rename); shared files use short `wx` locks. Dead agents are swept by pid. Add `.pi/msg/` to `.gitignore`.

## Constants
Concurrency 3 (max 10) · max 8 tasks · stuck after 5 min idle with a task/reservation · plan refinement 2 passes · review 3 iterations · inbox poll 1 s.

## Cross-process safety
Task claim key is `<runId>:<taskId>`; `execTask` claims it, so two pi processes with the same run run each task once. `reopen` (reset/revise) clears the claim and completion.

## Known limits
- Reservations are enforced for `edit`/`write`; bash is a heuristic (redirects, `sed -i`, `tee`, `mv`, `rm`, `cp` naming a reserved path). Scripts that write internally pass. pi-messenger does not check bash at all.
- No worktree isolation: parallel writers rely on declared `files`.
- Panel is a single view with DM tabs; no per-task live log beyond the feed.
