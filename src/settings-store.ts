// Settings store: decision/advisor/announce in ~/.pi/agent/msg.json (user-only file, 0600). No TUI imports, so it is unit-testable.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const settingsFile = () => path.join(os.homedir(), ".pi", "agent", "msg.json");

export interface Field {
	group?: "decision" | "advisor";
	key: string;
	label: string;
	options?: string[]; // cycled with Enter; "" = unset
	secret?: boolean;
	threshold?: boolean;
	/** shown dimmed when unset: what msg actually uses */
	auto?: () => string;
	/** one-line explanation shown for the selected field */
	help?: string;
}
export const FIELDS: Field[] = [
	{ group: "decision", key: "baseUrl", label: "decision.baseUrl", help: "Decision server (llama-server, Jev, Laya). Empty = $LLAMA_SERVER_URL; none = layer off.", auto: () => process.env.LLAMA_SERVER_URL ?? "off (layer disabled)" },
	{ group: "decision", key: "model", label: "decision.model", help: "Model id sent to the server.", auto: () => "ggml-org/Julia-1-GGUF:BF16" },
	{ group: "decision", key: "api", label: "decision.api", help: "Wire format: systemone (decision models) or openai-logprobs (any chat model).", options: ["", "systemone", "openai-logprobs"], auto: () => "systemone" },
	{ group: "decision", key: "threshold", label: "decision.threshold", help: "p >= threshold = sharp (runs in code); below = split (goes to the lead). 0..1.", threshold: true, auto: () => "0.8" },
	{ group: "decision", key: "apiKey", label: "decision.apiKey", help: "Bearer token for hosted backends. Stored in msg.json (0600).", secret: true },
	{ group: "advisor", key: "model", label: "advisor.model", help: "Model for advise (read-only). Empty = session model.", auto: () => "session model" },
	{ key: "announce", label: "announce", help: "Post full run results in chat instead of a one-line notice.", options: ["", "true", "false"], auto: () => "false" },
];

export const loadSettings = (file = settingsFile()): any => {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return {};
	}
};
export const getValue = (cfg: any, f: Field): string => {
	const v = (f.group ? cfg[f.group] : cfg)?.[f.key];
	return v === undefined ? "" : String(v);
};

/** Empty string removes the key. Throws on an invalid threshold. */
export function setValue(f: Field, raw: string, file = settingsFile()) {
	const cfg = loadSettings(file);
	const t = f.group ? (cfg[f.group] ??= {}) : cfg;
	if (raw === "") delete t[f.key];
	else if (f.threshold) {
		const n = Number(raw);
		if (!(n >= 0 && n <= 1)) throw new Error("threshold must be between 0 and 1");
		t[f.key] = n;
	} else t[f.key] = f.key === "announce" ? raw === "true" : raw;
	if (f.group && !Object.keys(t).length) delete cfg[f.group];
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString("hex")}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
	fs.renameSync(tmp, file);
}

