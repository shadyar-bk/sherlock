import { beforeEach, describe, expect, it, vi } from "vitest"
import type { InlangProject } from "@inlang/sdk"
import type { FileSystem } from "../fs/createFileSystemMapper.js"

const host = vi.hoisted(() => ({
	loadProjectFromDirectory: vi.fn(),
	prepareProject: vi.fn(),
	setActiveProject: vi.fn(),
	registerCodeActionsProvider: vi.fn(),
	messagePreview: vi.fn(),
	linterDiagnostics: vi.fn(),
	handleError: vi.fn(),
	createResourceLoadTracker: vi.fn(() => ({
		fs: { tracked: true },
		snapshot: vi.fn(),
	})),
}))

vi.mock("vscode", () => ({
	languages: {
		registerCodeActionsProvider: host.registerCodeActionsProvider,
	},
}))

vi.mock("@inlang/sdk", () => ({
	loadProjectFromDirectory: host.loadProjectFromDirectory,
}))

vi.mock("../state.js", () => ({
	prepareProject: host.prepareProject,
	setActiveProject: host.setActiveProject,
}))

vi.mock("../fs/pluginResourceWatcher.js", () => ({
	createResourceLoadTracker: host.createResourceLoadTracker,
}))

vi.mock("../../decorations/messagePreview.js", () => ({
	messagePreview: host.messagePreview,
}))

vi.mock("../../diagnostics/linterDiagnostics.js", () => ({
	linterDiagnostics: host.linterDiagnostics,
}))

vi.mock("../../actions/extractMessage.js", () => ({
	ExtractMessage: class {
		static providedCodeActionKinds = ["quickfix"]
	},
}))

vi.mock("../../configuration.js", () => ({
	CONFIGURATION: {
		FILES: { PROJECT: "project.inlang/settings.json" },
	},
}))

vi.mock("../utils.js", () => ({
	handleError: host.handleError,
}))

import { createProjectSessionEnvironment } from "./projectSessionEnvironment.js"

function fakeProject(name: string, documentSelectors: Array<{ language: string }> = []) {
	return {
		name,
		close: vi.fn(async () => undefined),
		plugins: {
			get: vi.fn(async () => [
				{
					meta: {
						"app.inlang.ideExtension": { documentSelectors },
					},
				},
			]),
		},
	} as unknown as InlangProject
}

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise
	})
	return { promise, resolve }
}

const fileSystem = {} as FileSystem

function disposable(onDispose: () => unknown = vi.fn()) {
	return { deactivate: onDispose, dispose: onDispose }
}

beforeEach(() => {
	vi.clearAllMocks()
	host.createResourceLoadTracker.mockReturnValue({
		fs: { tracked: true },
		snapshot: vi.fn(),
	})
	host.registerCodeActionsProvider.mockImplementation(() => disposable())
	host.messagePreview.mockImplementation(() => undefined)
	host.linterDiagnostics.mockResolvedValue(undefined)
})

