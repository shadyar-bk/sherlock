import { beforeEach, describe, expect, it, vi } from "vitest"
import * as vscode from "vscode"
import fg from "fast-glob"
import { activate, deactivate, discoverProjectsInWorkspace } from "./main.js"
import { state } from "./utilities/state.js"
import { handleError } from "./utilities/utils.js"
import { gettingStartedView } from "./utilities/getting-started/gettingStarted.js"
import { loadProjectFromDirectory } from "@inlang/sdk"
import { closestInlangProject } from "./utilities/project/closestInlangProject.js"
import { projectView } from "./utilities/project/project.js"
import { messageView } from "./utilities/messages/messages.js"
import { errorView } from "./utilities/errors/errors.js"
import { recommendationBannerView } from "./utilities/recommendation/recommendation.js"
import { getProjectRuntime } from "./utilities/project/projectRuntime.js"
import { CONFIGURATION } from "./configuration.js"
import {
	createResourceLoadTracker,
	setupPluginResourceWatcher,
} from "./utilities/fs/pluginResourceWatcher.js"

const createOpenEditorViewCallback = vi.hoisted(() => vi.fn(() => vi.fn()))

vi.mock("vscode", () => ({
	version: "1.90.0",
	commands: {
		executeCommand: vi.fn(),
		registerCommand: vi.fn(),
	},
	workspace: {
		workspaceFolders: [],
	},
	window: {
		registerTreeDataProvider: vi.fn(),
		registerWebviewViewProvider: vi.fn(),
		showErrorMessage: vi.fn(),
	},
	languages: {
		registerCodeActionsProvider: vi.fn(() => ({ dispose: vi.fn() })),
	},
	EventEmitter: class {
		fire = vi.fn()
		event = vi.fn()
	},
	ThemeIcon: class {},
	ThemeColor: class {},
	TreeItemCollapsibleState: {
		Collapsed: 0,
		None: 1,
		Expanded: 2,
	},
	CodeActionKind: {
		QuickFix: "quickfix",
	},
}))

vi.mock("fast-glob", () => ({
	default: {
		async: vi.fn(),
		convertPathToPattern: vi.fn((path: string) => path),
	},
}))

vi.mock("./configuration.js", () => ({
	CONFIGURATION: {
		COMMANDS: {
			OPEN_EDITOR_VIEW: {
				command: "sherlock.openEditorView",
				createCallback: createOpenEditorViewCallback,
				register: vi.fn(() => ({ dispose: vi.fn() })),
			},
			RELOAD: {
				command: "sherlock.reloadProject",
				callback: vi.fn(),
				register: vi.fn(() => ({ dispose: vi.fn() })),
			},
		},
		FILES: {
			PROJECT: "project.inlang/settings.json",
		},
		EVENTS: {
			ON_DID_EDIT_MESSAGE: { fire: vi.fn() },
			ON_DID_CREATE_MESSAGE: { fire: vi.fn() },
			ON_DID_EXTRACT_MESSAGE: { fire: vi.fn() },
			ON_DID_PROJECT_CHANGE: {
				fire: vi.fn(),
				event: vi.fn(() => ({ dispose: vi.fn() })),
			},
			ON_DID_PROJECT_TREE_VIEW_CHANGE: { fire: vi.fn() },
			ON_DID_ERROR_TREE_VIEW_CHANGE: { fire: vi.fn() },
		},
	},
}))

vi.mock("./utilities/utils.js", () => ({
	handleError: vi.fn(),
}))

vi.mock("./utilities/project/project.js", () => ({
	projectView: vi.fn(),
}))

vi.mock("./decorations/messagePreview.js", () => ({
	messagePreview: vi.fn(),
}))

vi.mock("./actions/extractMessage.js", () => ({
	ExtractMessage: class {
		static providedCodeActionKinds = []
	},
}))

vi.mock("./utilities/errors/errors.js", () => ({
	errorView: vi.fn(),
}))

vi.mock("./utilities/messages/messages.js", () => ({
	messageView: vi.fn(),
}))

vi.mock("./utilities/fs/createFileSystemMapper.js", () => ({
	createFileSystemMapper: vi.fn(),
}))

vi.mock("./utilities/getting-started/gettingStarted.js", () => ({
	gettingStartedView: vi.fn(),
}))

