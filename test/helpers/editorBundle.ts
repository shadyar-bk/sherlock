import { browser } from "@wdio/globals"
import vscode from "vscode"
import {} from "wdio-vscode-service"

export async function readEditorBundle(bundleId: string) {
	const workbench = await browser.getWorkbench()
	await browser.executeWorkbench(async (vscodeApi: typeof vscode, id: string) => {
		await vscodeApi.commands.executeCommand("sherlock.openEditorView", { bundleId: id })
	}, bundleId)
	let webview: Awaited<ReturnType<typeof workbench.getWebviewByTitle>> | undefined
	try {
		webview = await workbench.getWebviewByTitle(bundleId)
		await webview.open()
		const firstEditor = await $("inlang-pattern-editor .inlang-pattern-editor-contenteditable")
		await firstEditor.waitForDisplayed({ timeout: 30_000 })
		const editors = await $$("inlang-pattern-editor .inlang-pattern-editor-contenteditable")
		const patterns: string[] = []
		for (let index = 0; index < editors.length; index += 1) {
			patterns.push(await editors[index]!.getText())
		}
		return {
			patterns,
			text: await $("body").getText(),
		}
	} finally {
		await webview?.close().catch(() => undefined)
		// A departing webview can detach before close() switches both nested frames. Repeating the
		// top-level switch is safe and lets the next public-view poll start from the workbench again.
		await browser.switchToFrame(null).catch(() => undefined)
		await browser.switchToFrame(null).catch(() => undefined)
		await browser.executeWorkbench(async (vscodeApi: typeof vscode) => {
			await vscodeApi.commands.executeCommand("workbench.action.closeActiveEditor")
		})
	}
}

export async function waitForEditorBundle(bundleId: string, expectedPatterns: string[]) {
	let observed: Awaited<ReturnType<typeof readEditorBundle>> | undefined
	await browser.waitUntil(
		async () => {
			try {
				observed = await readEditorBundle(bundleId)
				return (
					typeof observed.text === "string" &&
					JSON.stringify(observed.patterns) === JSON.stringify(expectedPatterns)
				)
			} catch {
				return false
			}
		},
		{
			interval: 250,
			timeout: 30_000,
			timeoutMsg: `Bundle ${bundleId} did not reach ${JSON.stringify(expectedPatterns)}`,
		}
	)
	return observed!
}
