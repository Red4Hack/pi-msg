import { test, expect } from "bun:test";
import { report } from "../src/run.ts";
import type { Run } from "../src/bus.ts";

const run = (result: string): Run => ({
	id: "r1",
	created: 0,
	tasks: [{ id: "t1", title: "x", prompt: "x", deps: [], files: [], status: "done", result }],
});

test("report caps task results at 400 chars by default, Infinity returns all", () => {
	const long = "a".repeat(1000);
	expect(report(run(long))).toContain("a".repeat(400));
	expect(report(run(long))).not.toContain("a".repeat(401));
	expect(report(run(long), Infinity)).toContain("a".repeat(1000));
});
