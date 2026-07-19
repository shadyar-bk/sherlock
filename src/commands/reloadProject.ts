import * as vscode from "vscode"
import { handleError } from "../utilities/utils.js"
import { getProjectRuntime } from "../utilities/project/projectRuntime.js"

export const reloadProjectCommand = {
	command: "sherlock.reloadProject",
	title: "Sherlock: Reload project",
	register: vscode.commands.registerCommand,
	callback: async () => {
		try {
			console.log("Reloading project...")

			// Get current workspace
			const workspaceFolder = vscode.workspace.workspaceFolders?.[0]
			if (!workspaceFolder) {
				console.warn("No workspace folder found.")
				return "no-workspace" as const
			}

			const runtime = getProjectRuntime()
			const projectPath = runtime.activeProject()?.path ?? runtime.lastRequestedProjectPath()
			if (projectPath) {
				const result = await runtime.replaceProject(projectPath)
				if (result.status === "failed") throw result.error
				if (result.status === "committed") console.log("Project reloaded successfully")
				return result.status
			} else {
				console.warn("No project selected, nothing to reload")
				return "no-project" as const
			}
		} catch (error) {
			console.error("Failed to reload project:", error)
			handleError(error)
			return "failed" as const
		}
	},
}
