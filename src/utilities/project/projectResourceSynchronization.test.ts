import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const host = vi.hoisted(() => {
	type Uri = { fsPath: string }
	type Callback = (uri: Uri) => void
	const contents = new Map<string, Uint8Array>()
	const watchers: Array<{
		callbacks: { change?: Callback; create?: Callback; delete?: Callback }
		dispose: ReturnType<typeof vi.fn>
	}> = []
	const nodeFileSystem = {
		readFile: vi.fn(async (filePath: string, options?: string | { encoding?: string }) => {
			const content = contents.get(filePath)
			if (!content) throw Object.assign(new Error("missing"), { code: "ENOENT" })
			const encoding = typeof options === "string" ? options : options?.encoding
			return encoding ? new TextDecoder().decode(content) : content
		}),
		writeFile: vi.fn(async (filePath: string, data: string | Uint8Array) => {
			contents.set(
				filePath,
				typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data)
			)
		}),
		mkdir: vi.fn(),
		rmdir: vi.fn(),
		rm: vi.fn(),
		unlink: vi.fn(),
		readdir: vi.fn(),
		readlink: vi.fn(),
		symlink: vi.fn(),
		stat: vi.fn(),
		lstat: vi.fn(),
		watch: vi.fn(),
		access: vi.fn(),
		copyFile: vi.fn(),
	}
	return {
		contents,
		watchers,
		nodeFileSystem,
		patterns: [] as Array<{ base: string; pattern: string }>,
		loadProjectFromDirectory: vi.fn(),
		saveProjectToDirectory: vi.fn(),
		nodeReadFile: vi.fn(async (filePath: string) => {
			const content = contents.get(filePath)
			if (!content) throw Object.assign(new Error("missing"), { code: "ENOENT" })
			return content
		}),
		readFile: vi.fn(async (uri: Uri) => {
			const content = contents.get(uri.fsPath)
			if (!content) throw Object.assign(new Error("missing"), { code: "ENOENT" })
			return content
		}),
		createFileSystemWatcher: vi.fn(() => {
			const callbacks: { change?: Callback; create?: Callback; delete?: Callback } = {}
			const watcher = {
				callbacks,
				onDidChange: vi.fn((callback: Callback) => (callbacks.change = callback)),
				onDidCreate: vi.fn((callback: Callback) => (callbacks.create = callback)),
				onDidDelete: vi.fn((callback: Callback) => (callbacks.delete = callback)),
				dispose: vi.fn(),
			}
			watchers.push(watcher)
			return watcher
		}),
	}
})

vi.mock("node:fs", () => ({
	promises: { readFile: host.nodeReadFile },
}))

vi.mock("node:fs/promises", () => ({ default: host.nodeFileSystem }))

vi.mock("@inlang/sdk", () => ({
	loadProjectFromDirectory: host.loadProjectFromDirectory,
	saveProjectToDirectory: host.saveProjectToDirectory,
}))

vi.mock("vscode", () => ({
	RelativePattern: class {
		constructor(base: string, pattern: string) {
			host.patterns.push({ base, pattern })
		}
	},
	Uri: { file: (fsPath: string) => ({ fsPath }) },
	workspace: {
		createFileSystemWatcher: host.createFileSystemWatcher,
		fs: { readFile: host.readFile },
	},
}))

import { createProjectResourceSynchronization } from "./projectResourceSynchronization.js"

function createSession(project: any, projectPath: string) {
	const ownedResources: Array<{ dispose(): Promise<void> }> = []
	return {
		path: projectPath,
		project,
		ownedResources,
		own: vi.fn((resource) => {
			ownedResources.push(resource)
			return true
		}),
		runTask: vi.fn(async <T>(task: () => Promise<T>) => ({
			status: "completed" as const,
			value: await task(),
		})),
		requestReconciliation: vi.fn(() => ({ status: "scheduled" as const })),
	}
}

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise
	})
	return { promise, resolve }
}

