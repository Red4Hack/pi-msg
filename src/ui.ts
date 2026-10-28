// Overlay panel modeled on pi-messenger: list view + detail view, confirm/input bars, feed focus.
// shortcut: no per-agent DM tabs, no split/revise; add if requested.
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Bus, Run, Task } from "./bus.ts";
import { label } from "./presence.ts";
import { splitTask } from "./plan.ts";
import type { ActiveRun } from "./run.ts";

const ICON: Record<string, string> = { done: "✓", failed: "✗", blocked: "✗", aborted: "■", pending: "○", running: "●", waiting: "◌" };
const DOT: Record<string, string> = { active: "🟢", idle: "🟡", away: "⚪", stuck: "🔴" };
const DIM_KINDS = new Set(["join", "leave", "reserve", "release"]);
const HINTS = "  [^T] [^B]";

export interface PanelDeps {
	bus: Bus;
	me: string;
	cwd: string;
	active: Map<string, ActiveRun>;
	save: (r: Run) => void;
	resume: () => void;
	profiles: string[];
	lobby: (delta: number) => number;
}

export function openPanel(ctx: any, d: PanelDeps) {
	return ctx.ui.custom<void>(
		(tui: any, theme: any, _kb: any, done: (v?: void) => void) => {
			const timer = setInterval(() => tui.requestRender(), 1000);
			const p = new Panel(d, theme, () => {
				clearInterval(timer);
				done();
			});
			return {
				get width() { return Math.min(100, Math.max(40, process.stdout.columns ?? 90)); },
				focused: false,
				render: () => p.render(),
				invalidate() {},
				handleInput: (s: string) => { p.input(s); tui.requestRender(); },
			};
		},
		{ overlay: true },
	);
}

