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
const resourcesPath = path.join(workspacePath, "resources")
const enCommonPath = path.join(resourcesPath, "en/common.json")
const enVitalPath = path.join(resourcesPath, "en/vital.json")
const deCommonPath = path.join(resourcesPath, "de/common.json")
const deVitalPath = path.join(resourcesPath, "de/vital.json")

const i18nextSettings = {
	$schema: "https://inlang.com/schema/project-settings",
	baseLocale: "en",
	locales: ["en", "de"],
	modules: [e2ePluginFixtureUrl("i18next"), e2ePluginFixtureUrl("t-function-matcher")],
	"plugin.inlang.i18next": {
		pathPattern: {
			common: "./resources/{locale}/common.json",
			vital: "./resources/{locale}/vital.json",
		},
	},
}

async function writeJson(filePath: string, value: unknown) {
	await fs.mkdir(path.dirname(filePath), { recursive: true })
	await fs.writeFile(filePath, `${JSON.stringify(value, undefined, "\t")}\n`)
}

async function resetI18nextFixture() {
	await writeJson(settingsPath, i18nextSettings)
	await writeJson(enCommonPath, { greeting: "Common initial" })
	await writeJson(deCommonPath, { greeting: "Gemeinsam initial" })
	await writeJson(enVitalPath, { health: "Vital initial" })
	await writeJson(deVitalPath, { health: "Vital Deutsch" })
	await fs.writeFile(
		sourcePath,
		[
			"export function t(key) {",
			"\treturn key",
			"}",
			"",
			'console.log(t("common:greeting"))',
			'console.log(t("vital:health"))',
			"",
		].join("\n")
	)
}

describe("Plugin-owned resource watching", () => {
	let workspaceFixture: Awaited<ReturnType<typeof snapshotWorkspacePaths>> | undefined

	beforeEach(async () => {
		workspaceFixture = await snapshotWorkspacePaths([settingsPath, sourcePath, resourcesPath])
		await resetI18nextFixture()
	})

	afterEach(async () => {
		await workspaceFixture?.restore()
		workspaceFixture = undefined
	})

	it("watches official i18next locale and namespace resources across change, delete, and create", async () => {
		await triggerProjectRefreshAndWait({
			settingsPath,
			sourcePath,
			operation: { type: "reload" },
		})
		expect((await readEditorBundle("common:greeting")).patterns).toEqual([
			"Common initial",
			"Gemeinsam initial",
		])
		expect((await readEditorBundle("vital:health")).patterns).toEqual([
			"Vital initial",
			"Vital Deutsch",
		])

		await triggerProjectRefreshAndWait({
			settingsPath,
			sourcePath,
			operation: { type: "write", filePath: enCommonPath, value: { greeting: "Common changed" } },
		})
		expect((await readEditorBundle("common:greeting")).patterns).toEqual([
			"Common changed",
			"Gemeinsam initial",
		])
		expect((await readEditorBundle("vital:health")).patterns).toEqual([
			"Vital initial",
			"Vital Deutsch",
		])

		await triggerProjectRefreshAndWait({
			settingsPath,
			sourcePath,
			operation: { type: "delete", filePath: enCommonPath },
		})
		const deletedCommon = await waitForEditorBundle("common:greeting", ["Gemeinsam initial"])
		expect(deletedCommon.patterns).toEqual(["Gemeinsam initial"])
		expect(deletedCommon.text).toContain("Add en")

		await triggerProjectRefreshAndWait({
			settingsPath,
			sourcePath,
			operation: { type: "write", filePath: enCommonPath, value: { greeting: "Common recreated" } },
		})
		await waitForEditorBundle("common:greeting", ["Common recreated", "Gemeinsam initial"])

		await triggerProjectRefreshAndWait({
			settingsPath,
			sourcePath,
			operation: { type: "write", filePath: enVitalPath, value: { health: "Vital changed" } },
		})
		expect((await readEditorBundle("vital:health")).patterns).toEqual([
			"Vital changed",
			"Vital Deutsch",
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
			operation: { type: "write", filePath: enVitalPath, value: { health: "Vital after reload" } },
		})
		expect(postReloadRefresh.diagnosticEvents).toBe(1)
		expect((await readEditorBundle("vital:health")).patterns).toEqual([
			"Vital after reload",
			"Vital Deutsch",
		])
		expect((await readEditorBundle("common:greeting")).patterns).toEqual([
			"Common recreated",
			"Gemeinsam initial",
		])
	})
})
