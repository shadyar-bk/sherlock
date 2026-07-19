import * as vscode from "vscode"
import { handleError } from "./utilities/utils.js"
import { CONFIGURATION } from "./configuration.js"
import { projectView } from "./utilities/project/project.js"
import {
	prepareProject,
	setActiveProject,
	setProjectsInWorkspace,
	state,
} from "./utilities/state.js"
import { messagePreview } from "./decorations/messagePreview.js"
import { ExtractMessage } from "./actions/extractMessage.js"
import { errorView } from "./utilities/errors/errors.js"
import { messageView, type MessageViewController } from "./utilities/messages/messages.js"
import { createFileSystemMapper, type FileSystem } from "./utilities/fs/createFileSystemMapper.js"
import fs from "node:fs/promises"
import * as nodeFs from "node:fs"
import { gettingStartedView } from "./utilities/getting-started/gettingStarted.js"
import { closestInlangProject } from "./utilities/project/closestInlangProject.js"
import { recommendationBannerView } from "./utilities/recommendation/recommendation.js"
import { capture } from "./services/telemetry/index.js"
import packageJson from "../package.json" with { type: "json" }
import { statusBar } from "./utilities/settings/statusBar.js"
import fg from "fast-glob"
import {
	loadProjectFromDirectory,
	saveProjectToDirectory,
	type IdeExtensionConfig,
	type InlangProject,
} from "@inlang/sdk"
import type { ActiveProjectLease } from "./utilities/project/projectRuntime.js"
import path from "node:path"
import { linterDiagnostics } from "./diagnostics/linterDiagnostics.js"
import { setupDirectMessageWatcher } from "./utilities/fs/experimental/directMessageHandler.js"
import { deactivateBeforeClose, type Disposable } from "./utilities/project/projectSession.js"
import {
	createProjectRuntime,
	disposeProjectRuntime,
	getProjectRuntime,
	installProjectRuntime,
} from "./utilities/project/projectRuntime.js"
//import { initErrorMonitoring } from "./services/error-monitoring/implementation.js"

const messageFileSnapshots = new Map<string, Set<string>>()

type JsonObject = Record<string, unknown>
type DottedMessageKeySnapshot = {
	messageFilePath: string
	locale: string
	keys: Map<
		string,
		{
			hadNestedPath: boolean
		}
	>
}

// Entry Point
export async function activate(context: vscode.ExtensionContext): Promise<void> {
	// Sentry Error Handling
	//initErrorMonitoring()

	try {
		vscode.commands.executeCommand("setContext", "sherlock:hasProjectInWorkspace", false)
		vscode.commands.executeCommand("setContext", "sherlock:showRecommendationBanner", false)
		const workspaceFolder = vscode.workspace.workspaceFolders?.[0]

		if (!workspaceFolder) {
			console.warn("No workspace folder found.")
			return
		}

		const mappedFs = createFileSystemMapper(path.normalize(workspaceFolder.uri.fsPath), fs)

		await setProjects({ workspaceFolder })
		registerGlobalCommands(context)
		let messageController: MessageViewController | undefined
		if (state().projectsInWorkspace.length > 0) {
			messageController = await messageView({ context, workspaceFolder })
		}
		const runtime = createProjectRuntime({
			loadProject: async (projectPath) => {
				const project = await loadProjectFromDirectory({ path: projectPath, fs: nodeFs })
				prepareProject(project)
				return project
			},
			publishActiveSession: (session) =>
				setActiveProject(session ? { project: session.project, path: session.path } : undefined),
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
						void linterDiagnostics({ subscriptions: resources, fs: mappedFs, session })
						if (messageController) {
							resources.push(deactivateBeforeClose(messageController.bindProject(session)))
						}
					},
					afterPreviousDisposed: async () => {
						await setupDirectMessageWatcher({
							subscriptions: resources,
							workspaceFolder,
							session,
						})
						await session
							.runTask(async () => {
								resources.push(await seedMessageFileSnapshots(session.project, session.path))
								await handleInlangErrors(session.project)
							})
							.catch(handleError)
					},
				}
			},
			onDidReplaceSession: notifyProjectChanged,
			onError: (error) => handleError(error),
		})
		installProjectRuntime(runtime)
		context.subscriptions.push({ dispose: () => void disposeProjectRuntime() })
		if (state().projectsInWorkspace.length > 0) {
			await registerGlobalViews({ context, workspaceFolder, fs: mappedFs })
		}
		await activateInitialProjectSession({ context, workspaceFolder, fs: mappedFs })

		capture({
			event: "IDE-EXTENSION activated",
			properties: {
				vscode_version: vscode.version,
				version: packageJson.version,
				platform: process.platform,
			},
		})
	} catch (error) {
		await disposeProjectRuntime()
		handleError(error)
	}
}

