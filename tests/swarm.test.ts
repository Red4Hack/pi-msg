// 3 tasks, 2 workers: each worker claims one task at a time; no task runs twice.
import { test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBus } from "../src/bus.ts";

test("2 workers share 3 tasks via claim", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "msg-swarm-"));
	const bus = createBus(cwd);
	const tasks = ["t1", "t2", "t3"];
	const ran: Record<string, string[]> = {};
	const worker = async () => {
		const me = bus.join({}).name;
		for (;;) {
			const done = bus.completed();
			const t = tasks.find((x) => !done.has(x) && bus.claim(me, x).ok);
			if (!t) break;
			(ran[t] ??= []).push(me);
			await new Promise((r) => setTimeout(r, 50)); // simulated work
			bus.complete(me, t, "ok");
		}
		bus.leave(me);
		return me;
	};
	const [a, b] = await Promise.all([worker(), worker()]);
	for (const t of tasks) expect(ran[t]?.length).toBe(1); // exactly one owner each
	expect(bus.completed().size).toBe(3);
	expect(new Set(Object.values(ran).flat())).toEqual(new Set([a, b])); // both workers took part
	fs.rmSync(cwd, { recursive: true, force: true });
});
