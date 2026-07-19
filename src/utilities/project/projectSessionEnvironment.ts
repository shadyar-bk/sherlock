import { loadProjectFromDirectory, type IdeExtensionConfig, type InlangProject } from "@inlang/sdk"
import * as nodeFs from "node:fs"
import * as vscode from "vscode"
import { ExtractMessage } from "../../actions/extractMessage.js"
import { CONFIGURATION } from "../../configuration.js"
import { messagePreview } from "../../decorations/messagePreview.js"
import { linterDiagnostics } from "../../diagnostics/linterDiagnostics.js"
import type { MessageViewController } from "../messages/messages.js"
import type { FileSystem } from "../fs/createFileSystemMapper.js"
import { createResourceLoadTracker } from "../fs/pluginResourceWatcher.js"
import { prepareProject, setActiveProject } from "../state.js"
import { handleError } from "../utils.js"
import { createProjectRuntime, type ProjectRuntime } from "./projectRuntime.js"
import { deactivateBeforeClose } from "./projectSession.js"

export type ProjectSessionEnvironmentArgs = {
	fileSystem: FileSystem
	messageView?: Pick<MessageViewController, "bindProject">
}

export function createProjectSessionEnvironment(
	args: ProjectSessionEnvironmentArgs
): ProjectRuntime<InlangProject> {
	const resourceLoadSnapshots = new WeakMap<
		InlangProject,
		ReturnType<typeof createResourceLoadTracker>["snapshot"]
	>()

	return createProjectRuntime({
		loadProject: async (projectPath) => {
			const loadTracker = createResourceLoadTracker(nodeFs)
			const project = await loadProjectFromDirectory({ path: projectPath, fs: loadTracker.fs })
			resourceLoadSnapshots.set(project, loadTracker.snapshot)
			prepareProject(project)
			return project
		},
		prepareSession: async (session, resources) => {
			const ideExtension = (await session.project.plugins.get()).find(
				(plugin) => plugin?.meta?.["app.inlang.ideExtension"]
			)?.meta?.["app.inlang.ideExtension"] as IdeExtensionConfig | undefined
			const documentSelectors: vscode.DocumentSelector = [
				{ language: "javascript", pattern: `!${CONFIGURATION.FILES.PROJECT}` },
				...(ideExtension?.documentSelectors ?? []),
			]

			return {
				activate: () => {
					resources.push(
						deactivateBeforeClose(
							vscode.languages.registerCodeActionsProvider(
								documentSelectors,
								new ExtractMessage(),
								{ providedCodeActionKinds: ExtractMessage.providedCodeActionKinds }
							)
						)
					)
					messagePreview({ subscriptions: resources, session })
					void linterDiagnostics({ subscriptions: resources, fs: args.fileSystem, session }).catch(
						handleError
					)
					if (args.messageView) {
						resources.push(deactivateBeforeClose(args.messageView.bindProject(session)))
					}
				},
			}
		},
		publishActiveSession: (session) =>
			setActiveProject(session ? { project: session.project, path: session.path } : undefined),
	})
}
