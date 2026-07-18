import { expect } from "@wdio/globals"
import fs from "node:fs/promises"
import path from "node:path"
import { readEditorBundle, waitForEditorBundle } from "../helpers/editorBundle.js"
import { e2ePluginFixtureUrl } from "../helpers/pluginFixtureServer.js"
import { triggerProjectRefreshAndWait } from "../helpers/projectRefresh.js"
import { snapshotWorkspacePaths } from "../helpers/workspaceFixture.js"

const workspacePath =
	process.env.SHERLOCK_E2E_WORKSPACE ?? path.join(process.cwd(), "examples/minimal")
const settingsPath = path.join(workspacePath, "project.inlang/settings.json")
const sourcePath = path.join(workspacePath, "src/app.js")
const enResourcePath = path.join(workspacePath, "catalog/en/messages.resource.json")
const deResourcePath = path.join(workspacePath, "catalog/de/messages.resource.json")

const jsonSettings = {
	$schema: "https://inlang.com/schema/project-settings",
	baseLocale: "en",
	locales: ["en", "de"],
	modules: [e2ePluginFixtureUrl("json"), e2ePluginFixtureUrl("t-function-matcher")],
	"plugin.inlang.json": {
		pathPattern: "./catalog/{languageTag}/messages.resource.json",
		variableReferencePattern: ["{", "}"],
	},
}

async function writeJson(filePath: string, value: unknown) {
	await fs.mkdir(path.dirname(filePath), { recursive: true })
	await fs.writeFile(filePath, `${JSON.stringify(value, undefined, "\t")}\n`)
}

describe("Official JSON plugin resource watching", () => {
	let workspaceFixture: Awaited<ReturnType<typeof snapshotWorkspacePaths>> | undefined

	beforeEach(async () => {
		workspaceFixture = await snapshotWorkspacePaths([
			settingsPath,
			sourcePath,
			path.dirname(path.dirname(enResourcePath)),
		])
		await writeJson(settingsPath, jsonSettings)
		await writeJson(enResourcePath, { greeting: "JSON initial", stable: "Stable English" })
		await writeJson(deResourcePath, { greeting: "JSON Deutsch", stable: "Stabil Deutsch" })
		await fs.writeFile(
			sourcePath,
			[
				"export function t(key) {",
				"\treturn key",
				"}",
				"",
				'console.log(t("greeting"))',
				'console.log(t("stable"))',
				"",
			].join("\n")
		)
	})

	afterEach(async () => {
		await workspaceFixture?.restore()
		workspaceFixture = undefined
	})

	it("watches a non-default languageTag path whose filename does not encode the locale", async () => {
		await triggerProjectRefreshAndWait({
			settingsPath,
			sourcePath,
			operation: { type: "reload" },
		})
		expect((await readEditorBundle("greeting")).patterns).toEqual(["JSON initial", "JSON Deutsch"])

		await triggerProjectRefreshAndWait({
			settingsPath,
			sourcePath,
			operation: {
				type: "write",
				filePath: enResourcePath,
				value: { greeting: "JSON changed", stable: "Stable English" },
			},
		})
		expect((await readEditorBundle("greeting")).patterns).toEqual(["JSON changed", "JSON Deutsch"])
		expect((await readEditorBundle("stable")).patterns).toEqual([
			"Stable English",
			"Stabil Deutsch",
		])

		await triggerProjectRefreshAndWait({
			settingsPath,
			sourcePath,
			operation: { type: "delete", filePath: deResourcePath },
		})
		const deletedGerman = await waitForEditorBundle("greeting", ["JSON changed"])
		expect(deletedGerman.patterns).toEqual(["JSON changed"])
		expect(deletedGerman.text).toContain("Add de")

		await triggerProjectRefreshAndWait({
			settingsPath,
			sourcePath,
			operation: {
				type: "write",
				filePath: deResourcePath,
				value: { greeting: "JSON recreated", stable: "Stabil Deutsch" },
			},
		})
		expect((await readEditorBundle("greeting")).patterns).toEqual([
			"JSON changed",
			"JSON recreated",
		])

		await triggerProjectRefreshAndWait({
			settingsPath,
			sourcePath,
			operation: { type: "reload" },
		})
		const postReloadRefresh = await triggerProjectRefreshAndWait({
			settingsPath,
			sourcePath,
			settleDiagnosticEvents: true,
			operation: {
				type: "write",
				filePath: enResourcePath,
				value: { greeting: "JSON after reload", stable: "Stable English" },
			},
		})
		expect(postReloadRefresh.diagnosticEvents).toBe(1)
		expect((await readEditorBundle("greeting")).patterns).toEqual([
			"JSON after reload",
			"JSON recreated",
		])
	})
})
