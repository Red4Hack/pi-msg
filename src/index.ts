// pi-msg: messenger + crew + swarm + team, in-process and zero config.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { availableModels, runAgent, setRegistry } from "./agent.ts";
import { type Bus, type Run, createBus } from "./bus.ts";
import { MAX_TASKS, parsePlan, plannerPrompt, toTasks, validate } from "./plan.ts";
import { label, makeGuard, sweepStuck } from "./presence.ts";
import { type ActiveRun, report, resumable, runDag } from "./run.ts";
import { skillIndex } from "./skills.ts";
import * as team from "./team.ts";
import { openPanel } from "./ui.ts";
import { type Env, execTask } from "./worker.ts";

const ACTIONS = ["join", "list", "whois", "feed", "send", "broadcast", "reserve", "release", "status", "task", "tasks", "plan", "resume", "swarm", "claim", "unclaim", "complete", "models", "team", "team.save", "team.charter", "team.note", "team.memory", "team.roles", "team.status", "approve", "reject"] as const;

const TaskItem = Type.Object({
	id: Type.String(),
	prompt: Type.String(),
	title: Type.Optional(Type.String()),
	deps: Type.Optional(Type.Array(Type.String())),
	files: Type.Optional(Type.Array(Type.String(), { description: "Files/directories the task edits (required if it writes)" })),
	readOnly: Type.Optional(Type.Boolean()),
	model: Type.Optional(Type.String()),
	role: Type.Optional(Type.String()),
	riskLabels: Type.Optional(Type.Array(Type.String())),
});

