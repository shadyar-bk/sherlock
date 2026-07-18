import { browser } from "@wdio/globals"
import vscode from "vscode"
import {} from "wdio-vscode-service"

export type ProjectRefreshOperation =
	| { type: "reload" }
	| { type: "write"; filePath: string; value: unknown }
	| { type: "delete"; filePath: string }

export async function triggerProjectRefreshAndWait(args: {
	settingsPath: string
	sourcePath: string
	operation: ProjectRefreshOperation
	settleDiagnosticEvents?: boolean
}) {
	return browser.executeWorkbench(async (vscodeApi: typeof vscode, request: typeof args) => {
		const diagnosticQuietPeriodMs = 1_000
		const extension = vscodeApi.extensions.getExtension("inlang.vs-code-extension")
		await extension?.activate()
		const sourceDocument = await vscodeApi.workspace.openTextDocument(
			vscodeApi.Uri.file(request.sourcePath)
		)
		const settingsDocument = await vscodeApi.workspace.openTextDocument(
			vscodeApi.Uri.file(request.settingsPath)
		)

		const waitForDiagnosticsAfter = async (
			trigger: () => PromiseLike<unknown>,
			timeoutMessage: string,
			settleDiagnosticEvents = false,
			subscribeAfterTrigger = false
		) => {
			let subscription: vscode.Disposable | undefined
			let timeout: ReturnType<typeof setTimeout> | undefined
			let quietTimer: ReturnType<typeof setTimeout> | undefined
			let diagnosticEvents = 0
			const subscribe = () =>
				new Promise<number>((resolve, reject) => {
					timeout = setTimeout(() => reject(new Error(timeoutMessage)), 30_000)
					subscription = vscodeApi.languages.onDidChangeDiagnostics((event) => {
						if (!event.uris.some((uri) => uri.toString() === sourceDocument.uri.toString())) {
							return
						}
						diagnosticEvents += 1
						if (!settleDiagnosticEvents) {
							resolve(diagnosticEvents)
							return
						}
						if (quietTimer) clearTimeout(quietTimer)
						quietTimer = setTimeout(() => resolve(diagnosticEvents), diagnosticQuietPeriodMs)
					})
				})
			try {
				if (subscribeAfterTrigger) {
					await trigger()
					return await subscribe()
				}
				const diagnosticsChanged = subscribe()
				await trigger()
				return await diagnosticsChanged
			} finally {
				if (timeout) clearTimeout(timeout)
				if (quietTimer) clearTimeout(quietTimer)
				subscription?.dispose()
			}
		}
		await vscodeApi.window.showTextDocument(settingsDocument)
		// Make the source document active before observing the requested operation. Showing an already
		// diagnosed document is not guaranteed to emit a new event, so drain late activation work for a
		// bounded period instead of requiring an event that may never arrive.
		await vscodeApi.window.showTextDocument(sourceDocument)
		await new Promise((resolve) => setTimeout(resolve, diagnosticQuietPeriodMs))

		switch (request.operation.type) {
			case "reload":
				return {
					diagnosticEvents: await waitForDiagnosticsAfter(
						() => vscodeApi.commands.executeCommand("sherlock.reloadProject"),
						"Project reload did not refresh diagnostics",
						request.settleDiagnosticEvents
					),
				}
			case "write": {
				const { filePath, value } = request.operation
				return {
					diagnosticEvents: await waitForDiagnosticsAfter(
						() =>
							vscodeApi.workspace.fs.writeFile(
								vscodeApi.Uri.file(filePath),
								new TextEncoder().encode(`${JSON.stringify(value, undefined, "\t")}\n`)
							),
						"Resource write did not refresh diagnostics",
						request.settleDiagnosticEvents,
						!request.settleDiagnosticEvents
					),
				}
			}
			case "delete": {
				const { filePath } = request.operation
				return {
					diagnosticEvents: await waitForDiagnosticsAfter(
						() => vscodeApi.workspace.fs.delete(vscodeApi.Uri.file(filePath)),
						"Resource deletion did not refresh diagnostics",
						request.settleDiagnosticEvents,
						!request.settleDiagnosticEvents
					),
				}
			}
		}
	}, args)
}