// Main Function
async function activateInitialProjectSession(args: {
	context: vscode.ExtensionContext
	workspaceFolder: vscode.WorkspaceFolder
	fs: FileSystem
}): Promise<void> {
	if (state().projectsInWorkspace.length > 0) {
		// find the closest project to the workspace
		const closestProjectToWorkspace = await closestInlangProject({
			workingDirectory: path.normalize(args.workspaceFolder.uri.fsPath),
			projects: state().projectsInWorkspace,
		})

		const selectedProjectPath =
			state().selectedProjectPath ||
			closestProjectToWorkspace?.projectPath ||
			state().projectsInWorkspace[0]?.projectPath ||
			""

		vscode.commands.executeCommand("setContext", "sherlock:hasProjectInWorkspace", true)
		const result = await getProjectRuntime().replaceProject(selectedProjectPath)
		if (result.status === "failed") handleError(result.error)

		return
	} else {
		await gettingStartedView(args)
	}
}

function registerGlobalCommands(context: vscode.ExtensionContext) {
	context.subscriptions.push(
		...Object.values(CONFIGURATION.COMMANDS).map((command) =>
			command.register(command.command, command.callback as any)
		),
		CONFIGURATION.EVENTS.ON_DID_PROJECT_CHANGE.event(() => {
			CONFIGURATION.EVENTS.ON_DID_PROJECT_TREE_VIEW_CHANGE.fire(undefined)
			CONFIGURATION.EVENTS.ON_DID_ERROR_TREE_VIEW_CHANGE.fire(undefined)
		})
	)
}

async function registerGlobalViews(args: {
	context: vscode.ExtensionContext
	workspaceFolder: vscode.WorkspaceFolder
	fs: FileSystem
}) {
	await recommendationBannerView(args)
	await projectView(args)
	await errorView(args)
	await statusBar(args)
}

function notifyProjectChanged() {
	CONFIGURATION.EVENTS.ON_DID_PROJECT_CHANGE.fire(undefined)
}

export async function deactivate() {
	await disposeProjectRuntime()
}

async function handleInlangErrors(project: Awaited<ReturnType<typeof loadProjectFromDirectory>>) {
	const inlangErrors = (await project.errors.get()) || []
	if (inlangErrors.length > 0) {
		console.error("Extension errors (Sherlock):", inlangErrors)
	}
}

export async function discoverProjectsInWorkspace(args: {
	workspaceFolder: vscode.WorkspaceFolder
}): Promise<Array<{ projectPath: string }>> {
	try {
		const workspacePath = fg.convertPathToPattern(args.workspaceFolder.uri.fsPath) // Normalize path
		return (
			await fg.async(`${workspacePath}/**/*.inlang`, {
				onlyDirectories: true,
				ignore: ["**/node_modules/**"],
				absolute: true, // Ensures paths are absolute and properly formatted
				cwd: workspacePath, // Makes it platform-agnostic
				suppressErrors: true,
			})
		).map((project) => ({
			projectPath: project,
		}))
	} catch (error) {
		handleError(error)
		return []
	}
}

async function setProjects(args: { workspaceFolder: vscode.WorkspaceFolder }) {
	setProjectsInWorkspace(await discoverProjectsInWorkspace(args))
}

export async function saveProject(
	lease:
		| ActiveProjectLease<InlangProject>
		| undefined = getProjectRuntime<InlangProject>().activeProject()
) {
	if (!lease) return
	try {
		await lease.runTask(() => saveProjectData(lease.project, lease.path))
	} catch (error) {
		handleError(error)
	}
}

