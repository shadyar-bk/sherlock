import { describe, expect, it, vi } from "vitest"
import { createProjectSessionLifecycle, deactivateBeforeClose } from "./projectSession.js"

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise
	})
	return { promise, resolve }
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
