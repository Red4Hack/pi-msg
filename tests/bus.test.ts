import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBus, type Bus } from "../src/bus.ts";
import { makeGuard, sweepStuck, STUCK_MS } from "../src/presence.ts";

let cwd: string;
let bus: Bus;
beforeEach(() => { cwd = fs.mkdtempSync(path.join(os.tmpdir(), "msg-bus-")); bus = createBus(cwd); });
afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }));

test("registry: unique names, dead pids are dropped", () => {
	const names = new Set(Array.from({ length: 30 }, () => bus.join({}).name));
	expect(names.size).toBe(30);
	const f = path.join(cwd, ".pi/msg/registry/Ghost.json");
	fs.writeFileSync(f, JSON.stringify({ name: "Ghost", pid: 2 ** 22 + 12345, status: "active", tools: 0, tokens: 0 }));
	expect(bus.agents().some((a) => a.name === "Ghost")).toBe(false);
	expect(fs.existsSync(f)).toBe(false);
});

test("inbox: direct, order, drain empties, unknown throws", () => {
	const a = bus.join({}).name, b = bus.join({}).name;
	for (let i = 0; i < 20; i++) bus.send(a, b, `m${i}`);
	expect(bus.drain(b).map((m) => m.text)).toEqual(Array.from({ length: 20 }, (_, i) => `m${i}`));
	expect(bus.drain(b)).toEqual([]);
	expect(() => bus.send(a, "Nobody", "x")).toThrow();
});

test("broadcast: worker skips humans and self; human reaches everyone", () => {
	const h = bus.join({ human: true }).name, w1 = bus.join({}).name, w2 = bus.join({}).name;
	expect(bus.send(w1, "all", "hey")).toBe(1);
	expect(bus.drain(w2).length).toBe(1);
	expect(bus.drain(h).length).toBe(0);
	expect(bus.send(h, "all", "yo")).toBe(2);
});

test("leave clears inbox, reservations and claims", () => {
	const a = bus.join({}).name;
	bus.reserve(a, ["x.ts"]); bus.claim(a, "t1");
	bus.leave(a);
	expect(bus.claims()).toEqual([]);
	expect(Object.keys(bus.reservations())).toEqual([]);
});

test("reservations: conflicts, overlap, glob, release", () => {
	const a = bus.join({}).name, b = bus.join({}).name;
	expect(bus.reserve(a, ["src/**"]).ok).toBe(true);
	expect(bus.reserve(b, ["src/a.ts"]).ok).toBe(false);
	expect(bus.reserve(b, ["src"]).ok).toBe(false);
	expect(bus.reserve(a, ["src/a.ts"]).ok).toBe(true);
	expect(bus.reserve(b, ["srcother/x.ts"]).ok).toBe(true); // prefix of name is not a path overlap
	expect(bus.blocker(b, "src/deep/z.ts")?.owner).toBe(a);
	bus.release(a);
	expect(bus.reserve(b, ["src/a.ts"]).ok).toBe(true);
});

test("reservation of a dead owner is dropped", () => {
	const b = bus.join({}).name;
	fs.writeFileSync(path.join(cwd, ".pi/msg/reservations.json"), JSON.stringify({ [path.join(cwd, "f.ts")]: { owner: "Dead", since: 1 } }));
	expect(bus.reserve(b, ["f.ts"]).ok).toBe(true);
});

test("claims: exclusive, one open per owner, not after complete, steal from stuck", () => {
	const a = bus.join({}).name, b = bus.join({}).name;
	expect(bus.claim(a, "t1").ok).toBe(true);
	expect(bus.claim(b, "t1").ok).toBe(false);
	expect(bus.claim(a, "t2").ok).toBe(false);
	bus.update(a, { status: "stuck" });
	expect(bus.claim(b, "t1").ok).toBe(true);
	bus.complete(b, "t1", "done");
	expect(bus.claim(a, "t1").reason).toBe("already completed");
	bus.reopen("t1");
	expect(bus.claim(a, "t1").ok).toBe(true);
});

test("claim ids with ':' and '/' round-trip", () => {
	const a = bus.join({}).name;
	bus.claim(a, "run:1/t:1"); bus.complete(a, "run:1/t:1");
	expect(bus.completed().has("run:1/t:1")).toBe(true);
});

test("feed: recent(n) limits, n=0 is empty", () => {
	for (let i = 0; i < 5; i++) bus.feed({ who: "a", kind: "k", text: `${i}` });
	expect(bus.recent(2).map((e) => e.text)).toEqual(["3", "4"]);
	expect(bus.recent(0)).toEqual([]);
});

test("runs: save/load/latest", () => {
	expect(bus.latestRun()).toBeNull();
	bus.saveRun({ id: "20260101000000", created: 1, tasks: [] });
	bus.saveRun({ id: "20260102000000", created: 2, tasks: [] });
	expect(bus.latestRun()?.id).toBe("20260102000000");
});

test("guard: blocks writes to others' files, allows own, tracks tests", () => {
	const a = bus.join({}).name, b = bus.join({}).name;
	bus.reserve(a, ["src/a.ts"]);
	const g = makeGuard(bus, b);
	expect(g.call({ toolName: "edit", input: { path: "src/a.ts" } })?.block).toBe(true);
	expect(g.call({ toolName: "bash", input: { command: "echo x > src/a.ts" } })?.block).toBe(true);
	expect(g.call({ toolName: "bash", input: { command: "cat src/a.ts 2>&1" } })).toBeUndefined();
	expect(g.call({ toolName: "edit", input: { path: "src/b.ts" } })).toBeUndefined();
	g.result({ toolName: "bash", input: { command: "bun test" }, isError: true });
	expect(bus.agents().find((x) => x.name === b)?.note).toBe("debugging…");
});

test("sweepStuck marks only idle agents with work", () => {
	const a = bus.join({}).name, b = bus.join({}).name;
	bus.update(a, { task: "t1" });
	const later = Date.now() + STUCK_MS + 1000;
	expect(sweepStuck(bus, later)).toEqual([a]);
	expect(sweepStuck(bus, later)).toEqual([]);
	expect(bus.agents().find((x) => x.name === b)?.status).toBe("active");
});

test("findRun picks the run that owns the task, not the newest", () => {
	bus.saveRun({ id: "20260101000000", created: 1, tasks: [{ id: "s1", title: "", prompt: "", deps: [], files: [], status: "pending" }] });
	bus.saveRun({ id: "20260102000000", created: 2, tasks: [] });
	expect(bus.findRun("s1")?.id).toBe("20260101000000");
	expect(bus.findRun("nope")).toBeNull();
});
