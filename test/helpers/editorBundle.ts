import { browser } from "@wdio/globals"
import vscode from "vscode"
import {} from "wdio-vscode-service"

export async function readEditorBundle(bundleId: string) {
	const editor = await openEditorBundle(bundleId)
	try {
		return await editor.read()
	} finally {
		await editor.close()
	}
}

export async function openEditorBundle(bundleId: string) {
	const workbench = await browser.getWorkbench()
	await browser.executeWorkbench(async (vscodeApi: typeof vscode, id: string) => {
		await vscodeApi.commands.executeCommand("sherlock.openEditorView", { bundleId: id })
	}, bundleId)
	const webview = await workbench.getWebviewByTitle(bundleId)
	let opened = false
	let closed = false
	let healthy = false
	const close = async () => {
		if (closed) return
		closed = true
		let leftTargetWebview = false
		try {
			await webview.close()
			leftTargetWebview = opened && healthy
		} catch {
			// The session replacement may have detached the frame before cleanup starts.
		}
		// A departing webview can detach before close() switches both nested frames. Repeating the
		// top-level switch is safe and lets the next public-view poll start from the workbench again.
		await browser.switchToFrame(null).catch(() => undefined)
		await browser.switchToFrame(null).catch(() => undefined)
		if (!leftTargetWebview) return
		await browser
			.executeWorkbench(
				async (vscodeApi: typeof vscode, expected: [string, string]) => {
					const activeTab = vscodeApi.window.tabGroups.activeTabGroup.activeTab
					const activeInput = activeTab?.input as { viewType?: string } | undefined
					const matchesViewType =
						activeInput?.viewType === expected[0] ||
						activeInput?.viewType?.endsWith(`-${expected[0]}`)
					if (matchesViewType && activeTab?.label === expected[1]) {
						await vscodeApi.commands.executeCommand("workbench.action.closeActiveEditor")
					}
				},
				["editorViewPanel", `# ${bundleId}`]
			)
			.catch(() => undefined)
	}
	try {
		await webview.open()
		opened = true
	} catch (error) {
		await close()
		throw error
	}

	return {
		async read() {
			healthy = false
			try {
				const firstEditor = await $("inlang-pattern-editor .inlang-pattern-editor-contenteditable")
				await firstEditor.waitForDisplayed({ timeout: 30_000 })
				const editors = await $$("inlang-pattern-editor .inlang-pattern-editor-contenteditable")
				const patterns: string[] = []
				for (let index = 0; index < editors.length; index += 1) {
					const pattern = await editors[index]!.getText()
					if (typeof pattern !== "string") throw new Error("Editor frame detached while reading")
					patterns.push(pattern)
				}
				const text = await $("body").getText()
				if (typeof text !== "string") throw new Error("Editor frame detached while reading")
				healthy = true
				return { patterns, text }
			} catch (error) {
				healthy = false
				throw error
			}
		},
		async editFirstPattern(value: string) {
			healthy = false
			for (let attempt = 0; attempt < 3; attempt += 1) {
				const firstEditor = await $("inlang-pattern-editor .inlang-pattern-editor-contenteditable")
				await firstEditor.waitForDisplayed({ timeout: 30_000 })
				await firstEditor.click()
				const modifier = process.platform === "darwin" ? "\uE03D" : "\uE009"
				await browser.action("key").down(modifier).down("a").up("a").up(modifier).perform()
				await browser.keys(value)
				await browser.keys("Tab")
				try {
					await browser.waitUntil(
						async () =>
							(await $(
								"inlang-pattern-editor .inlang-pattern-editor-contenteditable"
							).getText()) === value,
						{ interval: 100, timeout: 2_000 }
					)
					healthy = true
					return
				} catch {
					// Retry the real keyboard interaction when WebDriver silently drops it.
				}
			}
			throw new Error(`Editor did not accept ${JSON.stringify(value)}`)
		},
		close,
	}
}

export async function waitForEditorBundle(bundleId: string, expectedPatterns: string[]) {
	let observed: Awaited<ReturnType<typeof readEditorBundle>> | undefined
	let editor: Awaited<ReturnType<typeof openEditorBundle>> | undefined
	try {
		try {
			await browser.waitUntil(
				async () => {
					try {
						editor ??= await openEditorBundle(bundleId)
						observed = await editor.read()
						return (
							typeof observed.text === "string" &&
							JSON.stringify(observed.patterns) === JSON.stringify(expectedPatterns)
						)
					} catch {
						await editor?.close().catch(() => undefined)
						editor = undefined
						return false
					}
				},
				{
					interval: 250,
					timeout: 30_000,
					timeoutMsg: `Bundle ${bundleId} did not reach ${JSON.stringify(expectedPatterns)}`,
				}
			)
		} catch (error) {
			throw new Error(
				`${String(error)}; last observed ${JSON.stringify(observed?.patterns ?? "unavailable")}`
			)
		}
		return observed!
	} finally {
		await editor?.close().catch(() => undefined)
	}
}
