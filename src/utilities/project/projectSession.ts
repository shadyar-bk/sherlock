export type ProjectSession<Project extends { close(): Promise<void> }> = {
	readonly path: string
	readonly project: Project
	own(resource: Disposable): boolean
	runTask<T>(task: () => Promise<T>): Promise<ProjectTaskResult<T>>
}

export type ProjectTaskResult<T> = { status: "completed"; value: T } | { status: "inactive" }

export type Disposable = {
	dispose(): unknown
	deactivate?(): unknown
}

export function deactivateBeforeClose(resource: Disposable): Disposable {
	let disposal: Promise<void> | undefined
	const dispose = () => {
		if (!disposal) {
			try {
				disposal = Promise.resolve(resource.dispose()).then(() => undefined)
			} catch (error) {
				disposal = Promise.reject(error)
			}
		}
		return disposal
	}
	return { deactivate: dispose, dispose }
}

export type ProjectSessionLifecycle = {
	replaceProject(path: string): Promise<ProjectReplacementResult>
	dispose(): Promise<void>
}

export type ProjectReplacementResult =
	| { status: "committed" }
	| { status: "superseded" }
	| { status: "failed"; error: unknown }

const COMMITTED = { status: "committed" } as const
const SUPERSEDED = { status: "superseded" } as const

export type PreparedProjectSession = {
	activate(): void
	afterPreviousDisposed?(): Promise<void> | void
}

