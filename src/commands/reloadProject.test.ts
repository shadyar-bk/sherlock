import { beforeEach, describe, expect, it, vi } from "vitest"
import * as vscode from "vscode"
import { reloadProjectCommand } from "./reloadProject.js"
import { getProjectRuntime } from "../utilities/project/projectRuntime.js"

const replaceProject = vi.hoisted(() => vi.fn())
const activeProject = vi.hoisted(() =>
	vi.fn<() => { path: string } | undefined>(() => ({ path: "/workspace/project.inlang" }))
)
const lastRequestedProjectPath = vi.hoisted(() => vi.fn(() => "/workspace/project.inlang"))

vi.mock("vscode", () => ({
	commands: { registerCommand: vi.fn() },
	workspace: { workspaceFolders: [{ uri: { fsPath: "/workspace" } }] },
}))

vi.mock("../utilities/project/projectRuntime.js", () => ({
	getProjectRuntime: vi.fn(() => ({
		activeProject,
		lastRequestedProjectPath,
		replaceProject,
	})),
}))

vi.mock("../utilities/utils.js", () => ({ handleError: vi.fn() }))

describe("reloadProjectCommand", () => {
	beforeEach(() => {
		replaceProject.mockReset().mockResolvedValue({ status: "committed" })
		activeProject.mockReset().mockReturnValue({ path: "/workspace/project.inlang" })
		lastRequestedProjectPath.mockReset().mockReturnValue("/workspace/project.inlang")
	})

	it("replaces the active session without activating the extension again", async () => {
		await expect(reloadProjectCommand.callback()).resolves.toBe("committed")

		expect(getProjectRuntime().replaceProject).toHaveBeenCalledWith("/workspace/project.inlang")
		expect(vscode.commands.registerCommand).not.toHaveBeenCalled()
	})

	it("retries the last requested path after startup loading failed", async () => {
		activeProject.mockReturnValue(undefined)

		await expect(reloadProjectCommand.callback()).resolves.toBe("committed")

		expect(replaceProject).toHaveBeenCalledWith("/workspace/project.inlang")
	})
})