const fmtTok = (n: number) => (n > 1000 ? `${Math.round(n / 1000)}k` : `${n}`);
const ago = (ms: number) => {
	const s = Math.floor(Math.max(0, ms) / 1000);
	return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m`;
};
const clock = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;

type Mode = "list" | "detail";
type Input = null | "message" | "block" | "revise" | "split";
interface Confirm { type: "reset" | "delete" | "abort-all"; id: string; title: string }

class Panel {
	sel = 0;
	mode: Mode = "list";
	input_: Input = null;
	buf = "";
	confirm: Confirm | null = null;
	feedFocus = false;
	scroll = 0;
	tab = 0; // 0 = All, n = DM with n-th peer
	note: { msg: string; until: number } | null = null;
	private d: PanelDeps;
	private theme: any;
	private close: () => void;
	constructor(d: PanelDeps, theme: any, close: () => void) {
		this.d = d;
		this.theme = theme;
		this.close = close;
	}

	private run(): ActiveRun | undefined {
		const act = [...this.d.active.values()].pop();
		if (act) return act;
		const r = this.d.bus.latestRun();
		return r ? { run: r, ac: new AbortController(), taskAcs: new Map() } : undefined;
	}
	private peer(): string | undefined {
		return this.d.bus.agents().filter((a) => !a.human)[this.tab - 1]?.name;
	}
	private flash(msg: string) {
		this.note = { msg, until: Date.now() + 4000 };
	}

	input(s: string) {
		const ar = this.run();
		const tasks = ar?.run.tasks ?? [];
		const t: Task | undefined = tasks[this.sel];

		// text inputs (message / block reason)
		if (this.input_) {
			if (matchesKey(s, "escape")) { this.input_ = null; this.buf = ""; }
			else if (matchesKey(s, "return")) this.submit(ar, t);
			else if (matchesKey(s, "backspace")) this.buf = this.buf.slice(0, -1);
			else if (matchesKey(s, "tab") && this.input_ === "message" && this.buf.startsWith("@") && !this.buf.includes(" ")) {
				const q = this.buf.slice(1).toLowerCase();
				const hit = ["all", ...this.d.bus.agents().map((a) => a.name)].find((n) => n.toLowerCase().startsWith(q));
				if (hit) this.buf = `@${hit} `;
			} else if (s.length === 1 && s.charCodeAt(0) >= 32) this.buf += s;
			return;
		}

		// y/n confirmation bar
		if (this.confirm) {
			const c = this.confirm;
			this.confirm = null;
			if (s !== "y") return;
			if (c.type === "abort-all") { ar?.ac.abort(); return this.flash("run aborted"); }
			if (!ar || !t) return;
			if (c.type === "reset") {
				t.status = "pending"; t.result = undefined; t.error = undefined; t.note = undefined;
				this.d.bus.reopen(`${ar.run.id}:${t.id}`);
				this.flash(`${t.id} reset`);
			} else {
				ar.run.tasks = ar.run.tasks.filter((x) => x.id !== c.id);
				for (const x of ar.run.tasks) x.deps = x.deps.filter((d) => d !== c.id);
				this.sel = Math.max(0, Math.min(this.sel, ar.run.tasks.length - 1));
				this.mode = "list";
				this.flash(`${c.id} deleted`);
			}
			this.d.save(ar.run);
			return;
		}

		if (matchesKey(s, "escape")) {
			if (this.mode === "detail") { this.mode = "list"; this.scroll = 0; return; }
			return this.close();
		}
		if (s === "m" || s === "@" || matchesKey(s, "tab")) { this.input_ = "message"; this.buf = s === "@" ? "@" : ""; return; }
		if (s === "l" || s === "L") return this.flash(`lobby workers: ${this.d.lobby(s === "l" ? 1 : -1)}`);
		if (s === "f") { this.feedFocus = !this.feedFocus; return; }
		if (s === "A" && ar) { this.confirm = { type: "abort-all", id: "", title: "" }; return; }

		const n = tasks.length;
		if (this.mode === "detail") {
			if (matchesKey(s, "up")) this.scroll = Math.max(0, this.scroll - 1);
			else if (matchesKey(s, "down")) this.scroll++;
			else if (matchesKey(s, "left") && n) { this.sel = Math.max(0, this.sel - 1); this.scroll = 0; }
			else if (matchesKey(s, "right") && n) { this.sel = Math.min(n - 1, this.sel + 1); this.scroll = 0; }
		} else if (matchesKey(s, "left")) this.tab = Math.max(0, this.tab - 1);
		else if (matchesKey(s, "right")) this.tab++;
		else if (matchesKey(s, "up")) this.sel = Math.max(0, this.sel - 1);
		else if (matchesKey(s, "down")) this.sel = Math.min(Math.max(0, n - 1), this.sel + 1);
		else if (matchesKey(s, "home")) this.sel = 0;
		else if (matchesKey(s, "end")) this.sel = Math.max(0, n - 1);
		else if (matchesKey(s, "return") && t) { this.mode = "detail"; this.scroll = 0; }

		if (!t || !ar) return;
		const live = t.status === "running" || t.status === "waiting";
		if ((s === "a" || s === "q") && live) { ar.taskAcs.get(t.id)?.abort(); this.flash(`${t.id} aborting`); }
		else if (s === "r" && !live) this.confirm = { type: "reset", id: t.id, title: t.title };
		else if (s === "x" && !live) this.confirm = { type: "delete", id: t.id, title: t.title };
		else if (s === "u" && t.status === "blocked") { t.status = "pending"; t.note = undefined; this.d.save(ar.run); this.flash(`${t.id} unblocked`); }
		else if (s === "S" && !live && t.status !== "done") { this.input_ = "split"; this.buf = ""; }
		else if (s === "p" && !live) { this.input_ = "revise"; this.buf = ""; }
		else if (s === "b" && live) { this.input_ = "block"; this.buf = ""; }
		else if (s === "s" && t.status === "pending" && !this.d.active.size) { this.d.resume(); this.flash("starting run…"); }
		else if ((s === "y" || s === "n") && t.approval === "pending") {
			t.approval = s === "y" ? "approved" : "rejected";
			this.d.save(ar.run);
			this.flash(`${t.id} ${t.approval}`);
		}
	}

	private submit(ar: ActiveRun | undefined, t: Task | undefined) {
		const text = this.buf.trim();
		const kind = this.input_;
		this.input_ = null;
		this.buf = "";
		if (!text) return;
		if (kind === "split") {
			if (!ar || !t) return;
			const parts = text.split(";").map((x) => x.trim()).filter(Boolean);
			try {
				const ids = splitTask(ar.run.tasks, t.id, parts);
				this.d.save(ar.run);
				return this.flash(`split into ${ids.join(", ")}`);
			} catch (e: any) {
				return this.flash(e.message);
			}
		}
		if (kind === "revise") {
			if (!ar || !t) return;
			t.prompt += `\n\nRevision: ${text}`;
			t.status = "pending"; t.result = undefined; t.error = undefined; t.note = undefined;
			this.d.bus.reopen(`${ar.run.id}:${t.id}`);
			this.d.save(ar.run);
			return this.flash(`${t.id} revised, reset to pending`);
		}
		if (kind === "block") {
			if (!ar || !t) return;
			ar.taskAcs.get(t.id)?.abort();
			t.status = "blocked";
			t.note = text;
			this.d.save(ar.run);
			return this.flash(`${t.id} blocked`);
		}
		const m = text.match(/^@(\S+)\s+([\s\S]+)$/);
		try {
			this.d.bus.send(this.d.me, m ? m[1] : this.peer() ?? "all", m ? m[2] : text);
		} catch (e: any) {
			this.flash(e.message);
		}
	}

	private detail(t: Task, ar: ActiveRun, w: number): string[] {
		const th = this.theme;
		const dim = (s: string) => th.fg("dim", s);
		const wk = this.d.bus.agents().find((a) => a.task === t.id && !a.human);
		const L: string[] = [`${t.id}: ${t.title}`];
		L.push(wk
			? `Status: ${t.status}  │  ${wk.name}  │  ${wk.tools} calls  ${fmtTok(wk.tokens)} tokens  ${ago(Date.now() - wk.startedAt)}`
			: `Status: ${t.status}${t.role ? `  │  Role: ${t.role}` : ""}${t.approval && t.approval !== "none" ? `  │  Approval: ${t.approval}` : ""}${t.model ? `  │  ${t.model}` : ""}`);
		L.push("");
		if (t.note) L.push(`Note: ${t.note}`, "");
		if (wk) {
			const ev = this.d.bus.recent(200).filter((e) => e.who === wk.name);
			const start = ev[0]?.ts ?? wk.startedAt;
			for (const e of ev.slice(-20)) L.push(`  [${clock(e.ts - start)}] ${e.kind} ${e.text}`);
			L.push(`  → ${wk.note || "working"}`);
		} else {
			if (t.deps.length) {
				L.push("Dependencies:");
				for (const id of t.deps) {
					const x = ar.run.tasks.find((y) => y.id === id);
					L.push(x ? `  ${x.status === "done" ? "✓" : "○"} ${x.id}: ${x.title} (${x.status})` : `  ○ ${id}: (missing)`);
				}
				L.push("");
			}
			if (t.files.length) L.push(`Files: ${t.files.join(", ")}`, "");
			if (t.error) L.push(`Error: ${t.error}`, "");
			if (t.result) { L.push(t.status === "done" ? "Completion Summary:" : "Result:"); for (const l of t.result.trimEnd().split("\n")) L.push(`  ${l}`); L.push(""); }
			L.push("Spec:");
			for (const l of t.prompt.trimEnd().split("\n")) L.push(`  ${l}`);
		}
		return L.flatMap((l) => (visibleWidth(l) > w ? [truncateToWidth(l, w)] : [l])).map((l) => (l.startsWith("Error") ? th.fg("error", l) : l.startsWith("  [") ? dim(l) : l));
	}

	private legend(t: Task | undefined): string {
		const th = this.theme;
		const N = this.note && Date.now() < this.note.until ? this.note.msg : "";
		if (this.confirm) {
			const c = this.confirm;
			return th.fg("warning", `⚠ ${c.type === "abort-all" ? "Abort entire run?" : `${c.type === "reset" ? "Reset" : "Delete"} ${c.id} "${c.title.slice(0, 30)}"?`} [y] Confirm  [n] Cancel${HINTS}`);
		}
		if (this.input_ === "split") return th.fg("accent", `Split (parts separated by ;): ${this.buf}█  [Enter] Apply  [Esc] Cancel${HINTS}`);
		if (this.input_ === "revise") return th.fg("accent", `Revise ${this.buf}█  [Enter] Apply  [Esc] Cancel${HINTS}`);
		if (this.input_ === "block") return th.fg("warning", `Block reason: ${this.buf}█  [Enter] Confirm  [Esc] Cancel${HINTS}`);
		if (this.input_ === "message") {
			const at = this.buf.startsWith("@");
			return th.fg("accent", `${at ? "DM" : "broadcast"}: ${this.buf}█  [Enter] Send${at && !this.buf.includes(" ") ? "  [Tab] Complete" : ""}  [Esc] Cancel`);
		}
		if (N) return N + HINTS;
		const h: string[] = [];
		if (t) {
			const live = t.status === "running" || t.status === "waiting";
			if (this.mode === "list") h.push("Enter:Detail");
			if (live) h.push("q:Stop", "b:Block");
			else h.push("r:Reset", "p:Revise", "S:Split", "x:Del");
			if (t.status === "blocked") h.push("u:Unblock");
			if (t.status === "pending" && !this.d.active.size) h.push("s:Start");
			if (t.approval === "pending") h.push("y/n:Approve");
			if (this.mode === "detail") h.push("←→:Nav");
		}
		h.push("l/L:Lobby", "m:Chat", "f:Feed", "A:AbortAll", ...HINTS.trim().split(" "));
		// single line (keeps the content area tall); Esc:Close first so right-edge truncation never hides it
		return th.fg("dim", h.join(" "));
	}

	render(): string[] {
		const th = this.theme;
		const w = Math.min(100, Math.max(40, process.stdout.columns ?? 90));
		const innerW = w - 2;
		const sectionW = innerW - 2;
		const border = (s: string) => th.fg("dim", s);
		const dim = (s: string) => th.fg("dim", s);
		const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - visibleWidth(s)));
		const row = (c: string) => border("│") + pad(` ${truncateToWidth(c.replace(/[\r\n\t]/g, " "), sectionW)}`, innerW) + border("│");
		const sep = dim("─".repeat(sectionW));

		const ar = this.run();
		const tasks = ar?.run.tasks ?? [];
		this.sel = Math.max(0, Math.min(this.sel, tasks.length - 1));
		if (!tasks.length) this.mode = "list";
		const sel: Task | undefined = tasks[this.sel];
		const agents = this.d.bus.agents();
		const now = Date.now();

		const title = `${th.fg("accent", "Messenger")} ─ ${dim(this.d.cwd.split("/").pop() ?? "")} ─ ${dim("Esc:Close")}`;
		const bl = Math.max(0, innerW - visibleWidth(title) - 2);
		const lines = [border(`╭${"─".repeat(Math.floor(bl / 2))}`) + ` ${title} ` + border(`${"─".repeat(bl - Math.floor(bl / 2))}╮`)];

		const cnt: Record<string, number> = {};
		for (const t of tasks) cnt[t.status] = (cnt[t.status] ?? 0) + 1;
		const workers = agents.filter((a) => !a.human && a.task);
		const needs = tasks.filter((t) => t.approval === "pending").length;
		const rej = tasks.filter((t) => t.approval === "rejected").length;
		lines.push(row(tasks.length
			? `📋 ${(ar?.run.goal ?? ar?.run.id ?? "").slice(0, 40)}: ${cnt.done ?? 0}/${tasks.length} │ ⚙ ${workers.length} workers${this.d.active.size ? ` │ ${th.fg("accent", "● RUNNING")}` : ""}${needs ? ` │ Needs lead: ${needs}` : ""}${rej ? ` │ Rejected: ${rej}` : ""}`
			: `No active run │ ⚙ ${workers.length} workers`));
		lines.push(row(""));

		const rows = process.stdout.rows ?? 24;
		const H = Math.max(8, rows - 6);
		let content: string[] = [];
		if (this.mode === "detail" && sel && ar) {
			const all = this.detail(sel, ar, sectionW);
			const max = Math.max(0, all.length - H);
			this.scroll = Math.min(this.scroll, max);
			if (workers.some((a) => a.task === sel.id)) this.scroll = max; // follow live worker
			content = all.slice(this.scroll, this.scroll + H);
		} else {
			content.push(agents.map((a) => `${DOT[a.status]} ${a.human ? "You" : a.name}${a.human ? "" : a.task ? ` (${a.task})` : ""} ${dim(`(${a.status === "stuck" ? "STUCK" : ago(now - a.lastActivity)})`)}`).join("  "));
			const peers = this.d.bus.agents().filter((a) => !a.human).map((a) => a.name);
			this.tab = Math.min(this.tab, peers.length);
			content.push(sep);
			const wl = workers.slice(0, rows <= 26 ? 2 : 5);
			if (wl.length) {
				for (const a of wl) content.push(`⚡ ${a.name} ${a.task}  ${a.note || "working"}  ${dim(`${ago(now - a.startedAt)}  ${a.tools}t ${fmtTok(a.tokens)} tok`)}`);
				content.push(sep);
			}
			if (!tasks.length) {
				content.push("Profiles: " + this.d.profiles.join(", "), "", "Start something:", dim("  /msg <task>"), dim("  /msg plan <goal>"), dim('  msg({ action: "tasks", tasks: [...] })'), dim('  msg({ action: "team", profile: "review-squad" })'));
			} else if (this.feedFocus) {
				content.push(`Tasks: ${th.fg("accent", `${cnt.done ?? 0} done`)}  ${th.fg("warning", `${cnt.running ?? 0} active`)}  ${th.fg("error", `${(cnt.failed ?? 0) + (cnt.blocked ?? 0)} blocked`)}  ${dim(`${cnt.pending ?? 0} todo`)}  (${tasks.length} total)`);
			} else {
				tasks.forEach((t, i) => {
					const color = t.status === "done" ? "accent" : t.status === "running" ? "warning" : t.status === "failed" || t.status === "blocked" ? "error" : "dim";
					const who = t.status === "running" ? workers.find((a) => a.task === t.id)?.name : undefined;
					const suffix = who ? ` (${who})` : t.status === "pending" && t.deps.length ? ` → ${t.deps.join(", ")}` : t.note ? ` [${t.note.slice(0, 28)}${t.note.length > 28 ? "…" : ""}]` : "";
					const lbl = [t.role ? `[${t.role}]` : "", t.approval && t.approval !== "none" ? `[${t.approval}]` : ""].filter(Boolean).join(" ");
					content.push(`${i === this.sel ? th.fg("accent", "▸ ") : "  "}${th.fg(color, ICON[t.status] ?? "?")} ${t.id}  ${lbl ? `${lbl} ` : ""}${t.title}${dim(suffix)}`);
				});
			}
			const feedH = Math.max(2, H - content.length - 1);
			const tabName = this.peer();
			const feed = this.d.bus.recent(200).filter((e) => !tabName || e.who === tabName || e.text.startsWith(`→ ${tabName}:`)).slice(-Math.max(1, this.feedFocus ? H - content.length - 1 : feedH)).map((e) => {
				const time = new Date(e.ts).toTimeString().slice(0, 5);
				const line = e.kind === "message" ? `${time} ${e.who} ${th.fg("accent", "→")} ${e.text.replace(/^→ \S+: /, "")}` : `${time} ${e.who} ${e.kind} ${e.text}`;
				return DIM_KINDS.has(e.kind) ? dim(line) : line;
			});
			content.push(dim(["All", ...this.d.bus.agents().filter((a) => !a.human).map((a) => a.name)].map((n, i) => (i === this.tab ? `[${n}]` : n)).join("  ") + "  (←→ tab)"));
			if (feed.length) content.push(sep, ...feed);
			content = content.slice(0, H);
		}
		while (content.length < H) content.push("");
		for (const l of content) lines.push(row(l));

		lines.push(border(`├${"─".repeat(innerW)}┤`));
		lines.push(row(this.legend(sel)));
		lines.push(border(`╰${"─".repeat(innerW)}╯`));
		return lines;
	}
}
void label;
