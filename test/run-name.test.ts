import assert from "node:assert/strict";
import { test } from "node:test";
import { runName } from "../src/roles.ts";

test("run name: role without repo prefix and the task's first line", () => {
	assert.equal(runName("pi-web/pi-web-developer", "  Round-2 UI fixes in pi-web\n\nDetails..."), "pi-web-developer: Round-2 UI fixes in pi-web");
});

test("run name: long first line is cut on a word boundary", () => {
	const name = runName("r/dev", "Fix the sidebar so that every role run shows a useful title instead of the boilerplate preamble");
	assert.equal(name, "dev: Fix the sidebar so that every role run shows a useful title…");
	assert.ok(name.length <= "dev: ".length + 61);
});

test("run name: one long word is cut hard", () => {
	assert.equal(runName("r/dev", "x".repeat(80)), `dev: ${"x".repeat(60)}…`);
});

test("run name: empty task is just the role", () => {
	assert.equal(runName("pi-web/pi-web-developer", " \n "), "pi-web-developer");
});
