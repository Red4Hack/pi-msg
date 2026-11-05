import { test, expect } from "bun:test";
import { decide } from "../src/decision.ts";

let body: any;
const serve = (q1: any) =>
	Bun.serve({ port: 0, async fetch(r) { body = await r.json(); return Response.json({ answers: { q1 } }); } });

test("sharp → code; request uses criteria", async () => {
	const s = serve({ choice: "edit", probabilities: { "run tests": 0.04, edit: 0.94 } });
	const d = await decide({ baseUrl: `http://localhost:${s.port}` }, "which tool?", ["run tests", "edit"]);
	expect(d).toEqual({ choice: "edit", p: 0.94, route: "code" });
	expect(body.questions.q1.criteria).toEqual({ "run tests": "run tests", edit: "edit" });
	s.stop();
});

test("split → lead; invalid choice → error", async () => {
	let s = serve({ choice: "x", probabilities: { x: 0.5, y: 0.5 } });
	expect((await decide({ baseUrl: `http://localhost:${s.port}` }, "q", ["x", "y"])).route).toBe("lead");
	s.stop();
	s = serve({ choice: "zzz", probabilities: {} });
	await expect(decide({ baseUrl: `http://localhost:${s.port}` }, "q", ["x", "y"])).rejects.toThrow("no valid choice");
	s.stop();
});

test("openai-logprobs adapter + unknown api", async () => {
	const s = Bun.serve({ port: 0, fetch: () => Response.json({ choices: [{ logprobs: { content: [{ top_logprobs: [{ token: "B", logprob: Math.log(0.9) }, { token: " A", logprob: Math.log(0.05) }, { token: "the", logprob: -1 }] }] } }] }) });
	const cfg = { baseUrl: `http://localhost:${s.port}`, api: "openai-logprobs" as const };
	const d = await decide(cfg, "q", ["x", "y"]);
	expect(d.choice).toBe("y");
	expect(d.p).toBeCloseTo(0.9 / 0.95, 3);
	expect(d.route).toBe("code");
	await expect(decide({ ...cfg, api: "nope" as any }, "q", ["x", "y"])).rejects.toThrow("unknown");
	s.stop();
});

test("truncated state → lead", async () => {
	const s = Bun.serve({ port: 0, fetch: () => Response.json({ answers: { q1: { choice: "x", probabilities: { x: 0.99, y: 0.01 } } }, usage: { truncated: true } }) });
	expect((await decide({ baseUrl: `http://localhost:${s.port}` }, "q", ["x", "y"])).route).toBe("lead");
	s.stop();
});
