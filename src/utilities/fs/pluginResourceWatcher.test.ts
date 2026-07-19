import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	createResourceLoadTracker,
	discoverPluginResourceDescriptors,
	runWithPluginResourceWrite,
	setupPluginResourceWatcher,
} from "./pluginResourceWatcher.js"

const mocks = vi.hoisted(() => {
	type Uri = { fsPath: string }
	type Callback = (uri: Uri) => void
	const watchers: Array<{
		callbacks: { change?: Callback; create?: Callback; delete?: Callback }
		dispose: ReturnType<typeof vi.fn>
	}> = []
	const contents = new Map<string, Uint8Array | Error>()
	return {
		watchers,
		contents,
		patterns: [] as Array<{ base: string; pattern: string }>,
		readFile: vi.fn(async (uri: Uri) => {
			const content = contents.get(uri.fsPath)
			if (content instanceof Error) throw content
			if (!content) throw Object.assign(new Error("missing"), { code: "ENOENT" })
			return content
		}),
		createFileSystemWatcher: vi.fn(() => {
			const callbacks: { change?: Callback; create?: Callback; delete?: Callback } = {}
			const watcher = {
				callbacks,
				onDidChange: vi.fn((callback: Callback) => {
					callbacks.change = callback
				}),
				onDidCreate: vi.fn((callback: Callback) => {
					callbacks.create = callback
				}),
				onDidDelete: vi.fn((callback: Callback) => {
					callbacks.delete = callback
				}),
				dispose: vi.fn(),
			}
			watchers.push(watcher)
			return watcher
		}),
	}
})

vi.mock("vscode", () => ({
	RelativePattern: class {
		constructor(base: string, pattern: string) {
			mocks.patterns.push({ base, pattern })
		}
	},
	Uri: { file: (fsPath: string) => ({ fsPath }) },
	workspace: {
		createFileSystemWatcher: mocks.createFileSystemWatcher,
		fs: { readFile: mocks.readFile },
	},
}))

function createSession(plugins: any[], settings: Record<string, unknown> = { locales: ["en"] }) {
	return {
		path: path.join(path.sep, "workspace", "project.inlang"),
		project: {
			settings: { get: vi.fn(async () => settings) },
			plugins: { get: vi.fn(async () => plugins) },
		},
	} as any
}

function importPlugin(descriptors: Array<{ path: string; locale: string }>) {
	return {
		key: "plugin.example",
		importFiles: vi.fn(),
		toBeImportedFiles: vi.fn(async () => descriptors),
	}
}

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise
	})
	return { promise, resolve }
}

