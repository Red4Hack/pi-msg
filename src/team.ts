// Optional team layer: built-in profiles, charter, typed memory, approval gate.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Task } from "./bus.ts";

export const ROLES: Record<string, string> = {
	"context-builder": "Gathers context from the code and docs for the others; does not edit.",
	delegate: "Executes a well-scoped subtask.",
	oracle: "Answers design questions and risks; does not edit.",
	planner: "Breaks goals down into parallelizable tasks.",
	researcher: "Searches code and docs and returns objective findings; does not edit.",
	reviewer: "Reviews correctness, security and tests of what was done; does not edit.",
	scout: "Maps what will be affected before implementing; does not edit.",
	worker: "Implements the task in small, reversible steps.",
};
const RO = new Set(["context-builder", "oracle", "researcher", "reviewer", "scout", "planner"]);
export const isReadOnlyRole = (r?: string) => !!r && RO.has(r);

interface Profile {
	name: string;
	description: string;
	roles: string[];
	approval: { mode: "none" | "risk-labels"; labels: string[] };
	memory: { maxCharsPerType: number };
}
const mem = { maxCharsPerType: 4000 };
const PROFILES: Record<string, Profile> = {
	"migration-squad": { name: "migration-squad", description: "Scouts, implements and reviews high-risk migrations with an approval gate", roles: ["scout", "worker", "reviewer"], approval: { mode: "risk-labels", labels: ["database", "migration", "destructive", "api-contract"] }, memory: mem },
	"review-squad": { name: "review-squad", description: "Cleanup: scout, reviewer and worker", roles: ["scout", "reviewer", "worker"], approval: { mode: "none", labels: [] }, memory: mem },
	"research-squad": { name: "research-squad", description: "Research first, planning afterwards", roles: ["researcher", "context-builder", "oracle", "planner"], approval: { mode: "none", labels: [] }, memory: mem },
};
const TYPES = ["decision", "interface", "risk", "handoff"];
const dir = (cwd: string) => path.join(cwd, ".pi", "msg", "team");
const userDir = () => path.join(os.homedir(), ".pi", "agent", "msg", "team-profiles");
const rd = (f: string) => {
	try {
		return fs.readFileSync(f, "utf8");
	} catch {
		return "";
	}
};

export function active(cwd: string): Profile | null {
	try {
		return JSON.parse(rd(path.join(dir(cwd), "profile.json")));
	} catch {
		return null;
	}
}

export function activate(cwd: string, name: string): string {
	let prof: Profile | undefined;
	try {
		prof = JSON.parse(rd(path.join(userDir(), `${name}.json`)));
	} catch { /* no user profile saved: fall back to the built-in one */ }
	prof ??= PROFILES[name];
	if (!prof) throw new Error(`unknown profile: ${name}. Available: ${Object.keys(PROFILES).join(", ")}`);
	fs.mkdirSync(dir(cwd), { recursive: true });
	fs.writeFileSync(path.join(dir(cwd), "profile.json"), JSON.stringify(prof, null, 1));
	const ch = path.join(dir(cwd), "charter.md");
	if (!fs.existsSync(ch)) fs.writeFileSync(ch, `# Charter — ${prof.name}\n\n${prof.description}\n\n- High-risk changes require approval from the lead.\n- Record decisions, interfaces and risks with team.note.\n`);
	return `Team "${prof.name}" active. Roles: ${prof.roles.join(", ")}. Approval: ${prof.approval.mode === "none" ? "none" : prof.approval.labels.join(", ")}.`;
}

export function save(cwd: string): string {
	const p = active(cwd);
	if (!p) throw new Error("no active team");
	fs.mkdirSync(userDir(), { recursive: true });
	const f = path.join(userDir(), `${p.name}.json`);
	fs.writeFileSync(f, JSON.stringify(p, null, 1));
	return `Profile saved to ${f}`;
}

export const charter = (cwd: string) => rd(path.join(dir(cwd), "charter.md")) || "(no charter)";
export const updateCharter = (cwd: string, msg: string) => fs.appendFileSync(path.join(dir(cwd), "charter.md"), `\n- ${msg}\n`);

export function note(cwd: string, type: string, message: string, who: string) {
	if (!TYPES.includes(type)) throw new Error(`type must be: ${TYPES.join(", ")}`);
	fs.mkdirSync(dir(cwd), { recursive: true });
	fs.appendFileSync(path.join(dir(cwd), "memory.jsonl"), `${JSON.stringify({ ts: Date.now(), type, who, message })}\n`);
}
export function memory(cwd: string, type?: string, limit = 50): { ts: number; type: string; who: string; message: string }[] {
	return rd(path.join(dir(cwd), "memory.jsonl")).split("\n").filter(Boolean).flatMap((l) => {
		try {
			return [JSON.parse(l)];
		} catch {
			return []; // skip a corrupt line instead of losing all memory
		}
	}).filter((m) => !type || m.type === type).slice(-limit);
}

/** Bounded context injected into the worker prompt. */
export function context(cwd: string, role?: string): string {
	const p = active(cwd);
	if (!p) return "";
	const max = p.memory.maxCharsPerType;
	const mems = TYPES.map((t) => {
		const s = memory(cwd, t).map((m) => `- ${m.message}`).join("\n");
		return s ? `[${t}]\n${s.slice(-max)}` : "";
	}).filter(Boolean);
	return `TEAM ${p.name}${role ? ` · your role: ${role} — ${ROLES[role] ?? ""}` : ""}\nCharter:\n${charter(cwd).slice(0, max)}\n${mems.join("\n")}\nUse team.note... via messages to the lead if you discover decisions/risks.`;
}

/** Sets approval=pending when riskLabels matches the profile's labels. */
export function applyRisk(cwd: string, tasks: Task[]): Task[] {
	const p = active(cwd);
	if (p?.approval.mode === "risk-labels") {
		for (const t of tasks) if (t.approval === "none" && t.riskLabels?.some((l) => p.approval.labels.includes(l))) t.approval = "pending";
	}
	return tasks;
}

export function status(cwd: string): string {
	const p = active(cwd);
	if (!p) return "No active team.";
	const counts = TYPES.map((t) => `${t}:${memory(cwd, t, 1e6).length}`).join(" ");
	return `Team ${p.name} — ${p.description}\nRoles: ${p.roles.join(", ")}\nMemory: ${counts}`;
}
export const profileNames = () => Object.keys(PROFILES);
