import { type IdeExtensionConfig, type InlangProject } from "@inlang/sdk"
import * as vscode from "vscode"
import { ExtractMessage } from "../../actions/extractMessage.js"
import { CONFIGURATION } from "../../configuration.js"
import { messagePreview } from "../../decorations/messagePreview.js"
import { linterDiagnostics } from "../../diagnostics/linterDiagnostics.js"
import type { MessageViewController } from "../messages/messages.js"
import type { FileSystem } from "../fs/createFileSystemMapper.js"
import { prepareProject, setActiveProject } from "../state.js"
import { handleError } from "../utils.js"
import type { ProjectRuntime } from "./projectRuntime.js"
import { projectResourceSynchronization } from "./projectResourceSynchronization.js"
import {
	createProjectSessionLifecycle,
	deactivateBeforeClose,
	type Disposable,
	type ProjectSession,
} from "./projectSession.js"

export type ProjectSessionEnvironmentArgs = {
	fileSystem: FileSystem
	messageView?: Pick<MessageViewController, "bindProject">
}

export function createProjectSessionEnvironment(
	args: ProjectSessionEnvironmentArgs
): ProjectRuntime<InlangProject> {
	return createEnvironmentRuntime({
		loadProject: async (projectPath) => {
			const project = await projectResourceSynchronization.load(projectPath)
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
				afterPreviousDisposed: async () => {
					await projectResourceSynchronization.watch(session, { onError: handleError })
					await session
						.runTask(async () => {
							await handleInlangErrors(session.project)
						})
						.catch(handleError)
				},
			}
		},
		publishActiveSession: (session) =>
			setActiveProject(session ? { project: session.project, path: session.path } : undefined),
		onDidReplaceSession: () => CONFIGURATION.EVENTS.ON_DID_PROJECT_CHANGE.fire(undefined),
		onError: (error) => handleError(error),
	})
}

async function handleInlangErrors(project: InlangProject) {
	const inlangErrors = (await project.errors.get()) || []
	if (inlangErrors.length > 0) {
		console.error("Extension errors (Sherlock):", inlangErrors)
	}
}

function createEnvironmentRuntime<Project extends { close(): Promise<void> }>(args: {
	loadProject(path: string): Promise<Project>
	prepareSession(
		session: ProjectSession<Project>,
		resources: Disposable[]
	): Promise<{
		activate(): void
		afterPreviousDisposed?(): Promise<void> | void
	}>
	publishActiveSession(session: ProjectSession<Project> | undefined): void
	onDidReplaceSession?(session: ProjectSession<Project>): Promise<void> | void
	onError?(
		error: unknown,
		phase: "cleanup" | "activation" | "notification" | "reconciliation"
	): void
}): ProjectRuntime<Project> {
	let activeSession: ProjectSession<Project> | undefined
	let lastRequestedProjectPath: string | undefined
	const lifecycle = createProjectSessionLifecycle({
		loadProject: args.loadProject,
		prepareSession: args.prepareSession,
		setActiveSession: (session) => {
			args.publishActiveSession(session)
			activeSession = session
		},
		onDidReplaceSession: args.onDidReplaceSession,
		onError: args.onError,
	})

	return {
		replaceProject(path) {
			lastRequestedProjectPath = path
			return lifecycle.replaceProject(path)
		},
		activeProject() {
			const session = activeSession
			if (!session) return undefined
			return {
				path: session.path,
				project: session.project,
				isCurrent: () => activeSession === session,
				own: (resource) => session.own(resource),
				runTask: (task) => session.runTask(task),
			}
		},
		lastRequestedProjectPath: () => lastRequestedProjectPath,
		dispose: lifecycle.dispose,
	}
}
