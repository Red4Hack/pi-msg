import { expect, test } from "bun:test";
import { fixAction } from "../src/actions.ts";

test("guessed action names map to the real ones; unknown ones are left to fail", () => {
	expect(fixAction("models")).toBe("models");
	expect(fixAction("list_models")).toBe("models");
	expect(fixAction("get_status")).toBe("status");
	expect(fixAction("team_save")).toBe("team.save");
	expect(fixAction("list")).toBe("list");
	expect(fixAction("nope")).toBe("nope");
});
