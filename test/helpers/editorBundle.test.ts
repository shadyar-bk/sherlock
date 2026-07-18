import { afterEach, describe, expect, it, vi } from "vitest"
import { readEditorBundle } from "./editorBundle.js"

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
})

describe("editor bundle observer", () => {
	it("returns to the workbench after a webview detaches during cleanup", async () => {
		const detached = new Error("target frame detached")
		mocks.getWebviewByTitle.mockResolvedValue({ open: mocks.open, close: mocks.close })
		mocks.open.mockRejectedValue(detached)
		mocks.close.mockRejectedValue(detached)
		mocks.switchToFrame.mockResolvedValue(undefined)
		mocks.executeWorkbench.mockResolvedValue(undefined)

		await expect(readEditorBundle("greeting")).rejects.toBe(detached)

		expect(mocks.switchToFrame).toHaveBeenNthCalledWith(1, null)
		expect(mocks.switchToFrame).toHaveBeenNthCalledWith(2, null)
		expect(mocks.executeWorkbench).toHaveBeenCalledTimes(2)
	})
})