beforeEach(() => {
	vi.clearAllMocks()
	host.contents.clear()
	host.watchers.length = 0
	host.patterns.length = 0
})

afterEach(() => vi.useRealTimers())

describe("project resource synchronization", () => {
	it("saves a project through the SDK exporter", async () => {
		const projectPath = path.join(path.sep, "workspace", "project.inlang")
		const project = {
			settings: { get: vi.fn(async () => ({ baseLocale: "en", locales: [] })) },
		}
		const synchronization = createProjectResourceSynchronization()

		await synchronization.save(project as any, projectPath)

		expect(host.saveProjectToDirectory).toHaveBeenCalledWith(
			expect.objectContaining({ project, path: projectPath })
		)
	})

	it("preserves explicit dotted JSON keys across SDK export", async () => {
		const projectPath = path.join(path.sep, "workspace", "project.inlang")
		const resourcePath = path.join(path.sep, "workspace", "messages", "en.json")
		const project = {
			settings: {
				get: vi.fn(async () => ({
					baseLocale: "en",
					locales: ["en"],
					"plugin.inlang.json": { pathPattern: "./messages/{languageTag}.json" },
				})),
			},
		}
		host.contents.set(resourcePath, new TextEncoder().encode('{"menu.file":"Open"}\n'))
		host.saveProjectToDirectory.mockImplementationOnce(async ({ fs }) => {
			await fs.writeFile("../messages/en.json", '{"menu":{"file":"Open"}}\n')
		})

		await createProjectResourceSynchronization().save(project as any, projectPath)

		expect(JSON.parse(new TextDecoder().decode(host.contents.get(resourcePath)))).toEqual({
			"menu.file": "Open",
		})
	})

	it("acknowledges an exact Sherlock resource write without requesting reconciliation", async () => {
		vi.useFakeTimers()
		const projectPath = path.join(path.sep, "workspace", "project.inlang")
		const resourcePath = path.join(path.sep, "workspace", "translations", "en.json")
		const project = {
			settings: { get: vi.fn(async () => ({ baseLocale: "en", locales: ["en"] })) },
			plugins: {
				get: vi.fn(async () => [
					{
						key: "plugin.example",
						importFiles: vi.fn(),
						toBeImportedFiles: vi.fn(async () => [{ path: resourcePath, locale: "en" }]),
					},
				]),
			},
		}
		host.contents.set(resourcePath, new TextEncoder().encode("initial"))
		const session = createSession(project, projectPath)
		const synchronization = createProjectResourceSynchronization()
		await synchronization.watch(session as any)
		host.saveProjectToDirectory.mockImplementationOnce(async ({ fs }) => {
			await fs.writeFile("../translations/en.json", "saved by Sherlock")
			host.watchers[0]?.callbacks.change?.({ fsPath: resourcePath })
		})

		await synchronization.save(project as any, projectPath)
		await vi.advanceTimersByTimeAsync(150)

		expect(session.requestReconciliation).not.toHaveBeenCalled()
		await session.ownedResources[0]?.dispose()
	})

	it("reconciles an external resource edit that overlaps a Sherlock save", async () => {
		vi.useFakeTimers()
		const projectPath = path.join(path.sep, "workspace", "project.inlang")
		const resourcePath = path.join(path.sep, "workspace", "translations", "en.json")
		const project = {
			settings: { get: vi.fn(async () => ({ baseLocale: "en", locales: ["en"] })) },
			plugins: {
				get: vi.fn(async () => [
					{
						key: "plugin.example",
						importFiles: vi.fn(),
						toBeImportedFiles: vi.fn(async () => [{ path: resourcePath, locale: "en" }]),
					},
				]),
			},
		}
		host.contents.set(resourcePath, new TextEncoder().encode("initial"))
		const session = createSession(project, projectPath)
		const synchronization = createProjectResourceSynchronization()
		await synchronization.watch(session as any)
		host.saveProjectToDirectory.mockImplementationOnce(async ({ fs }) => {
			await fs.writeFile("../translations/en.json", "saved by Sherlock")
			host.contents.set(resourcePath, new TextEncoder().encode("edited externally"))
			host.watchers[0]?.callbacks.change?.({ fsPath: resourcePath })
		})

		await synchronization.save(project as any, projectPath)
		await vi.advanceTimersByTimeAsync(150)

		expect(session.requestReconciliation).toHaveBeenCalledOnce()
		await session.ownedResources[0]?.dispose()
	})

	it("acknowledges a Sherlock resource deletion without requesting reconciliation", async () => {
		vi.useFakeTimers()
		const projectPath = path.join(path.sep, "workspace", "project.inlang")
		const resourcePath = path.join(path.sep, "workspace", "translations", "en.json")
		const project = {
			settings: { get: vi.fn(async () => ({ baseLocale: "en", locales: ["en"] })) },
			plugins: {
				get: vi.fn(async () => [
					{
						key: "plugin.example",
						importFiles: vi.fn(),
						toBeImportedFiles: vi.fn(async () => [{ path: resourcePath, locale: "en" }]),
					},
				]),
			},
		}
		host.contents.set(resourcePath, new TextEncoder().encode("initial"))
		const session = createSession(project, projectPath)
		const synchronization = createProjectResourceSynchronization()
		await synchronization.watch(session as any)
		host.saveProjectToDirectory.mockImplementationOnce(async ({ fs }) => {
			await fs.unlink("../translations/en.json")
			host.contents.delete(resourcePath)
			host.watchers[0]?.callbacks.delete?.({ fsPath: resourcePath })
		})

		await synchronization.save(project as any, projectPath)
		await vi.advanceTimersByTimeAsync(150)

		expect(session.requestReconciliation).not.toHaveBeenCalled()
		await session.ownedResources[0]?.dispose()
	})

	it("serializes concurrent saves for the same project", async () => {
		const projectPath = path.join(path.sep, "workspace", "project.inlang")
		const project = {
			settings: { get: vi.fn(async () => ({ baseLocale: "en", locales: [] })) },
		}
		const firstSave = deferred<void>()
		const order: string[] = []
		host.saveProjectToDirectory
			.mockImplementationOnce(async () => {
				order.push("first started")
				await firstSave.promise
				order.push("first finished")
			})
			.mockImplementationOnce(async () => {
				order.push("second started")
			})
		const synchronization = createProjectResourceSynchronization()

		const first = synchronization.save(project as any, projectPath)
		const second = synchronization.save(project as any, projectPath)
		await vi.waitFor(() => expect(order).toEqual(["first started"]))
		firstSave.resolve()
		await Promise.all([first, second])

		expect(order).toEqual(["first started", "first finished", "second started"])
	})

	it("reconciles a resource change across the load-to-watch handoff", async () => {
		const resourcePath = path.join(path.sep, "workspace", "resources", "en.json")
		const projectPath = path.join(path.sep, "workspace", "project.inlang")
		const project = {
			settings: { get: vi.fn(async () => ({ locales: ["en"] })) },
			plugins: {
				get: vi.fn(async () => [
					{
						key: "plugin.example",
						importFiles: vi.fn(),
						toBeImportedFiles: vi.fn(async () => [{ path: resourcePath, locale: "en" }]),
					},
				]),
			},
		}
		const loaded = new TextEncoder().encode("loaded")
		host.loadProjectFromDirectory.mockImplementationOnce(async ({ fs }) => {
			host.contents.set(resourcePath, loaded)
			await fs.promises.readFile(resourcePath)
			return project
		})
		const synchronization = createProjectResourceSynchronization()

		await expect(synchronization.load(projectPath)).resolves.toBe(project)
		host.contents.set(resourcePath, new TextEncoder().encode("changed before watch"))
		const session = createSession(project, projectPath)
		await synchronization.watch(session as any)

		await vi.waitFor(() => expect(session.requestReconciliation).toHaveBeenCalledOnce())
		await session.ownedResources[0]?.dispose()
	})

	it("watches every plugin-declared path and reconciles a changed resource", async () => {
		vi.useFakeTimers()
		const projectPath = path.join(path.sep, "workspace", "project.inlang")
		const commonPath = path.join(path.sep, "workspace", "catalog", "en", "common.json")
		const vitalPath = path.join(path.sep, "workspace", "catalog", "en", "vital.json")
		const project = {
			settings: { get: vi.fn(async () => ({ locales: ["en"] })) },
			plugins: {
				get: vi.fn(async () => [
					{
						key: "plugin.example",
						importFiles: vi.fn(),
						toBeImportedFiles: vi.fn(async () => [
							{ path: "./catalog/en/common.json", locale: "en" },
							{ path: "./catalog/en/vital.json", locale: "en" },
						]),
					},
				]),
			},
		}
		host.contents.set(commonPath, new TextEncoder().encode("common"))
		host.contents.set(vitalPath, new TextEncoder().encode("vital"))
		const session = createSession(project, projectPath)
		const synchronization = createProjectResourceSynchronization()

		await synchronization.watch(session as any)

		expect(host.patterns).toEqual([
			{ base: path.dirname(commonPath), pattern: "common.json" },
			{ base: path.dirname(vitalPath), pattern: "vital.json" },
		])
		host.contents.set(vitalPath, new TextEncoder().encode("changed"))
		host.watchers[1]?.callbacks.change?.({ fsPath: vitalPath })
		await vi.advanceTimersByTimeAsync(150)
		expect(session.requestReconciliation).toHaveBeenCalledOnce()
		await session.ownedResources[0]?.dispose()
	})

	it("reports descriptor failures while continuing to watch valid plugins", async () => {
		const descriptorError = new Error("descriptor failed")
		const onError = vi.fn()
		const resourcePath = path.join(path.sep, "workspace", "catalog.data")
		const project = {
			settings: { get: vi.fn(async () => ({ locales: ["en"] })) },
			plugins: {
				get: vi.fn(async () => [
					{
						key: "plugin.failed",
						importFiles: vi.fn(),
						toBeImportedFiles: vi.fn(async () => {
							throw descriptorError
						}),
					},
					{
						key: "plugin.valid",
						importFiles: vi.fn(),
						toBeImportedFiles: vi.fn(async () => [{ path: resourcePath, locale: "en" }]),
					},
				]),
			},
		}
		host.contents.set(resourcePath, new TextEncoder().encode("valid"))
		const session = createSession(project, path.join(path.sep, "workspace", "project.inlang"))

		await createProjectResourceSynchronization().watch(session as any, { onError })

		expect(onError).toHaveBeenCalledWith(descriptorError)
		expect(host.watchers).toHaveLength(1)
		await session.ownedResources[0]?.dispose()
	})

	it("stops accepting events and disposes native watchers with the owning session", async () => {
		vi.useFakeTimers()
		const resourcePath = path.join(path.sep, "workspace", "translations", "en.json")
		const project = {
			settings: { get: vi.fn(async () => ({ locales: ["en"] })) },
			plugins: {
				get: vi.fn(async () => [
					{
						key: "plugin.example",
						importFiles: vi.fn(),
						toBeImportedFiles: vi.fn(async () => [{ path: resourcePath, locale: "en" }]),
					},
				]),
			},
		}
		host.contents.set(resourcePath, new TextEncoder().encode("initial"))
		const session = createSession(project, path.join(path.sep, "workspace", "project.inlang"))
		await createProjectResourceSynchronization().watch(session as any)

		await session.ownedResources[0]?.dispose()
		host.contents.set(resourcePath, new TextEncoder().encode("late"))
		host.watchers[0]?.callbacks.change?.({ fsPath: resourcePath })
		await vi.advanceTimersByTimeAsync(150)

		expect(host.watchers[0]?.dispose).toHaveBeenCalledOnce()
		expect(session.requestReconciliation).not.toHaveBeenCalled()
	})
})
