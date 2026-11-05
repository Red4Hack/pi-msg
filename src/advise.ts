// Advisor: read-only model that reads the whole session and returns advice; never edits.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** {"advisor": {"model": "provider/id"}} in .pi/msg/config.json or ~/.pi/agent/msg.json. Absent = session model. */
export function advisorModel(cwd: string): string | undefined {
	for (const f of [path.join(os.homedir(), ".pi", "agent", "msg.json")]) {
		try {
			const m = JSON.parse(fs.readFileSync(f, "utf8")).advisor?.model;
			if (m) return m;
		} catch {}
	}
}

const MAX_CHARS = 120_000; // shortcut: keeps the tail of the session only, upgrade to summarising the head

export function transcript(entries: any[]): string {
	const out: string[] = [];
	for (const e of entries) {
		const m = e.type === "message" ? e.message : undefined;
		if (!m) continue;
		const parts = typeof m.content === "string" ? [m.content] : (m.content ?? []).map((c: any) => (c.type === "text" ? c.text : c.type === "toolCall" ? `[call ${c.name} ${JSON.stringify(c.arguments).slice(0, 300)}]` : ""));
		out.push(`${m.role}: ${parts.filter(Boolean).join(" ").slice(0, 2000)}`);
	}
	return out.join("\n").slice(-MAX_CHARS);
}

export async function advise(o: { cwd: string; entries: any[]; model?: string; why?: string; signal?: AbortSignal }): Promise<string> {
	// lazy: agent.ts needs the pi runtime, which unit tests of transcript() do not have
	const { runAgent } = await import("./agent.ts");
	return runAgent({
		cwd: o.cwd, readOnly: true, signal: o.signal, model: advisorModel(o.cwd) ?? o.model,
		prompt: `You are an advisor. Read this session transcript and give short, concrete advice (max 8 lines). Never write code; the lead applies your advice.${o.why ? `\nWhy you were called: ${o.why}` : ""}\n\n${transcript(o.entries)}`,
	});
}
