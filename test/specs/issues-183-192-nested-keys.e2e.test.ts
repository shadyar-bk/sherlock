import { browser, expect } from "@wdio/globals"
import fs from "node:fs/promises"
import path from "node:path"
import vscode from "vscode"
import {} from "wdio-vscode-service"

const workspacePath =
	process.env.SHERLOCK_E2E_WORKSPACE ?? path.join(process.cwd(), "examples/minimal")
const enMessagesPath = path.join(workspacePath, "messages/en.json")
const deMessagesPath = path.join(workspacePath, "messages/de.json")

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
	await writeJson(enMessagesPath, originalEnMessages)
	await writeJson(deMessagesPath, originalDeMessages)
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

	it("does not restore a deleted explicit dotted key on the next save", async () => {
		await writeJson(enMessagesPath, numericNestedMessages)
		await writeJson(deMessagesPath, numericNestedMessages)

		await activateAndReloadProject()

		const messagesAfterDelete = { ...numericNestedMessages }
		delete messagesAfterDelete["1.3"]
		await writeJson(enMessagesPath, messagesAfterDelete)
		await writeJson(deMessagesPath, messagesAfterDelete)
		await browser.pause(1500)

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
		await browser.keys("test after dotted delete")
		await browser.waitUntil(async () => (await editor.getText()) === "test after dotted delete", {
			timeout: 5_000,
			timeoutMsg: "Expected numeric key editor to accept text",
		})
		await browser.keys("Tab")

		await browser.waitUntil(
			async () => {
				const messages = await readEnMessages()
				return messages["1_1"] === "test after dotted delete"
			},
			{
				timeout: 5_000,
				timeoutMsg: "Expected numeric key edit to be saved",
			}
		)

		await webview.close()

		const messages = await readEnMessages()
		expect(messages["1_1"]).toBe("test after dotted delete")
		expect(messages["1"]).toEqual({ "2": "test" })
		expect(messages["1.3"]).toBeUndefined()
	})
})