vi.mock("./utilities/project/closestInlangProject.js", () => ({
	closestInlangProject: vi.fn(),
}))

vi.mock("./utilities/recommendation/recommendation.js", () => ({
	recommendationBannerView: vi.fn(),
}))

vi.mock("./services/telemetry/index.js", () => ({
	capture: vi.fn(),
	telemetry: {
		capture: vi.fn(),
	},
}))

vi.mock("./utilities/settings/statusBar.js", () => ({
	statusBar: vi.fn(),
}))

vi.mock("./diagnostics/linterDiagnostics.js", () => ({
	linterDiagnostics: vi.fn(),
}))

vi.mock("./utilities/fs/pluginResourceWatcher.js", () => ({
	createResourceLoadTracker: vi.fn((fs) => ({ fs, snapshot: new Map() })),
	setupPluginResourceWatcher: vi.fn(),
}))

vi.mock("@inlang/sdk", () => ({
	saveProjectToDirectory: vi.fn(),
	loadProjectFromDirectory: vi.fn(),
}))

describe("discoverProjectsInWorkspace", () => {
	const workspaceFolder = {
		uri: {
			fsPath: "/workspace",
		},
	} as vscode.WorkspaceFolder

	beforeEach(async () => {
		await deactivate()
		vi.clearAllMocks()
		;(
			vscode.workspace as unknown as { workspaceFolders: vscode.WorkspaceFolder[] }
		).workspaceFolders = [workspaceFolder]
	})

	it("suppresses unreadable workspace directories during project discovery", async () => {
		vi.mocked(fg.async).mockResolvedValueOnce(["/workspace/project.inlang"])

		const projects = await discoverProjectsInWorkspace({ workspaceFolder })

		expect(fg.async).toHaveBeenCalledWith(
			"/workspace/**/*.inlang",
			expect.objectContaining({
				onlyDirectories: true,
				ignore: ["**/node_modules/**"],
				absolute: true,
				cwd: "/workspace",
				suppressErrors: true,
			})
		)
		expect(projects).toEqual([
			{
				projectPath: "/workspace/project.inlang",
			},
		])
	})

	it("initializes an empty project list if discovery still fails", async () => {
		const error = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })
		vi.mocked(fg.async).mockRejectedValueOnce(error)

		const projects = await discoverProjectsInWorkspace({ workspaceFolder })

		expect(handleError).toHaveBeenCalledWith(error)
		expect(projects).toEqual([])
	})

	it("falls back to Getting Started when activation discovery fails before state exists", async () => {
		const error = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })
		const context = {
			subscriptions: [],
		} as unknown as vscode.ExtensionContext
		vi.mocked(fg.async).mockRejectedValueOnce(error)

		await expect(activate(context)).resolves.toBeUndefined()

		expect(handleError).toHaveBeenCalledWith(error)
		expect(state().projectsInWorkspace).toEqual([])
		expect(gettingStartedView).toHaveBeenCalledWith(expect.objectContaining({ workspaceFolder }))
	})

	it("registers global views once while replacing only the project session", async () => {
		const firstWatcherDispose = vi.fn()
		const secondWatcherDispose = vi.fn()
		let watcherInstall = 0
		vi.mocked(setupPluginResourceWatcher).mockImplementation(async ({ session }) => {
			session.own({
				dispose: watcherInstall++ === 0 ? firstWatcherDispose : secondWatcherDispose,
			})
			return []
		})
		const firstProject = {
			plugins: { get: vi.fn(async () => []) },
			settings: { get: vi.fn(async () => ({ locales: [] })) },
			errors: { get: vi.fn(async () => []) },
			close: vi.fn(async () => undefined),
		}
		const reloadedProject = {
			plugins: { get: vi.fn(async () => []) },
			settings: { get: vi.fn(async () => ({ locales: [] })) },
			errors: { get: vi.fn(async () => []) },
			close: vi.fn(async () => undefined),
		}
		const context = {
			subscriptions: [],
			extensionUri: { fsPath: "/extension" },
		} as unknown as vscode.ExtensionContext
		vi.mocked(fg.async).mockResolvedValueOnce(["/workspace/project.inlang"])
		vi.mocked(closestInlangProject).mockResolvedValueOnce({
			projectPath: "/workspace/project.inlang",
		} as any)
		vi.mocked(loadProjectFromDirectory)
			.mockResolvedValueOnce(firstProject as any)
			.mockResolvedValueOnce(reloadedProject as any)

		await activate(context)
		await getProjectRuntime().replaceProject("/workspace/project.inlang")

		expect(createResourceLoadTracker).toHaveBeenCalledTimes(2)
		expect(projectView).toHaveBeenCalledTimes(1)
		expect(messageView).toHaveBeenCalledTimes(1)
		expect(messageView).toHaveBeenCalledWith({
			workspaceFolder,
			extensionUri: context.extensionUri,
			subscriptions: context.subscriptions,
		})
		expect(createOpenEditorViewCallback).toHaveBeenCalledOnce()
		expect(createOpenEditorViewCallback).toHaveBeenCalledWith({
			extensionUri: context.extensionUri,
		})
		expect(errorView).toHaveBeenCalledTimes(1)
		expect(recommendationBannerView).toHaveBeenCalledTimes(1)
		expect(firstProject.close).toHaveBeenCalledTimes(1)
		expect(setupPluginResourceWatcher).toHaveBeenCalledTimes(2)
		expect(vi.mocked(setupPluginResourceWatcher).mock.calls[0]?.[0].loadSnapshot).toBe(
			vi.mocked(createResourceLoadTracker).mock.results[0]?.value.snapshot
		)
		expect(vi.mocked(setupPluginResourceWatcher).mock.calls[1]?.[0].loadSnapshot).toBe(
			vi.mocked(createResourceLoadTracker).mock.results[1]?.value.snapshot
		)
		expect(firstWatcherDispose).toHaveBeenCalledOnce()
		const firstCodeActionProvider = vi.mocked(vscode.languages.registerCodeActionsProvider).mock
			.results[0]?.value as vscode.Disposable
		expect(firstCodeActionProvider.dispose).toHaveBeenCalledTimes(1)
		expect(vi.mocked(firstCodeActionProvider.dispose).mock.invocationCallOrder[0]).toBeLessThan(
			firstProject.close.mock.invocationCallOrder[0]!
		)
		expect(firstWatcherDispose.mock.invocationCallOrder[0]).toBeLessThan(
			firstProject.close.mock.invocationCallOrder[0]!
		)
		expect(firstProject.close.mock.invocationCallOrder[0]).toBeLessThan(
			vi.mocked(setupPluginResourceWatcher).mock.invocationCallOrder[1]!
		)
		expect(reloadedProject.close).not.toHaveBeenCalled()
		expect(CONFIGURATION.EVENTS.ON_DID_PROJECT_CHANGE.fire).toHaveBeenCalledTimes(2)

		await deactivate()
		await deactivate()
		expect(secondWatcherDispose).toHaveBeenCalledOnce()
		expect(reloadedProject.close).toHaveBeenCalledTimes(1)
	})

	it("keeps global views and the runtime available after the initial project load fails", async () => {
		const loadError = new Error("plugin failed to load")
		const recoveredProject = {
			plugins: { get: vi.fn(async () => []) },
			settings: { get: vi.fn(async () => ({ locales: [] })) },
			errors: { get: vi.fn(async () => []) },
			close: vi.fn(async () => undefined),
		}
		const context = { subscriptions: [] } as unknown as vscode.ExtensionContext
		vi.mocked(fg.async).mockResolvedValueOnce(["/workspace/project.inlang"])
		vi.mocked(closestInlangProject).mockResolvedValueOnce({
			projectPath: "/workspace/project.inlang",
		} as any)
		vi.mocked(loadProjectFromDirectory)
			.mockRejectedValueOnce(loadError)
			.mockResolvedValueOnce(recoveredProject as any)

		await activate(context)

		expect(handleError).toHaveBeenCalledWith(loadError)
		expect(projectView).toHaveBeenCalledTimes(1)
		expect(errorView).toHaveBeenCalledTimes(1)
		expect(getProjectRuntime().lastRequestedProjectPath()).toBe("/workspace/project.inlang")
		await expect(getProjectRuntime().replaceProject("/workspace/project.inlang")).resolves.toEqual({
			status: "committed",
		})
		expect(state().project).toBe(recoveredProject)
	})
})