async function captureLoadedResource(filePath: string, content?: Uint8Array) {
	const readFile = vi.fn(async () => {
		if (content === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" })
		return content
	})
	const tracker = createResourceLoadTracker({ promises: { readFile } } as any)
	await tracker.fs.promises.readFile(filePath).catch(() => undefined)
	return tracker.snapshot
}

function createWatcherSession(descriptors: Array<{ path: string; locale: string }>) {
	const session = createSession([importPlugin(descriptors)])
	session.ownedResources = []
	session.own = vi.fn((resource) => {
		session.ownedResources.push(resource)
		return true
	})
	session.runTask = vi.fn(async <T>(task: () => Promise<T>) => ({
		status: "completed" as const,
		value: await task(),
	}))
	session.requestReconciliation = vi.fn(() => ({ status: "scheduled" as const }))
	return session
}

function expectReconciliationRuns(session: ReturnType<typeof createWatcherSession>, count: number) {
	expect(session.requestReconciliation).toHaveBeenCalledTimes(count)
}

afterEach(() => {
	vi.useRealTimers()
	vi.clearAllMocks()
	mocks.watchers.length = 0
	mocks.patterns.length = 0
	mocks.contents.clear()
})

describe("plugin resource descriptor discovery", () => {
	it("preserves plugin-owned paths, locales, and metadata while resolving paths", async () => {
		const metadata = { namespace: "common" }
		const importFiles = vi.fn()
		const toBeImportedFiles = vi.fn(async () => [
			{ path: "./resources/en/common.json", locale: "en", metadata },
			{ path: path.join(path.sep, "translations", "de.json"), locale: "de" },
		])
		const session = createSession([{ key: "plugin.example", importFiles, toBeImportedFiles }])

		const descriptors = await discoverPluginResourceDescriptors({ session })

		expect(descriptors).toEqual([
			{
				pluginKey: "plugin.example",
				path: "./resources/en/common.json",
				absolutePath: path.join(path.sep, "workspace", "resources", "en", "common.json"),
				locale: "en",
				metadata,
			},
			{
				pluginKey: "plugin.example",
				path: path.join(path.sep, "translations", "de.json"),
				absolutePath: path.join(path.sep, "translations", "de.json"),
				locale: "de",
				metadata: undefined,
			},
		])
		expect(session.project.settings.get).toHaveBeenCalledTimes(1)
		expect(session.project.plugins.get).toHaveBeenCalledTimes(1)
		expect(toBeImportedFiles).toHaveBeenCalledWith({ settings: { locales: ["en"] } })
	})

	it("ignores non-import plugins and continues after one plugin fails discovery", async () => {
		const discoveryError = new Error("descriptor failure")
		const onError = vi.fn()
		const validDescriptor = { path: "./custom/catalog.data", locale: "en" }
		const session = createSession([
			{
				key: "plugin.no-import",
				toBeImportedFiles: vi.fn(async () => [validDescriptor]),
			},
			{
				key: "plugin.throwing",
				importFiles: vi.fn(),
				toBeImportedFiles: vi.fn(async () => {
					throw discoveryError
				}),
			},
			{
				key: "plugin.valid",
				importFiles: vi.fn(),
				toBeImportedFiles: vi.fn(async () => [validDescriptor]),
			},
		])

		const descriptors = await discoverPluginResourceDescriptors({ session, onError })

		expect(descriptors).toEqual([
			expect.objectContaining({
				pluginKey: "plugin.valid",
				path: "./custom/catalog.data",
				locale: "en",
			}),
		])
		expect(onError).toHaveBeenCalledOnce()
		expect(onError).toHaveBeenCalledWith(discoveryError)
	})

	it("ignores matcher-shaped plugins without the modern import contract", async () => {
		const matcher = {
			key: "plugin.inlang.messageFormat",
			match: vi.fn(() => true),
			parse: vi.fn(),
			serialize: vi.fn(),
		}
		const validDescriptor = { path: "./custom/catalog.data", locale: "en" }
		const session = createSession([matcher, importPlugin([validDescriptor])])

		const descriptors = await discoverPluginResourceDescriptors({ session })

		expect(descriptors).toEqual([
			expect.objectContaining({ path: validDescriptor.path, locale: validDescriptor.locale }),
		])
		expect(matcher.match).not.toHaveBeenCalled()
		expect(matcher.parse).not.toHaveBeenCalled()
		expect(matcher.serialize).not.toHaveBeenCalled()
	})

	it("continues descriptor discovery when the error reporter throws", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
		const validDescriptor = { path: "./custom/catalog.data", locale: "en" }
		const session = createSession([
			{
				key: "plugin.throwing",
				importFiles: vi.fn(),
				toBeImportedFiles: vi.fn(async () => {
					throw new Error("descriptor failure")
				}),
			},
			{
				key: "plugin.valid",
				importFiles: vi.fn(),
				toBeImportedFiles: vi.fn(async () => [validDescriptor]),
			},
		])

		const descriptors = await discoverPluginResourceDescriptors({
			session,
			onError: () => {
				throw new Error("reporter failure")
			},
		})

		expect(descriptors).toEqual([
			expect.objectContaining({ pluginKey: "plugin.valid", path: validDescriptor.path }),
		])
		expect(consoleError).toHaveBeenCalledOnce()
	})

	it("preserves official i18next single-namespace and languageTag descriptors", async () => {
		const descriptorsFromPlugin = [
			{ locale: "en", path: "/translations/en.json" },
			{ locale: "de", path: "/translations/de.json" },
		]
		const session = createSession([
			{
				key: "plugin.example",
				importFiles: vi.fn(),
				toBeImportedFiles: vi.fn(async () => descriptorsFromPlugin),
			},
		])

		const descriptors = await discoverPluginResourceDescriptors({ session })

		expect(descriptors.map(({ path, locale }) => ({ path, locale }))).toEqual(descriptorsFromPlugin)
	})

	it("retains official i18next multi-namespace metadata", async () => {
		const settings = {
			locales: ["en", "de"],
			"plugin.example.i18next": {
				pathPattern: {
					common: "/resources/{locale}/common.json",
					vital: "/resources/{locale}/vital.json",
				},
			},
		}
		const session = createSession(
			[
				{
					key: "plugin.example",
					importFiles: vi.fn(),
					toBeImportedFiles: vi.fn(async ({ settings: receivedSettings }) => {
						expect(receivedSettings).toBe(settings)
						return [
							{
								path: "/resources/en/common.json",
								locale: "en",
								metadata: { namespace: "common" },
							},
							{
								path: "/resources/en/vital.json",
								locale: "en",
								metadata: { namespace: "vital" },
							},
							{
								path: "/resources/de/common.json",
								locale: "de",
								metadata: { namespace: "common" },
							},
							{
								path: "/resources/de/vital.json",
								locale: "de",
								metadata: { namespace: "vital" },
							},
						]
					}),
				},
			],
			settings
		)

		const descriptors = await discoverPluginResourceDescriptors({ session })

		expect(descriptors.map(({ path, locale, metadata }) => ({ path, locale, metadata }))).toEqual([
			{
				path: "/resources/en/common.json",
				locale: "en",
				metadata: { namespace: "common" },
			},
			{
				path: "/resources/en/vital.json",
				locale: "en",
				metadata: { namespace: "vital" },
			},
			{
				path: "/resources/de/common.json",
				locale: "de",
				metadata: { namespace: "common" },
			},
			{
				path: "/resources/de/vital.json",
				locale: "de",
				metadata: { namespace: "vital" },
			},
		])
	})
})

