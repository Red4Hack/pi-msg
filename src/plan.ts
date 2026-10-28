import type { Task } from "./bus.ts";

export const MAX_TASKS = 8;

export function validate(tasks: any, max = MAX_TASKS): string | null {
	if (!Array.isArray(tasks) || !tasks.length) return "tasks must be a non-empty list";
	if (tasks.length > max) return `maximum of ${max} tasks`;
	const ids = new Set<string>();
	for (const t of tasks) {
		if (!t || typeof t.id !== "string" || !t.id) return "every task needs an id (string)";
		if (ids.has(t.id)) return `duplicate id: ${t.id}`;
		ids.add(t.id);
		if (typeof t.prompt !== "string" || !t.prompt) return `${t.id}: missing prompt`;
	}
	for (const t of tasks) {
		for (const d of t.deps ?? []) {
			if (d === t.id) return `${t.id}: depends on itself`;
			if (!ids.has(d)) return `${t.id}: unknown dep ${d}`;
		}
		if (!t.readOnly && !(t.files?.length > 0)) return `${t.id}: a task that writes needs files (or readOnly:true)`;
	}
	if (waves(tasks).flat().length !== tasks.length) return "dependency cycle";
	return null;
}

/** Waves (Kahn): visual label; the scheduler uses no barrier between waves. */
export function waves(tasks: Pick<Task, "id" | "deps">[]): string[][] {
	const done = new Set<string>();
	const left = [...tasks];
	const out: string[][] = [];
	while (left.length) {
		const w = left.filter((t) => (t.deps ?? []).every((d) => done.has(d)));
		if (!w.length) break;
		out.push(w.map((t) => t.id));
		for (const t of w) {
			done.add(t.id);
			left.splice(left.indexOf(t), 1);
		}
	}
	return out;
}

export function parsePlan(text: string): any[] | null {
	const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	const raw = m ? m[1] : text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
	try {
		const j = JSON.parse(raw);
		return Array.isArray(j) ? j : j.tasks;
	} catch {
		return null;
	}
}

export function toTasks(list: any[], defaultModel?: string): Task[] {
	return list.map((t) => ({
		id: t.id,
		title: t.title ?? String(t.prompt).replace(/\s+/g, " ").slice(0, 60),
		prompt: t.prompt,
		deps: t.deps ?? [],
		files: t.files ?? [],
		model: t.model ?? defaultModel,
		role: t.role,
		readOnly: !!t.readOnly,
		riskLabels: t.riskLabels,
		approval: "none",
		status: "pending",
	}));
}

export function plannerPrompt(goal: string, o: { skills?: string; roles?: string; max?: number } = {}): string {
	return `You are the planner. Explore the code (read-only) and break the goal down into tasks.

GOAL: ${goal}

Rules:
- MAXIMIZE parallelism: foundation with no deps starts immediately; features that don't touch the same files become separate chains.
- At most ${o.max ?? MAX_TASKS} tasks, each small and independent enough for one agent.
- A task that writes MUST list "files" (paths/directories it will edit); a read-only task uses "readOnly": true.
- Tasks that touch the same files must depend on each other.
${o.roles ? `- Optional: "role" (${o.roles}) and "riskLabels" (e.g. database, migration, destructive, api-contract).\n` : ""}${o.skills ? `\nAvailable skills (the worker can read them):\n${o.skills}\n` : ""}
Reply ONLY with JSON:
\`\`\`json
{"tasks":[{"id":"t1","title":"...","prompt":"full instructions","deps":[],"files":["src/x.ts"],"readOnly":false}]}
\`\`\``;
}

/** Replace task `id` with one task per prompt part; dependents now wait for all parts. Returns new ids. */
export function splitTask(tasks: Task[], id: string, parts: string[]): string[] {
	const i = tasks.findIndex((t) => t.id === id);
	if (i < 0 || parts.length < 2) throw new Error("split needs an existing task and at least 2 parts");
	const t = tasks[i];
	const ids = parts.map((_, n) => `${id}.${n + 1}`);
	const subs: Task[] = parts.map((prompt, n) => ({ ...t, id: ids[n], title: prompt.replace(/\s+/g, " ").slice(0, 60), prompt, status: "pending", result: undefined, error: undefined, note: undefined }));
	tasks.splice(i, 1, ...subs);
	for (const x of tasks) if (x.deps.includes(id)) x.deps = x.deps.flatMap((d) => (d === id ? ids : [d]));
	return ids;
}
