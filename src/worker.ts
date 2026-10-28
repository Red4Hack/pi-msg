// Runs 1 task: joins the bus, reserves files (waits if blocked), runs the agent, verifies.
import { runAgent } from "./agent.ts";
import type { Bus, Run, Task } from "./bus.ts";
import { makeGuard } from "./presence.ts";
import type { ExecResult } from "./run.ts";
import * as team from "./team.ts";

export interface Env {
	cwd: string;
	bus: Bus;
	model?: string;
	reviewer?: string;
	verify?: boolean;
	concurrency?: number;
}
const MAX_REVIEWS = 3;
const sleep = (ms: number, s: AbortSignal) => new Promise<void>((r) => { const t = setTimeout(r, ms); s.addEventListener("abort", () => { clearTimeout(t); r(); }, { once: true }); });

export async function execTask(env: Env, run: Run, t: Task, signal: AbortSignal): Promise<ExecResult> {
	const { bus, cwd } = env;
	const me = bus.join({ task: t.id, model: t.model ?? env.model });
	const name = me.name;
	try {
		// Cross-process arbiter: the in-memory run copy is per process, the claim file is shared. Key is run-scoped.
		const c = bus.claim(name, `${run.id}:${t.id}`);
		if (!c.ok) {
			t.note = c.reason;
			return { ok: false, skipped: true, text: c.reason ?? "claimed elsewhere" };
		}
		while (t.files.length) {
			const r = bus.reserve(name, t.files, t.id);
			if (r.ok) break;
			if (signal.aborted) return { ok: false, text: "aborted" };
			t.status = "waiting";
			t.note = `reserved by ${r.conflicts[0].owner}`;
			await sleep(1000, signal);
		}
		t.status = "running";
		t.note = undefined;
		bus.feed({ who: name, kind: "task", text: `started ${t.id} ${t.title}` });
		const deps = t.deps.map((d) => run.tasks.find((x) => x.id === d)).map((d) => `- ${d?.id} ${d?.title}: ${(d?.result ?? "").slice(0, 600)}`).join("\n");
		const ro = Boolean(t.readOnly) || team.isReadOnlyRole(t.role);
		const mk = (extra = "") => `You are ${name}, a pi-msg worker, task ${t.id}: ${t.title}\n\n${t.prompt}\n\n${t.files.length ? `Files reserved for you: ${t.files.join(", ")}. Only edit within them; if an edit is blocked by another agent's reservation, work on something else or stop and report.\n` : ""}${ro ? "Read-only: do not modify any files.\n" : ""}${deps ? `\nDependency results:\n${deps}\n` : ""}${team.context(cwd, t.role)}${extra}\nWhen finished, reply with a short summary of what was done. You can message peers with the msg_send tool (to a name or "all"); replies arrive as [msg from X] steering messages.`;
		const go = (extra?: string) => runAgent({ cwd, prompt: mk(extra), model: t.model ?? env.model, readOnly: ro, signal, guard: makeGuard(bus, name), bus, name });
		let text = await go();
		for (let i = 0; env.verify && !ro && i < MAX_REVIEWS; i++) {
			const rev = await runAgent({
				cwd, readOnly: true, signal, model: env.reviewer ?? env.model,
				prompt: `Review (read-only) whether the task was completed.\nTASK: ${t.title}\n${t.prompt}\nWORKER SUMMARY: ${text}\nReply with one line: SHIP, NEEDS_WORK or MAJOR_RETHINK, and then the feedback.`,
			});
			const v = rev.match(/\b(SHIP|NEEDS_WORK|MAJOR_RETHINK)\b/)?.[1] ?? "SHIP";
			if (v === "SHIP") break;
			if (v === "MAJOR_RETHINK") return { ok: false, blocked: true, text: rev };
			if (i === MAX_REVIEWS - 1) return { ok: false, text: `review did not approve after ${MAX_REVIEWS} iterations: ${rev}` };
			text = await go(`\nThe reviewer requested changes:\n${rev}\n`);
		}
		bus.complete(name, `${run.id}:${t.id}`); // lets other processes with a stale run copy skip it
		bus.feed({ who: name, kind: "task", text: `completed ${t.id}` });
		return { ok: true, text };
	} finally {
		bus.leave(name);
	}
}
