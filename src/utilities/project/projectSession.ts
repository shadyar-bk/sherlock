export type ProjectSession<Project extends { close(): Promise<void> }> = {
	readonly path: string
	readonly project: Project
	own(resource: Disposable): boolean
	runTask<T>(task: () => Promise<T>): Promise<ProjectTaskResult<T>>
	requestReconciliation(options?: { deferStart?: boolean }): ProjectReconciliationRequestResult
}

export type ProjectTaskResult<T> = { status: "completed"; value: T } | { status: "inactive" }

export type ProjectSessionDisposalReason = "replacement" | "shutdown"

export type ProjectReconciliationRequestResult =
	| { status: "scheduled" }
	| { status: "deferred" }
	| { status: "superseded" }

export type Disposable = {
	dispose(reason?: ProjectSessionDisposalReason): unknown
	deactivate?(reason?: ProjectSessionDisposalReason): unknown
}

export function deactivateBeforeClose(resource: Disposable): Disposable {
	let disposal: Promise<void> | undefined
	const dispose = (reason?: ProjectSessionDisposalReason) => {
		if (!disposal) {
			try {
				disposal = Promise.resolve(resource.dispose(reason)).then(() => undefined)
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
	onError?(
		error: unknown,
		phase: "cleanup" | "activation" | "notification" | "reconciliation"
	): void
}) {
	let activeSession:
		| (ProjectSession<Project> & {
				dispose(reason?: ProjectSessionDisposalReason): Promise<void>
				markReconciliationDirty(): void
				flushDirtyReconciliation(): void
				takeReconciliationDirty(): boolean
		  })
		| undefined
	let disposed = false
	let disposal: Promise<void> | undefined
	let generation = 0
	let commitQueue = Promise.resolve()
	const replacements = new Set<Promise<ProjectReplacementResult>>()
	const pendingUserReplacementGenerations = new Set<number>()

	function createSession(path: string, project: Project, sessionGeneration: number) {
		let resources: Disposable[] = []
		let sessionDisposed = false
		let active = false
		let reconciliationDirty = false
		let reconciliationStartDeferred = false
		let reconciliationInFlight = false
		const tasks = new Set<Promise<unknown>>()
		let session: ProjectSession<Project> & {
			resources: Disposable[]
			activate(): void
			markReconciliationDirty(): void
			flushDirtyReconciliation(): void
			takeReconciliationDirty(): boolean
			dispose(reason?: ProjectSessionDisposalReason): Promise<void>
		}
		const hasNewerUserReplacement = () =>
			[...pendingUserReplacementGenerations].some(
				(replacementGeneration) => replacementGeneration > sessionGeneration
			)
		const scheduleReconciliation = () => {
			reconciliationDirty = false
			reconciliationStartDeferred = false
			reconciliationInFlight = true
			void trackReplacement(path, session)
				.then((result) => {
					if (result.status === "failed") reportError(result.error, "reconciliation")
					if (result.status === "superseded") session.markReconciliationDirty()
				})
				.finally(() => {
					reconciliationInFlight = false
					session.flushDirtyReconciliation()
				})
		}
		session = {
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
			requestReconciliation(options) {
				if (!active || sessionDisposed || activeSession !== session) return SUPERSEDED
				if (options?.deferStart) {
					reconciliationDirty = true
					reconciliationStartDeferred = true
					return { status: "deferred" }
				}
				reconciliationStartDeferred = false
				if (hasNewerUserReplacement()) {
					reconciliationDirty = true
					return { status: "deferred" }
				}
				if (reconciliationInFlight) {
					reconciliationDirty = true
					return { status: "scheduled" }
				}
				scheduleReconciliation()
				return { status: "scheduled" }
			},
			markReconciliationDirty() {
				reconciliationDirty = true
				reconciliationStartDeferred = false
			},
			flushDirtyReconciliation() {
				if (
					!reconciliationDirty ||
					reconciliationStartDeferred ||
					!active ||
					sessionDisposed ||
					activeSession !== session ||
					hasNewerUserReplacement() ||
					reconciliationInFlight
				) {
					return
				}
				scheduleReconciliation()
			},
			takeReconciliationDirty() {
				const dirty = reconciliationDirty
				reconciliationDirty = false
				reconciliationStartDeferred = false
				return dirty
			},
			async dispose(reason: ProjectSessionDisposalReason = "replacement") {
				if (sessionDisposed) return
				sessionDisposed = true
				active = false
				const errors: unknown[] = []
				const earlyDisposals = new Map<Disposable, Promise<PromiseSettledResult<void>>>()
				for (let index = resources.length - 1; index >= 0; index -= 1) {
					const resource = resources[index]!
					if (!resource.deactivate) continue
					try {
						earlyDisposals.set(
							resource,
							Promise.resolve(resource.deactivate(reason)).then(
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
				for (let index = resources.length - 1; index >= 0; index -= 1) {
					const resource = resources[index]!
					const earlyDisposal = earlyDisposals.get(resource)
					if (earlyDisposal) {
						const result = await earlyDisposal
						if (result.status === "rejected") errors.push(result.reason)
						continue
					}
					try {
						await resource.dispose(reason)
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
		return session
	}

	function reportError(
		error: unknown,
		phase: "cleanup" | "activation" | "notification" | "reconciliation"
	) {
		try {
			args.onError?.(error, phase)
		} catch (reportingError) {
			console.error("Failed to report project-session error", reportingError)
		}
	}

	async function disposeCandidate(
		candidate: ProjectSession<Project> & {
			dispose(reason?: ProjectSessionDisposalReason): Promise<void>
		},
		message: string
	): Promise<Extract<ProjectReplacementResult, { status: "failed" }> | undefined> {
		try {
			await candidate.dispose()
			return undefined
		} catch (error) {
			return { status: "failed", error: new AggregateError([error], message) }
		}
	}

	async function replaceProject(path: string, replacementGeneration: number) {
		if (disposed) return SUPERSEDED
		let project: Project
		try {
			project = await args.loadProject(path)
		} catch (error) {
			if (disposed || replacementGeneration !== generation) return SUPERSEDED
			return { status: "failed", error } as const
		}

		const candidate = createSession(path, project, replacementGeneration)
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
			if (previous?.path === candidate.path && previous.takeReconciliationDirty()) {
				candidate.markReconciliationDirty()
			}
			try {
				await previous?.dispose("replacement")
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

	function trackReplacement(
		path: string,
		reconciliationSource?: NonNullable<typeof activeSession>
	) {
		const replacementGeneration = ++generation
		if (!reconciliationSource) pendingUserReplacementGenerations.add(replacementGeneration)
		const replacement = replaceProject(path, replacementGeneration)
		replacements.add(replacement)
		replacement
			.finally(() => {
				replacements.delete(replacement)
				pendingUserReplacementGenerations.delete(replacementGeneration)
				activeSession?.flushDirtyReconciliation()
			})
			.catch(() => undefined)
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
					await previous?.dispose("shutdown")
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
