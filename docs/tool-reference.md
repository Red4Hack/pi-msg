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

Guessed action names are mapped to the real one: a `list`/`get`/`show` prefix is dropped and `_`/`-` become `.` (`list_models` -> `models`, `team_status` -> `team.status`).

Rules: a task that writes must declare `files` (reserved while it runs) or be `readOnly:true`. `verify:true` adds a reviewer (SHIP / NEEDS_WORK / MAJOR_RETHINK, max 3 iterations). `concurrency` defaults to 3, max 10.

## Coordination
`join`, `list`, `whois{name}`, `feed{limit?}`, `send{to,message}`, `broadcast{message}`, `reserve{paths,reason?}`, `release{paths?}`.

## Swarm (agents pull work)
`swarm{tasks?}` create/list, `claim{taskId}`, `unclaim{taskId}`, `complete{taskId,message?}`. Claims are atomic (`wx` file create); one open claim per agent; stuck/dead owners can be taken over; deps must be complete.

## Team
`team{profile}`, `team.save`, `team.charter{message?}`, `team.note{type,message}` (decision | interface | risk | handoff), `team.memory{type?,limit?}`, `team.roles`, `team.status`, `approve{taskId}`, `reject{taskId,reason?}`.

## Worker tool
Workers get `msg_send{to,message}` (`to` = agent name or `all`). Replies arrive as `[msg from X]` steering messages. A worker's `all` does not wake the human; the human's `all` reaches everyone.

## decide / advise

Config in `~/.pi/agent/msg.json`:

```json
{ "decision": { "baseUrl": "http://192.168.0.19:9931", "model": "ggml-org/Julia-1-GGUF:BF16", "threshold": 0.8, "api": "systemone" },
  "advisor":  { "model": "provider/id" } }
```

- Jev (`https://api.typesafe.ai`, model `jev-latest`, `apiKey` in config; auth header not verified), Laya (`model: "english"`) and llama.cpp all speak System One: use `api: "systemone"`. `p` is the chosen option's probability (not Laya's entropy-based `confidence`); `usage.truncated` forces `lead`.
- `decision.api`: `systemone` (default, llama-server decision model) or `openai-logprobs` (any OpenAI-compatible chat model, p from first-token logprobs).
- `decide {question, options}` → `{choice, p, route}`. Backend: llama-server decision model via `/v1/systemone` (`message` = optional state/context; `baseUrl` defaults to `$LLAMA_SERVER_URL`, model to Julia-1). `p >= threshold` = sharp → `code`; otherwise split → `lead`. No `decision` config = layer off. Logged in the feed (`kind=decision`).
- `advise {message?}`: read-only agent reads the session transcript and returns advice (advisor model, default = session model). Also fires automatically when the same tool error occurs twice in a row (steer message, no new turn).
- Status line shows `advisor [advising]` and `decision [N forks]`.
- `/msg settings` opens a TUI to edit `decision`, `advisor` and `announce` (saved to `~/.pi/agent/msg.json`, 0600; secret key masked).
