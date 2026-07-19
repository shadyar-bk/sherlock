import { loadProjectFromDirectory, type InlangProject } from "@inlang/sdk"
import * as nodeFs from "node:fs"
import type { MessageViewController } from "../messages/messages.js"
import type { FileSystem } from "../fs/createFileSystemMapper.js"
import { createResourceLoadTracker } from "../fs/pluginResourceWatcher.js"
import { prepareProject, setActiveProject } from "../state.js"
import { createProjectRuntime, type ProjectRuntime } from "./projectRuntime.js"

export type ProjectSessionEnvironmentArgs = {
	fileSystem: FileSystem
	messageView?: Pick<MessageViewController, "bindProject">
}

export function createProjectSessionEnvironment(
	args: ProjectSessionEnvironmentArgs
): ProjectRuntime<InlangProject> {
	void args
	const resourceLoadSnapshots = new WeakMap<
		InlangProject,
		ReturnType<typeof createResourceLoadTracker>["snapshot"]
	>()

	return createProjectRuntime({
		loadProject: async (projectPath) => {
			const loadTracker = createResourceLoadTracker(nodeFs)
			const project = await loadProjectFromDirectory({ path: projectPath, fs: loadTracker.fs })
			resourceLoadSnapshots.set(project, loadTracker.snapshot)
			prepareProject(project)
			return project
		},
		prepareSession: async () => ({ activate: () => undefined }),
		publishActiveSession: (session) =>
			setActiveProject(session ? { project: session.project, path: session.path } : undefined),
	})
}
