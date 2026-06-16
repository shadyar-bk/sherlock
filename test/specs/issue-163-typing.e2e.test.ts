import { browser, expect } from "@wdio/globals"
import fs from "node:fs/promises"
import path from "node:path"
import vscode from "vscode"
import {} from "wdio-vscode-service"

const workspacePath =
	process.env.SHERLOCK_E2E_WORKSPACE ?? path.join(process.cwd(), "examples/minimal")
const enMessagesPath = path.join(workspacePath, "messages/en.json")
const originalEnMessages = {
	hello_world: "Hello world",
	welcome_user: "Welcome, {name}!",
	missing_in_german: "This message is intentionally missing in German",
}

async function resetMessages() {
	await fs.writeFile(enMessagesPath, `${JSON.stringify(originalEnMessages, undefined, "\t")}\n`)
}

async function readEnMessages() {
	return JSON.parse(await fs.readFile(enMessagesPath, "utf8")) as Record<string, string>
}

describe("Issue #163: edit view does not duplicate keystrokes", () => {
	beforeEach(async () => {
		await resetMessages()
	})

	afterEach(async () => {
		await resetMessages()
	})

	it("keeps the cursor stable while typing continuously in a translation field", async () => {
		const workbench = await browser.getWorkbench()

		await browser.executeWorkbench(async (vscodeApi: typeof vscode) => {
			const extension = vscodeApi.extensions.getExtension("inlang.vs-code-extension")
			await extension?.activate()
			await vscodeApi.commands.executeCommand("sherlock.openEditorView", {
				bundleId: "hello_world",
			})
		})

		const webview = await workbench.getWebviewByTitle("hello_world")
		await webview.open()

		const editor = await $("inlang-pattern-editor .inlang-pattern-editor-contenteditable")
		await editor.waitForDisplayed({ timeout: 30_000 })
		await expect(editor).toHaveText("Hello world")

		const expectedText = "Continuous typing should stay in order"

		await editor.click()
		await browser.keys([process.platform === "darwin" ? "Meta" : "Control", "a"])

		for (const character of expectedText) {
			await browser.keys(character)
		}

		await browser.waitUntil(async () => (await editor.getText()) === expectedText, {
			timeout: 5_000,
			timeoutMsg: "Expected edit-view typing to stay ordered without duplicated keystrokes",
		})

		await browser.keys("Tab")

		await browser.waitUntil(
			async () => {
				const messages = await readEnMessages()
				return messages.hello_world === expectedText
			},
			{
				timeout: 5_000,
				timeoutMsg: "Expected continuous edit-view typing to persist after blur",
			}
		)

		await webview.close()

		expect((await readEnMessages()).hello_world).toBe(expectedText)
	})
})
