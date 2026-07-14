import { existsSync } from "node:fs"
import { describe, expect, it } from "vitest"
import packageJson from "../package.json"

it("should have matching engine and dependency versions", () => {
	expect(packageJson.engines.vscode.replace(/^\^/, "")).toBe(
		packageJson.devDependencies["@types/vscode"]
	)
})

describe("production build", () => {
	it.each(["lit-html.js", "settings-component.js"])(
		"includes the %s settings dependency",
		(fileName) => {
			expect(existsSync(new URL(`../assets/${fileName}`, import.meta.url))).toBe(true)
		}
	)
})
