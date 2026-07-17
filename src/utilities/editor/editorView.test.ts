import { describe, expect, it, vi } from "vitest"
import { editorView } from "./editorView.js"
import { saveProjectData } from "../../main.js"

vi.mock("vscode", () => ({}))
vi.mock("../../configuration.js", () => ({ CONFIGURATION: { EVENTS: {} } }))
vi.mock("../messages/msg.js", () => ({ msg: vi.fn() }))
vi.mock("./helper/getUri.js", () => ({ getUri: vi.fn() }))
vi.mock("../../main.js", () => ({
	saveProject: vi.fn(),
	saveProjectData: vi.fn(async () => undefined),
}))

describe("editorView", () => {
	it("persists its owned project before session disposal", async () => {
		const project = {}
		const view = editorView({
			extensionUri: {} as never,
			initialBundleId: "welcome",
			lease: {
				path: "/workspace/project.inlang",
				project,
				isCurrent: () => false,
			} as any,
		})

		await view.dispose({ persist: true })

		expect(saveProjectData).toHaveBeenCalledWith(project, "/workspace/project.inlang")
	})
})
