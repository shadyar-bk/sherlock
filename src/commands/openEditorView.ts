import { commands } from "vscode"
import { capture } from "../services/telemetry/index.js"
import { editorView } from "../utilities/editor/editorView.js"
import * as vscode from "vscode"
import type { InlangProject } from "@inlang/sdk"
import { getProjectRuntime } from "../utilities/project/projectRuntime.js"

export const openEditorViewCommand = {
	command: "sherlock.openEditorView",
	title: "Sherlock: Open Editor View",
	register: commands.registerCommand,
	callback: async function (args: { bundleId: string }) {
		const extensionUri = vscode.extensions.getExtension("inlang.vs-code-extension")?.extensionUri
		const lease = getProjectRuntime<InlangProject>().activeProject()

		if (!extensionUri || !lease) {
			console.error("Extension environment or active project is not available.")
			return
		}

		const editor = editorView({ extensionUri, lease, initialBundleId: args.bundleId })
		if (!lease.own({ dispose: () => editor.dispose({ persist: true }) })) {
			await editor.dispose()
			return
		}
		await editor.createOrShowPanel()

		capture({
			event: "IDE-EXTENSION Editor View opened",
			properties: { bundleId: args.bundleId },
		})
		return undefined
	},
}
