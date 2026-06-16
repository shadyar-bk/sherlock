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

async function writeJson(filePath: string, messages: Record<string, string>) {
	await fs.writeFile(filePath, `${JSON.stringify(messages, undefined, "\t")}\n`)
}

async function resetMessages() {
	await writeJson(enMessagesPath, originalEnMessages)
	await writeJson(deMessagesPath, originalDeMessages)
}

async function readEnMessages() {
	return JSON.parse(await fs.readFile(enMessagesPath, "utf8")) as Record<string, string>
}

async function readDeMessages() {
	return JSON.parse(await fs.readFile(deMessagesPath, "utf8")) as Record<string, string>
}

async function activateAndReloadProject() {
	await browser.executeWorkbench(async (vscodeApi: typeof vscode) => {
		const extension = vscodeApi.extensions.getExtension("inlang.vs-code-extension")
		await extension?.activate()
		await vscodeApi.commands.executeCommand("sherlock.reloadProject")
	})
}

describe("Issue #186: deleted translations stay deleted", () => {
	beforeEach(async () => {
		await resetMessages()
	})

	afterEach(async () => {
		await resetMessages()
	})

	it("does not restore a manually deleted message key on the next Sherlock save", async () => {
		const workbench = await browser.getWorkbench()

		await activateAndReloadProject()

		const messagesAfterDelete = { ...originalEnMessages }
		delete messagesAfterDelete.missing_in_german
		await writeJson(enMessagesPath, messagesAfterDelete)

		await browser.waitUntil(async () => !("missing_in_german" in (await readEnMessages())), {
			timeout: 5_000,
			timeoutMsg: "Expected the manually deleted key to be absent from messages/en.json",
		})
		await browser.pause(1500)

		await browser.executeWorkbench(async (vscodeApi: typeof vscode) => {
			await vscodeApi.commands.executeCommand("sherlock.openEditorView", {
				bundleId: "hello_world",
			})
		})

		const webview = await workbench.getWebviewByTitle("hello_world")
		await webview.open()

		const editor = await $("inlang-pattern-editor .inlang-pattern-editor-contenteditable")
		await editor.waitForDisplayed({ timeout: 30_000 })
		await expect(editor).toHaveText("Hello world")

		await editor.click()
		await browser.keys([process.platform === "darwin" ? "Meta" : "Control", "a"])
		await browser.keys("Hello after deletion")
		await browser.waitUntil(async () => (await editor.getText()) === "Hello after deletion", {
			timeout: 5_000,
			timeoutMsg: "Expected unrelated edit-view text change to apply",
		})
		await browser.keys("Tab")

		await browser.waitUntil(
			async () => {
				const messages = await readEnMessages()
				return messages.hello_world === "Hello after deletion"
			},
			{
				timeout: 5_000,
				timeoutMsg: "Expected the unrelated edit-view change to be saved",
			}
		)

		await webview.close()

		const messages = await readEnMessages()
		expect(messages.hello_world).toBe("Hello after deletion")
		expect(messages).not.toHaveProperty("missing_in_german")
	})

	it("does not restore a manually deleted target-locale translation on the next Sherlock save", async () => {
		const workbench = await browser.getWorkbench()

		await activateAndReloadProject()

		const germanMessagesAfterDelete = { ...originalDeMessages }
		delete germanMessagesAfterDelete.welcome_user
		await writeJson(deMessagesPath, germanMessagesAfterDelete)

		await browser.waitUntil(async () => !("welcome_user" in (await readDeMessages())), {
			timeout: 5_000,
			timeoutMsg: "Expected the manually deleted German key to be absent from messages/de.json",
		})

		await browser.executeWorkbench(async (vscodeApi: typeof vscode) => {
			await vscodeApi.commands.executeCommand("sherlock.openEditorView", {
				bundleId: "hello_world",
			})
		})

		const webview = await workbench.getWebviewByTitle("hello_world")
		await webview.open()

		const editor = await $("inlang-pattern-editor .inlang-pattern-editor-contenteditable")
		await editor.waitForDisplayed({ timeout: 30_000 })
		await expect(editor).toHaveText("Hello world")

		await editor.click()
		await browser.keys([process.platform === "darwin" ? "Meta" : "Control", "a"])
		await browser.keys("Hello after German deletion")
		await browser.waitUntil(async () => (await editor.getText()) === "Hello after German deletion", {
			timeout: 5_000,
			timeoutMsg: "Expected unrelated edit-view text change to apply",
		})
		await browser.keys("Tab")

		await browser.waitUntil(
			async () => {
				const messages = await readEnMessages()
				return messages.hello_world === "Hello after German deletion"
			},
			{
				timeout: 5_000,
				timeoutMsg: "Expected the unrelated edit-view change to be saved",
			}
		)

		await webview.close()

		const germanMessages = await readDeMessages()
		expect(germanMessages.hello_world).toBe("Hallo Welt")
		expect(germanMessages).not.toHaveProperty("welcome_user")
	})
})
