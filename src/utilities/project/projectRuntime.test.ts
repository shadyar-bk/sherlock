import { afterEach, describe, expect, it, vi } from "vitest"
import {
	createProjectRuntime,
	disposeProjectRuntime,
	getProjectRuntime,
	installProjectRuntime,
} from "./projectRuntime.js"

function fakeProject(name: string) {
	return {
		name,
		close: vi.fn(async () => undefined),
	}
}

const prepareSession = vi.fn(async () => ({ activate: () => undefined }))

afterEach(async () => {
	await disposeProjectRuntime()
})

describe("project runtime", () => {
	it("is the single installed lifecycle owner and disposes idempotently", async () => {
		const project = fakeProject("active")
		const runtime = createProjectRuntime({
			loadProject: vi.fn(async () => project),
			prepareSession,
			publishActiveSession: vi.fn(),
		})

		installProjectRuntime(runtime)
		expect(getProjectRuntime()).toBe(runtime)
		expect(() => installProjectRuntime(runtime)).toThrow("already initialized")

		await runtime.replaceProject("/active.inlang")
		await disposeProjectRuntime()
		await disposeProjectRuntime()

		expect(project.close).toHaveBeenCalledTimes(1)
		expect(() => getProjectRuntime()).toThrow("not initialized")
	})

	it("returns a lease that becomes stale after project replacement", async () => {
		const first = fakeProject("first")
		const second = fakeProject("second")
		const runtime = createProjectRuntime({
			loadProject: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second),
			prepareSession,
			publishActiveSession: vi.fn(),
		})

		await runtime.replaceProject("/first.inlang")
		const lease = runtime.activeProject()
		const resource = { dispose: vi.fn() }
		expect(lease?.own(resource)).toBe(true)
		expect(lease?.project).toBe(first)
		await runtime.replaceProject("/second.inlang")

		expect(lease?.isCurrent()).toBe(false)
		expect(resource.dispose).toHaveBeenCalledWith("replacement")
		expect(lease?.own({ dispose: vi.fn() })).toBe(false)
		expect(runtime.activeProject()?.project).toBe(second)
		const activeResource = { dispose: vi.fn() }
		expect(runtime.activeProject()?.own(activeResource)).toBe(true)

		await runtime.dispose()

		expect(activeResource.dispose).toHaveBeenCalledWith("shutdown")
	})

	it("remembers a failed initial project path for recovery", async () => {
		const runtime = createProjectRuntime({
			loadProject: vi.fn(async () => Promise.reject(new Error("load failed"))),
			prepareSession,
			publishActiveSession: vi.fn(),
		})

		await expect(runtime.replaceProject("/failed.inlang")).resolves.toMatchObject({
			status: "failed",
		})

		expect(runtime.activeProject()).toBeUndefined()
		expect(runtime.lastRequestedProjectPath()).toBe("/failed.inlang")
	})
})
