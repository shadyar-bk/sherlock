import { beforeEach, describe, expect, it, vi } from "vitest"
import * as vscode from "vscode"
import fg from "fast-glob"
import { activate, discoverProjectsInWorkspace } from "./main.js"
import { state } from "./utilities/state.js"
import { handleError } from "./utilities/utils.js"
import { gettingStartedView } from "./utilities/getting-started/gettingStarted.js"

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
		registerCodeActionsProvider: vi.fn(),
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
		COMMANDS: {},
		FILES: {
			PROJECT: "project.inlang/settings.json",
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

vi.mock("./utilities/fs/experimental/directMessageHandler.js", () => ({
	setupDirectMessageWatcher: vi.fn(),
}))

vi.mock("@inlang/sdk", () => ({
	saveProjectToDirectory: vi.fn(),
}))

describe("discoverProjectsInWorkspace", () => {
	const workspaceFolder = {
		uri: {
			fsPath: "/workspace",
		},
	} as vscode.WorkspaceFolder

	beforeEach(() => {
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

		await expect(activate(context)).resolves.toEqual({ context })

		expect(handleError).toHaveBeenCalledWith(error)
		expect(state().projectsInWorkspace).toEqual([])
		expect(gettingStartedView).toHaveBeenCalledWith(expect.objectContaining({ workspaceFolder }))
	})
})
