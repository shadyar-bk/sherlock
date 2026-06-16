import * as vscode from "vscode"
import type { Disposable, WebviewPanel } from "vscode"

import { getUri } from "./helper/getUri.js"
import { getNonce } from "./helper/getNonce.js"
import { state } from "../state.js"
import { CONFIGURATION } from "../../configuration.js"
import { getSelectedBundleByBundleIdOrAlias } from "../helper.js"
import { msg } from "../messages/msg.js"
import type { ChangeEventDetail } from "@inlang/editor-component"
import { deleteVariant } from "./helper/deleteVariant.js"
import { deleteBundleNested } from "./helper/deleteBundleNested.js"
import { handleUpdateBundle } from "./helper/handleBundleUpdate.js"
import { createMessage } from "./helper/createMessage.js"
import { saveProject } from "../../main.js"

// Same interface as before
export interface UpdateBundleMessage {
	command: string
	change: ChangeEventDetail
	persist?: boolean
}

/**
 * An ID you can use to differentiate panels in VS Code.
 * (Doesn't have to match the old 'editorView' if you don't want.)
 */
export const EDITOR_PANEL_ID = "editorViewPanel"

/**
 * Creates or reveals a regular WebviewPanel (like an editor tab),
 * instead of a side-view via WebviewViewProvider.
 *
 * All your bundle/update logic remains the same.
 */
