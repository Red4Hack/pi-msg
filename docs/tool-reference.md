# `msg` tool reference

One tool, `action` selects the operation.

## Delegation
| Action | Params | Notes |
|---|---|---|
| `task` | `task`, `model?` | One worker, no planner/review |
| `tasks` | `tasks[{id,prompt,title?,deps?,files?,readOnly?,model?,role?,riskLabels?}]`, `model?`, `verify?`, `concurrency?` | DAG; each task starts when its deps are done. Max 8 tasks |
| `plan` | `goal`, `planner?`, `reviewer?`, `autoApprove?` | Planner → reviewer refinement → approval → run |
| `resume` | | Continue latest run |
| `status` | | Report of current/latest run |
| `models` | | Available `provider/id` list |

Rules: a task that writes must declare `files` (reserved while it runs) or be `readOnly:true`. `verify:true` adds a reviewer (SHIP / NEEDS_WORK / MAJOR_RETHINK, max 3 iterations). `concurrency` defaults to 3, max 10.

## Coordination
`join`, `list`, `whois{name}`, `feed{limit?}`, `send{to,message}`, `broadcast{message}`, `reserve{paths,reason?}`, `release{paths?}`.

## Swarm (agents pull work)
`swarm{tasks?}` create/list, `claim{taskId}`, `unclaim{taskId}`, `complete{taskId,message?}`. Claims are atomic (`wx` file create); one open claim per agent; stuck/dead owners can be taken over; deps must be complete.

## Team
`team{profile}`, `team.save`, `team.charter{message?}`, `team.note{type,message}` (decision | interface | risk | handoff), `team.memory{type?,limit?}`, `team.roles`, `team.status`, `approve{taskId}`, `reject{taskId,reason?}`.

## Worker tool
Workers get `msg_send{to,message}` (`to` = agent name or `all`). Replies arrive as `[msg from X]` steering messages. A worker's `all` does not wake the human; the human's `all` reaches everyone.
