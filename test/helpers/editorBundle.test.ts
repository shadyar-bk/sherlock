import { afterEach, describe, expect, it, vi } from "vitest"
import { openEditorBundle, readEditorBundle } from "./editorBundle.js"

const mocks = vi.hoisted(() => ({
	close: vi.fn(),
	executeWorkbench: vi.fn(),
	getWebviewByTitle: vi.fn(),
	open: vi.fn(),
	switchToFrame: vi.fn(),
}))

vi.mock("@wdio/globals", () => ({
	browser: {
		executeWorkbench: mocks.executeWorkbench,
		getWorkbench: vi.fn(async () => ({ getWebviewByTitle: mocks.getWebviewByTitle })),
		switchToFrame: mocks.switchToFrame,
	},
}))

vi.mock("vscode", () => ({ default: {} }))
vi.mock("wdio-vscode-service", () => ({}))

afterEach(() => {
	vi.clearAllMocks()
	vi.unstubAllGlobals()
})

describe("editor bundle observer", () => {
	it("returns to the workbench after a webview detaches during cleanup", async () => {
		const detached = new Error("target frame detached")
		const executeCommand = vi.fn(async () => undefined)
		mocks.getWebviewByTitle.mockResolvedValue({ open: mocks.open, close: mocks.close })
		mocks.open.mockRejectedValue(detached)
		mocks.close.mockRejectedValue(detached)
		mocks.switchToFrame.mockResolvedValue(undefined)
		mocks.executeWorkbench.mockImplementation(async (callback, argument) =>
			callback(
				{
					commands: { executeCommand },
					window: {
						tabGroups: {
							activeTabGroup: {
								activeTab: { input: { viewType: "editorViewPanel" }, label: "# greeting" },
							},
						},
					},
				},
				argument
			)
		)

		await expect(readEditorBundle("greeting")).rejects.toBe(detached)

		expect(mocks.switchToFrame).toHaveBeenNthCalledWith(1, null)
		expect(mocks.switchToFrame).toHaveBeenNthCalledWith(2, null)
		expect(executeCommand).toHaveBeenNthCalledWith(1, "sherlock.openEditorView", {
			bundleId: "greeting",
		})
		expect(executeCommand).toHaveBeenCalledTimes(1)
	})

	it("closes only a successfully opened matching Sherlock editor tab", async () => {
		const executeCommand = vi.fn(async () => undefined)
		mocks.getWebviewByTitle.mockResolvedValue({ open: mocks.open, close: mocks.close })
		mocks.open.mockResolvedValue(undefined)
		mocks.close.mockResolvedValue(undefined)
		mocks.switchToFrame.mockResolvedValue(undefined)
		mocks.executeWorkbench.mockImplementation(async (callback, argument) =>
			callback(
				{
					commands: { executeCommand },
					window: {
						tabGroups: {
							activeTabGroup: {
								activeTab: {
									input: { viewType: "mainThreadWebview-editorViewPanel" },
									label: "# greeting",
								},
							},
						},
					},
				},
				argument
			)
		)
		vi.stubGlobal(
			"$",
			vi.fn(() => ({
				waitForDisplayed: vi.fn(async () => undefined),
				getText: vi.fn(async () => "body"),
			}))
		)
		vi.stubGlobal(
			"$$",
			vi.fn(async () => [{ getText: vi.fn(async () => "Hello") }])
		)

		const editor = await openEditorBundle("greeting")
		await editor.read()
		await editor.close()
		await editor.close()

		expect(executeCommand).toHaveBeenNthCalledWith(2, "workbench.action.closeActiveEditor")
		expect(executeCommand).toHaveBeenCalledTimes(2)
	})

	it("does not close a different Sherlock editor revealed during cleanup", async () => {
		const executeCommand = vi.fn(async () => undefined)
		mocks.getWebviewByTitle.mockResolvedValue({ open: mocks.open, close: mocks.close })
		mocks.open.mockResolvedValue(undefined)
		mocks.close.mockResolvedValue(undefined)
		mocks.switchToFrame.mockResolvedValue(undefined)
		mocks.executeWorkbench.mockImplementation(async (callback, argument) =>
			callback(
				{
					commands: { executeCommand },
					window: {
						tabGroups: {
							activeTabGroup: {
								activeTab: { input: { viewType: "editorViewPanel" }, label: "# other" },
							},
						},
					},
				},
				argument
			)
		)
		vi.stubGlobal(
			"$",
			vi.fn(() => ({
				waitForDisplayed: vi.fn(async () => undefined),
				getText: vi.fn(async () => "body"),
			}))
		)
		vi.stubGlobal(
			"$$",
			vi.fn(async () => [{ getText: vi.fn(async () => "Hello") }])
		)

		const editor = await openEditorBundle("greeting")
		await editor.read()
		await editor.close()

		expect(executeCommand).toHaveBeenCalledTimes(1)
	})

	it("rejects a structured WebDriver error returned during a detached-frame read", async () => {
		const executeCommand = vi.fn(async () => undefined)
		mocks.getWebviewByTitle.mockResolvedValue({ open: mocks.open, close: mocks.close })
		mocks.open.mockResolvedValue(undefined)
		mocks.close.mockResolvedValue(undefined)
		mocks.switchToFrame.mockResolvedValue(undefined)
		mocks.executeWorkbench.mockImplementation(async (callback, argument) =>
			callback(
				{
					commands: { executeCommand },
					window: {
						tabGroups: {
							activeTabGroup: {
								activeTab: {
									input: { viewType: "mainThreadWebview-editorViewPanel" },
									label: "# greeting",
								},
							},
						},
					},
				},
				argument
			)
		)
		vi.stubGlobal(
			"$",
			vi.fn(() => ({ waitForDisplayed: vi.fn(async () => undefined) }))
		)
		vi.stubGlobal(
			"$$",
			vi.fn(async () => [{ getText: vi.fn(async () => ({ error: "no such element" })) }])
		)

		const editor = await openEditorBundle("greeting")
		await expect(editor.read()).rejects.toThrow("Editor frame detached while reading")
		await editor.close()
		expect(executeCommand).toHaveBeenCalledTimes(1)
	})
})
