import { browser, expect } from "@wdio/globals"
import fs from "node:fs/promises"
import path from "node:path"
import vscode from "vscode"
import {} from "wdio-vscode-service"

const workspacePath =
	process.env.SHERLOCK_E2E_WORKSPACE ?? path.join(process.cwd(), "examples/minimal")
const appPath = path.join(workspacePath, "src/app.js")
const enMessagesPath = path.join(workspacePath, "messages/en.json")
const deMessagesPath = path.join(workspacePath, "messages/de.json")

const originalApp = `export function t(key) {
\treturn key
}

console.log(t("hello_world"))
console.log(t("welcome_user"))
console.log(t("missing_in_german"))
`
const originalEnMessages = {
	hello_world: "Hello world",
	welcome_user: "Welcome, {name}!",
	missing_in_german: "This message is intentionally missing in German",
}
const originalDeMessages = {
	hello_world: "Hallo Welt",
	welcome_user: "Willkommen, {name}!",
}
const numericNestedMessages = {
	$schema: "https://inlang.com/schema/inlang-message-format",
	"1_1": "test",
	"1": { "2": "test" },
	"1.3": "test",
}

async function writeJson(filePath: string, json: unknown) {
	await fs.writeFile(filePath, `${JSON.stringify(json, undefined, "\t")}\n`)
}

async function resetFixture() {
	await fs.writeFile(appPath, originalApp)
	await writeJson(enMessagesPath, originalEnMessages)
	await writeJson(deMessagesPath, originalDeMessages)
}

async function readApp() {
	return fs.readFile(appPath, "utf8")
}

async function readEnMessages() {
	return JSON.parse(await fs.readFile(enMessagesPath, "utf8")) as Record<string, any>
}

async function activateAndReloadProject() {
	await browser.executeWorkbench(async (vscodeApi: typeof vscode) => {
		const extension = vscodeApi.extensions.getExtension("inlang.vs-code-extension")
		await extension?.activate()
		await vscodeApi.commands.executeCommand("sherlock.reloadProject")
	})
}

describe("Nested message keys", () => {
	beforeEach(async () => {
		await resetFixture()
	})

	afterEach(async () => {
		await resetFixture()
	})

	it("Issue #183: extracts dotted keys with bracket-syntax replacements", async () => {
		const selectedText = "Nested extract label"
		await fs.writeFile(
			appPath,
			`export function t(key) {
\treturn key
}

console.log("${selectedText}")
`
		)

		await activateAndReloadProject()

		await browser.executeWorkbench(
			async (vscodeApi: typeof vscode, filePath: string, textToSelect: string) => {
				const document = await vscodeApi.workspace.openTextDocument(vscodeApi.Uri.file(filePath))
				const editor = await vscodeApi.window.showTextDocument(document)
				const text = document.getText()
				const offset = text.indexOf(`"${textToSelect}"`)
				const startPosition = document.positionAt(offset)
				const endPosition = document.positionAt(offset + textToSelect.length + 2)
				editor.selection = new vscodeApi.Selection(startPosition, endPosition)
			},
			appPath,
			selectedText
		)

		await browser.executeWorkbench(async (vscodeApi: typeof vscode) => {
			void vscodeApi.commands.executeCommand("sherlock.extractMessage")
		})

		const input = await $(".quick-input-widget input")
		await input.waitForDisplayed({ timeout: 10_000 })
		await browser.execute(() => {
			;(document.querySelector(".quick-input-widget input") as HTMLInputElement | null)?.focus()
		})
		await browser.executeWorkbench(async (vscodeApi: typeof vscode) => {
			await vscodeApi.env.clipboard.writeText("test.new_key")
		})
		await browser.keys([process.platform === "darwin" ? "Meta" : "Control", "v"])
		await browser.waitUntil(async () => (await input.getValue()) === "test.new_key", {
			timeout: 5_000,
			timeoutMsg: "Expected extract-message ID input to receive the dotted key",
		})
		await browser.keys("Enter")

		await browser.waitUntil(async () => (await $$(".quick-input-list .monaco-list-row")).length > 0, {
			timeout: 10_000,
			timeoutMsg: "Expected extract-message replacement options to be shown",
		})
		await browser.keys("Enter")

		const editorText = await browser.executeWorkbench(async (vscodeApi: typeof vscode) => {
			return vscodeApi.window.activeTextEditor?.document.getText()
		})

		expect(editorText).toContain('m["test.new_key"]()')
		expect(editorText).not.toContain("m.test_new_key()")
	})

	it("Issue #192: preserves numeric and dotted JSON keys after saving", async () => {
		await writeJson(enMessagesPath, numericNestedMessages)
		await writeJson(deMessagesPath, numericNestedMessages)

		await activateAndReloadProject()

		const workbench = await browser.getWorkbench()
		await browser.executeWorkbench(async (vscodeApi: typeof vscode) => {
			await vscodeApi.commands.executeCommand("sherlock.openEditorView", {
				bundleId: "1_1",
			})
		})

		const webview = await workbench.getWebviewByTitle("1_1")
		await webview.open()

		const editor = await $("inlang-pattern-editor .inlang-pattern-editor-contenteditable")
		await editor.waitForDisplayed({ timeout: 30_000 })
		await expect(editor).toHaveText("test")

		await editor.click()
		await browser.keys([process.platform === "darwin" ? "Meta" : "Control", "a"])
		await browser.keys("test changed")
		await browser.waitUntil(async () => (await editor.getText()) === "test changed", {
			timeout: 5_000,
			timeoutMsg: "Expected numeric key editor to accept text",
		})
		await browser.keys("Tab")

		await browser.waitUntil(
			async () => {
				const messages = await readEnMessages()
				return messages["1_1"] === "test changed"
			},
			{
				timeout: 5_000,
				timeoutMsg: "Expected numeric key edit to be saved",
			}
		)

		await webview.close()

		const messages = await readEnMessages()
		expect(messages["1_1"]).toBe("test changed")
		expect(Array.isArray(messages["1"])).toBe(false)
		expect(messages["1"]).toEqual({ "2": "test" })
		expect(messages["1.3"]).toBe("test")
	})
})
