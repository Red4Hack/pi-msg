import { test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FIELDS, getValue, loadSettings, setValue } from "../src/settings-store.ts";

test("setValue writes 0600, validates threshold, empty unsets", () => {
	const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "msg-set-")), "msg.json");
	const by = (k: string) => FIELDS.find((x) => x.label === k)!;
	setValue(by("decision.baseUrl"), "http://h:1", f);
	setValue(by("decision.threshold"), "0.7", f);
	setValue(by("announce"), "true", f);
	expect(loadSettings(f)).toEqual({ decision: { baseUrl: "http://h:1", threshold: 0.7 }, announce: true });
	expect(fs.statSync(f).mode & 0o777).toBe(0o600);
	expect(() => setValue(by("decision.threshold"), "2", f)).toThrow("threshold");
	setValue(by("decision.baseUrl"), "", f);
	setValue(by("decision.threshold"), "", f);
	expect(loadSettings(f)).toEqual({ announce: true });
	expect(getValue(loadSettings(f), by("announce"))).toBe("true");
});
