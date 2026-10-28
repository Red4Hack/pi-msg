# pi-msg

Multi-agent messenger + crew orchestration for [pi](https://github.com/earendil-works/pi). In-process, zero config, no external CLI.

Install: `pi install /path/to/pi-msg` (or `pi -e ./src/index.ts`).

## Use
- `/msg` opens the panel (agents, tasks, feed, chat). `Enter` detail, `m` chat (`@Name msg`, `@all msg`), `q` stop task, `A` abort all.
- `/msg <task>` runs one worker. `/msg -m provider/id <task>` picks a model. `/msg plan <goal>` plans, asks approval, runs. `/msg resume` continues the last run.
- The LLM uses the `msg` tool: `task`, `tasks` (DAG with `deps`, `files`), `plan`, `swarm`/`claim`/`complete`, `reserve`/`release`, `send`, `feed`, `list`, `models`, `team*`.

## Notes
- State lives in `.pi/msg/` (JSON files). Models default to the current session; the LLM can override per call.
- Tasks that write must declare `files` (reserved while running); there is no worktree isolation.
- Docs: `docs/usage.md`, `docs/tool-reference.md`, `docs/architecture.md`.

## Config (optional)
`{"announce": true}` in `.pi/msg/config.json` or `~/.pi/agent/msg.json` posts the full result in chat when a `/msg` run finishes. Default: one-line notification only.

## Panel keys
`←→` DM tab, `Enter` detail, `m` chat, `p` revise task, `r` reset, `x` delete, `b` block, `q` stop, `u` unblock, `s` start, `y/n` approve, `f` feed focus, `A` abort all.
Unread messages show as `✉ N unread` in the status bar until `/msg` is opened. `/msg plan` runs up to 2 reviewer refinement passes before approval.

`S` split a task (parts separated by `;`), `l`/`L` add/remove a lobby worker (standing worker that pulls ready tasks from the current run).

## How it works

```mermaid
flowchart TD
  U([You / main LLM]) -->|"/msg, msg tool"| IDX[index.ts<br/>tool + command + hooks]
  IDX -->|task / tasks| RUN[run.ts<br/>DAG scheduler]
  IDX -->|plan goal| PLN[plan.ts<br/>planner → reviewer ×2 → approval]
  PLN --> RUN
  RUN -->|"deps done, max 3-10 parallel"| WK[worker.ts<br/>execTask]
  WK -->|claim run:task| BUS[(".pi/msg bus<br/>registry · inbox · reservations<br/>claims · feed · runs")]
  WK -->|reserve files| BUS
  WK --> AG[agent.ts<br/>createAgentSession]
  AG -->|tool_call guard| GD[presence.ts<br/>block edits on others' reservations]
  GD --> BUS
  AG <-->|msg_send / steer| BUS
  WK -->|verify:true| RV[reviewer<br/>SHIP / NEEDS_WORK / MAJOR_RETHINK]
  RV --> WK
  BUS --> UI[ui.ts panel + widget]
  UI -->|abort, reset, chat, approve| BUS
  LB[lobby workers] -->|pull ready tasks| WK
  TM[team.ts<br/>roles · charter · approval gate] -.-> PLN
  TM -.-> WK
```

```mermaid
sequenceDiagram
  participant L as Main LLM
  participant S as Scheduler
  participant A as Worker A
  participant B as Worker B
  participant X as Bus (.pi/msg)
  L->>S: msg tasks [t1, t2, t3→t1,t2]
  par wave 1
    S->>A: t1
    S->>B: t2
  end
  A->>X: claim + reserve files
  B->>X: claim + reserve files
  A-->>B: msg_send (steering)
  A->>S: done
  B->>S: done
  S->>A: t3 (deps done)
  A->>X: complete, release reservations
  S->>L: report
```
