import { beforeEach, describe, expect, it, vi } from "vitest"
import type { InlangProject } from "@inlang/sdk"
import type { FileSystem } from "../fs/createFileSystemMapper.js"

const host = vi.hoisted(() => ({
	loadProjectFromDirectory: vi.fn(),
	prepareProject: vi.fn(),
	setActiveProject: vi.fn(),
	createResourceLoadTracker: vi.fn(() => ({
		fs: { tracked: true },
		snapshot: vi.fn(),
	})),
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

import { createProjectSessionEnvironment } from "./projectSessionEnvironment.js"

function fakeProject(name: string) {
	return {
		name,
		close: vi.fn(async () => undefined),
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

beforeEach(() => {
	vi.clearAllMocks()
	host.createResourceLoadTracker.mockReturnValue({
		fs: { tracked: true },
		snapshot: vi.fn(),
	})
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
})
