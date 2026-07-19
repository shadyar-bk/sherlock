import { afterEach, describe, expect, it, vi } from "vitest"
import { triggerProjectRefreshAndWait } from "./projectRefresh.js"

const mocks = vi.hoisted(() => ({
	executeWorkbench: vi.fn(),
}))

vi.mock("@wdio/globals", () => ({
	browser: { executeWorkbench: mocks.executeWorkbench },
}))

vi.mock("vscode", () => ({ default: {} }))
vi.mock("wdio-vscode-service", () => ({}))

afterEach(() => {
	vi.useRealTimers()
	vi.clearAllMocks()
})

describe("project refresh diagnostics", () => {
	it("observes a synchronous resource reaction without requiring source activation diagnostics", async () => {
		vi.useFakeTimers()
		const listeners = new Set<(event: { uris: Array<{ toString(): string }> }) => void>()
		const sourceUri = { toString: () => "file:///workspace/src/app.js" }
		const settingsUri = { toString: () => "file:///workspace/project.inlang/settings.json" }
		const emitSourceDiagnostics = () => {
			for (const listener of listeners) listener({ uris: [sourceUri] })
		}
		const vscodeApi = {
			extensions: { getExtension: () => ({ activate: vi.fn() }) },
			workspace: {
				openTextDocument: vi.fn(async (uri: { toString(): string }) => ({ uri })),
				fs: {
					writeFile: vi.fn(async () => {
						emitSourceDiagnostics()
					}),
				},
			},
			window: {
				showTextDocument: vi.fn(async () => undefined),
			},
			languages: {
				onDidChangeDiagnostics: (listener: (event: { uris: (typeof sourceUri)[] }) => void) => {
					listeners.add(listener)
					return { dispose: () => listeners.delete(listener) }
				},
			},
			commands: { executeCommand: vi.fn() },
			Uri: {
				file: (filePath: string) => (filePath.endsWith("settings.json") ? settingsUri : sourceUri),
			},
		}
		mocks.executeWorkbench.mockImplementation(async (callback, request) =>
			callback(vscodeApi, request)
		)

		const refresh = triggerProjectRefreshAndWait({
			settingsPath: "/workspace/project.inlang/settings.json",
			sourcePath: "/workspace/src/app.js",
			settleDiagnosticEvents: true,
			operation: { type: "write", filePath: "/workspace/messages/en.json", value: {} },
		})
		await vi.advanceTimersByTimeAsync(35_000)

		await expect(refresh).resolves.toEqual({ diagnosticEvents: 1 })
	})
})