export function editorView(args: { context: vscode.ExtensionContext; initialBundleId: string }) {
	const { context, initialBundleId } = args
	const extensionUri = context.extensionUri

	let panel: WebviewPanel | undefined
	let disposables: Disposable[] = []
	let bundleId = initialBundleId
	let pendingUpdate = Promise.resolve()

	/**
	 * Opens a new panel if none is open, otherwise reveals the existing one.
	 */
	async function createOrShowPanel() {
		if (panel) {
			// If we already have a panel, reveal it
			panel.reveal(vscode.ViewColumn.One)
			return
		}

		// Otherwise, create a brand-new panel
		panel = vscode.window.createWebviewPanel(
			EDITOR_PANEL_ID,
			`# ${bundleId}`,
			vscode.ViewColumn.One,
			{
				enableScripts: true,
				localResourceRoots: [extensionUri],
			}
		)

		// Set up disposal
		panel.onDidDispose(
			() => {
				void persistEdit()
				dispose()
				panel = undefined
			},
			null,
			disposables
		)

		// Listen to panel and load state when it's visible
		panel.onDidChangeViewState(
			async (e) => {
				if (e.webviewPanel.visible) {
					panel?.webview.postMessage({
						command: "change",
						data: {
							bundle: await getSelectedBundleByBundleIdOrAlias(bundleId),
							settings: await state().project?.settings.get(),
						},
					})
				}
			},
			null,
			disposables
		)

		// Provide the same HTML you had before
		panel.webview.html = getHtmlForWebview(panel.webview)

		// Set initial data
		panel.webview.postMessage({
			command: "change",
			data: {
				bundle: await getSelectedBundleByBundleIdOrAlias(bundleId),
				settings: await state().project?.settings.get(),
			},
		})

		// Set up the same message listener logic
		setWebviewMessageListener(panel.webview)
	}

	/**
	 * The same message handler logic you used in your snippet,
	 * listening for 'updateBundle' etc.
	 */
	function setWebviewMessageListener(webview: vscode.Webview) {
		const disposable = webview.onDidReceiveMessage(async (message: any) => {
			const command = message.command

			switch (command) {
				case "create-message":
					await createMessage({
						db: state().project?.db,
						message: message.message,
					})

					await updateView()
					return
				case "delete-variant":
					await deleteVariant({
						db: state().project?.db,
						variantId: message.id,
					})

					await updateView()
					return
				case "delete-bundle":
					await deleteBundleNested({
						db: state().project?.db,
						bundleId: message.id,
					})

					await updateView()
					return
				case "change":
					await queueUpdate(message)

					if (message.persist === true) {
						await updateView()
					}
					return
				case "persist-edit":
					await persistEdit()
					return
				case "show-info-message":
					msg(message.message, "info", "statusBar", vscode.StatusBarAlignment.Right, 3000)
					return
				case "show-error-message":
					msg(message.message, "error", "statusBar", vscode.StatusBarAlignment.Right, 3000)
					return

				default:
					console.error("Unknown command from webview:", command)
			}
		})
		disposables.push(disposable)
	}

	function queueUpdate(message: UpdateBundleMessage) {
		pendingUpdate = pendingUpdate.then(() =>
			handleUpdateBundle({
				db: state().project?.db,
				message,
			})
		)
		return pendingUpdate
	}

	/**
	 * Update view
	 */
	async function updateView() {
		await pendingUpdate

		CONFIGURATION.EVENTS.ON_DID_EDIT_MESSAGE.fire()
		CONFIGURATION.EVENTS.ON_DID_EDITOR_VIEW_CHANGE.fire()

		panel?.webview.postMessage({
			command: "change",
			data: {
				bundle: await getSelectedBundleByBundleIdOrAlias(bundleId),
				settings: await state().project?.settings.get(),
			},
		})

		const workspaceFolder = vscode.workspace.workspaceFolders![0]
		if (workspaceFolder) {
			try {
				await saveProject()
			} catch (error) {
				console.error("Failed to save project", error)
				msg(`Failed to save project. ${String(error)}`, "error")
			}
		}
	}

	async function persistEdit() {
		await pendingUpdate

		CONFIGURATION.EVENTS.ON_DID_EDIT_MESSAGE.fire()

		const workspaceFolder = vscode.workspace.workspaceFolders![0]
		if (workspaceFolder) {
			try {
				await saveProject()
			} catch (error) {
				console.error("Failed to save project", error)
				msg(`Failed to save project. ${String(error)}`, "error")
			}
		}
	}

	/**
	 * Your original logic for generating the HTML,
	 * including dev vs. prod, React Refresh, etc.
	 */
	function getHtmlForWebview(webview: vscode.Webview) {
		const stylesUri = getUri(webview, extensionUri, [
			"assets",
			"sherlock-editor-app",
			"assets",
			"index.css",
		])

		const scriptUri = getUri(webview, extensionUri, [
			"assets",
			"sherlock-editor-app",
			"assets",
			"index.js",
		])

		const nonce = getNonce()

		const csp = [
			`default-src 'none';`,

			// Allow scripts from safe sources
			`script-src 'self' https://* 'nonce-${nonce}';`,

			// Allow inline styles for better compatibility
			`style-src ${webview.cspSource} 'self' 'unsafe-inline' https://*;`,

			// Allow fonts from safe sources
			`font-src ${webview.cspSource} https://*;`,

			// Allow images from trusted sources and `data:` URLs
			`img-src ${webview.cspSource} https://* data:;`,

			// Allow media from safe sources (if needed)
			`media-src ${webview.cspSource} https://* data:;`,

			// Allow connections to APIs, WebSockets, and data URIs - include http://localhost:3000 for RPC
			`connect-src https://* http://localhost:3000 data:;`,

			// Allow iframes only from trusted sources
			`frame-src 'self' https://*;`,
		].join(" ")

		return /*html*/ `<!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta http-equiv="Content-Security-Policy" content="${csp}">
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <link rel="stylesheet" type="text/css" href="${stylesUri}">
        <title>${bundleId}</title>
      </head>
      <body>
        <div id="root"></div>
        <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
      </body>
    </html>`
	}

	/**
	 * Let external code update the bundleId if desired
	 */
	function setBundleId(newBundleId: string) {
		bundleId = newBundleId
	}

	function getBundleId() {
		return bundleId
	}

	/**
	 * Dispose any event listeners or watchers
	 */
	function dispose() {
		while (disposables.length) {
			const disposable = disposables.pop()
			if (disposable) disposable.dispose()
		}
	}

	/**
	 * Return an object with methods to show the panel,
	 * set the bundleId, etc.
	 */
	return {
		createOrShowPanel,
		setBundleId,
		getBundleId,
		dispose,
	}
}
