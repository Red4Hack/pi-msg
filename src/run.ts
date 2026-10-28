import type { Run, Task } from "./bus.ts";

export const CONCURRENCY = 3;
export const MAX_CONCURRENCY = 10; // same hard ceiling as pi-messenger
export interface ExecResult {
	ok: boolean;
	text: string;
	blocked?: boolean;
	/** another process already claimed this task */
	skipped?: boolean;
}
export type Exec = (t: Task, signal: AbortSignal) => Promise<ExecResult>;
export interface ActiveRun {
	run: Run;
	ac: AbortController;
	taskAcs: Map<string, AbortController>;
}

const BAD = new Set(["failed", "blocked", "aborted"]);
const readyToStart = (t: Task, run: Run) =>
	t.status === "pending" && t.approval !== "pending" && t.approval !== "rejected" && t.deps.every((d) => run.tasks.find((x) => x.id === d)?.status === "done");

/** DAG scheduler: each task starts as soon as its deps are done (no wave barrier). */
export async function runDag(run: Run, exec: Exec, o: { signal: AbortSignal; taskAcs?: Map<string, AbortController>; concurrency?: number; onChange?: () => void }) {
	const running = new Set<Promise<void>>();
	const max = Math.min(MAX_CONCURRENCY, Math.max(1, o.concurrency ?? CONCURRENCY));
	const start = (t: Task) => {
		t.status = "running";
		const ac = new AbortController();
		const link = () => ac.abort();
		o.signal.addEventListener("abort", link);
		o.taskAcs?.set(t.id, ac);
		const pr: Promise<void> = exec(t, ac.signal)
			.then((r) => {
				t.result = r.text;
				t.status = r.skipped ? "waiting" : ac.signal.aborted && !r.ok ? "aborted" : r.blocked ? "blocked" : r.ok ? "done" : "failed";
			})
			.catch((e) => {
				t.error = String(e?.message ?? e);
				t.status = ac.signal.aborted ? "aborted" : "failed";
			})
			.finally(() => {
				o.signal.removeEventListener("abort", link);
				o.taskAcs?.delete(t.id);
				running.delete(pr);
				o.onChange?.();
			});
		running.add(pr);
		o.onChange?.();
	};
	while (!o.signal.aborted) {
		for (const t of run.tasks) {
			if (t.status === "pending" && t.deps.some((d) => BAD.has(run.tasks.find((x) => x.id === d)?.status ?? ""))) t.status = "blocked";
		}
		for (const t of run.tasks) {
			if (running.size >= max) break;
			if (readyToStart(t, run)) start(t);
		}
		if (!running.size) break;
		await Promise.race(running);
	}
	await Promise.all(running);
	return run;
}

/** Prepares a resume: whatever was running/aborted/blocked goes back to pending. */
export function resumable(run: Run): Run {
	for (const t of run.tasks) if (["running", "waiting", "aborted", "blocked"].includes(t.status)) t.status = "pending";
	return run;
}

export function report(run: Run): string {
	const icon: Record<string, string> = { done: "✓", failed: "✗", blocked: "⛔", aborted: "■", pending: "⏸", running: "▶", waiting: "⏳" };
	const lines = run.tasks.map((t) => `${icon[t.status] ?? "?"} ${t.id} ${t.title} [${t.status}${t.approval === "pending" ? ", awaiting approval" : t.approval === "rejected" ? ", rejected" : ""}]${t.result && t.status === "done" ? `\n    ${t.result.slice(0, 400).replace(/\n/g, "\n    ")}` : ""}${t.error ? `\n    error: ${t.error}` : ""}`);
	const needs = run.tasks.filter((t) => t.approval === "pending").map((t) => t.id);
	const done = run.tasks.filter((t) => t.status === "done").length;
	return `Run ${run.id}: ${done}/${run.tasks.length} completed\n${lines.join("\n")}${needs.length ? `\nneedsApproval: ${needs.join(", ")} (task approve/reject)` : ""}`;
}
