import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { InlangProject } from "@inlang/sdk"
import type { FileSystem } from "../fs/createFileSystemMapper.js"

const host = vi.hoisted(() => {
	return {
		loadProjectFromDirectory: vi.fn(),
		watchProject: vi.fn(),
		prepareProject: vi.fn(),
		setActiveProject: vi.fn(),
		registerCodeActionsProvider: vi.fn(),
		messagePreview: vi.fn(),
		linterDiagnostics: vi.fn(),
		handleError: vi.fn(),
		projectChange: vi.fn(),
	}
})

vi.mock("vscode", () => ({
	RelativePattern: class {},
	Uri: { file: (fsPath: string) => ({ fsPath }) },
	languages: {
		registerCodeActionsProvider: host.registerCodeActionsProvider,
	},
}))

vi.mock("@inlang/sdk", () => ({
	loadProjectFromDirectory: host.loadProjectFromDirectory,
}))

vi.mock("./projectResourceSynchronization.js", () => ({
	projectResourceSynchronization: {
		load: host.loadProjectFromDirectory,
		watch: host.watchProject,
	},
}))

vi.mock("../state.js", () => ({
	prepareProject: host.prepareProject,
	setActiveProject: host.setActiveProject,
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
		EVENTS: { ON_DID_PROJECT_CHANGE: { fire: host.projectChange } },
	},
}))

vi.mock("../utils.js", () => ({
	handleError: host.handleError,
}))

import { createProjectSessionEnvironment } from "./projectSessionEnvironment.js"

function fakeProject(
	name: string,
	documentSelectors: Array<{ language: string }> = [],
	resourcePaths: string[] = []
) {
	return {
		name,
		close: vi.fn(async () => undefined),
		settings: { get: vi.fn(async () => ({ locales: ["en"] })) },
		errors: { get: vi.fn(async () => []) },
		plugins: {
			get: vi.fn(async () => [
				{
					meta: {
						"app.inlang.ideExtension": { documentSelectors },
					},
				},
				...(resourcePaths.length
					? [
							{
								key: `plugin.${name}`,
								importFiles: vi.fn(),
								toBeImportedFiles: vi.fn(async () =>
									resourcePaths.map((path) => ({ path, locale: "en" }))
								),
							},
						]
					: []),
			]),
		},
	} as unknown as InlangProject
}

function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (error: unknown) => void
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise
		reject = rejectPromise
	})
	return { promise, resolve, reject }
}

const fileSystem = {} as FileSystem

function disposable(onDispose: () => unknown = vi.fn()) {
	return { deactivate: onDispose, dispose: onDispose }
}

beforeEach(() => {
	vi.clearAllMocks()
	host.loadProjectFromDirectory.mockReset()
	host.watchProject.mockReset()
	host.watchProject.mockResolvedValue(undefined)
	host.registerCodeActionsProvider.mockReset()
	host.messagePreview.mockReset()
	host.linterDiagnostics.mockReset()
	host.registerCodeActionsProvider.mockImplementation(() => disposable())
	host.messagePreview.mockImplementation(() => undefined)
	host.linterDiagnostics.mockResolvedValue(undefined)
})

afterEach(() => {
	vi.useRealTimers()
})

