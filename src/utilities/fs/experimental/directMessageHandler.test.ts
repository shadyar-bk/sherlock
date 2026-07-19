import { afterEach, describe, expect, it, vi } from "vitest"
import { setupDirectMessageWatcher } from "./directMessageHandler.js"

const mocks = vi.hoisted(() => {
	const callbacks: { change?: (uri: { fsPath: string }) => void } = {}
	const watcher = {
		onDidChange: vi.fn((callback) => {
			callbacks.change = callback
		}),
		onDidCreate: vi.fn(),
		onDidDelete: vi.fn(),
		dispose: vi.fn(),
	}
	return {
		callbacks,
		watcher,
		findFiles: vi.fn(),
		readFile: vi.fn(async () => new TextEncoder().encode("{}")),
		createFileSystemWatcher: vi.fn(() => watcher),
		uiFire: vi.fn(),
	}
})

vi.mock("vscode", () => ({
	RelativePattern: vi.fn((workspaceFolder, pattern) => ({ workspaceFolder, pattern })),
	workspace: {
		createFileSystemWatcher: mocks.createFileSystemWatcher,
		findFiles: mocks.findFiles,
		fs: { readFile: mocks.readFile },
	},
}))

vi.mock("../../../configuration.js", () => ({
	CONFIGURATION: {
		EVENTS: { ON_DID_EDIT_MESSAGE: { fire: mocks.uiFire } },
	},
}))

vi.mock("../../utils.js", () => ({ handleError: vi.fn() }))

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise
	})
	return { promise, resolve }
}

function createSession(
	runTask = vi.fn(async <T>(task: () => Promise<T>) => ({
		status: "completed" as const,
		value: await task(),
	}))
) {
	return {
		path: "/workspace/project.inlang",
		project: {},
		runTask,
	} as any
}

describe("setupDirectMessageWatcher", () => {
	afterEach(() => {
		vi.useRealTimers()
		vi.clearAllMocks()
		mocks.callbacks.change = undefined
	})

	it("waits for the initial snapshot scan and owns exactly one watcher", async () => {
		const scan = deferred<Array<{ fsPath: string }>>()
		mocks.findFiles.mockReturnValueOnce(scan.promise)
		const subscriptions: Array<{ dispose(): unknown }> = []

		const setup = setupDirectMessageWatcher({
			subscriptions,
			workspaceFolder: { uri: { fsPath: "/workspace" } } as any,
			session: createSession(),
		})
		let settled = false
		void setup.then(() => {
			settled = true
		})
		await Promise.resolve()

		expect(settled).toBe(false)
		expect(mocks.createFileSystemWatcher).toHaveBeenCalledTimes(1)
		expect(mocks.findFiles).toHaveBeenCalledTimes(1)

		scan.resolve([])
		await setup
		expect(subscriptions).toHaveLength(1)

		await subscriptions[0]!.dispose()
		expect(mocks.watcher.dispose).toHaveBeenCalledTimes(1)
	})

	it("stops the watcher immediately and waits for a running callback", async () => {
		vi.useFakeTimers()
		mocks.findFiles.mockResolvedValueOnce([])
		const callback = deferred<{ status: "completed"; value: false }>()
		const runTask = vi
			.fn()
			.mockImplementationOnce(async <T>(task: () => Promise<T>) => ({
				status: "completed" as const,
				value: await task(),
			}))
			.mockImplementationOnce(() => callback.promise)
		const subscriptions: Array<{ dispose(): unknown }> = []
		await setupDirectMessageWatcher({
			subscriptions,
			workspaceFolder: { uri: { fsPath: "/workspace" } } as any,
			session: createSession(runTask),
		})

		mocks.callbacks.change?.({ fsPath: "/workspace/messages/en.json" })
		await vi.advanceTimersByTimeAsync(150)
		expect(runTask).toHaveBeenCalledTimes(2)

		const disposal = Promise.resolve(subscriptions[0]!.dispose())
		let settled = false
		void disposal.then(() => {
			settled = true
		})
		await Promise.resolve()

		expect(mocks.watcher.dispose).toHaveBeenCalledTimes(1)
		expect(settled).toBe(false)

		callback.resolve({ status: "completed", value: false })
		await disposal
		expect(settled).toBe(true)
	})

	it("does not refresh the UI when file work finishes on an inactive session", async () => {
		vi.useFakeTimers()
		mocks.findFiles.mockResolvedValueOnce([])
		const importFiles = vi.fn(async () => undefined)
		const runTask = vi
			.fn()
			.mockImplementationOnce(async <T>(task: () => Promise<T>) => ({
				status: "completed" as const,
				value: await task(),
			}))
			.mockImplementationOnce(async <T>(task: () => Promise<T>) => {
				await task()
				return { status: "inactive" as const }
			})
		const session = createSession(runTask)
		session.project = {
			db: {},
			plugins: { get: vi.fn(async () => [{ key: "json" }]) },
			importFiles,
		}
		await setupDirectMessageWatcher({
			subscriptions: [],
			workspaceFolder: { uri: { fsPath: "/workspace" } } as any,
			session,
		})

		mocks.callbacks.change?.({ fsPath: "/workspace/messages/en.json" })
		await vi.advanceTimersByTimeAsync(150)
		await vi.waitFor(() => expect(importFiles).toHaveBeenCalledTimes(1))

		expect(mocks.uiFire).not.toHaveBeenCalled()
	})
})