export function createProjectSessionLifecycle<Project extends { close(): Promise<void> }>(args: {
	loadProject(path: string): Promise<Project>
	prepareSession(
		session: ProjectSession<Project>,
		resources: Disposable[]
	): Promise<PreparedProjectSession>
	setActiveSession(session: ProjectSession<Project> | undefined): void
	onDidReplaceSession?(session: ProjectSession<Project>): Promise<void> | void
	onError?(error: unknown, phase: "cleanup" | "activation" | "notification"): void
}) {
	let activeSession: (ProjectSession<Project> & { dispose(): Promise<void> }) | undefined
	let disposed = false
	let disposal: Promise<void> | undefined
	let generation = 0
	let commitQueue = Promise.resolve()
	const replacements = new Set<Promise<ProjectReplacementResult>>()

	function createSession(path: string, project: Project) {
		let resources: Disposable[] = []
		let sessionDisposed = false
		let active = false
		const tasks = new Set<Promise<unknown>>()
		return {
			path,
			project,
			resources,
			activate() {
				active = true
			},
			own(resource: Disposable) {
				if (!active || sessionDisposed) return false
				resources.push(resource)
				return true
			},
			async runTask<T>(task: () => Promise<T>) {
				if (!active || sessionDisposed) return { status: "inactive" } as const
				const execution = task()
				tasks.add(execution)
				try {
					const value = await execution
					if (!active || sessionDisposed) return { status: "inactive" } as const
					return { status: "completed", value } as const
				} finally {
					tasks.delete(execution)
				}
			},
			async dispose() {
				if (sessionDisposed) return
				sessionDisposed = true
				active = false
				const errors: unknown[] = []
				const earlyDisposals = new Map<Disposable, Promise<PromiseSettledResult<void>>>()
				for (const resource of resources.toReversed()) {
					if (!resource.deactivate) continue
					try {
						earlyDisposals.set(
							resource,
							Promise.resolve(resource.deactivate()).then(
								() => ({ status: "fulfilled", value: undefined }),
								(reason) => ({ status: "rejected", reason })
							)
						)
					} catch (error) {
						errors.push(error)
					}
				}
				const taskResults = await Promise.allSettled([...tasks])
				for (const result of taskResults) {
					if (result.status === "rejected") errors.push(result.reason)
				}
				for (const resource of resources.toReversed()) {
					const earlyDisposal = earlyDisposals.get(resource)
					if (earlyDisposal) {
						const result = await earlyDisposal
						if (result.status === "rejected") errors.push(result.reason)
						continue
					}
					try {
						await resource.dispose()
					} catch (error) {
						errors.push(error)
					}
				}
				try {
					await project.close()
				} catch (error) {
					errors.push(error)
				}
				if (errors.length > 0) throw new AggregateError(errors, "Failed to dispose project session")
			},
		}
	}

	function reportError(error: unknown, phase: "cleanup" | "activation" | "notification") {
		try {
			args.onError?.(error, phase)
		} catch (reportingError) {
			console.error("Failed to report project-session error", reportingError)
		}
	}

	async function disposeCandidate(
		candidate: ProjectSession<Project> & { dispose(): Promise<void> },
		message: string
	): Promise<Extract<ProjectReplacementResult, { status: "failed" }> | undefined> {
		try {
			await candidate.dispose()
			return undefined
		} catch (error) {
			return { status: "failed", error: new AggregateError([error], message) }
		}
	}

	async function replaceProject(path: string) {
		if (disposed) return SUPERSEDED
		const replacementGeneration = ++generation
		let project: Project
		try {
			project = await args.loadProject(path)
		} catch (error) {
			if (disposed || replacementGeneration !== generation) return SUPERSEDED
			return { status: "failed", error } as const
		}

		const candidate = createSession(path, project)
		const commit = commitQueue.then(async () => {
			if (disposed || replacementGeneration !== generation) {
				const failure = await disposeCandidate(candidate, "Failed to close superseded project")
				if (failure) return failure
				return SUPERSEDED
			}

			const previous = activeSession
			let preparedSession: PreparedProjectSession
			try {
				preparedSession = await args.prepareSession(candidate, candidate.resources)
			} catch (error) {
				try {
					await candidate.dispose()
				} catch (cleanupError) {
					return {
						status: "failed",
						error: new AggregateError([error, cleanupError], "Project preparation failed"),
					} as const
				}
				return { status: "failed", error } as const
			}

			if (disposed || replacementGeneration !== generation) {
				const failure = await disposeCandidate(candidate, "Failed to close superseded project")
				if (failure) return failure
				return SUPERSEDED
			}

			candidate.activate()
			try {
				preparedSession.activate()
			} catch (error) {
				try {
					await candidate.dispose()
				} catch (cleanupError) {
					return {
						status: "failed",
						error: new AggregateError([error, cleanupError], "Project activation failed"),
					} as const
				}
				return { status: "failed", error } as const
			}
			try {
				args.setActiveSession(candidate)
			} catch (error) {
				const cleanupFailure = await disposeCandidate(
					candidate,
					"Failed to clean up unpublished project"
				)
				try {
					args.setActiveSession(previous)
				} catch (rollbackError) {
					return {
						status: "failed",
						error: new AggregateError(
							[error, cleanupFailure?.error, rollbackError].filter(Boolean),
							"Failed to publish project session"
						),
					} as const
				}
				if (cleanupFailure) {
					return {
						status: "failed",
						error: new AggregateError(
							[error, cleanupFailure.error],
							"Failed to publish and clean up project session"
						),
					} as const
				}
				return { status: "failed", error } as const
			}
			activeSession = candidate
			try {
				await previous?.dispose()
			} catch (error) {
				reportError(error, "cleanup")
			}
			try {
				await preparedSession.afterPreviousDisposed?.()
			} catch (error) {
				reportError(error, "activation")
			}
			try {
				await args.onDidReplaceSession?.(candidate)
			} catch (error) {
				reportError(error, "notification")
			}
			return COMMITTED
		})
		commitQueue = commit.then(
			() => undefined,
			() => undefined
		)
		return commit
	}

	function trackReplacement(path: string) {
		const replacement = replaceProject(path)
		replacements.add(replacement)
		replacement.finally(() => replacements.delete(replacement)).catch(() => undefined)
		return replacement
	}

	return {
		replaceProject: trackReplacement,
		dispose() {
			if (disposal) return disposal
			disposed = true
			generation += 1
			disposal = (async () => {
				await Promise.allSettled([...replacements])
				await commitQueue
				const previous = activeSession
				activeSession = undefined
				const errors: unknown[] = []
				try {
					args.setActiveSession(undefined)
				} catch (error) {
					errors.push(error)
				}
				try {
					await previous?.dispose()
				} catch (error) {
					errors.push(error)
				}
				if (errors.length > 0) {
					throw new AggregateError(errors, "Failed to dispose project lifecycle")
				}
			})()
			return disposal
		},
	}
}
