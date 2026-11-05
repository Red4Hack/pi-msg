import { test, expect } from "bun:test";
import { transcript } from "../src/advise.ts";

test("transcript keeps roles, tool calls, and the tail", () => {
	const t = transcript([
		{ type: "message", message: { role: "user", content: "hi" } },
		{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { c: 1 } }] } },
		{ type: "other" },
	]);
	expect(t).toContain("user: hi");
	expect(t).toContain("[call bash");
	expect(transcript([{ type: "message", message: { role: "user", content: "x".repeat(500_000) } }]).length).toBeLessThan(121_000);
});
