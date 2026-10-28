// Compact skill index for the planner (zero tokens until the worker reads it).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const meta = (f: string) => {
	try {
		const t = fs.readFileSync(f, "utf8");
		const g = (k: string) => t.match(new RegExp(`^${k}:\\s*(.+)$`, "m"))?.[1]?.trim();
		return { name: g("name") ?? path.basename(path.dirname(f)), description: g("description") ?? "", file: f };
	} catch {}
};

export function skillIndex(cwd: string): string {
	const out: string[] = [];
	const user = path.join(os.homedir(), ".pi", "agent", "skills");
	const proj = path.join(cwd, ".pi", "msg", "skills");
	const ls = (d: string) => (fs.existsSync(d) ? fs.readdirSync(d) : []);
	for (const n of ls(user)) out.push(meta(path.join(user, n, "SKILL.md"))!);
	for (const n of ls(proj).filter((n) => n.endsWith(".md"))) out.push(meta(path.join(proj, n))!);
	return out.filter(Boolean).map((s) => `- ${s.name}: ${s.description.slice(0, 120)} (${s.file})`).join("\n");
}