/** Persists a project that is still owned by a session during awaited teardown. */
export async function saveProjectData(project: InlangProject, projectPath: string) {
	await removeMessagesDeletedFromJsonFiles(project, projectPath)
	const dottedKeySnapshots = await snapshotExplicitDottedMessageKeys(project, projectPath)

	await saveProjectToDirectory({
		fs: createFileSystemMapper(projectPath, fs),
		project,
		path: projectPath,
	})

	await restoreExplicitDottedMessageKeys(dottedKeySnapshots)
}

async function snapshotExplicitDottedMessageKeys(
	project: InlangProject,
	selectedProjectPath: string
): Promise<DottedMessageKeySnapshot[]> {
	const settings = await project.settings.get()
	const pathPattern = getJsonPathPattern(settings)
	if (!pathPattern) return []

	const snapshots: DottedMessageKeySnapshot[] = []
	for (const locale of settings.locales) {
		const messageFilePath = getMessageFilePath(selectedProjectPath, pathPattern, locale)
		const json = await readJsonObject(messageFilePath).catch(() => undefined)
		if (!json) continue

		const keys = new Map<string, { hadNestedPath: boolean }>()
		for (const key of Object.keys(json)) {
			if (key === "$schema" || !key.includes(".")) continue
			keys.set(key, {
				hadNestedPath: hasNestedPath(json, key.split(".")),
			})
		}

		if (keys.size > 0) {
			snapshots.push({ messageFilePath, locale, keys })
		}
	}

	return snapshots
}

async function restoreExplicitDottedMessageKeys(snapshots: DottedMessageKeySnapshot[]) {
	for (const snapshot of snapshots) {
		const originalContent = await fs
			.readFile(snapshot.messageFilePath, "utf8")
			.catch(() => undefined)
		if (originalContent === undefined) continue

		const json = parseJsonObject(originalContent)
		if (!json) continue

		let changed = false
		for (const [key, savedKey] of snapshot.keys) {
			const exportedValue = getNestedPath(json, key.split("."))
			if (exportedValue === undefined) {
				continue
			}

			if (json[key] !== exportedValue) {
				json[key] = exportedValue
				changed = true
			}

			if (!savedKey.hadNestedPath && deleteNestedPath(json, key.split("."))) {
				changed = true
			}
		}

		if (!changed) continue

		await fs.writeFile(
			snapshot.messageFilePath,
			stringifyJsonObject(json, {
				indent: detectJsonIndent(originalContent),
				trailingNewline: originalContent.endsWith("\n"),
			})
		)
		messageFileSnapshots.set(
			snapshot.messageFilePath,
			new Set(Object.keys(json).filter((key) => key !== "$schema"))
		)
	}
}

async function removeMessagesDeletedFromJsonFiles(
	project: InlangProject,
	selectedProjectPath: string
) {
	const settings = await project.settings.get()
	const baseLocale = settings.baseLocale ?? settings.locales[0]
	const pathPattern = getJsonPathPattern(settings)
	if (!pathPattern || !baseLocale) return

	for (const locale of settings.locales) {
		const messageFilePath = getMessageFilePath(selectedProjectPath, pathPattern, locale)
		const currentKeys = await readMessageFileKeys(messageFilePath)
		if (!currentKeys) continue

		const previousKeys = messageFileSnapshots.get(messageFilePath)
		if (!previousKeys) {
			messageFileSnapshots.set(messageFilePath, currentKeys)
			continue
		}

		const deletedKeys = [...previousKeys].filter((key) => !currentKeys.has(key))
		for (const key of deletedKeys) {
			if (locale === baseLocale) {
				await deleteBundleMessages(key)
			} else {
				await deleteLocaleMessage(key, locale)
			}
		}

		messageFileSnapshots.set(messageFilePath, currentKeys)
	}

	async function deleteBundleMessages(bundleId: string) {
		const messages = await project.db
			.selectFrom("message")
			.select("id")
			.where("bundleId", "=", bundleId)
			.execute()

		for (const message of messages) {
			await project.db.deleteFrom("variant").where("messageId", "=", message.id).execute()
		}

		await project.db.deleteFrom("message").where("bundleId", "=", bundleId).execute()
		await project.db.deleteFrom("bundle").where("id", "=", bundleId).execute()
	}

	async function deleteLocaleMessage(bundleId: string, locale: string) {
		const messages = await project.db
			.selectFrom("message")
			.select("id")
			.where("bundleId", "=", bundleId)
			.where("locale", "=", locale)
			.execute()

		for (const message of messages) {
			await project.db.deleteFrom("variant").where("messageId", "=", message.id).execute()
		}

		await project.db
			.deleteFrom("message")
			.where("bundleId", "=", bundleId)
			.where("locale", "=", locale)
			.execute()

		const remainingMessages = await project.db
			.selectFrom("message")
			.select("id")
			.where("bundleId", "=", bundleId)
			.execute()

		if (remainingMessages.length === 0) {
			await project.db.deleteFrom("bundle").where("id", "=", bundleId).execute()
		}
	}
}