describe("plugin resource watcher", () => {
	it("reconciles an edit made after import but before watcher creation", async () => {
		vi.useFakeTimers()
		const resourcePath = path.join(path.sep, "workspace", "translations", "en.json")
		const imported = new TextEncoder().encode("imported")
		const loadSnapshot = await captureLoadedResource(resourcePath, imported)
		mocks.contents.set(resourcePath, new TextEncoder().encode("edited before watcher creation"))
		const session = createWatcherSession([{ path: resourcePath, locale: "en" }])

		await setupPluginResourceWatcher({ session, loadSnapshot })
		await vi.advanceTimersByTimeAsync(150)

		expectReconciliationRuns(session, 1)
		await session.ownedResources[0].dispose()
	})

	it("reconciles a missing resource created after import but before watcher creation", async () => {
		vi.useFakeTimers()
		const resourcePath = path.join(path.sep, "workspace", "translations", "en.json")
		const loadSnapshot = await captureLoadedResource(resourcePath)
		mocks.contents.set(resourcePath, new TextEncoder().encode("created before watcher creation"))
		const session = createWatcherSession([{ path: resourcePath, locale: "en" }])

		await setupPluginResourceWatcher({ session, loadSnapshot })
		await vi.advanceTimersByTimeAsync(150)

		expectReconciliationRuns(session, 1)
		await session.ownedResources[0].dispose()
	})

	it("reconciles an edit made during descriptor discovery", async () => {
		vi.useFakeTimers()
		const resourcePath = path.join(path.sep, "workspace", "translations", "en.json")
		const imported = new TextEncoder().encode("imported")
		const loadSnapshot = await captureLoadedResource(resourcePath, imported)
		mocks.contents.set(resourcePath, imported)
		const descriptors = deferred<Array<{ path: string; locale: string }>>()
		const session = createWatcherSession([])
		session.project.plugins.get.mockResolvedValue([
			{
				key: "plugin.example",
				importFiles: vi.fn(),
				toBeImportedFiles: vi.fn(() => descriptors.promise),
			},
		])

		const setup = setupPluginResourceWatcher({ session, loadSnapshot })
		await vi.waitFor(() => expect(session.project.plugins.get).toHaveBeenCalledOnce())
		mocks.contents.set(resourcePath, new TextEncoder().encode("edited during discovery"))
		descriptors.resolve([{ path: resourcePath, locale: "en" }])
		await setup
		await vi.advanceTimersByTimeAsync(150)

		expectReconciliationRuns(session, 1)
		await session.ownedResources[0].dispose()
	})

	it("reconciles a descriptor that was not observed during project loading", async () => {
		vi.useFakeTimers()
		const resourcePath = path.join(path.sep, "workspace", "translations", "new-descriptor.json")
		mocks.contents.set(resourcePath, new TextEncoder().encode("discovered after import"))
		const session = createWatcherSession([{ path: resourcePath, locale: "en" }])

		await setupPluginResourceWatcher({ session, loadSnapshot: new Map() })
		await vi.advanceTimersByTimeAsync(150)

		expectReconciliationRuns(session, 1)
		await session.ownedResources[0].dispose()
	})

	it("reconciles a missing descriptor that was not observed during project loading", async () => {
		vi.useFakeTimers()
		const resourcePath = path.join(path.sep, "workspace", "translations", "missing.json")
		const session = createWatcherSession([{ path: resourcePath, locale: "en" }])

		await setupPluginResourceWatcher({ session, loadSnapshot: new Map() })
		await vi.advanceTimersByTimeAsync(150)

		expectReconciliationRuns(session, 1)
		await session.ownedResources[0].dispose()
	})

	it("proves fingerprints stable after an edit during the initial read", async () => {
		vi.useFakeTimers()
		const resourcePath = path.join(path.sep, "workspace", "translations", "en.json")
		const imported = new TextEncoder().encode("imported")
		const loadSnapshot = await captureLoadedResource(resourcePath, imported)
		const initialRead = deferred<Uint8Array>()
		mocks.readFile.mockReturnValueOnce(initialRead.promise)
		const session = createWatcherSession([{ path: resourcePath, locale: "en" }])

		const setup = setupPluginResourceWatcher({ session, loadSnapshot })
		await vi.waitFor(() => expect(mocks.watchers).toHaveLength(1))
		mocks.contents.set(resourcePath, new TextEncoder().encode("edited during fingerprinting"))
		initialRead.resolve(imported)
		await setup
		await vi.advanceTimersByTimeAsync(150)

		expectReconciliationRuns(session, 1)
		await session.ownedResources[0].dispose()
	})

	it("does not reconcile a stable import-to-watcher handoff", async () => {
		vi.useFakeTimers()
		const resourcePath = path.join(path.sep, "workspace", "translations", "en.json")
		const imported = new TextEncoder().encode("stable")
		const loadSnapshot = await captureLoadedResource(resourcePath, imported)
		mocks.contents.set(resourcePath, imported)
		const session = createWatcherSession([{ path: resourcePath, locale: "en" }])

		await setupPluginResourceWatcher({ session, loadSnapshot })
		await vi.advanceTimersByTimeAsync(150)

		expectReconciliationRuns(session, 0)
		await session.ownedResources[0].dispose()
	})

	it("does not create native watchers after session ownership has ended", async () => {
		const resourcePath = path.join(path.sep, "workspace", "translations", "en.json")
		const session = createWatcherSession([{ path: resourcePath, locale: "en" }])
		session.own.mockReturnValue(false)

		await setupPluginResourceWatcher({ session })

		expect(session.own).toHaveBeenCalledOnce()
		expect(mocks.createFileSystemWatcher).not.toHaveBeenCalled()
		expect(session.ownedResources).toHaveLength(0)
	})

	it("binds its watcher group directly to the active project session", async () => {
		const resourcePath = path.join(path.sep, "workspace", "translations", "en.json")
		const session = createWatcherSession([{ path: resourcePath, locale: "en" }])

		await setupPluginResourceWatcher({ session })

		expect(session.own).toHaveBeenCalledOnce()
		expect(session.ownedResources).toHaveLength(1)
		await session.ownedResources[0].dispose()
		expect(mocks.watchers[0]?.dispose).toHaveBeenCalledOnce()
	})

	it("creates one escaped exact watcher per unique resource path and tolerates missing files", async () => {
		const resourcePath = path.join(path.sep, "workspace", "translations", "catalog[en]?.json")
		const session = createWatcherSession([
			{ path: resourcePath, locale: "en" },
			{ path: resourcePath, locale: "en-duplicate" },
		])

		const descriptors = await setupPluginResourceWatcher({ session })

		expect(descriptors).toHaveLength(2)
		expect(mocks.createFileSystemWatcher).toHaveBeenCalledTimes(1)
		expect(mocks.patterns).toEqual([
			{
				base: path.dirname(resourcePath),
				pattern: "catalog[[]en[]][?].json",
			},
		])
		expect(session.ownedResources).toHaveLength(1)
		await session.ownedResources[0].dispose()
		expect(mocks.watchers[0]?.dispose).toHaveBeenCalledOnce()
	})

	it("keeps installing valid resource watchers when one exact watcher cannot be created", async () => {
		const firstPath = path.join(path.sep, "workspace", "translations", "en.json")
		const secondPath = path.join(path.sep, "workspace", "translations", "de.json")
		const watchError = new Error("watch unavailable")
		mocks.createFileSystemWatcher.mockImplementationOnce(() => {
			throw watchError
		})
		const session = createWatcherSession([
			{ path: firstPath, locale: "en" },
			{ path: secondPath, locale: "de" },
		])
		const onError = vi.fn()

		await expect(setupPluginResourceWatcher({ session, onError })).resolves.toHaveLength(2)

		expect(onError).toHaveBeenCalledWith(watchError)
		expect(mocks.createFileSystemWatcher).toHaveBeenCalledTimes(2)
		expect(mocks.watchers).toHaveLength(1)
		await session.ownedResources[0].dispose()
		expect(mocks.watchers[0]?.dispose).toHaveBeenCalledOnce()
	})

	it("requests one reconciliation only after the debounce expires", async () => {
		vi.useFakeTimers()
		const resourcePath = path.join(path.sep, "workspace", "translations", "en.json")
		mocks.contents.set(resourcePath, new TextEncoder().encode("initial"))
		const session = createWatcherSession([{ path: resourcePath, locale: "en" }])
		await setupPluginResourceWatcher({ session })

		mocks.contents.set(resourcePath, new TextEncoder().encode("changed"))
		mocks.watchers[0]?.callbacks.change?.({ fsPath: resourcePath })
		await vi.advanceTimersByTimeAsync(0)
		expectReconciliationRuns(session, 0)

		await vi.advanceTimersByTimeAsync(149)
		expectReconciliationRuns(session, 0)
		await vi.advanceTimersByTimeAsync(1)
		expectReconciliationRuns(session, 1)
		expect(session.requestReconciliation).toHaveBeenCalledWith()

		await session.ownedResources[0].dispose()
	})

	it("ignores unchanged notifications and coalesces changed resources into one reload", async () => {
		vi.useFakeTimers()
		const firstPath = path.join(path.sep, "workspace", "translations", "en.json")
		const secondPath = path.join(path.sep, "workspace", "translations", "de.json")
		mocks.contents.set(firstPath, new TextEncoder().encode("before-en"))
		mocks.contents.set(secondPath, new TextEncoder().encode("before-de"))
		const session = createWatcherSession([
			{ path: firstPath, locale: "en" },
			{ path: secondPath, locale: "de" },
		])
		await setupPluginResourceWatcher({ session })

		mocks.watchers[0]?.callbacks.change?.({ fsPath: firstPath })
		await vi.advanceTimersByTimeAsync(150)
		expectReconciliationRuns(session, 0)

		mocks.contents.set(firstPath, new TextEncoder().encode("after-en"))
		mocks.contents.set(secondPath, new TextEncoder().encode("after-de"))
		mocks.watchers[0]?.callbacks.change?.({ fsPath: firstPath })
		mocks.watchers[1]?.callbacks.change?.({ fsPath: secondPath })
		await vi.advanceTimersByTimeAsync(150)

		expectReconciliationRuns(session, 1)
		await session.ownedResources[0].dispose()
	})

	it("suppresses delayed duplicate notifications for the same changed bytes", async () => {
		vi.useFakeTimers()
		const resourcePath = path.join(path.sep, "workspace", "translations", "en.json")
		mocks.contents.set(resourcePath, new TextEncoder().encode("initial"))
		const session = createWatcherSession([{ path: resourcePath, locale: "en" }])
		await setupPluginResourceWatcher({ session })

		mocks.contents.set(resourcePath, new TextEncoder().encode("changed"))
		mocks.watchers[0]?.callbacks.change?.({ fsPath: resourcePath })
		await vi.advanceTimersByTimeAsync(150)
		expectReconciliationRuns(session, 1)

		mocks.watchers[0]?.callbacks.change?.({ fsPath: resourcePath })
		await vi.advanceTimersByTimeAsync(150)
		expectReconciliationRuns(session, 1)
		await session.ownedResources[0].dispose()
	})

	it("serializes same-path reads so a later event cannot commit before an earlier read", async () => {
		vi.useFakeTimers()
		const resourcePath = path.join(path.sep, "workspace", "translations", "en.json")
		mocks.contents.set(resourcePath, new TextEncoder().encode("initial"))
		const session = createWatcherSession([{ path: resourcePath, locale: "en" }])
		await setupPluginResourceWatcher({ session })
		const earlierRead = deferred<Uint8Array>()
		const laterRead = deferred<Uint8Array>()
		mocks.readFile.mockReturnValueOnce(earlierRead.promise).mockReturnValueOnce(laterRead.promise)

		mocks.watchers[0]?.callbacks.change?.({ fsPath: resourcePath })
		mocks.watchers[0]?.callbacks.change?.({ fsPath: resourcePath })
		await Promise.resolve()

		expect(mocks.readFile).toHaveBeenCalledTimes(2)
		earlierRead.resolve(new TextEncoder().encode("changed"))
		await vi.waitFor(() => expect(mocks.readFile).toHaveBeenCalledTimes(3))
		laterRead.resolve(new TextEncoder().encode("changed"))
		await vi.advanceTimersByTimeAsync(150)

		expectReconciliationRuns(session, 1)
		await session.ownedResources[0].dispose()
	})

	it("bounds a same-path event storm to one active and one coalesced fingerprint read", async () => {
		vi.useFakeTimers()
		const resourcePath = path.join(path.sep, "workspace", "translations", "en.json")
		mocks.contents.set(resourcePath, new TextEncoder().encode("initial"))
		const session = createWatcherSession([{ path: resourcePath, locale: "en" }])
		await setupPluginResourceWatcher({ session })
		const activeRead = deferred<Uint8Array>()
		mocks.readFile.mockReturnValueOnce(activeRead.promise)

		for (let event = 0; event < 50; event += 1) {
			mocks.watchers[0]?.callbacks.change?.({ fsPath: resourcePath })
		}
		await Promise.resolve()

		expect(mocks.readFile).toHaveBeenCalledTimes(2)
		mocks.contents.set(resourcePath, new TextEncoder().encode("latest"))
		activeRead.resolve(new TextEncoder().encode("latest"))
		await vi.waitFor(() => expect(mocks.readFile).toHaveBeenCalledTimes(3))
		await vi.advanceTimersByTimeAsync(150)

		expect(mocks.readFile).toHaveBeenCalledTimes(3)
		expectReconciliationRuns(session, 1)
		await session.ownedResources[0].dispose()
	})

	it("reloads when a resource changes while its initial fingerprint is still settling", async () => {
		vi.useFakeTimers()
		const resourcePath = path.join(path.sep, "workspace", "translations", "en.json")
		const initialRead = deferred<Uint8Array>()
		const eventRead = deferred<Uint8Array>()
		mocks.readFile.mockReturnValueOnce(initialRead.promise).mockReturnValueOnce(eventRead.promise)
		const session = createWatcherSession([{ path: resourcePath, locale: "en" }])

		const setup = setupPluginResourceWatcher({ session })
		await vi.waitFor(() => expect(mocks.watchers).toHaveLength(1))
		mocks.watchers[0]?.callbacks.change?.({ fsPath: resourcePath })

		const changedContent = new TextEncoder().encode("changed during setup")
		initialRead.resolve(changedContent)
		await setup
		eventRead.resolve(changedContent)
		await vi.advanceTimersByTimeAsync(150)

		expectReconciliationRuns(session, 1)
		await session.ownedResources[0].dispose()
	})

	it("reloads for creation and deletion, then stops accepting events on disposal", async () => {
		vi.useFakeTimers()
		const resourcePath = path.join(path.sep, "workspace", "translations", "en.json")
		const session = createWatcherSession([{ path: resourcePath, locale: "en" }])
		await setupPluginResourceWatcher({ session })

		mocks.contents.set(resourcePath, new TextEncoder().encode("created"))
		mocks.watchers[0]?.callbacks.create?.({ fsPath: resourcePath })
		await vi.advanceTimersByTimeAsync(150)
		expectReconciliationRuns(session, 1)

		mocks.watchers[0]?.callbacks.delete?.({ fsPath: resourcePath })
		await vi.advanceTimersByTimeAsync(150)
		expectReconciliationRuns(session, 2)
		mocks.watchers[0]?.callbacks.delete?.({ fsPath: resourcePath })
		await vi.advanceTimersByTimeAsync(150)
		expectReconciliationRuns(session, 2)

		await session.ownedResources[0].dispose()
		mocks.watchers[0]?.callbacks.delete?.({ fsPath: resourcePath })
		await vi.advanceTimersByTimeAsync(150)
		expectReconciliationRuns(session, 2)
	})

	it("reconciles a create event even when the file is not readable yet", async () => {
		vi.useFakeTimers()
		const resourcePath = path.join(path.sep, "workspace", "translations", "en.json")
		const session = createWatcherSession([{ path: resourcePath, locale: "en" }])
		await setupPluginResourceWatcher({ session })

		mocks.watchers[0]?.callbacks.create?.({ fsPath: resourcePath })
		await vi.advanceTimersByTimeAsync(150)

		expectReconciliationRuns(session, 1)
		await session.ownedResources[0].dispose()
	})

	it("reports a fingerprint error without letting it suppress reconciliation", async () => {
		vi.useFakeTimers()
		const resourcePath = path.join(path.sep, "workspace", "translations", "en.json")
		mocks.contents.set(resourcePath, new TextEncoder().encode("initial"))
		const session = createWatcherSession([{ path: resourcePath, locale: "en" }])
		const onError = vi.fn()
		await setupPluginResourceWatcher({ session, onError })
		const readError = Object.assign(new Error("permission denied"), { code: "EACCES" })
		mocks.contents.set(resourcePath, readError)

		mocks.watchers[0]?.callbacks.change?.({ fsPath: resourcePath })
		await vi.advanceTimersByTimeAsync(150)

		expect(onError).toHaveBeenCalledWith(readError)
		expectReconciliationRuns(session, 1)
		await session.ownedResources[0].dispose()
	})

	it("disposes native watchers immediately and awaits already-running fingerprint work", async () => {
		const resourcePath = path.join(path.sep, "workspace", "translations", "en.json")
		mocks.contents.set(resourcePath, new TextEncoder().encode("initial"))
		const session = createWatcherSession([{ path: resourcePath, locale: "en" }])
		await setupPluginResourceWatcher({ session })
		const pendingRead = deferred<Uint8Array>()
		mocks.readFile.mockReturnValueOnce(pendingRead.promise)

		mocks.watchers[0]?.callbacks.change?.({ fsPath: resourcePath })
		await Promise.resolve()
		const disposal = Promise.resolve(session.ownedResources[0].dispose())
		let settled = false
		void disposal.then(() => {
			settled = true
		})
		await Promise.resolve()

		expect(mocks.watchers[0]?.dispose).toHaveBeenCalledOnce()
		expect(settled).toBe(false)
		pendingRead.resolve(new TextEncoder().encode("changed"))
		await disposal
		expect(settled).toBe(true)
		expectReconciliationRuns(session, 0)
	})

	it("never imports or exports directly for inbound resource events", async () => {
		vi.useFakeTimers()
		const resourcePath = path.join(path.sep, "workspace", "translations", "en.json")
		mocks.contents.set(resourcePath, new TextEncoder().encode("initial"))
		const session = createWatcherSession([{ path: resourcePath, locale: "en" }])
		await setupPluginResourceWatcher({ session })

		mocks.watchers[0]?.callbacks.delete?.({ fsPath: resourcePath })
		await vi.advanceTimersByTimeAsync(150)

		expectReconciliationRuns(session, 1)
		const plugin = (await session.project.plugins.get())[0]
		expect(plugin.importFiles).not.toHaveBeenCalled()
		expect(session.project.exportFiles).toBeUndefined()
		await session.ownedResources[0].dispose()
	})

	it("acknowledges a successful Sherlock write without hiding the next external edit", async () => {
		vi.useFakeTimers()
		const resourcePath = path.join(path.sep, "workspace", "translations", "en.json")
		mocks.contents.set(resourcePath, new TextEncoder().encode("initial"))
		const session = createWatcherSession([{ path: resourcePath, locale: "en" }])
		await setupPluginResourceWatcher({ session })

		await runWithPluginResourceWrite(session.project, async (recordResourceWrite) => {
			const saved = new TextEncoder().encode("saved by Sherlock")
			mocks.contents.set(resourcePath, saved)
			recordResourceWrite({
				type: "write",
				path: resourcePath,
				data: saved,
				options: undefined,
			})
			mocks.watchers[0]?.callbacks.change?.({ fsPath: resourcePath })
		})
		await vi.advanceTimersByTimeAsync(150)
		expectReconciliationRuns(session, 0)

		mocks.contents.set(resourcePath, new TextEncoder().encode("edited externally"))
		mocks.watchers[0]?.callbacks.change?.({ fsPath: resourcePath })
		await vi.advanceTimersByTimeAsync(150)

		expectReconciliationRuns(session, 1)
		await session.ownedResources[0].dispose()
	})

	it("reconciles an external edit that overlaps a successful Sherlock write", async () => {
		vi.useFakeTimers()
		const resourcePath = path.join(path.sep, "workspace", "translations", "en.json")
		mocks.contents.set(resourcePath, new TextEncoder().encode("initial"))
		const session = createWatcherSession([{ path: resourcePath, locale: "en" }])
		await setupPluginResourceWatcher({ session })

		await runWithPluginResourceWrite(session.project, async (recordResourceWrite) => {
			const saved = new TextEncoder().encode("saved by Sherlock")
			mocks.contents.set(resourcePath, saved)
			recordResourceWrite({
				type: "write",
				path: resourcePath,
				data: saved,
				options: undefined,
			})
			mocks.contents.set(resourcePath, new TextEncoder().encode("edited externally"))
			mocks.watchers[0]?.callbacks.change?.({ fsPath: resourcePath })
		})
		await vi.advanceTimersByTimeAsync(150)

		expectReconciliationRuns(session, 1)
		await session.ownedResources[0].dispose()
	})

	it("reconciles an external edit after Sherlock's refresh read but before release", async () => {
		vi.useFakeTimers()
		const resourcePath = path.join(path.sep, "workspace", "translations", "en.json")
		mocks.contents.set(resourcePath, new TextEncoder().encode("initial"))
		const session = createWatcherSession([{ path: resourcePath, locale: "en" }])
		await setupPluginResourceWatcher({ session })
		const refreshRead = deferred<Uint8Array>()
		mocks.readFile.mockReturnValueOnce(refreshRead.promise)

		const write = runWithPluginResourceWrite(session.project, async (recordResourceWrite) => {
			const saved = new TextEncoder().encode("saved by Sherlock")
			mocks.contents.set(resourcePath, saved)
			recordResourceWrite({
				type: "write",
				path: resourcePath,
				data: saved,
				options: undefined,
			})
			mocks.watchers[0]?.callbacks.change?.({ fsPath: resourcePath })
		})
		await vi.waitFor(() => expect(mocks.readFile).toHaveBeenCalledTimes(2))
		refreshRead.resolve(new TextEncoder().encode("saved by Sherlock"))
		mocks.contents.set(resourcePath, new TextEncoder().encode("edited externally"))
		await write
		await vi.advanceTimersByTimeAsync(150)

		expectReconciliationRuns(session, 1)
		await session.ownedResources[0].dispose()
	})

	it("serializes concurrent Sherlock resource saves", async () => {
		const project = {}
		const firstWrite = deferred<void>()
		const order: string[] = []
		const first = runWithPluginResourceWrite(project, async () => {
			order.push("first started")
			await firstWrite.promise
			order.push("first finished")
		})
		const second = runWithPluginResourceWrite(project, async () => {
			order.push("second started")
		})
		await vi.waitFor(() => expect(order).toEqual(["first started"]))

		firstWrite.resolve()
		await Promise.all([first, second])

		expect(order).toEqual(["first started", "first finished", "second started"])
	})

	it("does not suppress resource events when a Sherlock write fails", async () => {
		vi.useFakeTimers()
		const resourcePath = path.join(path.sep, "workspace", "translations", "en.json")
		mocks.contents.set(resourcePath, new TextEncoder().encode("initial"))
		const session = createWatcherSession([{ path: resourcePath, locale: "en" }])
		await setupPluginResourceWatcher({ session })
		const writeError = new Error("write failed")

		await expect(
			runWithPluginResourceWrite(session.project, async () => {
				mocks.contents.set(resourcePath, new TextEncoder().encode("partially written"))
				mocks.watchers[0]?.callbacks.change?.({ fsPath: resourcePath })
				throw writeError
			})
		).rejects.toBe(writeError)
		await vi.advanceTimersByTimeAsync(150)

		expectReconciliationRuns(session, 1)
		await session.ownedResources[0].dispose()
	})

	it("keeps one native watcher owner across ten installed revisions", async () => {
		const resourcePath = path.join(path.sep, "workspace", "translations", "en.json")
		const createWatcher = mocks.createFileSystemWatcher.getMockImplementation()!
		let activeWatchers = 0
		let maximumActiveWatchers = 0
		mocks.createFileSystemWatcher.mockImplementation(() => {
			const watcher = createWatcher()
			activeWatchers += 1
			maximumActiveWatchers = Math.max(maximumActiveWatchers, activeWatchers)
			watcher.dispose.mockImplementation(() => {
				activeWatchers -= 1
			})
			return watcher
		})

		try {
			for (let revision = 0; revision < 10; revision += 1) {
				const session = createWatcherSession([{ path: resourcePath, locale: "en" }])
				await setupPluginResourceWatcher({ session })
				expect(activeWatchers).toBe(1)
				await session.ownedResources[0].dispose()
				expect(activeWatchers).toBe(0)
			}
			expect(maximumActiveWatchers).toBe(1)
		} finally {
			mocks.createFileSystemWatcher.mockImplementation(createWatcher)
		}
	})

	it("uses Windows path semantics for relative descriptors and exact watcher patterns", async () => {
		vi.resetModules()
		vi.doMock("node:path", async (importOriginal) => ({
			...(await importOriginal<typeof import("node:path")>()),
			default: path.win32,
		}))
		try {
			const windowsWatcher = await import("./pluginResourceWatcher.js")
			const session = createWatcherSession([
				{ path: String.raw`./translations/catalog[en]?.json`, locale: "en" },
			])
			session.path = String.raw`C:\workspace\project.inlang`

			const descriptors = await windowsWatcher.setupPluginResourceWatcher({ session })

			expect(descriptors[0]?.absolutePath).toBe(
				String.raw`C:\workspace\translations\catalog[en]?.json`
			)
			expect(mocks.patterns).toEqual([
				{
					base: String.raw`C:\workspace\translations`,
					pattern: "catalog[[]en[]][?].json",
				},
			])
			await session.ownedResources[0].dispose()
		} finally {
			vi.doUnmock("node:path")
			vi.resetModules()
		}
	})
})
