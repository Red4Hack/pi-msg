# Usage

## Install
`pi install /path/to/pi-msg`, or try it with `pi -e ./src/index.ts`. No config needed.

## Commands
| Command | What it does |
|---|---|
| `/msg` | Open the panel |
| `/msg <task>` | Run one worker directly (research, grep, docs...) |
| `/msg -m provider/id[:level] <task>` | Same, with a specific model |
| `/msg plan <goal>` | Planner builds a task graph, reviewer refines it (up to 2 passes), you approve, then it runs |
| `/msg resume` | Continue the latest run (done tasks are skipped) |

Models default to the current session's model. The LLM can override per call; `msg({action:"models"})` lists valid ones.

## Panel keys
| Key | Action |
|---|---|
| `↑↓` / `Home` / `End` | Select task |
| `←→` | Switch DM tab (list view) / previous-next task (detail view) |
| `Enter` / `Esc` | Open detail / back, then close |
| `m`, `@`, `Tab` | Chat. `@Name msg` = DM, `@all msg` = broadcast, `Tab` completes names |
| `q` or `a` | Stop selected running task |
| `b` | Block running task with a reason |
| `r` | Reset task (confirm `y`) |
| `p` | Revise: append instructions and reset to pending |
| `S` | Split task, parts separated by `;` |
| `x` | Delete task (confirm `y`) |
| `u` | Unblock |
| `s` | Start/resume the run |
| `y` / `n` | Approve / reject a task awaiting approval |
| `l` / `L` | Add / remove a lobby worker |
| `f` | Toggle feed focus |
| `A` | Abort entire run (confirm `y`) |

## Status UI
- While workers run, a widget above the editor lists them (task, name, note, tools, tokens).
- `✉ N unread (/msg)` appears in the status bar until you open the panel.

## Optional config
`{"announce": true}` in `.pi/msg/config.json` (project) or `~/.pi/agent/msg.json` (global) posts the full result in chat when a `/msg` run finishes. Default: a one-line notification.

## Team layer (optional)
Ask in plain language ("use the review squad", "migration, pause before database changes"). The LLM calls `msg({action:"team", profile})`. Built-in profiles: `migration-squad` (approval gates on `database`, `migration`, `destructive`, `api-contract`), `review-squad`, `research-squad`. Tasks with matching `riskLabels` wait for approval (`y`/`n` in the panel, or `approve`/`reject` actions). `team.save` writes an editable copy to `~/.pi/agent/msg/team-profiles/`.

## Skills
The planner sees an index of `~/.pi/agent/skills/*/SKILL.md` and `.pi/msg/skills/*.md`; workers read them only if needed.