describe("project session environment", () => {
	it("loads and publishes the first project", async () => {
		const project = fakeProject("first")
		host.loadProjectFromDirectory.mockResolvedValue(project)
		const runtime = createProjectSessionEnvironment({ fileSystem })

		await expect(runtime.replaceProject("/first.inlang")).resolves.toEqual({
			status: "committed",
		})

		expect(host.loadProjectFromDirectory).toHaveBeenCalledWith({
			path: "/first.inlang",
			fs: { tracked: true },
		})
		expect(host.prepareProject).toHaveBeenCalledWith(project)
		expect(host.setActiveProject).toHaveBeenLastCalledWith({
			project,
			path: "/first.inlang",
		})
		expect(runtime.activeProject()?.project).toBe(project)
	})

	it("keeps the prior active lease current when loading fails", async () => {
		const first = fakeProject("first")
		host.loadProjectFromDirectory
			.mockResolvedValueOnce(first)
			.mockRejectedValueOnce(new Error("load failed"))
		const runtime = createProjectSessionEnvironment({ fileSystem })
		await runtime.replaceProject("/first.inlang")
		const lease = runtime.activeProject()

		await expect(runtime.replaceProject("/failed.inlang")).resolves.toMatchObject({
			status: "failed",
		})

		expect(lease?.isCurrent()).toBe(true)
		expect(runtime.activeProject()?.project).toBe(first)
		expect(first.close).not.toHaveBeenCalled()
	})

	it("lets a newer replacement supersede an older unresolved load", async () => {
		const slow = deferred<InlangProject>()
		const older = fakeProject("older")
		const newer = fakeProject("newer")
		host.loadProjectFromDirectory.mockReturnValueOnce(slow.promise).mockResolvedValueOnce(newer)
		const runtime = createProjectSessionEnvironment({ fileSystem })
		const olderReplacement = runtime.replaceProject("/older.inlang")
		const newerReplacement = runtime.replaceProject("/newer.inlang")
		slow.resolve(older)

		await expect(olderReplacement).resolves.toEqual({ status: "superseded" })
		await expect(newerReplacement).resolves.toEqual({ status: "committed" })
		expect(older.close).toHaveBeenCalledTimes(1)
		expect(runtime.activeProject()?.project).toBe(newer)
	})

	it("invalidates the prior lease and closes its project on replacement", async () => {
		const first = fakeProject("first")
		const second = fakeProject("second")
		host.loadProjectFromDirectory.mockResolvedValueOnce(first).mockResolvedValueOnce(second)
		const runtime = createProjectSessionEnvironment({ fileSystem })
		await runtime.replaceProject("/first.inlang")
		const lease = runtime.activeProject()

		await runtime.replaceProject("/second.inlang")

		expect(lease?.isCurrent()).toBe(false)
		expect(first.close).toHaveBeenCalledTimes(1)
		expect(runtime.activeProject()?.project).toBe(second)
	})

	it("unpublishes the project and disposes idempotently", async () => {
		const project = fakeProject("active")
		host.loadProjectFromDirectory.mockResolvedValue(project)
		const runtime = createProjectSessionEnvironment({ fileSystem })
		await runtime.replaceProject("/active.inlang")

		await runtime.dispose()
		await runtime.dispose()

		expect(host.setActiveProject).toHaveBeenLastCalledWith(undefined)
		expect(project.close).toHaveBeenCalledTimes(1)
		expect(runtime.activeProject()).toBeUndefined()
	})

	it("registers code actions for selectors read after project preparation", async () => {
		const selector = { language: "typescript" }
		const project = fakeProject("prepared", [selector])
		host.loadProjectFromDirectory.mockResolvedValue(project)
		const runtime = createProjectSessionEnvironment({ fileSystem })

		await runtime.replaceProject("/prepared.inlang")

		expect(host.prepareProject).toHaveBeenCalledBefore(
			project.plugins.get as ReturnType<typeof vi.fn>
		)
		expect(host.registerCodeActionsProvider).toHaveBeenCalledWith(
			[{ language: "javascript", pattern: "!project.inlang/settings.json" }, selector],
			expect.anything(),
			{ providedCodeActionKinds: ["quickfix"] }
		)
	})

	it("owns immediate resources only for their candidate session", async () => {
		const first = fakeProject("first")
		const second = fakeProject("second")
		const firstResource = disposable()
		const secondResource = disposable()
		host.loadProjectFromDirectory.mockResolvedValueOnce(first).mockResolvedValueOnce(second)
		host.registerCodeActionsProvider
			.mockReturnValueOnce(firstResource)
			.mockReturnValueOnce(secondResource)
		const runtime = createProjectSessionEnvironment({ fileSystem })

		await runtime.replaceProject("/first.inlang")
		const firstSession = host.messagePreview.mock.calls[0]?.[0].session
		await runtime.replaceProject("/second.inlang")
		const secondSession = host.messagePreview.mock.calls[1]?.[0].session

		expect(firstSession).not.toBe(secondSession)
		expect(firstResource.dispose).toHaveBeenCalledTimes(1)
		expect(secondResource.dispose).not.toHaveBeenCalled()
		expect(firstSession.own(disposable())).toBe(false)
		expect(secondSession.own(disposable())).toBe(true)
	})

	it("disposes a candidate with failed required activation and preserves the previous session", async () => {
		const first = fakeProject("first")
		const failed = fakeProject("failed")
		host.loadProjectFromDirectory.mockResolvedValueOnce(first).mockResolvedValueOnce(failed)
		host.registerCodeActionsProvider
			.mockImplementationOnce(() => disposable())
			.mockImplementationOnce(() => {
				throw new Error("registration failed")
			})
		const runtime = createProjectSessionEnvironment({ fileSystem })
		await runtime.replaceProject("/first.inlang")
		const previousLease = runtime.activeProject()

		await expect(runtime.replaceProject("/failed.inlang")).resolves.toMatchObject({
			status: "failed",
		})

		expect(previousLease?.isCurrent()).toBe(true)
		expect(first.close).not.toHaveBeenCalled()
		expect(failed.close).toHaveBeenCalledTimes(1)
	})

	it("deactivates immediate resources before closing the previous project", async () => {
		const order: string[] = []
		const first = fakeProject("first")
		const second = fakeProject("second")
		;(first.close as ReturnType<typeof vi.fn>).mockImplementation(async () => {
			order.push("project")
		})
		host.loadProjectFromDirectory.mockResolvedValueOnce(first).mockResolvedValueOnce(second)
		host.registerCodeActionsProvider.mockReturnValueOnce(
			disposable(() => order.push("code-action"))
		)
		const runtime = createProjectSessionEnvironment({ fileSystem })
		await runtime.replaceProject("/first.inlang")

		await runtime.replaceProject("/second.inlang")

		expect(order.indexOf("code-action")).toBeLessThan(order.indexOf("project"))
	})

	it("disposes session resources in reverse ownership order", async () => {
		const order: string[] = []
		const project = fakeProject("active")
		host.loadProjectFromDirectory.mockResolvedValue(project)
		host.registerCodeActionsProvider.mockReturnValue(disposable(() => order.push("code-action")))
		host.messagePreview.mockImplementation(({ subscriptions }) => {
			subscriptions.push(disposable(() => order.push("preview")))
		})
		host.linterDiagnostics.mockImplementation(async ({ subscriptions }) => {
			subscriptions.push(disposable(() => order.push("diagnostics")))
		})
		const messageView = {
			bindProject: vi.fn(() => disposable(() => order.push("message-view"))),
		}
		const runtime = createProjectSessionEnvironment({ fileSystem, messageView })
		await runtime.replaceProject("/active.inlang")

		await runtime.dispose()

		expect(order).toEqual(["message-view", "diagnostics", "preview", "code-action"])
	})

	it("allows an absent message view and binds a present view once per committed session", async () => {
		const first = fakeProject("first")
		const second = fakeProject("second")
		host.loadProjectFromDirectory.mockResolvedValueOnce(first).mockResolvedValueOnce(second)
		const withoutView = createProjectSessionEnvironment({ fileSystem })
		await expect(withoutView.replaceProject("/first.inlang")).resolves.toEqual({
			status: "committed",
		})
		await withoutView.dispose()

		const messageView = { bindProject: vi.fn(() => disposable()) }
		const withView = createProjectSessionEnvironment({ fileSystem, messageView })
		await withView.replaceProject("/second.inlang")

		expect(messageView.bindProject).toHaveBeenCalledTimes(1)
	})

	it("reports diagnostics activation rejection", async () => {
		const error = new Error("diagnostics failed")
		const project = fakeProject("active")
		host.loadProjectFromDirectory.mockResolvedValue(project)
		host.linterDiagnostics.mockRejectedValue(error)
		const runtime = createProjectSessionEnvironment({ fileSystem })

		await expect(runtime.replaceProject("/active.inlang")).resolves.toEqual({
			status: "committed",
		})
		await vi.waitFor(() => expect(host.handleError).toHaveBeenCalledWith(error))
	})
})