describe("project session environment", () => {
	it("loads and publishes the first project", async () => {
		const project = fakeProject("first")
		host.loadProjectFromDirectory.mockResolvedValue(project)
		const runtime = createProjectSessionEnvironment({ fileSystem })

		await expect(runtime.replaceProject("/first.inlang")).resolves.toEqual({
			status: "committed",
		})

		expect(host.loadProjectFromDirectory).toHaveBeenCalledWith("/first.inlang")
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

	it("rolls active publication back when publishing a candidate fails", async () => {
		const first = fakeProject("first")
		const candidate = fakeProject("candidate")
		const publicationError = new Error("publication failed")
		host.loadProjectFromDirectory.mockResolvedValueOnce(first).mockResolvedValueOnce(candidate)
		const runtime = createProjectSessionEnvironment({ fileSystem })
		await runtime.replaceProject("/first.inlang")
		const previousLease = runtime.activeProject()
		host.setActiveProject.mockImplementationOnce(() => {
			throw publicationError
		})

		await expect(runtime.replaceProject("/candidate.inlang")).resolves.toEqual({
			status: "failed",
			error: publicationError,
		})

		expect(previousLease?.isCurrent()).toBe(true)
		expect(runtime.activeProject()?.project).toBe(first)
		expect(host.setActiveProject).toHaveBeenLastCalledWith({
			project: first,
			path: "/first.inlang",
		})
		expect(first.close).not.toHaveBeenCalled()
		expect(candidate.close).toHaveBeenCalledTimes(1)
		expect(host.projectChange).toHaveBeenCalledTimes(1)
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
		host.messagePreview.mockImplementation(
			({ subscriptions }: { subscriptions: Array<ReturnType<typeof disposable>> }) => {
				subscriptions.push(disposable(() => order.push("preview")))
			}
		)
		host.linterDiagnostics.mockImplementation(
			async ({ subscriptions }: { subscriptions: Array<ReturnType<typeof disposable>> }) => {
				subscriptions.push(disposable(() => order.push("diagnostics")))
			}
		)
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

	it("reconciles the committed session when resource synchronization requests it", async () => {
		vi.useFakeTimers()
		const resourcePath = "/resources/messages.json"
		const first = fakeProject("first", [], [resourcePath])
		const superseded = fakeProject("superseded", [], [resourcePath])
		const latest = fakeProject("latest", [], [resourcePath])
		const reconciled = fakeProject("reconciled")
		const slow = deferred<InlangProject>()
		const latestPreparation = deferred<Awaited<ReturnType<InlangProject["plugins"]["get"]>>>()
		const latestPlugins = await latest.plugins.get()
		;(latest.plugins.get as ReturnType<typeof vi.fn>)
			.mockReturnValueOnce(latestPreparation.promise)
			.mockResolvedValue(latestPlugins)
		host.watchProject.mockImplementation(async (session) => {
			if (session.project === latest) session.requestReconciliation()
		})
		host.loadProjectFromDirectory
			.mockResolvedValueOnce(first)
			.mockReturnValueOnce(slow.promise)
			.mockResolvedValueOnce(latest)
			.mockResolvedValueOnce(reconciled)
		const runtime = createProjectSessionEnvironment({ fileSystem })
		await runtime.replaceProject("/first.inlang")

		const olderReplacement = runtime.replaceProject("/superseded.inlang")
		const latestReplacement = runtime.replaceProject("/latest.inlang")
		for (let index = 0; index < 10; index += 1) await Promise.resolve()
		slow.resolve(superseded)
		for (let index = 0; index < 10; index += 1) await Promise.resolve()
		latestPreparation.resolve(latestPlugins)
		await expect(olderReplacement).resolves.toEqual({ status: "superseded" })
		await expect(latestReplacement).resolves.toEqual({ status: "committed" })
		await vi.advanceTimersByTimeAsync(200)
		for (let index = 0; index < 10; index += 1) await Promise.resolve()

		expect(host.loadProjectFromDirectory).toHaveBeenCalledTimes(4)
		expect(runtime.activeProject()?.project).toBe(reconciled)
	})

	it("closes the previous project before the next watcher becomes authoritative", async () => {
		const first = fakeProject("first", [], ["/resources/first.json"])
		const second = fakeProject("second", [], ["/resources/second.json"])
		const synchronizedResources: Array<ReturnType<typeof disposable>> = []
		host.watchProject.mockImplementation(async (session) => {
			const resource = disposable()
			synchronizedResources.push(resource)
			session.own(resource)
		})
		host.loadProjectFromDirectory.mockResolvedValueOnce(first).mockResolvedValueOnce(second)
		const runtime = createProjectSessionEnvironment({ fileSystem })
		await runtime.replaceProject("/first.inlang")

		await runtime.replaceProject("/second.inlang")

		expect((first.close as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]).toBeLessThan(
			host.watchProject.mock.invocationCallOrder[1]!
		)
		expect(synchronizedResources[0]?.dispose).toHaveBeenCalledTimes(1)
		await runtime.dispose()
	})

	it("reconciles a resource change reported during the load-to-watch handoff", async () => {
		vi.useFakeTimers()
		const resourcePath = "/resources/messages.json"
		const initial = fakeProject("initial", [], [resourcePath])
		const reconciled = fakeProject("reconciled")
		host.watchProject.mockImplementationOnce(async (session) => {
			session.requestReconciliation()
		})
		host.loadProjectFromDirectory.mockResolvedValueOnce(initial).mockResolvedValueOnce(reconciled)
		const runtime = createProjectSessionEnvironment({ fileSystem })

		await runtime.replaceProject("/project.inlang")
		await vi.advanceTimersByTimeAsync(200)
		for (let index = 0; index < 10; index += 1) await Promise.resolve()

		expect(host.loadProjectFromDirectory).toHaveBeenCalledTimes(2)
		expect(runtime.activeProject()?.project).toBe(reconciled)
	})

	it("keeps an explicit selection over reconciliation from the prior project", async () => {
		vi.useFakeTimers()
		const resourcePath = "/resources/messages.json"
		const first = fakeProject("first", [], [resourcePath])
		const second = fakeProject("second")
		const secondLoad = deferred<InlangProject>()
		host.watchProject.mockImplementationOnce(async (session) => {
			setTimeout(() => session.requestReconciliation(), 150)
		})
		host.loadProjectFromDirectory
			.mockResolvedValueOnce(first)
			.mockReturnValueOnce(secondLoad.promise)
		const runtime = createProjectSessionEnvironment({ fileSystem })
		await runtime.replaceProject("/first.inlang")
		await vi.advanceTimersByTimeAsync(1)

		const explicitReplacement = runtime.replaceProject("/second.inlang")
		await vi.advanceTimersByTimeAsync(200)
		secondLoad.resolve(second)

		await expect(explicitReplacement).resolves.toEqual({ status: "committed" })
		expect(host.loadProjectFromDirectory).toHaveBeenCalledTimes(2)
		expect(runtime.activeProject()?.project).toBe(second)
	})

	it("replays deferred reconciliation when a newer explicit selection fails", async () => {
		vi.useFakeTimers()
		const resourcePath = "/resources/messages.json"
		const first = fakeProject("first", [], [resourcePath])
		const reconciled = fakeProject("reconciled")
		const secondLoad = deferred<InlangProject>()
		host.watchProject.mockImplementationOnce(async (session) => {
			setTimeout(() => session.requestReconciliation(), 150)
		})
		host.loadProjectFromDirectory
			.mockResolvedValueOnce(first)
			.mockReturnValueOnce(secondLoad.promise)
			.mockResolvedValueOnce(reconciled)
		const runtime = createProjectSessionEnvironment({ fileSystem })
		await runtime.replaceProject("/first.inlang")
		await vi.advanceTimersByTimeAsync(1)

		const failedReplacement = runtime.replaceProject("/second.inlang")
		await vi.advanceTimersByTimeAsync(200)
		secondLoad.reject(new Error("selection failed"))

		await expect(failedReplacement).resolves.toMatchObject({ status: "failed" })
		await vi.waitFor(() => expect(runtime.activeProject()?.project).toBe(reconciled))
		expect(host.loadProjectFromDirectory).toHaveBeenCalledTimes(3)
	})

	it("reports watcher setup failure without changing committed replacement semantics", async () => {
		const watcherError = new Error("watcher setup failed")
		const project = fakeProject("active")
		host.watchProject.mockRejectedValueOnce(watcherError)
		host.loadProjectFromDirectory.mockResolvedValue(project)
		const runtime = createProjectSessionEnvironment({ fileSystem })

		await expect(runtime.replaceProject("/active.inlang")).resolves.toEqual({
			status: "committed",
		})

		expect(host.handleError).toHaveBeenCalledWith(watcherError)
		expect(project.errors.get).not.toHaveBeenCalled()
		expect(host.projectChange).toHaveBeenCalledTimes(1)
	})

	it("notifies exactly once for committed replacements only", async () => {
		const first = fakeProject("first")
		const superseded = fakeProject("superseded")
		const latest = fakeProject("latest")
		const slow = deferred<InlangProject>()
		host.loadProjectFromDirectory
			.mockResolvedValueOnce(first)
			.mockRejectedValueOnce(new Error("load failed"))
			.mockReturnValueOnce(slow.promise)
			.mockResolvedValueOnce(latest)
		const runtime = createProjectSessionEnvironment({ fileSystem })

		await runtime.replaceProject("/first.inlang")
		await runtime.replaceProject("/failed.inlang")
		const olderReplacement = runtime.replaceProject("/superseded.inlang")
		const latestReplacement = runtime.replaceProject("/latest.inlang")
		slow.resolve(superseded)
		await olderReplacement
		await latestReplacement

		expect(host.projectChange).toHaveBeenCalledTimes(2)
	})

	it("bounds repeated shutdown and disposes the active watcher once", async () => {
		vi.useFakeTimers()
		const project = fakeProject("active")
		const synchronizedResource = disposable()
		host.watchProject.mockImplementationOnce(async (session) => {
			session.own(synchronizedResource)
		})
		host.loadProjectFromDirectory.mockResolvedValue(project)
		const runtime = createProjectSessionEnvironment({ fileSystem })
		await runtime.replaceProject("/active.inlang")
		void runtime.activeProject()?.runTask(() => new Promise<void>(() => undefined))

		const firstDisposal = runtime.dispose()
		const secondDisposal = runtime.dispose()
		expect(firstDisposal).toBe(secondDisposal)
		await vi.advanceTimersByTimeAsync(1_001)
		await Promise.all([firstDisposal, secondDisposal])

		expect(synchronizedResource.dispose).toHaveBeenCalledTimes(1)
		expect(project.close).not.toHaveBeenCalled()
	})
})
