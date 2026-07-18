import { describe, expect, it, vi } from "vitest"
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

	it("defers reconciliation until a newer user selection fails", async () => {
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

		await vi.waitFor(() => expect(loadProject).toHaveBeenCalledTimes(3))
		await vi.waitFor(() => expect(first.close).toHaveBeenCalledTimes(1))
	})

	it("runs one bounded trailing reconciliation for work arriving after the active snapshot", async () => {
		const first = fakeProject("first")
		const staleRefresh = fakeProject("stale refresh")
		const trailingRefresh = fakeProject("trailing refresh")
		const refreshLoad = deferred<typeof staleRefresh>()
		let firstSession: any
		const loadProject = vi
			.fn()
			.mockResolvedValueOnce(first)
			.mockReturnValueOnce(refreshLoad.promise)
			.mockResolvedValueOnce(trailingRefresh)
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

		refreshLoad.resolve(staleRefresh)

		await vi.waitFor(() => expect(loadProject).toHaveBeenCalledTimes(3))
		await vi.waitFor(() => expect(staleRefresh.close).toHaveBeenCalledTimes(1))
		expect(loadProject).toHaveBeenCalledTimes(3)
		expect(notifications).toEqual(["first", "stale refresh", "trailing refresh"])
		expect(trailingRefresh.close).not.toHaveBeenCalled()
	})

	it("transfers dirty work to a committed same-path explicit reload", async () => {
		const first = fakeProject("first")
		const staleExplicitReload = fakeProject("stale explicit reload")
		const trailingRefresh = fakeProject("trailing refresh")
		const explicitLoad = deferred<typeof staleExplicitReload>()
		let firstSession: any
		const loadProject = vi
			.fn()
			.mockResolvedValueOnce(first)
			.mockReturnValueOnce(explicitLoad.promise)
			.mockResolvedValueOnce(trailingRefresh)
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
		explicitLoad.resolve(staleExplicitReload)

		expect(await explicitReload).toEqual({ status: "committed" })
		await vi.waitFor(() => expect(loadProject).toHaveBeenCalledTimes(3))
		await vi.waitFor(() => expect(staleExplicitReload.close).toHaveBeenCalledTimes(1))
		expect(trailingRefresh.close).not.toHaveBeenCalled()
	})

	it("transfers watcher dirty work recorded before its debounce timer fires", async () => {
		const first = fakeProject("first")
		const explicitReload = fakeProject("explicit reload")
		const trailingRefresh = fakeProject("trailing refresh")
		let firstSession: any
		const loadProject = vi
			.fn()
			.mockResolvedValueOnce(first)
			.mockResolvedValueOnce(explicitReload)
			.mockResolvedValueOnce(trailingRefresh)
		const lifecycle = createProjectSessionLifecycle<ReturnType<typeof fakeProject>>({
			loadProject,
			prepareSession: vi.fn(async () => preparedSession()),
			setActiveSession: (session) => {
				if (session?.project === first) firstSession = session
			},
		})

		await lifecycle.replaceProject("/project.inlang")
		expect(firstSession.requestReconciliation({ deferStart: true })).toEqual({ status: "deferred" })
		expect(loadProject).toHaveBeenCalledTimes(1)

		expect(await lifecycle.replaceProject("/project.inlang")).toEqual({ status: "committed" })

		await vi.waitFor(() => expect(loadProject).toHaveBeenCalledTimes(3))
		await vi.waitFor(() => expect(explicitReload.close).toHaveBeenCalledTimes(1))
		expect(trailingRefresh.close).not.toHaveBeenCalled()
	})

	it("does not start debounced work from an earlier reconciliation finalizer", async () => {
		const first = fakeProject("first")
		const reconciliation = fakeProject("reconciliation")
		const debouncedRefresh = fakeProject("debounced refresh")
		let activeSession: any
		let replacementCount = 0
		const loadProject = vi
			.fn()
			.mockResolvedValueOnce(first)
			.mockResolvedValueOnce(reconciliation)
			.mockResolvedValueOnce(debouncedRefresh)
		const lifecycle = createProjectSessionLifecycle<ReturnType<typeof fakeProject>>({
			loadProject,
			prepareSession: vi.fn(async () => preparedSession()),
			setActiveSession: (session) => {
				activeSession = session
			},
			onDidReplaceSession: (session) => {
				replacementCount += 1
				if (replacementCount === 2) {
					expect(session.requestReconciliation({ deferStart: true })).toEqual({
						status: "deferred",
					})
				}
			},
		})

		await lifecycle.replaceProject("/project.inlang")
		activeSession.requestReconciliation()
		await vi.waitFor(() => expect(replacementCount).toBe(2))
		await Promise.resolve()
		await Promise.resolve()

		expect(loadProject).toHaveBeenCalledTimes(2)
		activeSession.requestReconciliation()
		await vi.waitFor(() => expect(loadProject).toHaveBeenCalledTimes(3))
	})

	it("retries retained dirty work once after a failed refresh", async () => {
		const first = fakeProject("first")
		const trailing = fakeProject("trailing")
		const refreshLoad = deferred<ReturnType<typeof fakeProject>>()
		const refreshError = new Error("refresh failed")
		const onError = vi.fn()
		let firstSession: any
		const loadProject = vi
			.fn()
			.mockResolvedValueOnce(first)
			.mockReturnValueOnce(refreshLoad.promise)
			.mockResolvedValueOnce(trailing)
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
		expect(firstSession.requestReconciliation()).toEqual({ status: "scheduled" })
		refreshLoad.reject(refreshError)

		await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(refreshError, "reconciliation"))
		await vi.waitFor(() => expect(loadProject).toHaveBeenCalledTimes(3))
		await vi.waitFor(() => expect(first.close).toHaveBeenCalledTimes(1))
		expect(firstSession.requestReconciliation()).toEqual({ status: "superseded" })
		expect(trailing.close).not.toHaveBeenCalled()
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

	it("retries a superseded reconciliation when the newer selection fails", async () => {
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
