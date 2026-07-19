import { commands, type Uri } from "vscode"
import { capture } from "../services/telemetry/index.js"
import { editorView } from "../utilities/editor/editorView.js"
import type { InlangProject } from "@inlang/sdk"
import { getProjectRuntime, type ActiveProjectLease } from "../utilities/project/projectRuntime.js"

export function createOpenEditorViewCallback(args: {
	extensionUri: Uri
	activeProject?: () => ActiveProjectLease<InlangProject> | undefined
}) {
	const activeProject =
		args.activeProject ?? (() => getProjectRuntime<InlangProject>().activeProject())

	return async function (commandArgs: { bundleId: string }) {
		const lease = activeProject()

		if (!lease) return

		const editor = editorView({
			extensionUri: args.extensionUri,
			lease,
			initialBundleId: commandArgs.bundleId,
		})
		if (
			!lease.own({
				dispose: (reason) =>
					reason === "shutdown" ? editor.dispose({ persist: true }) : editor.dispose(),
			})
		) {
			await editor.dispose()
			return
		}
		await editor.createOrShowPanel()

		capture({
			event: "IDE-EXTENSION Editor View opened",
			properties: { bundleId: commandArgs.bundleId },
		})
		return undefined
	}
}

export const openEditorViewCommand = {
	command: "sherlock.openEditorView",
	title: "Sherlock: Open Editor View",
	register: commands.registerCommand,
	createCallback: createOpenEditorViewCallback,
}
