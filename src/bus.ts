// File-based bus (.pi/msg): registry, inbox, reservations, claims, feed, runs.
// shortcut: files + polling, no socket; switch to a local socket if latency/volume becomes a problem.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export type Status = "active" | "idle" | "away" | "stuck";
export interface Agent {
	name: string;
	pid: number;
	startedAt: number;
	cwd: string;
	model?: string;
	branch?: string;
	task?: string;
	status: Status;
	note?: string;
	tools: number;
	tokens: number;
	lastActivity: number;
	human?: boolean;
}
export type TaskStatus = "pending" | "running" | "waiting" | "done" | "failed" | "blocked" | "aborted";
export interface Task {
	id: string;
	title: string;
	prompt: string;
	deps: string[];
	files: string[];
	model?: string;
	role?: string;
	readOnly?: boolean;
	riskLabels?: string[];
	approval?: "none" | "pending" | "approved" | "rejected";
	status: TaskStatus;
	result?: string;
	error?: string;
	note?: string;
}
export interface Run {
	id: string;
	goal?: string;
	created: number;
	tasks: Task[];
}
export interface Reservation {
	owner: string;
	reason?: string;
	since: number;
}
export type Bus = ReturnType<typeof createBus>;

const ADJ = ["Swift", "Lunar", "Oak", "Iron", "Bold", "Quiet", "Amber", "Crimson", "Misty", "Rapid", "Silver", "Wild", "Gentle", "Brave", "Cosmic", "Dusty", "Frosty", "Golden", "Hidden", "Jolly"];
const NOUN = ["Raven", "Dust", "Tree", "Fox", "Hawk", "Falcon", "Otter", "Comet", "River", "Stone", "Wolf", "Lynx", "Heron", "Maple", "Ember", "Pine", "Tiger", "Moth", "Reef", "Finch"];
const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const enc = encodeURIComponent;

