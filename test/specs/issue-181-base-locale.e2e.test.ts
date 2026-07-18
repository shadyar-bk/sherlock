import { browser, expect } from "@wdio/globals"
import fs from "node:fs/promises"
import path from "node:path"
import vscode from "vscode"
import {} from "wdio-vscode-service"
import { e2ePluginFixtureUrl } from "../helpers/pluginFixtureServer.js"

const workspacePath =
	process.env.SHERLOCK_E2E_WORKSPACE ?? path.join(process.cwd(), "examples/minimal")
const settingsPath = path.join(workspacePath, "project.inlang/settings.json")
const enMessagesPath = path.join(workspacePath, "messages/en.json")
const deMessagesPath = path.join(workspacePath, "messages/de.json")

const originalSettings = {
	$schema: "https://inlang.com/schema/project-settings",
	baseLocale: "en",
	locales: ["en", "de"],
	modules: [e2ePluginFixtureUrl("json"), e2ePluginFixtureUrl("t-function-matcher")],
	"plugin.inlang.json": {
		pathPattern: "./messages/{languageTag}.json",
		variableReferencePattern: ["{", "}"],
	},
}
const germanBaseSettings = {
	...originalSettings,
	baseLocale: "de",
	locales: ["de", "en"],
}
const originalEnMessages = {
	hello_world: "Hello world",
	welcome_user: "Welcome, {name}!",
	missing_in_german: "This message is intentionally missing in German",
}
const originalDeMessages = {
	hello_world: "Hallo Welt",
	welcome_user: "Willkommen, {name}!",
}

async function writeJson(filePath: string, json: unknown) {
	await fs.writeFile(filePath, `${JSON.stringify(json, undefined, "\t")}\n`)
}

async function resetFixture(settings = originalSettings) {
	await writeJson(settingsPath, settings)
	await writeJson(enMessagesPath, originalEnMessages)
	await writeJson(deMessagesPath, originalDeMessages)
}

async function readSettings() {
	return JSON.parse(await fs.readFile(settingsPath, "utf8")) as typeof originalSettings
}

async function readDeMessages() {
	return JSON.parse(await fs.readFile(deMessagesPath, "utf8")) as Record<string, string>
}

describe("Issue #181: Sherlock preserves non-English baseLocale", () => {
	beforeEach(async () => {
		await resetFixture(germanBaseSettings)
	})

	afterEach(async () => {
		await resetFixture()
	})

	it("does not rewrite baseLocale to en when saving a translation", async () => {
		const workbench = await browser.getWorkbench()

		await browser.executeWorkbench(async (vscodeApi: typeof vscode) => {
			const extension = vscodeApi.extensions.getExtension("inlang.vs-code-extension")
			await extension?.activate()
			await vscodeApi.commands.executeCommand("sherlock.reloadProject")
			await vscodeApi.commands.executeCommand("sherlock.openEditorView", {
				bundleId: "hello_world",
			})
		})

		const webview = await workbench.getWebviewByTitle("hello_world")
		await webview.open()

		const editor = await $("inlang-pattern-editor .inlang-pattern-editor-contenteditable")
		await editor.waitForDisplayed({ timeout: 30_000 })
		await expect(editor).toHaveText("Hallo Welt")

		await editor.click()
		await browser.keys([process.platform === "darwin" ? "Meta" : "Control", "a"])
		await browser.keys("Hallo Basis")
		await browser.waitUntil(async () => (await editor.getText()) === "Hallo Basis", {
			timeout: 5_000,
			timeoutMsg: "Expected the German base-locale editor to accept text",
		})
		await browser.keys("Tab")

		await browser.waitUntil(
			async () => {
				const messages = await readDeMessages()
				return messages.hello_world === "Hallo Basis"
			},
			{
				timeout: 5_000,
				timeoutMsg: "Expected the German base-locale edit to be saved",
			}
		)

		await webview.close()

		const settings = await readSettings()
		expect(settings.baseLocale).toBe("de")
		expect(settings.locales).toEqual(["de", "en"])
	})
})
