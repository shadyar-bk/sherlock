import {
	createProjectSessionLifecycle,
	type Disposable,
	type ProjectSession,
	type ProjectReplacementResult,
	type PreparedProjectSession,
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

export function createProjectRuntime<Project extends CloseableProject>(args: {
	loadProject(path: string): Promise<Project>
	prepareSession(
		session: ProjectSession<Project>,
		resources: Disposable[]
	): Promise<PreparedProjectSession>
	publishActiveSession(session: ProjectSession<Project> | undefined): void
	onDidReplaceSession?(session: ProjectSession<Project>): Promise<void> | void
	onError?(
		error: unknown,
		phase: "cleanup" | "activation" | "notification" | "reconciliation"
	): void
}): ProjectRuntime<Project> {
	let activeSession: ProjectSession<Project> | undefined
	let lastRequestedProjectPath: string | undefined
	const lifecycle = createProjectSessionLifecycle({
		loadProject: args.loadProject,
		prepareSession: args.prepareSession,
		setActiveSession: (session) => {
			args.publishActiveSession(session)
			activeSession = session
		},
		onDidReplaceSession: args.onDidReplaceSession,
		onError: args.onError,
	})

	return {
		replaceProject(path) {
			lastRequestedProjectPath = path
			return lifecycle.replaceProject(path)
		},
		activeProject() {
			const session = activeSession
			if (!session) return undefined
			return {
				path: session.path,
				project: session.project,
				isCurrent: () => activeSession === session,
				own: (resource) => session.own(resource),
				runTask: (task) => session.runTask(task),
			}
		},
		lastRequestedProjectPath: () => lastRequestedProjectPath,
		dispose: lifecycle.dispose,
	}
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
