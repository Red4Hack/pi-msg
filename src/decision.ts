// Decision layer: a decision model (llama-server /v1/systemone, no text generation) answers "which file/tool/retry or stop".
// p = probability of the chosen option. sharp (p >= threshold) → code, split → lead.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface DecisionCfg {
	baseUrl: string;
	model?: string;
	apiKey?: string;
	threshold?: number;
	/** wire format: systemone (decision model, default) | openai-logprobs (any chat model) */
	api?: "systemone" | "openai-logprobs";
}
export interface Decision {
	choice: string;
	p: number;
	route: "code" | "lead";
}

const DEFAULT_MODEL = "ggml-org/Julia-1-GGUF:BF16";

/** {"decision": {"baseUrl", "model", "threshold", "api"}} in .pi/msg/config.json or ~/.pi/agent/msg.json; baseUrl falls back to $LLAMA_SERVER_URL. No baseUrl = layer off. */
export function decisionCfg(cwd: string): DecisionCfg | undefined {
	let d: any = {};
	for (const f of [path.join(os.homedir(), ".pi", "agent", "msg.json")]) {
		try {
			d = JSON.parse(fs.readFileSync(f, "utf8")).decision ?? {};
			if (d.baseUrl) break;
		} catch {}
	}
	const baseUrl = d.baseUrl ?? process.env.LLAMA_SERVER_URL;
	return baseUrl ? { ...d, baseUrl, model: d.model ?? DEFAULT_MODEL } : undefined;
}

type Pick = { choice: string; p: number };
type Adapter = (cfg: DecisionCfg, question: string, options: string[], state: string | undefined, signal?: AbortSignal) => Promise<Pick>;

const post = async (cfg: DecisionCfg, route: string, body: unknown, signal?: AbortSignal): Promise<any> => {
	const res = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}${route}`, {
		method: "POST",
		signal,
		headers: { "content-type": "application/json", ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
		body: JSON.stringify(body),
	});
	if (!res.ok) throw new Error(`decision backend ${res.status}: ${(await res.text()).slice(0, 200)}`);
	return res.json();
};

const systemone: Adapter = async (cfg, question, options, state, signal) => {
	const j = await post(cfg, "/v1/systemone", {
		model: cfg.model ?? DEFAULT_MODEL,
		state: state ?? question,
		questions: { q1: { type: "choice", instructions: question, criteria: Object.fromEntries(options.map((o) => [o, o])) } },
	}, signal);
	const a = j.answers?.q1;
	const p = a?.probabilities?.[a?.choice];
	if (!options.includes(a?.choice) || typeof p !== "number") throw new Error("decision backend returned no valid choice");
	// truncated input = the model did not read the whole state, so never call it sharp
	return { choice: a.choice, p: j.usage?.truncated ? 0 : p };
};

// Any OpenAI-compatible chat model: p = share of first-token probability on the option letters.
// shortcut: max_tokens=1, so a model that thinks before answering needs thinking disabled server-side
const openaiLogprobs: Adapter = async (cfg, question, options, state, signal) => {
	const letters = options.map((_, i) => String.fromCharCode(65 + i));
	const prompt = `${state ? `${state}\n\n` : ""}${question}\n${options.map((o, i) => `${letters[i]}) ${o}`).join("\n")}\nAnswer with the single letter of the best option.`;
	const j = await post(cfg, "/v1/chat/completions", { model: cfg.model, messages: [{ role: "user", content: prompt }], max_tokens: 1, temperature: 0, logprobs: true, top_logprobs: 20 }, signal);
	const mass = new Map<string, number>();
	for (const t of j.choices?.[0]?.logprobs?.content?.[0]?.top_logprobs ?? []) {
		const l = String(t.token).trim().toUpperCase();
		if (letters.includes(l)) mass.set(l, (mass.get(l) ?? 0) + Math.exp(t.logprob));
	}
	const total = [...mass.values()].reduce((x, y) => x + y, 0);
	if (!total) throw new Error("decision backend returned no logprobs for the options");
	const [best, m] = [...mass.entries()].sort((x, y) => y[1] - x[1])[0];
	return { choice: options[letters.indexOf(best)], p: m / total };
};

const ADAPTERS: Record<string, Adapter> = { systemone, "openai-logprobs": openaiLogprobs };

export async function decide(cfg: DecisionCfg, question: string, options: string[], signal?: AbortSignal, state?: string): Promise<Decision> {
	if (options.length < 2 || options.length > 20) throw new Error("decide: need 2-20 options");
	const ad = ADAPTERS[cfg.api ?? "systemone"];
	if (!ad) throw new Error(`decision.api "${cfg.api}" unknown. Valid: ${Object.keys(ADAPTERS).join(", ")}`);
	const { choice, p } = await ad(cfg, question, options, state, signal);
	return { choice, p, route: p >= (cfg.threshold ?? 0.8) ? "code" : "lead" };
}
