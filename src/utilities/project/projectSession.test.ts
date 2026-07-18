import { afterEach, describe, expect, it, vi } from "vitest"
import { pollQuery } from "../polling/pollQuery.js"
import { createProjectSessionLifecycle, deactivateBeforeClose } from "./projectSession.js"

function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (reason?: unknown) => void
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise
		reject = rejectPromise
	})
	return { promise, resolve, reject }
}

function fakeProject(name: string) {
	return {
		name,
		close: vi.fn(async () => undefined),
	}
}

function preparedSession() {
	return { activate: () => undefined }
}

afterEach(() => {
	vi.useRealTimers()
})

describe("project session lifecycle", () => {
	it("accepts reconciliation requested while the session's own commit is finishing", async () => {
		const first = fakeProject("first")
		const refreshed = fakeProject("refreshed")
		let requestResult: unknown
		const loadProject = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(refreshed)
		const lifecycle = createProjectSessionLifecycle<ReturnType<typeof fakeProject>>({
			loadProject,
			prepareSession: vi.fn(async (session) => ({
				activate: () => undefined,
				afterPreviousDisposed: () => {
					if (session.project === first) {
						requestResult = session.requestReconciliation()
					}
				},
			})),
			setActiveSession: () => undefined,
		})

		expect(await lifecycle.replaceProject("/project.inlang")).toEqual({ status: "committed" })
		expect(requestResult).toEqual({ status: "scheduled" })
		await vi.waitFor(() => expect(loadProject).toHaveBeenCalledTimes(2))
		await vi.waitFor(() => expect(first.close).toHaveBeenCalledTimes(1))
	})

	it("does not retain watcher intent while a newer user selection is pending", async () => {
		const first = fakeProject("first")
		const secondLoad = deferred<ReturnType<typeof fakeProject>>()
		const refreshed = fakeProject("refreshed")
		let firstSession: any
		const loadProject = vi
			.fn()
			.mockResolvedValueOnce(first)
			.mockReturnValueOnce(secondLoad.promise)
			.mockResolvedValueOnce(refreshed)
		const lifecycle = createProjectSessionLifecycle<ReturnType<typeof fakeProject>>({
			loadProject,
			prepareSession: vi.fn(async () => preparedSession()),
			setActiveSession: (session) => {
				if (session?.project === first) firstSession = session
			},
		})

		await lifecycle.replaceProject("/first.inlang")
		const selection = lifecycle.replaceProject("/second.inlang")

		expect(firstSession.requestReconciliation()).toEqual({ status: "deferred" })
		expect(loadProject).toHaveBeenCalledTimes(2)
		secondLoad.reject(new Error("selection failed"))
		expect(await selection).toMatchObject({ status: "failed" })

		expect(loadProject).toHaveBeenCalledTimes(2)
		expect(firstSession.requestReconciliation()).toEqual({ status: "scheduled" })
		await vi.waitFor(() => expect(loadProject).toHaveBeenCalledTimes(3))
		await vi.waitFor(() => expect(first.close).toHaveBeenCalledTimes(1))
	})

	it("coalesces requests while reconciliation is pending without trailing work", async () => {
		const first = fakeProject("first")
		const refreshed = fakeProject("refreshed")
		const refreshLoad = deferred<typeof refreshed>()
		let firstSession: any
		const loadProject = vi
			.fn()
			.mockResolvedValueOnce(first)
			.mockReturnValueOnce(refreshLoad.promise)
		const notifications: string[] = []
		const lifecycle = createProjectSessionLifecycle<ReturnType<typeof fakeProject>>({
			loadProject,
			prepareSession: vi.fn(async () => preparedSession()),
			setActiveSession: (session) => {
				if (session?.project === first) firstSession = session
			},
			onDidReplaceSession: (session) => {
				notifications.push(session.project.name)
			},
		})

		await lifecycle.replaceProject("/project.inlang")
		expect(firstSession.requestReconciliation()).toEqual({ status: "scheduled" })
		expect(loadProject).toHaveBeenCalledTimes(2)
		for (let event = 0; event < 50; event += 1) {
			expect(firstSession.requestReconciliation()).toEqual({ status: "scheduled" })
		}

		refreshLoad.resolve(refreshed)

		await vi.waitFor(() => expect(first.close).toHaveBeenCalledTimes(1))
		expect(loadProject).toHaveBeenCalledTimes(2)
		expect(notifications).toEqual(["first", "refreshed"])
		expect(refreshed.close).not.toHaveBeenCalled()
	})

	it("does not transfer watcher intent to a committed same-path explicit reload", async () => {
		const first = fakeProject("first")
		const explicitRevision = fakeProject("explicit revision")
		const explicitLoad = deferred<typeof explicitRevision>()
		let firstSession: any
		const loadProject = vi
			.fn()
			.mockResolvedValueOnce(first)
			.mockReturnValueOnce(explicitLoad.promise)
		const lifecycle = createProjectSessionLifecycle<ReturnType<typeof fakeProject>>({
			loadProject,
			prepareSession: vi.fn(async () => preparedSession()),
			setActiveSession: (session) => {
				if (session?.project === first) firstSession = session
			},
		})

		await lifecycle.replaceProject("/project.inlang")
		const explicitReload = lifecycle.replaceProject("/project.inlang")
		expect(firstSession.requestReconciliation()).toEqual({ status: "deferred" })
		explicitLoad.resolve(explicitRevision)

		expect(await explicitReload).toEqual({ status: "committed" })
		expect(loadProject).toHaveBeenCalledTimes(2)
		expect(firstSession.requestReconciliation()).toEqual({ status: "superseded" })
		expect(explicitRevision.close).not.toHaveBeenCalled()
	})

	it("lets a newer user selection supersede an in-flight reconciliation", async () => {
		const first = fakeProject("first")
		const staleRefresh = fakeProject("stale refresh")
		const selected = fakeProject("selected")
		const refreshLoad = deferred<typeof staleRefresh>()
		let firstSession: any
		const loadProject = vi
			.fn()
			.mockResolvedValueOnce(first)
			.mockReturnValueOnce(refreshLoad.promise)
			.mockResolvedValueOnce(selected)
		const lifecycle = createProjectSessionLifecycle<ReturnType<typeof fakeProject>>({
			loadProject,
			prepareSession: vi.fn(async () => preparedSession()),
			setActiveSession: (session) => {
				if (session?.project === first) firstSession = session
			},
		})

		await lifecycle.replaceProject("/first.inlang")
		expect(firstSession.requestReconciliation()).toEqual({ status: "scheduled" })
		const selection = lifecycle.replaceProject("/selected.inlang")
		expect(await selection).toEqual({ status: "committed" })

		refreshLoad.resolve(staleRefresh)
		await vi.waitFor(() => expect(staleRefresh.close).toHaveBeenCalledTimes(1))
		expect(first.close).toHaveBeenCalledTimes(1)
		expect(selected.close).not.toHaveBeenCalled()
	})

	it("allows a later event after a superseded reconciliation and failed selection", async () => {
		const first = fakeProject("first")
		const staleRefresh = fakeProject("stale refresh")
		const recoveredRefresh = fakeProject("recovered refresh")
		const refreshLoad = deferred<typeof staleRefresh>()
		const selectionLoad = deferred<ReturnType<typeof fakeProject>>()
		let firstSession: any
		const loadProject = vi
			.fn()
			.mockResolvedValueOnce(first)
			.mockReturnValueOnce(refreshLoad.promise)
			.mockReturnValueOnce(selectionLoad.promise)
			.mockResolvedValueOnce(recoveredRefresh)
		const lifecycle = createProjectSessionLifecycle<ReturnType<typeof fakeProject>>({
			loadProject,
			prepareSession: vi.fn(async () => preparedSession()),
			setActiveSession: (session) => {
				if (session?.project === first) firstSession = session
			},
		})

		await lifecycle.replaceProject("/first.inlang")
		expect(firstSession.requestReconciliation()).toEqual({ status: "scheduled" })
		const selection = lifecycle.replaceProject("/broken.inlang")

		refreshLoad.resolve(staleRefresh)
		await vi.waitFor(() => expect(staleRefresh.close).toHaveBeenCalledTimes(1))
		selectionLoad.reject(new Error("selection failed"))
		expect(await selection).toMatchObject({ status: "failed" })

		expect(loadProject).toHaveBeenCalledTimes(3)
		expect(firstSession.requestReconciliation()).toEqual({ status: "scheduled" })
		await vi.waitFor(() => expect(loadProject).toHaveBeenCalledTimes(4))
		await vi.waitFor(() => expect(first.close).toHaveBeenCalledTimes(1))
		expect(recoveredRefresh.close).not.toHaveBeenCalled()
	})

	it("lets the current idle session request a fresh project revision", async () => {
		const first = fakeProject("first")
		const refreshed = fakeProject("refreshed")
		let session: any
		const loadProject = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(refreshed)
		const lifecycle = createProjectSessionLifecycle<ReturnType<typeof fakeProject>>({
			loadProject,
			prepareSession: vi.fn(async () => preparedSession()),
			setActiveSession: (value) => {
				if (value?.project === first) session = value
			},
		})

		await lifecycle.replaceProject("/project.inlang")

		expect(session.requestReconciliation()).toEqual({ status: "scheduled" })
		await vi.waitFor(() => expect(loadProject).toHaveBeenCalledTimes(2))
		expect(loadProject).toHaveBeenLastCalledWith("/project.inlang")
		await vi.waitFor(() => expect(first.close).toHaveBeenCalledTimes(1))
	})

	it("rejects reconciliation requests from an inactive session", async () => {
		const first = fakeProject("first")
		const second = fakeProject("second")
		let firstSession: any
		const loadProject = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second)
		const lifecycle = createProjectSessionLifecycle<ReturnType<typeof fakeProject>>({
			loadProject,
			prepareSession: vi.fn(async () => preparedSession()),
			setActiveSession: (session) => {
				if (session?.project === first) firstSession = session
			},
		})

		await lifecycle.replaceProject("/first.inlang")
		await lifecycle.replaceProject("/second.inlang")

		expect(firstSession.requestReconciliation()).toEqual({ status: "superseded" })
		expect(loadProject).toHaveBeenCalledTimes(2)
	})

	it("discards deferred reconciliation when a newer user selection commits", async () => {
		const first = fakeProject("first")
		const second = fakeProject("second")
		const secondLoad = deferred<typeof second>()
		let firstSession: any
		const loadProject = vi.fn().mockResolvedValueOnce(first).mockReturnValueOnce(secondLoad.promise)
		const lifecycle = createProjectSessionLifecycle<ReturnType<typeof fakeProject>>({
			loadProject,
			prepareSession: vi.fn(async () => preparedSession()),
			setActiveSession: (session) => {
				if (session?.project === first) firstSession = session
			},
		})

		await lifecycle.replaceProject("/first.inlang")
		const selection = lifecycle.replaceProject("/second.inlang")

		expect(firstSession.requestReconciliation()).toEqual({ status: "deferred" })
		expect(loadProject).toHaveBeenCalledTimes(2)
		secondLoad.resolve(second)
		expect(await selection).toEqual({ status: "committed" })
		await Promise.resolve()
		expect(loadProject).toHaveBeenCalledTimes(2)
	})

	it("reports a failed reconciliation and allows a later retry", async () => {
		const first = fakeProject("first")
		const refreshed = fakeProject("refreshed")
		const refreshError = new Error("refresh failed")
		let firstSession: any
		const onError = vi.fn()
		const loadProject = vi
			.fn()
			.mockResolvedValueOnce(first)
			.mockRejectedValueOnce(refreshError)
			.mockResolvedValueOnce(refreshed)
		const lifecycle = createProjectSessionLifecycle<ReturnType<typeof fakeProject>>({
			loadProject,
			prepareSession: vi.fn(async () => preparedSession()),
			setActiveSession: (session) => {
				if (session?.project === first) firstSession = session
			},
			onError,
		})

		await lifecycle.replaceProject("/project.inlang")
		expect(firstSession.requestReconciliation()).toEqual({ status: "scheduled" })
		await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(refreshError, "reconciliation"))
		expect(firstSession.requestReconciliation()).toEqual({ status: "scheduled" })
		await vi.waitFor(() => expect(loadProject).toHaveBeenCalledTimes(3))
		await vi.waitFor(() => expect(first.close).toHaveBeenCalledTimes(1))
	})

	it("lets the requesting task settle before reconciliation disposal waits for it", async () => {
		const first = fakeProject("first")
		const refreshed = fakeProject("refreshed")
		let firstSession: any
		const lifecycle = createProjectSessionLifecycle<ReturnType<typeof fakeProject>>({
			loadProject: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(refreshed),
			prepareSession: vi.fn(async () => preparedSession()),
			setActiveSession: (session) => {
				if (session?.project === first) firstSession = session
			},
		})

		await lifecycle.replaceProject("/project.inlang")
		const callback = firstSession.runTask(async () => {
			firstSession.requestReconciliation()
		})

		await expect(callback).resolves.toEqual({ status: "completed", value: undefined })
		await vi.waitFor(() => expect(first.close).toHaveBeenCalledTimes(1))
	})

	it("awaits a scheduled reconciliation while deactivating the lifecycle", async () => {
		const first = fakeProject("first")
		const candidate = fakeProject("candidate")
		const refreshLoad = deferred<typeof candidate>()
		let firstSession: any
		const lifecycle = createProjectSessionLifecycle<ReturnType<typeof fakeProject>>({
			loadProject: vi.fn().mockResolvedValueOnce(first).mockReturnValueOnce(refreshLoad.promise),
			prepareSession: vi.fn(async () => preparedSession()),
			setActiveSession: (session) => {
				if (session?.project === first) firstSession = session
			},
		})

		await lifecycle.replaceProject("/project.inlang")
		expect(firstSession.requestReconciliation()).toEqual({ status: "scheduled" })
		const disposal = lifecycle.dispose()
		let disposed = false
		void disposal.then(() => {
			disposed = true
		})
		await Promise.resolve()
		expect(disposed).toBe(false)

		refreshLoad.resolve(candidate)
		await disposal
		expect(candidate.close).toHaveBeenCalledTimes(1)
		expect(first.close).toHaveBeenCalledTimes(1)
	})

	it("keeps one active resource owner across repeated fresh revisions", async () => {
		let activeResources = 0
		let currentSession: any
		const projects = Array.from({ length: 11 }, (_, index) => fakeProject(`revision-${index}`))
		const lifecycle = createProjectSessionLifecycle<ReturnType<typeof fakeProject>>({
			loadProject: vi.fn(async () => projects.shift()!),
			prepareSession: vi.fn(async (_session, resources) => {
				resources.push({ dispose: () => void (activeResources -= 1) })
				return { activate: () => void (activeResources += 1) }
			}),
			setActiveSession: (session) => {
				if (session) currentSession = session
			},
		})

		await lifecycle.replaceProject("/project.inlang")
		for (let revision = 0; revision < 10; revision += 1) {
			const previousSession = currentSession
			expect(previousSession.requestReconciliation()).toEqual({ status: "scheduled" })
			await vi.waitFor(() => expect(currentSession).not.toBe(previousSession))
			expect(activeResources).toBe(1)
		}

		await lifecycle.dispose()
		expect(activeResources).toBe(0)
	})

	it("replaces the active project and disposes its resources exactly once", async () => {
		const first = fakeProject("first")
		const second = fakeProject("second")
		const firstResource = { dispose: vi.fn() }
		const secondResource = { dispose: vi.fn() }
		const activeProjects: Array<string | undefined> = []
		const lifecycle = createProjectSessionLifecycle<ReturnType<typeof fakeProject>>({
			loadProject: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second),
			prepareSession: vi.fn(async (session, resources) => {
				resources.push(session.project === first ? firstResource : secondResource)
				return preparedSession()
			}),
			setActiveSession: (session) => activeProjects.push(session?.project.name),
		})

		await lifecycle.replaceProject("/first.inlang")
		await lifecycle.replaceProject("/second.inlang")

		expect(activeProjects.at(-1)).toBe("second")
		expect(firstResource.dispose).toHaveBeenCalledTimes(1)
		expect(first.close).toHaveBeenCalledTimes(1)
		expect(secondResource.dispose).not.toHaveBeenCalled()
		expect(second.close).not.toHaveBeenCalled()

		await lifecycle.dispose()
		await lifecycle.dispose()

		expect(secondResource.dispose).toHaveBeenCalledTimes(1)
		expect(second.close).toHaveBeenCalledTimes(1)
	})

	it("keeps the active session when loading or installing its replacement fails", async () => {
		const first = fakeProject("first")
		const failed = fakeProject("failed")
		const firstResource = { dispose: vi.fn() }
		const activeProjects: Array<string | undefined> = []
		const loadProject = vi
			.fn()
			.mockResolvedValueOnce(first)
			.mockRejectedValueOnce(new Error("load failed"))
			.mockResolvedValueOnce(failed)
		const failedResource = { dispose: vi.fn() }
		const prepareSession = vi.fn(async (session, resources) => {
			resources.push(session.project === first ? firstResource : failedResource)
			if (session.project === failed) throw new Error("install failed")
			return preparedSession()
		})
		const lifecycle = createProjectSessionLifecycle<ReturnType<typeof fakeProject>>({
			loadProject,
			prepareSession,
			setActiveSession: (session) => activeProjects.push(session?.project.name),
		})

		await lifecycle.replaceProject("/first.inlang")
		await expect(lifecycle.replaceProject("/load-fails.inlang")).resolves.toMatchObject({
			status: "failed",
			error: expect.objectContaining({ message: "load failed" }),
		})
		expect(activeProjects.at(-1)).toBe("first")
		expect(first.close).not.toHaveBeenCalled()

		await expect(lifecycle.replaceProject("/install-fails.inlang")).resolves.toMatchObject({
			status: "failed",
			error: expect.objectContaining({ message: "install failed" }),
		})
		expect(activeProjects.at(-1)).toBe("first")
		expect(firstResource.dispose).not.toHaveBeenCalled()
		expect(first.close).not.toHaveBeenCalled()
		expect(failedResource.dispose).toHaveBeenCalledTimes(1)
		expect(failed.close).toHaveBeenCalledTimes(1)
	})

	it("keeps the current session published while its replacement is being prepared", async () => {
		const preparation = deferred<void>()
		const first = fakeProject("first")
		const second = fakeProject("second")
		const activeProjects: Array<string | undefined> = []
		const prepareSession = vi.fn(async (session: { project: typeof first }) => {
			if (session.project === second) await preparation.promise
			return preparedSession()
		})
		const lifecycle = createProjectSessionLifecycle<ReturnType<typeof fakeProject>>({
			loadProject: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second),
			prepareSession,
			setActiveSession: (session) => activeProjects.push(session?.project.name),
		})

		await lifecycle.replaceProject("/first.inlang")
		const replacement = lifecycle.replaceProject("/second.inlang")
		await vi.waitFor(() => expect(prepareSession).toHaveBeenCalledTimes(2))
		expect(activeProjects.at(-1)).toBe("first")

		preparation.resolve()
		await replacement

		expect(activeProjects.at(-1)).toBe("second")
	})

	it("does not let a stale asynchronous load replace a newer selection", async () => {
		const slow = deferred<ReturnType<typeof fakeProject>>()
		const fast = deferred<ReturnType<typeof fakeProject>>()
		const slowProject = fakeProject("slow")
		const fastProject = fakeProject("fast")
		const activeProjects: Array<string | undefined> = []
		const lifecycle = createProjectSessionLifecycle<ReturnType<typeof fakeProject>>({
			loadProject: (path) => (path.includes("slow") ? slow.promise : fast.promise),
			prepareSession: vi.fn(async () => preparedSession()),
			setActiveSession: (session) => activeProjects.push(session?.project.name),
		})

		const slowReplacement = lifecycle.replaceProject("/slow.inlang")
		const fastReplacement = lifecycle.replaceProject("/fast.inlang")
		fast.resolve(fastProject)
		expect(await fastReplacement).toEqual({ status: "committed" })
		slow.resolve(slowProject)
		expect(await slowReplacement).toEqual({ status: "superseded" })

		expect(activeProjects.at(-1)).toBe("fast")
		expect(slowProject.close).toHaveBeenCalledTimes(1)
		expect(fastProject.close).not.toHaveBeenCalled()
	})

	it("returns a failed result when a superseded candidate cannot be closed", async () => {
		const slow = deferred<ReturnType<typeof fakeProject>>()
		const slowProject = fakeProject("slow")
		slowProject.close.mockRejectedValueOnce(new Error("close failed"))
		const fastProject = fakeProject("fast")
		const lifecycle = createProjectSessionLifecycle<ReturnType<typeof fakeProject>>({
			loadProject: (path) => (path.includes("slow") ? slow.promise : Promise.resolve(fastProject)),
			prepareSession: vi.fn(async () => preparedSession()),
			setActiveSession: vi.fn(),
		})

		const slowReplacement = lifecycle.replaceProject("/slow.inlang")
		expect(await lifecycle.replaceProject("/fast.inlang")).toEqual({ status: "committed" })
		slow.resolve(slowProject)

		expect(await slowReplacement).toMatchObject({
			status: "failed",
			error: expect.objectContaining({ message: "Failed to close superseded project" }),
		})
		expect(fastProject.close).not.toHaveBeenCalled()
	})

	it("publishes only the latest project during a rapid A to B to C switch", async () => {
		const loads = {
			a: deferred<ReturnType<typeof fakeProject>>(),
			b: deferred<ReturnType<typeof fakeProject>>(),
			c: deferred<ReturnType<typeof fakeProject>>(),
		}
		const projects = {
			a: fakeProject("a"),
			b: fakeProject("b"),
			c: fakeProject("c"),
		}
		const activeProjects: Array<string | undefined> = []
		const lifecycle = createProjectSessionLifecycle<ReturnType<typeof fakeProject>>({
			loadProject: (path) => loads[path.at(1) as "a" | "b" | "c"].promise,
			prepareSession: vi.fn(async () => preparedSession()),
			setActiveSession: (session) => activeProjects.push(session?.project.name),
		})

		const replacements = [
			lifecycle.replaceProject("/a.inlang"),
			lifecycle.replaceProject("/b.inlang"),
			lifecycle.replaceProject("/c.inlang"),
		]
		loads.b.resolve(projects.b)
		loads.c.resolve(projects.c)
		loads.a.resolve(projects.a)

		expect(await Promise.all(replacements)).toEqual([
			{ status: "superseded" },
			{ status: "superseded" },
			{ status: "committed" },
		])
		expect(activeProjects).toEqual(["c"])
		expect(projects.a.close).toHaveBeenCalledTimes(1)
		expect(projects.b.close).toHaveBeenCalledTimes(1)
		expect(projects.c.close).not.toHaveBeenCalled()
	})

	it("does not activate a session superseded while its resources are being prepared", async () => {
		const firstInstall = deferred<void>()
		const first = fakeProject("first")
		const second = fakeProject("second")
		const activeProjects: Array<string | undefined> = []
		const activateSession = vi.fn()
		const prepareSession = vi.fn(async (session: { project: typeof first }) => {
			if (session.project === first) await firstInstall.promise
			return { activate: () => activateSession(session) }
		})
		const lifecycle = createProjectSessionLifecycle<ReturnType<typeof fakeProject>>({
			loadProject: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second),
			prepareSession,
			setActiveSession: (session) => activeProjects.push(session?.project.name),
		})

		const firstReplacement = lifecycle.replaceProject("/first.inlang")
		await vi.waitFor(() => expect(prepareSession).toHaveBeenCalledTimes(1))
		const secondReplacement = lifecycle.replaceProject("/second.inlang")
		firstInstall.resolve()

		expect(await firstReplacement).toEqual({ status: "superseded" })
		expect(await secondReplacement).toEqual({ status: "committed" })
		expect(activeProjects.at(-1)).toBe("second")
		expect(first.close).toHaveBeenCalledTimes(1)
		expect(activateSession).toHaveBeenCalledTimes(1)
		expect(activateSession.mock.calls[0]?.[0].project).toBe(second)
	})

	it("waits for project resources to quiesce before closing the project", async () => {
		const resourceDisposal = deferred<void>()
		const first = fakeProject("first")
		const second = fakeProject("second")
		const lifecycle = createProjectSessionLifecycle<ReturnType<typeof fakeProject>>({
			loadProject: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second),
			prepareSession: vi.fn(async (session, resources) => {
				if (session.project === first) {
					resources.push({ dispose: () => resourceDisposal.promise })
				}
				return preparedSession()
			}),
			setActiveSession: vi.fn(),
		})
		await lifecycle.replaceProject("/first.inlang")

		const replacement = lifecycle.replaceProject("/second.inlang")
		let replacementSettled = false
		void replacement.then(() => {
			replacementSettled = true
		})
		await Promise.resolve()
		expect(replacementSettled).toBe(false)
		expect(first.close).not.toHaveBeenCalled()
		resourceDisposal.resolve()
		await replacement

		expect(first.close).toHaveBeenCalledTimes(1)
	})

	it("waits for active project tasks before closing and rejects stale work", async () => {
		const runningTask = deferred<void>()
		const first = fakeProject("first")
		const second = fakeProject("second")
		let firstSession: any
		const lifecycle = createProjectSessionLifecycle<ReturnType<typeof fakeProject>>({
			loadProject: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second),
			prepareSession: vi.fn(async () => preparedSession()),
			setActiveSession: (session) => {
				if (session?.project === first) firstSession = session
			},
		})
		await lifecycle.replaceProject("/first.inlang")
		const task = firstSession.runTask(async () => {
			await runningTask.promise
			return "finished"
		})

		const replacement = lifecycle.replaceProject("/second.inlang")
		await Promise.resolve()
		expect(first.close).not.toHaveBeenCalled()
		runningTask.resolve()
		await replacement

		expect(await task).toEqual({ status: "inactive" })
		expect(first.close).toHaveBeenCalledTimes(1)
		const staleWork = vi.fn(async () => "stale")
		expect(await firstSession.runTask(staleWork)).toEqual({ status: "inactive" })
		expect(staleWork).not.toHaveBeenCalled()
	})

	it("bounds lifecycle disposal without closing a project used by unresolved work", async () => {
		vi.useFakeTimers()
		const runningTask = deferred<void>()
		const project = fakeProject("active")
		const resource = { dispose: vi.fn() }
		let session: any
		const lifecycle = createProjectSessionLifecycle<ReturnType<typeof fakeProject>>({
			loadProject: vi.fn(async () => project),
			prepareSession: vi.fn(async (_session, resources) => {
				resources.push(resource)
				return preparedSession()
			}),
			setActiveSession: (value) => {
				session = value
			},
			cleanupGraceMs: 100,
		})
		await lifecycle.replaceProject("/active.inlang")
		const task = session.runTask(() => runningTask.promise)

		const disposal = lifecycle.dispose()
		expect(lifecycle.dispose()).toBe(disposal)
		let disposalSettled = false
		void disposal.then(() => {
			disposalSettled = true
		})
		await vi.advanceTimersByTimeAsync(99)
		expect(disposalSettled).toBe(false)
		expect(project.close).not.toHaveBeenCalled()

		await vi.advanceTimersByTimeAsync(1)
		await disposal
		expect(resource.dispose).not.toHaveBeenCalled()
		expect(project.close).not.toHaveBeenCalled()

		runningTask.resolve()
		await task
		await vi.waitFor(() => expect(project.close).toHaveBeenCalledTimes(1))
		expect(resource.dispose).toHaveBeenCalledTimes(1)
		expect(resource.dispose.mock.invocationCallOrder[0]).toBeLessThan(
			project.close.mock.invocationCallOrder[0]!
		)
	})

	it("deactivates the published session before awaiting an in-flight replacement", async () => {
		const active = fakeProject("active")
		const candidate = fakeProject("candidate")
		const candidateLoad = deferred<typeof candidate>()
		const earlyDeactivate = vi.fn()
		let session: any
		const lifecycle = createProjectSessionLifecycle<ReturnType<typeof fakeProject>>({
			loadProject: vi.fn().mockResolvedValueOnce(active).mockReturnValueOnce(candidateLoad.promise),
			prepareSession: vi.fn(async (value, resources) => {
				if (value.project === active) {
					resources.push({ deactivate: earlyDeactivate, dispose: vi.fn() })
				}
				return preparedSession()
			}),
			setActiveSession: (value) => {
				if (value?.project === active) session = value
			},
		})
		await lifecycle.replaceProject("/active.inlang")
		const replacement = lifecycle.replaceProject("/candidate.inlang")

		const disposal = lifecycle.dispose()

		expect(earlyDeactivate).toHaveBeenCalledTimes(1)
		expect(await session.runTask(async () => "stale")).toEqual({ status: "inactive" })
		expect(session.own({ dispose: vi.fn() })).toBe(false)

		candidateLoad.resolve(candidate)
		expect(await replacement).toEqual({ status: "superseded" })
		await disposal
	})

	it("bounds deactivation while a project replacement never settles", async () => {
		vi.useFakeTimers()
		const loading = deferred<ReturnType<typeof fakeProject>>()
		const setActiveSession = vi.fn()
		const lifecycle = createProjectSessionLifecycle<ReturnType<typeof fakeProject>>({
			loadProject: () => loading.promise,
			prepareSession: vi.fn(async () => preparedSession()),
			setActiveSession,
			cleanupGraceMs: 100,
		})
		void lifecycle.replaceProject("/blocked.inlang")

		let disposed = false
		const disposal = lifecycle.dispose().then(() => {
			disposed = true
		})
		await vi.advanceTimersByTimeAsync(99)
		expect(disposed).toBe(false)

		await vi.advanceTimersByTimeAsync(1)
		await disposal
		expect(disposed).toBe(true)
		expect(setActiveSession).toHaveBeenCalledWith(undefined)
	})

	it("observes immediate cleanup failures while an in-flight replacement settles", async () => {
		const active = fakeProject("active")
		const candidate = fakeProject("candidate")
		const candidateLoad = deferred<typeof candidate>()
		const cleanupError = new Error("cleanup failed")
		const lifecycle = createProjectSessionLifecycle<ReturnType<typeof fakeProject>>({
			loadProject: vi.fn().mockResolvedValueOnce(active).mockReturnValueOnce(candidateLoad.promise),
			prepareSession: vi.fn(async (session, resources) => {
				if (session.project === active) {
					resources.push({ dispose: () => Promise.reject(cleanupError) })
				}
				return preparedSession()
			}),
			setActiveSession: vi.fn(),
		})
		await lifecycle.replaceProject("/active.inlang")
		const replacement = lifecycle.replaceProject("/candidate.inlang")

		const disposal = lifecycle.dispose()
		await Promise.resolve()
		candidateLoad.resolve(candidate)

		expect(await replacement).toEqual({ status: "superseded" })
		await expect(disposal).rejects.toMatchObject({
			message: "Failed to dispose project lifecycle",
		})
		expect(active.close).toHaveBeenCalledTimes(1)
	})

	it("commits a replacement after grace and finalizes the retained project exactly once", async () => {
		vi.useFakeTimers()
		const runningTask = deferred<void>()
		const first = fakeProject("first")
		const second = fakeProject("second")
		let firstSession: any
		let activeProject: typeof first | undefined
		const lifecycle = createProjectSessionLifecycle<ReturnType<typeof fakeProject>>({
			loadProject: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second),
			prepareSession: vi.fn(async () => preparedSession()),
			setActiveSession: (session) => {
				activeProject = session?.project
				if (session?.project === first) firstSession = session
			},
			cleanupGraceMs: 100,
		})
		await lifecycle.replaceProject("/first.inlang")
		const task = firstSession.runTask(() => runningTask.promise)

		const replacement = lifecycle.replaceProject("/second.inlang")
		await vi.advanceTimersByTimeAsync(100)

		expect(await replacement).toEqual({ status: "committed" })
		expect(activeProject).toBe(second)
		expect(first.close).not.toHaveBeenCalled()
		expect(await firstSession.runTask(async () => "stale")).toEqual({ status: "inactive" })

		runningTask.resolve()
		await task
		await vi.waitFor(() => expect(first.close).toHaveBeenCalledTimes(1))
		await lifecycle.dispose()
		expect(first.close).toHaveBeenCalledTimes(1)
		expect(second.close).toHaveBeenCalledTimes(1)
	})

	it("reports a detached finalizer failure through the cleanup error channel", async () => {
		vi.useFakeTimers()
		const runningTask = deferred<void>()
		const taskError = new Error("late task failure")
		const project = fakeProject("active")
		const onError = vi.fn()
		let session: any
		const lifecycle = createProjectSessionLifecycle<ReturnType<typeof fakeProject>>({
			loadProject: vi.fn(async () => project),
			prepareSession: vi.fn(async () => preparedSession()),
			setActiveSession: (value) => {
				session = value
			},
			onError,
			cleanupGraceMs: 100,
		})
		await lifecycle.replaceProject("/active.inlang")
		void session.runTask(() => runningTask.promise).catch(() => undefined)

		const disposal = lifecycle.dispose()
		await vi.advanceTimersByTimeAsync(100)
		await disposal
		runningTask.reject(taskError)

		await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1))
		expect(onError).toHaveBeenCalledWith(
			expect.objectContaining({ message: "Failed to dispose project session" }),
			"cleanup"
		)
		expect(project.close).toHaveBeenCalledTimes(1)
	})

	it("bounds a never-settling poll while suppressing late view delivery", async () => {
		vi.useFakeTimers()
		const queryResult = deferred<string[]>()
		const project = fakeProject("active")
		const subscriber = vi.fn()
		const query = vi.fn(() => queryResult.promise)
		let session: any
		const lifecycle = createProjectSessionLifecycle<ReturnType<typeof fakeProject>>({
			loadProject: vi.fn(async () => project),
			prepareSession: vi.fn(async () => preparedSession()),
			setActiveSession: (value) => {
				session = value
			},
			cleanupGraceMs: 100,
		})
		await lifecycle.replaceProject("/active.inlang")
		const subscription = pollQuery(async () => {
			const result = await session.runTask(query)
			return result.status === "completed" ? result.value : []
		}, 50).subscribe(subscriber)
		expect(session.own(deactivateBeforeClose({ dispose: () => subscription.unsubscribe() }))).toBe(
			true
		)
		expect(query).toHaveBeenCalledTimes(1)

		const disposal = lifecycle.dispose()
		await vi.advanceTimersByTimeAsync(100)
		await disposal
		expect(project.close).not.toHaveBeenCalled()

		queryResult.resolve(["stale"])
		await vi.waitFor(() => expect(project.close).toHaveBeenCalledTimes(1))
		await vi.advanceTimersByTimeAsync(500)
		expect(query).toHaveBeenCalledTimes(1)
		expect(subscriber).not.toHaveBeenCalled()
	})

	it("distinguishes a completed undefined value from inactive work", async () => {
		const project = fakeProject("project")
		let session: any
		const lifecycle = createProjectSessionLifecycle<ReturnType<typeof fakeProject>>({
			loadProject: vi.fn(async () => project),
			prepareSession: vi.fn(async () => preparedSession()),
			setActiveSession: (value) => {
				session = value
			},
		})
		await lifecycle.replaceProject("/project.inlang")

		expect(await session.runTask(async () => undefined)).toEqual({
			status: "completed",
			value: undefined,
		})
	})

	it("deactivates callbacks before waiting for old project tasks", async () => {
		const runningTask = deferred<void>()
		const first = fakeProject("first")
		const second = fakeProject("second")
		const callbackRegistration = { dispose: vi.fn() }
		let outputDisposed = false
		const taskOutput = {
			dispose: vi.fn(() => {
				outputDisposed = true
			}),
			write: vi.fn(() => {
				if (outputDisposed) throw new Error("task output was disposed before the task settled")
			}),
		}
		let firstSession: any
		const lifecycle = createProjectSessionLifecycle<ReturnType<typeof fakeProject>>({
			loadProject: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second),
			prepareSession: vi.fn(async (session, resources) => {
				if (session.project === first) {
					resources.push(taskOutput, deactivateBeforeClose(callbackRegistration))
				}
				return preparedSession()
			}),
			setActiveSession: (session) => {
				if (session?.project === first) firstSession = session
			},
		})
		await lifecycle.replaceProject("/first.inlang")
		void firstSession.runTask(async () => {
			await runningTask.promise
			taskOutput.write()
		})

		const replacement = lifecycle.replaceProject("/second.inlang")
		await vi.waitFor(() => expect(callbackRegistration.dispose).toHaveBeenCalledTimes(1))

		expect(first.close).not.toHaveBeenCalled()
		expect(taskOutput.dispose).not.toHaveBeenCalled()
		runningTask.resolve()
		await replacement
		expect(taskOutput.write).toHaveBeenCalledTimes(1)
		expect(taskOutput.dispose).toHaveBeenCalledTimes(1)
		expect(first.close).toHaveBeenCalledTimes(1)
	})

	it("reports old-session cleanup errors without turning a committed replacement into failure", async () => {
		const first = fakeProject("first")
		const second = fakeProject("second")
		const cleanupError = new Error("cleanup failed")
		const onError = vi.fn()
		const activeProjects: Array<string | undefined> = []
		const lifecycle = createProjectSessionLifecycle<ReturnType<typeof fakeProject>>({
			loadProject: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second),
			prepareSession: vi.fn(async (session, resources) => {
				if (session.project === first) {
					resources.push({ dispose: () => Promise.reject(cleanupError) })
				}
				return preparedSession()
			}),
			setActiveSession: (session) => activeProjects.push(session?.project.name),
			onError,
		})

		await lifecycle.replaceProject("/first.inlang")
		await expect(lifecycle.replaceProject("/second.inlang")).resolves.toEqual({
			status: "committed",
		})

		expect(activeProjects.at(-1)).toBe("second")
		expect(first.close).toHaveBeenCalledTimes(1)
		expect(onError).toHaveBeenCalledTimes(1)
	})

	it("keeps committed-success semantics when notification and error reporting fail", async () => {
		const first = fakeProject("first")
		const second = fakeProject("second")
		const notificationError = new Error("notification failed")
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
		const activeProjects: Array<string | undefined> = []
		const lifecycle = createProjectSessionLifecycle<ReturnType<typeof fakeProject>>({
			loadProject: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second),
			prepareSession: vi.fn(async () => preparedSession()),
			setActiveSession: (session) => activeProjects.push(session?.project.name),
			onDidReplaceSession: vi
				.fn()
				.mockResolvedValueOnce(undefined)
				.mockRejectedValueOnce(notificationError),
			onError: () => {
				throw new Error("reporting failed")
			},
		})

		await lifecycle.replaceProject("/first.inlang")
		await expect(lifecycle.replaceProject("/second.inlang")).resolves.toEqual({
			status: "committed",
		})

		expect(activeProjects.at(-1)).toBe("second")
		expect(first.close).toHaveBeenCalledTimes(1)
		expect(consoleError).toHaveBeenCalledWith(
			"Failed to report project-session error",
			expect.any(Error)
		)
		consoleError.mockRestore()
	})

	it("preserves publication and cleanup errors when a candidate cannot be published", async () => {
		const candidate = fakeProject("candidate")
		const publicationError = new Error("publication failed")
		candidate.close.mockRejectedValueOnce(new Error("cleanup failed"))
		const lifecycle = createProjectSessionLifecycle<ReturnType<typeof fakeProject>>({
			loadProject: vi.fn(async () => candidate),
			prepareSession: vi.fn(async () => preparedSession()),
			setActiveSession: (session) => {
				if (session) throw publicationError
			},
		})

		const result = await lifecycle.replaceProject("/candidate.inlang")

		expect(result).toMatchObject({
			status: "failed",
			error: expect.objectContaining({
				message: "Failed to publish and clean up project session",
			}),
		})
		if (result.status !== "failed" || !(result.error instanceof AggregateError)) {
			throw new Error("Expected an aggregate publication failure")
		}
		expect(result.error.errors).toContain(publicationError)
		expect(candidate.close).toHaveBeenCalledTimes(1)
	})

	it("closes a candidate when disposed while its resources are being prepared", async () => {
		const preparation = deferred<void>()
		const candidate = fakeProject("candidate")
		const prepareSession = vi.fn(async () => {
			await preparation.promise
			return preparedSession()
		})
		const lifecycle = createProjectSessionLifecycle<ReturnType<typeof fakeProject>>({
			loadProject: vi.fn(async () => candidate),
			prepareSession,
			setActiveSession: vi.fn(),
		})

		const replacement = lifecycle.replaceProject("/candidate.inlang")
		await vi.waitFor(() => expect(prepareSession).toHaveBeenCalledTimes(1))
		const disposal = lifecycle.dispose()
		preparation.resolve()

		expect(await replacement).toEqual({ status: "superseded" })
		await disposal
		expect(candidate.close).toHaveBeenCalledTimes(1)
	})

	it("closes an in-flight project when disposed during loading", async () => {
		const loading = deferred<ReturnType<typeof fakeProject>>()
		const loadedProject = fakeProject("loaded")
		const lifecycle = createProjectSessionLifecycle<ReturnType<typeof fakeProject>>({
			loadProject: () => loading.promise,
			prepareSession: vi.fn(async () => preparedSession()),
			setActiveSession: vi.fn(),
		})

		const replacement = lifecycle.replaceProject("/loaded.inlang")
		const disposal = lifecycle.dispose()
		loading.resolve(loadedProject)

		expect(await replacement).toEqual({ status: "superseded" })
		await disposal
		expect(loadedProject.close).toHaveBeenCalledTimes(1)
	})

	it("closes the active project when clearing published state fails during disposal", async () => {
		const project = fakeProject("active")
		const publicationError = new Error("publication failed")
		const lifecycle = createProjectSessionLifecycle<ReturnType<typeof fakeProject>>({
			loadProject: vi.fn(async () => project),
			prepareSession: vi.fn(async () => preparedSession()),
			setActiveSession: (session) => {
				if (!session) throw publicationError
			},
		})
		await lifecycle.replaceProject("/active.inlang")

		await expect(lifecycle.dispose()).rejects.toMatchObject({
			message: "Failed to dispose project lifecycle",
		})
		expect(project.close).toHaveBeenCalledTimes(1)
	})
})
