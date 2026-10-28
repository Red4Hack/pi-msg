// Presence, automatic feed, reservation guard, and stuck detection.
import type { Bus } from "./bus.ts";

export const STUCK_MS = 5 * 60_000;
const WRITE = /(^|[^<>=-])>>?\s*[^\s&|]|\bsed\s+(-\w*\s+)*-i|\btee\b|\bmv\b|\brm\b|\bcp\b/;
const TEST = /\b(npm (run )?test|vitest|jest|pytest|cargo test|go test|node --test|bun test)\b/;

export type Guard = ReturnType<typeof makeGuard>;

/** tool_call/tool_result hook: blocks writes to a path reserved by someone else and tracks activity. */
export function makeGuard(bus: Bus, name: string, now: () => number = Date.now) {
	const edits: number[] = [];
	let failing = false;
	const touch = (extra: Record<string, unknown> = {}) =>
		bus.update(name, (a) => {
			const recent = edits.filter((t) => now() - t < STUCK_MS).length;
			return { tools: a.tools + 1, lastActivity: now(), status: "active", note: failing ? "debugging…" : recent >= 8 ? "on fire" : "", ...extra };
		});
	const block = (b: { owner: string; reason?: string; path: string }) => ({
		block: true as const,
		reason: `${b.path} is reserved by ${b.owner}${b.reason ? ` (${b.reason})` : ""}. Talk to ${b.owner} via msg send or work on another file.`,
	});
	return {
		call(ev: any) {
			const t: string = ev.toolName;
			const i = ev.input ?? {};
			if (t === "edit" || t === "write") {
				const f = i.path ?? i.file_path;
				const b = f && bus.blocker(name, f);
				if (b) return block(b);
				edits.push(now());
				bus.feed({ who: name, kind: "edit", text: String(f) });
			} else if (t === "bash" && typeof i.command === "string") {
				if (WRITE.test(i.command)) {
					const b = bus.blockerInText(name, i.command);
					if (b) return block(b);
				}
				if (/git\s+commit/.test(i.command)) bus.feed({ who: name, kind: "commit", text: i.command.slice(0, 80) });
			}
			touch();
		},
		result(ev: any) {
			const cmd = ev.input?.command;
			if (ev.toolName === "bash" && typeof cmd === "string" && TEST.test(cmd)) {
				failing = !!ev.isError;
				bus.feed({ who: name, kind: "test", text: `${cmd.slice(0, 60)} ${failing ? "✗" : "✓"}` });
				touch();
			}
		},
	};
}

/** Marks as stuck anyone with a task/reservation who has been idle for > STUCK_MS. Returns the newly marked ones. */
export function sweepStuck(bus: Bus, now = Date.now()): string[] {
	const out: string[] = [];
	for (const a of bus.agents()) {
		if (a.status === "stuck" || now - a.lastActivity <= STUCK_MS) continue;
		if (!a.task && !bus.reservedBy(a.name)) continue;
		bus.update(a.name, { status: "stuck", note: "STUCK" });
		bus.feed({ who: a.name, kind: "stuck", text: `idle for ${Math.round((now - a.lastActivity) / 60000)}min` });
		out.push(a.name);
	}
	return out;
}

export const label = (a: { name: string; human?: boolean }) => (a.human ? `${a.name} (you)` : a.name);