const Params = Type.Object({
	action: StringEnum(ACTIONS),
	task: Type.Optional(Type.String({ description: "action=task: direct prompt for 1 worker (research, grep, docs...)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "action=tasks|swarm: task graph (deps form parallel waves)" })),
	goal: Type.Optional(Type.String({ description: "action=plan: large/vague goal; a planner generates the graph" })),
	model: Type.Optional(Type.String({ description: "provider/id[:level]. Omitted = session model. Use action=models to list" })),
	planner: Type.Optional(Type.String()),
	reviewer: Type.Optional(Type.String()),
	concurrency: Type.Optional(Type.Number({ description: "Parallel workers (default 3, max 10)" })),
	verify: Type.Optional(Type.Boolean({ description: "Enables the reviewer (SHIP/NEEDS_WORK/MAJOR_RETHINK)" })),
	autoApprove: Type.Optional(Type.Boolean({ description: "plan: skips plan approval" })),
	to: Type.Optional(Type.String()),
	message: Type.Optional(Type.String()),
	paths: Type.Optional(Type.Array(Type.String())),
	reason: Type.Optional(Type.String()),
	name: Type.Optional(Type.String()),
	taskId: Type.Optional(Type.String()),
	limit: Type.Optional(Type.Number()),
	profile: Type.Optional(Type.String({ description: "migration-squad | review-squad | research-squad" })),
	type: Type.Optional(Type.String({ description: "decision | interface | risk | handoff" })),
});

const MAX_PLAN_PASSES = 2;

export default function (pi: ExtensionAPI) {
	let bus: Bus | undefined;
	let me = "";
	let cwd = process.cwd();
	let model: string | undefined;
	let ui: any;
	let timer: ReturnType<typeof setInterval> | undefined;
	let tick = 0;
	let unread = 0;
	let guard: ReturnType<typeof makeGuard> | undefined;
	const active = new Map<string, ActiveRun>();
	const plural = (n: number) => (n === 1 ? "agent" : "agents");
	const B = () => bus ?? (bus = createBus(cwd));

	// Result in chat is off by default (the TUI shows it); enable with {"announce": true} in .pi/msg/config.json or ~/.pi/agent/msg.json
	const announceOn = () =>
		[path.join(cwd, ".pi", "msg", "config.json"), path.join(os.homedir(), ".pi", "agent", "msg.json")].some((f) => {
			try {
				return JSON.parse(fs.readFileSync(f, "utf8")).announce === true;
			} catch {
				return false;
			}
		});
	const announce = (text: string, ctx: any) =>
		announceOn() ? pi.sendMessage({ customType: "msg", content: text, display: true }) : ctx.ui.notify(`msg: ${text.split("\n")[0]}`, "info");

	const refresh = () => {
		if (!bus || !ui) return;
		const ws = bus.agents().filter((x) => !x.human && x.task);
		// Claude Code-style subagent list above the editor; hidden when idle
		ui.setStatus("msg", unread ? `✉ ${unread} unread (/msg)` : undefined);
		ui.setWidget("msg", ws.length ? [`⏺ ${ws.length} ${plural(ws.length)} running`, ...ws.slice(0, 5).map((a, i, l) => `  ${i === l.length - 1 ? "└─" : "├─"} ${a.task} · ${a.name} · ${a.note || "working"} · ${a.tools} tools · ${a.tokens > 1000 ? `${Math.round(a.tokens / 1000)}k` : a.tokens} tok`)] : undefined);
	};

	pi.on("session_start", (_e: unknown, ctx: any) => {
		cwd = ctx.cwd;
		setRegistry(ctx.modelRegistry);
		ui = ctx.hasUI ? ctx.ui : undefined;
		model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
		const b = B();
		me = b.join({ human: true, model, branch: undefined }).name;
		guard = makeGuard(b, me);
		timer = setInterval(() => {
			for (const m of b.drain(me)) {
				unread++;
				b.update(me, { lastActivity: Date.now() });
				pi.sendMessage({ customType: "msg", content: `[msg from ${m.from}] ${m.text}`, display: true }, { triggerTurn: true, deliverAs: "steer" });
			}
			if (++tick % 30 === 0) for (const n of sweepStuck(b)) if (n !== me) ui?.notify(`${n} seems stuck`, "warning");
			refresh();
		}, 1000);
		refresh();
	});
	pi.on("model_select", (e: any) => void (model = `${e.model.provider}/${e.model.id}`));
	pi.on("tool_call", (e: any) => guard?.call(e));
	pi.on("tool_result", (e: any) => guard?.result(e));
	pi.on("session_shutdown", () => {
		if (timer) clearInterval(timer);
		for (const a of active.values()) a.ac.abort();
		for (const l of lobby) l.abort();
		if (bus && me) bus.leave(me);
	});

	const env = (p: { model?: string; reviewer?: string; verify?: boolean; concurrency?: number }): Env => ({ concurrency: p.concurrency, cwd, bus: B(), model: p.model ?? model, reviewer: p.reviewer, verify: p.verify });

	async function execute(run: Run, e: Env, signal?: AbortSignal): Promise<string> {
		const ac = new AbortController();
		signal?.addEventListener("abort", () => ac.abort(), { once: true });
		const ar: ActiveRun = { run, ac, taskAcs: new Map() };
		active.set(run.id, ar);
		try {
			await runDag(run, (t, s) => execTask(e, run, t, s), { signal: ac.signal, taskAcs: ar.taskAcs, concurrency: e.concurrency, onChange: () => { B().saveRun(run); refresh(); } });
		} finally {
			active.delete(run.id);
			B().saveRun(run);
			refresh();
		}
		return report(run);
	}

	// Lobby: standing workers that pull ready tasks (claim) from the current run. shortcut: polls every 2s.
	const lobby: AbortController[] = [];
	const lobbyLoop = async (ac: AbortController) => {
		const b = B();
		const owner = b.join({ note: "lobby" }).name;
		b.update(owner, { status: "idle" });
		try {
			while (!ac.signal.aborted) {
				const run = [...active.values()].pop()?.run ?? b.latestRun();
				const t = run?.tasks.find((x) => x.status === "pending" && x.approval !== "pending" && x.approval !== "rejected" && x.deps.every((d) => run.tasks.find((y) => y.id === d)?.status === "done"));
				if (run && t) {
					t.status = "running";
					try {
						const r = await execTask(env({}), run, t, ac.signal);
						t.result = r.text;
						if (r.skipped) t.status = "pending";
						else if (r.blocked) t.status = "blocked";
						else t.status = r.ok ? "done" : "failed";
					} catch (e: any) {
						t.error = String(e?.message ?? e);
						t.status = ac.signal.aborted ? "aborted" : "failed";
					}
					b.saveRun(run);
					if (t.status === "pending") await new Promise((res) => setTimeout(res, 2000));
				} else await new Promise((res) => setTimeout(res, 2000));
			}
		} finally {
			b.leave(owner);
		}
	};
	const setLobby = (delta: number) => {
		if (delta > 0) {
			const ac = new AbortController();
			lobby.push(ac);
			void lobbyLoop(ac);
		} else lobby.pop()?.abort();
		return lobby.length;
	};

	const newRun = (tasks: Run["tasks"], goal?: string): Run => {
		const run: Run = { id: new Date().toISOString().replace(/\D/g, "").slice(0, 14), goal, created: Date.now(), tasks: team.applyRisk(cwd, tasks) };
		B().saveRun(run);
		return run;
	};

	async function planFlow(goal: string, p: any, ctx: any, signal?: AbortSignal): Promise<string> {
		const prof = team.active(cwd);
		const ask = (extra = "") => runAgent({ cwd, readOnly: true, signal, model: p.planner ?? p.model ?? model, prompt: plannerPrompt(goal, { skills: skillIndex(cwd), roles: prof ? prof.roles.join("|") : undefined, max: MAX_TASKS }) + extra });
		let list = parsePlan(await ask());
		let err = validate(list);
		if (err) {
			list = parsePlan(await ask(`\n\nYour previous response was invalid: ${err}. Fix it and reply with the JSON only.`));
			err = validate(list);
			if (err) return `Planner failed: ${err}`;
		}
		// Refinement: reviewer checks the plan; planner revises on NEEDS_WORK (max 2 passes, constant).
		for (let pass = 0; pass < MAX_PLAN_PASSES; pass++) {
			const rev = await runAgent({ cwd, readOnly: true, signal, model: p.reviewer ?? p.planner ?? p.model ?? model, prompt: `Review this plan (read-only) for goal: ${goal}\n\n${JSON.stringify(list)}\n\nCheck: missing steps, wrong deps, tasks touching the same files without a dep, too little parallelism. Reply with one line SHIP or NEEDS_WORK, then feedback.` });
			if (!/\bNEEDS_WORK\b/.test(rev)) break;
			const next = parsePlan(await ask(`\n\nA reviewer asked for changes:\n${rev}\nRevise the plan. Reply with the JSON only.`));
			if (validate(next)) break; // keep the last valid plan
			list = next;
		}
		const run = newRun(toTasks(list ?? [], p.model ?? model), goal);
		if (!p.autoApprove && ctx?.hasUI) {
			const ok = await ctx.ui.confirm("Approve plan?", run.tasks.map((t) => `${t.id} ${t.title}${t.deps.length ? ` (→${t.deps.join(",")})` : ""}`).join("\n"));
			if (!ok) return `Plan ${run.id} saved, not executed (use resume).`;
		}
		return execute(run, env(p), signal);
	}

	async function act(p: any, signal?: AbortSignal, ctx?: any): Promise<string> {
		const b = B();
		switch (p.action) {
			case "join": return `You are ${me}.`;
			case "list": return b.agents().map((a) => `${label(a)} [${a.status}] task=${a.task ?? "—"} model=${a.model ?? "?"} ${a.note ?? ""} ${a.tools} tools, ${a.tokens} tok`).join("\n");
			case "whois": return JSON.stringify(b.agents().find((a) => a.name === p.name) ?? "not found", null, 1);
			case "feed": return b.recent(p.limit ?? 20).map((e) => `${new Date(e.ts).toTimeString().slice(0, 8)} ${e.who} ${e.kind} ${e.text}`).join("\n") || "(empty)";
			case "send": case "broadcast": return `Sent to ${b.send(me, p.action === "broadcast" ? "all" : p.to ?? "", p.message ?? "")} agent(s).`;
			case "reserve": { const r = b.reserve(me, p.paths ?? [], p.reason); return r.ok ? "Reserved." : `Blocked by: ${r.conflicts.map((c) => `${c.owner} (${c.path})`).join(", ")}`; }
			case "release": b.release(me, p.paths); return "Released.";
			case "models": return (await availableModels()).join("\n");
			case "status": { const r = [...active.values()].pop()?.run ?? b.latestRun(); return r ? report(r) : "No run."; }
			case "task": {
				if (!p.task) throw new Error("task: missing `task`");
				return execute(newRun(toTasks([{ id: "t1", title: p.task.slice(0, 60), prompt: p.task, readOnly: false, files: [], model: p.model }])), env(p), signal);
			}
			case "tasks": {
				const err = validate(p.tasks);
				if (err) throw new Error(err);
				return execute(newRun(toTasks(p.tasks, p.model ?? model)), env(p), signal);
			}
			case "plan": if (!p.goal) throw new Error("plan: missing `goal`"); return planFlow(p.goal, p, ctx, signal);
			case "resume": {
				const r = b.latestRun();
				if (!r) return "No run to resume.";
				return execute(resumable(r), env(p), signal);
			}
			case "approve": case "reject": {
				const r = [...active.values()].pop()?.run ?? b.latestRun();
				const t = r?.tasks.find((x) => x.id === p.taskId);
				if (!r || !t) throw new Error(`task ${p.taskId} not found`);
				t.approval = p.action === "approve" ? "approved" : "rejected";
				if (p.reason) t.note = p.reason;
				b.saveRun(r);
				return `${t.id}: ${t.approval}. Run action=resume to continue.`;
			}
			// swarm: agents pull tasks (claim/complete)
			case "swarm": {
				if (p.tasks) {
					const err = validate(p.tasks);
					if (err) throw new Error(err);
					const r = newRun(toTasks(p.tasks));
					return `Swarm ${r.id} created with ${r.tasks.length} tasks.`;
				}
				const r = b.latestRun();
				if (!r) return "No tasks.";
				const cl = b.claims(), dn = b.completed();
				return r.tasks.map((t) => {
					const owner = cl.find((c) => c.taskId === t.id)?.owner;
					const mark = dn.has(t.id) ? "✓" : owner ? `▶ ${owner}` : "⏸";
					return `${mark} ${t.id} ${t.title}${t.deps.length ? ` (→${t.deps.join(",")})` : ""}`;
				}).join("\n");
			}
			case "claim": {
				const t = b.latestRun()?.tasks.find((x) => x.id === p.taskId);
				if (!t) throw new Error(`task ${p.taskId} does not exist`);
				const dn = b.completed();
				if (!t.deps.every((d) => dn.has(d))) return `Pending deps: ${t.deps.filter((d) => !dn.has(d)).join(", ")}`;
				const c = b.claim(me, t.id);
				if (!c.ok) return c.reason ?? "claim failed";
				if (t.files.length) {
					const r = b.reserve(me, t.files, t.id);
					if (!r.ok) { b.unclaim(me, t.id); return `Files reserved by ${r.conflicts[0].owner}`; }
				}
				b.update(me, { task: t.id });
				return `Claim ${t.id}:\n${t.prompt}`;
			}
			case "unclaim": b.unclaim(me, p.taskId); b.release(me); b.update(me, { task: undefined }); return "ok";
			case "complete": b.complete(me, p.taskId, p.message); b.update(me, { task: undefined }); return "ok";
			case "team": return team.activate(cwd, p.profile ?? "review-squad");
			case "team.save": return team.save(cwd);
			case "team.charter": if (p.message) { team.updateCharter(cwd, p.message); } return team.charter(cwd);
			case "team.note": team.note(cwd, p.type ?? "", p.message ?? "", me); return "ok";
			case "team.memory": return team.memory(cwd, p.type, p.limit).map((m) => `[${m.type}] ${m.who}: ${m.message}`).join("\n") || "(empty)";
			case "team.roles": return Object.entries(team.ROLES).map(([k, v]) => `${k}: ${v}`).join("\n");
			case "team.status": return team.status(cwd);
		default:
			throw new Error(`unknown action: ${p.action}`);
		}
	}

	pi.registerTool({
		name: "msg",
		label: "msg",
		description:
			"Multi-agent, in-process. Delegate: {action:'task',task} = 1 worker (research/grep/docs); {action:'tasks',tasks:[{id,prompt,deps,files}]} = parallel graph (waves); {action:'plan',goal} = planner generates the graph. Coordination: list, feed, send, broadcast, reserve, release. Swarm: swarm, claim, unclaim, complete. Team: team, team.*, approve, reject. Models: action=models lists them; `model` optional (provider/id[:level]), omitted = current session. Tasks that write require `files`.",
		parameters: Params,
		async execute(_id: string, params: any, signal: AbortSignal, _upd: unknown, ctx: any) {
			const text = await act(params, signal, ctx);
			return { content: [{ type: "text", text }], details: undefined };
		},
	} as any);

	pi.registerCommand("msg", {
		description: "/msg → panel · /msg <task> · /msg plan <goal> · /msg resume · /msg -m provider/id <task>",
		handler: async (args: string, ctx: any) => {
			const a = args.trim();
			if (!a) return void (await (unread = 0, refresh(), openPanel(ctx, { bus: B(), me, cwd, active, save: (r) => B().saveRun(r), resume: () => void act({ action: "resume" }, undefined, ctx).then((t) => announce(t, ctx), (e) => ctx.ui.notify(`msg: ${e.message}`, "error")), profiles: team.profileNames(), lobby: setLobby })));
			const mm = a.match(/^-m\s+(\S+)\s+([\s\S]+)$/);
			const [m, rest] = mm ? [mm[1], mm[2]] : [undefined, a];
			let p: any = { action: "task", task: rest, model: m };
			if (rest === "resume") p = { action: "resume", model: m };
			else if (rest.startsWith("plan ")) p = { action: "plan", goal: rest.slice(5), model: m };
			ctx.ui.notify("msg: running in background (/msg opens the panel)", "info");
			act(p, undefined, ctx).then(
				(text) => announce(text, ctx),
				(e) => ctx.ui.notify(`msg: ${e.message}`, "error"),
			);
		},
	});
}