async function seedMessageFileSnapshots(
	project: Awaited<ReturnType<typeof loadProjectFromDirectory>>,
	selectedProjectPath: string
): Promise<Disposable> {
	const ownedSnapshots = new Map<string, Set<string>>()

	const settings = await project.settings.get()
	const pathPattern = getJsonPathPattern(settings)
	if (!pathPattern) return { dispose: () => undefined }

	for (const locale of settings.locales) {
		const messageFilePath = getMessageFilePath(selectedProjectPath, pathPattern, locale)
		const keys = await readMessageFileKeys(messageFilePath)
		if (keys) {
			messageFileSnapshots.set(messageFilePath, keys)
			ownedSnapshots.set(messageFilePath, keys)
		}
	}

	return {
		dispose: () => {
			for (const [messageFilePath, snapshot] of ownedSnapshots) {
				if (messageFileSnapshots.get(messageFilePath) === snapshot) {
					messageFileSnapshots.delete(messageFilePath)
				}
			}
		},
	}
}

function getJsonPathPattern(settings: Awaited<ReturnType<InlangProject["settings"]["get"]>>) {
	const pathPattern =
		(settings as any)["plugin.inlang.json"]?.pathPattern ??
		(settings as any)["plugin.inlang.messageFormat"]?.pathPattern

	return typeof pathPattern === "string" ? pathPattern : undefined
}

function getMessageFilePath(selectedProjectPath: string, pathPattern: string, locale: string) {
	const projectDirectory = path.dirname(selectedProjectPath)
	return path.resolve(
		projectDirectory,
		pathPattern.replace("{languageTag}", locale).replace("{locale}", locale)
	)
}

async function readMessageFileKeys(messageFilePath: string) {
	try {
		const file = await readJsonObject(messageFilePath)
		if (!file) return undefined
		return new Set(Object.keys(file).filter((key) => key !== "$schema"))
	} catch {
		return undefined
	}
}

async function readJsonObject(filePath: string) {
	return parseJsonObject(await fs.readFile(filePath, "utf8"))
}

function parseJsonObject(content: string) {
	const json = JSON.parse(content)
	return isJsonObject(json) ? json : undefined
}

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasNestedPath(json: JsonObject, pathParts: string[]) {
	return getNestedPath(json, pathParts) !== undefined
}

function getNestedPath(json: JsonObject, pathParts: string[]) {
	let current: unknown = json
	for (const part of pathParts) {
		if (!isJsonObject(current) || !(part in current)) {
			return undefined
		}
		current = current[part]
	}
	return current
}

function deleteNestedPath(json: JsonObject, pathParts: string[]) {
	if (pathParts.length < 2) return false

	const parents: Array<{ object: JsonObject; key: string }> = []
	let current: JsonObject = json
	for (const part of pathParts.slice(0, -1)) {
		const next = current[part]
		if (!isJsonObject(next)) {
			return false
		}
		parents.push({ object: current, key: part })
		current = next
	}

	const leafKey = pathParts[pathParts.length - 1]
	if (leafKey === undefined || !(leafKey in current)) {
		return false
	}

	delete current[leafKey]

	for (let index = parents.length - 1; index >= 0; index -= 1) {
		const { object, key } = parents[index]!
		const child = object[key]
		if (isJsonObject(child) && Object.keys(child).length === 0) {
			delete object[key]
			continue
		}
		break
	}

	return true
}

function stringifyJsonObject(
	json: JsonObject,
	format: { indent: string | number; trailingNewline: boolean }
) {
	return `${JSON.stringify(json, undefined, format.indent)}${format.trailingNewline ? "\n" : ""}`
}

function detectJsonIndent(content: string) {
	return content.match(/\n(\s+)"/)?.[1] ?? "\t"
}