export function createBus(cwd: string) {
	const root = path.join(cwd, ".pi", "msg");
	const p = (...a: string[]) => path.join(root, ...a);
	const mk = (d: string) => fs.mkdirSync(d, { recursive: true });
	const readJson = <T>(f: string, def: T): T => {
		try {
			return JSON.parse(fs.readFileSync(f, "utf8"));
		} catch {
			return def;
		}
	};
	const writeJson = (f: string, v: unknown) => {
		mk(path.dirname(f));
		const t = `${f}.${process.pid}.${crypto.randomBytes(3).toString("hex")}.tmp`;
		fs.writeFileSync(t, JSON.stringify(v, null, 1));
		fs.renameSync(t, f);
	};
	const lock = <T>(name: string, fn: () => T): T => {
		const f = p(`${name}.lock`);
		mk(root);
		for (let i = 0; ; i++) {
			try {
				fs.closeSync(fs.openSync(f, "wx"));
				break;
			} catch (e: any) {
				if (e.code !== "EEXIST") throw e;
				try {
					if (Date.now() - fs.statSync(f).mtimeMs > 5000) fs.unlinkSync(f);
				} catch {}
				if (i > 300) throw new Error("lock timeout");
				sleepSync(10);
			}
		}
		try {
			return fn();
		} finally {
			try {
				fs.unlinkSync(f);
			} catch {}
		}
	};
	const alive = (a: Agent) => {
		try {
			process.kill(a.pid, 0);
			return true;
		} catch (e: any) {
			return e.code === "EPERM";
		}
	};
	const files = (dir: string, ext = ".json") => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(ext)).sort() : []);

	// ---- registry
	function agents(): Agent[] {
		const out: Agent[] = [];
		for (const f of files(p("registry"))) {
			const a = readJson<Agent | null>(p("registry", f), null);
			if (!a) continue;
			if (!alive(a)) leave(a.name);
			else out.push(a);
		}
		return out;
	}
	function join(init: Partial<Agent> = {}): Agent {
		return lock("names", () => {
			const used = new Set(agents().map((a) => a.name));
			let name = init.name;
			for (let i = 0; !name || used.has(name); i++) {
				name = ADJ[Math.floor(Math.random() * ADJ.length)] + NOUN[Math.floor(Math.random() * NOUN.length)] + (i > 40 ? i : "");
			}
			const a: Agent = { pid: process.pid, startedAt: Date.now(), cwd, status: "active", tools: 0, tokens: 0, lastActivity: Date.now(), ...init, name };
			writeJson(p("registry", `${name}.json`), a);
			return a;
		});
	}
	function update(name: string, patch: Partial<Agent> | ((a: Agent) => Partial<Agent>)) {
		const f = p("registry", `${name}.json`);
		const a = readJson<Agent | null>(f, null);
		if (!a) return;
		writeJson(f, { ...a, ...(typeof patch === "function" ? patch(a) : patch) });
	}
	function leave(name: string) {
		fs.rmSync(p("registry", `${name}.json`), { force: true });
		fs.rmSync(p("inbox", name), { recursive: true, force: true });
		release(name);
		for (const c of claims()) if (c.owner === name) unclaim(name, c.taskId);
	}

	// ---- messages
	function send(from: string, to: string, text: string): number {
		const sender = agents().find((a) => a.name === from);
		// worker broadcasts skip humans (they read the feed); human broadcasts reach everyone
		const names = to === "all" ? agents().filter((a) => a.name !== from && (sender?.human || !a.human)).map((a) => a.name) : [to];
		if (to !== "all" && !agents().some((a) => a.name === to)) throw new Error(`agent "${to}" not found`);
		for (const n of names) {
			writeJson(p("inbox", n, `${Date.now()}-${crypto.randomUUID()}.json`), { from, to, text, ts: Date.now() });
		}
		feed({ who: from, kind: "message", text: `→ ${to}: ${text}` });
		return names.length;
	}
	function drain(name: string): { from: string; text: string; ts: number }[] {
		const d = p("inbox", name);
		const out = [];
		for (const f of files(d)) {
			const m = readJson<any>(path.join(d, f), null);
			fs.rmSync(path.join(d, f), { force: true });
			if (m) out.push(m);
		}
		return out;
	}

	// ---- reservations
	const norm = (x: string) => path.resolve(cwd, x).replace(/\/\*{0,2}$/, "");
	const overlap = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
	const reservations = () => readJson<Record<string, Reservation>>(p("reservations.json"), {});
	function reserve(owner: string, paths: string[], reason?: string): { ok: boolean; conflicts: { path: string; owner: string }[] } {
		const live = new Set(agents().map((a) => a.name)); // outside the lock: agents() may call leave()
		return lock("reservations", () => {
			const all = reservations();
			for (const k of Object.keys(all)) if (!live.has(all[k].owner)) delete all[k];
			const want = paths.map(norm);
			const conflicts = [];
			for (const w of want) for (const [k, r] of Object.entries(all)) if (r.owner !== owner && overlap(w, k)) conflicts.push({ path: k, owner: r.owner });
			if (conflicts.length) return { ok: false, conflicts };
			for (const w of want) all[w] = { owner, reason, since: Date.now() };
			writeJson(p("reservations.json"), all);
			return { ok: true, conflicts: [] };
		});
	}
	function release(owner: string, paths?: string[]) {
		if (!fs.existsSync(p("reservations.json"))) return;
		const want = paths?.map(norm);
		lock("reservations", () => {
			const all = reservations();
			for (const k of Object.keys(all)) if (all[k].owner === owner && (!want || want.includes(k))) delete all[k];
			writeJson(p("reservations.json"), all);
		});
	}
	function blocker(owner: string, file: string): ({ path: string } & Reservation) | undefined {
		const f = norm(file);
		for (const [k, r] of Object.entries(reservations())) if (r.owner !== owner && overlap(f, k)) return { path: k, ...r };
	}
	function blockerInText(owner: string, text: string) {
		for (const [k, r] of Object.entries(reservations())) {
			if (r.owner !== owner && (text.includes(k) || text.includes(path.relative(cwd, k) || "\0"))) return { path: k, ...r };
		}
	}
	const reservedBy = (owner: string) => Object.values(reservations()).some((r) => r.owner === owner);

	// ---- feed
	function feed(ev: { who: string; kind: string; text: string }) {
		mk(root);
		fs.appendFileSync(p("feed.jsonl"), `${JSON.stringify({ ts: Date.now(), ...ev })}\n`);
	}
	function recent(n = 20): { ts: number; who: string; kind: string; text: string }[] {
		try {
			return fs.readFileSync(p("feed.jsonl"), "utf8").trim().split("\n").filter(Boolean).slice(-n).map((l) => JSON.parse(l));
		} catch {
			return [];
		}
	}

	// ---- runs
	const saveRun = (r: Run) => writeJson(p("runs", `${r.id}.json`), r);
	const loadRun = (id: string) => readJson<Run | null>(p("runs", `${id}.json`), null);
	const latestRun = () => {
		const f = files(p("runs")).pop();
		return f ? loadRun(f.slice(0, -5)) : null;
	};

	// ---- swarm: atomic claims (wx)
	function claims(): { taskId: string; owner: string; since: number }[] {
		return files(p("claims")).map((f) => readJson<any>(p("claims", f), null)).filter(Boolean);
	}
	function claim(owner: string, taskId: string): { ok: boolean; reason?: string } {
		if (completed().has(taskId)) return { ok: false, reason: "already completed" };
		if (claims().some((c) => c.owner === owner)) return { ok: false, reason: "you already have an open claim" };
		const f = p("claims", `${enc(taskId)}.json`);
		mk(path.dirname(f));
		const rec = { taskId, owner, since: Date.now() };
		try {
			fs.writeFileSync(f, JSON.stringify(rec), { flag: "wx" });
			return { ok: true };
		} catch (e: any) {
			if (e.code !== "EEXIST") throw e;
			const c = readJson<any>(f, null);
			const a = c && agents().find((x) => x.name === c.owner);
			// shortcut: claim stealing is not atomic between two simultaneous thieves
			if (!c || !a || a.status === "stuck") {
				writeJson(f, rec);
				return { ok: true };
			}
			return { ok: false, reason: `already claimed by ${c.owner}` };
		}
	}
	function unclaim(owner: string, taskId: string) {
		const f = p("claims", `${enc(taskId)}.json`);
		if (readJson<any>(f, null)?.owner === owner) fs.rmSync(f, { force: true });
	}
	function complete(owner: string, taskId: string, summary?: string) {
		writeJson(p("completions", `${enc(taskId)}.json`), { taskId, owner, summary, ts: Date.now() });
		fs.rmSync(p("claims", `${enc(taskId)}.json`), { force: true });
		release(owner);
		feed({ who: owner, kind: "task", text: `completed ${taskId}${summary ? `: ${summary}` : ""}` });
	}
	/** Forget completion/claim of a task so it can run again (reset/revise). */
	const reopen = (taskId: string) => {
		fs.rmSync(p("completions", `${enc(taskId)}.json`), { force: true });
		fs.rmSync(p("claims", `${enc(taskId)}.json`), { force: true });
	};
	const completed = () => new Set(files(p("completions")).map((f) => decodeURIComponent(f.slice(0, -5))));

	return { root, agents, join, update, leave, send, drain, reserve, release, blocker, blockerInText, reservedBy, reservations, feed, recent, saveRun, loadRun, latestRun, claims, claim, unclaim, complete, completed, reopen };
}
