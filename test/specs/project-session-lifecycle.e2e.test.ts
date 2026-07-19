import { browser, expect } from "@wdio/globals"
import vscode from "vscode"
import {} from "wdio-vscode-service"

describe("Project session lifecycle", () => {
	it("keeps extension registration stable across repeated project reloads", async () => {
		const result = await browser.executeWorkbench(async (vscodeApi: typeof vscode) => {
			const extension = vscodeApi.extensions.getExtension("inlang.vs-code-extension")
			await extension?.activate()
			const workspaceFolder = vscodeApi.workspace.workspaceFolders?.[0]
			if (!workspaceFolder) throw new Error("Expected the E2E workspace to be open")
			const document = await vscodeApi.workspace.openTextDocument(
				vscodeApi.Uri.joinPath(workspaceFolder.uri, "src/app.js")
			)
			const countSherlockCodeActions = async () => {
				const actions = await vscodeApi.commands.executeCommand<vscode.CodeAction[]>(
					"vscode.executeCodeActionProvider",
					document.uri,
					new vscodeApi.Range(0, 0, 0, 1)
				)
				return actions?.filter((action) => action.title === "Sherlock: Extract Message").length ?? 0
			}
			const codeActionCounts = [await countSherlockCodeActions()]
			const firstReload = await vscodeApi.commands.executeCommand<string>("sherlock.reloadProject")
			codeActionCounts.push(await countSherlockCodeActions())
			const secondReload = await vscodeApi.commands.executeCommand<string>("sherlock.reloadProject")
			codeActionCounts.push(await countSherlockCodeActions())

			return {
				active: extension?.isActive ?? false,
				hasPrivateContextExport: extension?.exports?.context !== undefined,
				codeActionCounts,
				firstReload,
				secondReload,
			}
		})

		expect(result).toEqual({
			active: true,
			hasPrivateContextExport: false,
			codeActionCounts: [1, 1, 1],
			firstReload: "committed",
			secondReload: "committed",
		})
	})

	it("deactivates cleanly when VS Code restarts the extension host", async () => {
		await browser.executeWorkbench(async (vscodeApi: typeof vscode) => {
			await vscodeApi.extensions.getExtension("inlang.vs-code-extension")?.activate()
			setTimeout(() => {
				void vscodeApi.commands.executeCommand("workbench.action.restartExtensionHost")
			}, 0)
		})

		await browser.waitUntil(
			async () => {
				try {
					return await browser.executeWorkbench(async (vscodeApi: typeof vscode) => {
						const extension = vscodeApi.extensions.getExtension("inlang.vs-code-extension")
						await extension?.activate()
						return extension?.isActive ?? false
					})
				} catch {
					return false
				}
			},
			{ timeout: 60_000, interval: 500 }
		)

		const result = await browser.executeWorkbench(async (vscodeApi: typeof vscode) => {
			const extension = vscodeApi.extensions.getExtension("inlang.vs-code-extension")
			await extension?.activate()
			const workspaceFolder = vscodeApi.workspace.workspaceFolders?.[0]
			if (!workspaceFolder) throw new Error("Expected the E2E workspace to be open")
			const document = await vscodeApi.workspace.openTextDocument(
				vscodeApi.Uri.joinPath(workspaceFolder.uri, "src/app.js")
			)
			const countSherlockCodeActions = async () => {
				const actions = await vscodeApi.commands.executeCommand<vscode.CodeAction[]>(
					"vscode.executeCodeActionProvider",
					document.uri,
					new vscodeApi.Range(0, 0, 0, 1)
				)
				return actions?.filter((action) => action.title === "Sherlock: Extract Message").length ?? 0
			}
			const beforeReload = await countSherlockCodeActions()
			const reload = await vscodeApi.commands.executeCommand<string>("sherlock.reloadProject")
			const afterReload = await countSherlockCodeActions()
			return { beforeReload, reload, afterReload }
		})

		expect(result).toEqual({ beforeReload: 1, reload: "committed", afterReload: 1 })
	})
})
