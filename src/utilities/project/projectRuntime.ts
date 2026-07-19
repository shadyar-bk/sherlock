import {
	type Disposable,
	type ProjectReplacementResult,
	type ProjectTaskResult,
} from "./projectSession.js"

type CloseableProject = { close(): Promise<void> }

export type ActiveProjectLease<Project extends CloseableProject> = {
	readonly path: string
	readonly project: Project
	isCurrent(): boolean
	own(resource: Disposable): boolean
	runTask<T>(task: () => Promise<T>): Promise<ProjectTaskResult<T>>
}

export type ProjectRuntime<Project extends CloseableProject> = {
	replaceProject(path: string): Promise<ProjectReplacementResult>
	activeProject(): ActiveProjectLease<Project> | undefined
	lastRequestedProjectPath(): string | undefined
	dispose(): Promise<void>
}

let installedRuntime: ProjectRuntime<CloseableProject> | undefined
let runtimeDisposal: Promise<void> | undefined

export function installProjectRuntime<Project extends CloseableProject>(
	runtime: ProjectRuntime<Project>
) {
	if (installedRuntime) throw new Error("Project runtime is already initialized")
	installedRuntime = runtime
}

export function getProjectRuntime<Project extends CloseableProject = CloseableProject>() {
	if (!installedRuntime) throw new Error("Project runtime is not initialized")
	return installedRuntime as ProjectRuntime<Project>
}

export function disposeProjectRuntime() {
	if (runtimeDisposal) return runtimeDisposal
	const runtime = installedRuntime
	if (!runtime) return Promise.resolve()
	installedRuntime = undefined
	runtimeDisposal = runtime.dispose().finally(() => {
		runtimeDisposal = undefined
	})
	return runtimeDisposal
}
