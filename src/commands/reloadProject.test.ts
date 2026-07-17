import { beforeEach, describe, expect, it, vi } from "vitest"
import * as vscode from "vscode"
import { reloadProjectCommand } from "./reloadProject.js"
import { getProjectRuntime } from "../utilities/project/projectRuntime.js"

const replaceProject = vi.hoisted(() => vi.fn())

vi.mock("vscode", () => ({
	commands: { registerCommand: vi.fn() },
	workspace: { workspaceFolders: [{ uri: { fsPath: "/workspace" } }] },
}))

vi.mock("../utilities/project/projectRuntime.js", () => ({
	getProjectRuntime: vi.fn(() => ({
		activeProject: () => ({ path: "/workspace/project.inlang" }),
		replaceProject,
	})),
}))

vi.mock("../utilities/utils.js", () => ({ handleError: vi.fn() }))

describe("reloadProjectCommand", () => {
	beforeEach(() => {
		replaceProject.mockReset().mockResolvedValue({ status: "committed" })
	})

	it("replaces the active session without activating the extension again", async () => {
		await expect(reloadProjectCommand.callback()).resolves.toBe("committed")

		expect(getProjectRuntime().replaceProject).toHaveBeenCalledWith("/workspace/project.inlang")
		expect(vscode.commands.registerCommand).not.toHaveBeenCalled()
	})
})
