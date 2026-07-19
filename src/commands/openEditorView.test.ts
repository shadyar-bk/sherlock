import { beforeEach, describe, expect, it, vi } from "vitest"
import { editorView } from "../utilities/editor/editorView.js"
import { openEditorViewCommand } from "./openEditorView.js"

const lease = vi.hoisted(() => ({
	own: vi.fn(),
}))

vi.mock("vscode", () => ({
	commands: { registerCommand: vi.fn() },
	extensions: {
		getExtension: vi.fn(() => ({ extensionUri: { fsPath: "/extension" } })),
	},
}))

vi.mock("../utilities/editor/editorView.js", () => ({
	editorView: vi.fn(),
}))

vi.mock("../utilities/project/projectRuntime.js", () => ({
	getProjectRuntime: () => ({ activeProject: () => lease }),
}))

vi.mock("../services/telemetry/index.js", () => ({ capture: vi.fn() }))

describe("Open Editor command", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		lease.own.mockReturnValue(true)
	})

	it("retires the editor without exporting the replaced project", async () => {
		const editor = {
			createOrShowPanel: vi.fn(async () => undefined),
			dispose: vi.fn(async () => undefined),
		}
		vi.mocked(editorView).mockReturnValue(editor as never)

		await openEditorViewCommand.callback({ bundleId: "welcome" })

		const ownedResource = lease.own.mock.calls[0]?.[0]
		await ownedResource.dispose()

		expect(editor.dispose).toHaveBeenCalledWith()
	})

	it("exports a focused editor when the extension shuts down", async () => {
		const editor = {
			createOrShowPanel: vi.fn(async () => undefined),
			dispose: vi.fn(async () => undefined),
		}
		vi.mocked(editorView).mockReturnValue(editor as never)

		await openEditorViewCommand.callback({ bundleId: "welcome" })

		const ownedResource = lease.own.mock.calls[0]?.[0]
		await ownedResource.dispose("shutdown")

		expect(editor.dispose).toHaveBeenCalledWith({ persist: true })
	})
})
