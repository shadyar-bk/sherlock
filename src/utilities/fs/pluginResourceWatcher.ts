import path from "node:path"
import crypto from "node:crypto"
import type fs from "node:fs"
import * as vscode from "vscode"
import type { InlangProject } from "@inlang/sdk"
import { deactivateBeforeClose, type ProjectSession } from "../project/projectSession.js"
import type { FileSystemMutation } from "./createFileSystemMapper.js"

const DEBOUNCE_MS = 150
const MISSING_RESOURCE = Symbol("missing resource")

export type ResourceLoadSnapshot = ReadonlyMap<string, string | typeof MISSING_RESOURCE>

type ResourceWriteState = {
	activeWrites: number
	revision: number
	refreshers: Set<() => Promise<void>>
	trackedPaths: Map<string, number>
	expectedFingerprints: Map<string, string | typeof MISSING_RESOURCE>
	suppressedPaths: Set<string>
	release?: Promise<void>
	releaseWrite?: () => void
	writesSucceeded: boolean
}

const resourceWrites = new WeakMap<object, ResourceWriteState>()

export type PluginResourceDescriptor = {
	pluginKey: string
	path: string
	absolutePath: string
	locale: string
	metadata?: Record<string, unknown>
}

function reportError(onError: ((error: unknown) => void) | undefined, error: unknown) {
	try {
		onError?.(error)
	} catch (reportingError) {
		console.error("Failed to report plugin-resource watcher error", reportingError)
	}
}

export async function discoverPluginResourceDescriptors(args: {
	session: ProjectSession<InlangProject>
	onError?(error: unknown): void
}): Promise<PluginResourceDescriptor[]> {
	const settings = await args.session.project.settings.get()
	const plugins = await args.session.project.plugins.get()
	const projectDirectory = path.dirname(args.session.path)
	const descriptors: PluginResourceDescriptor[] = []

	for (const plugin of plugins) {
		if (!plugin.toBeImportedFiles || !plugin.importFiles) continue
		try {
			for (const descriptor of await plugin.toBeImportedFiles({ settings })) {
				descriptors.push({
					pluginKey: plugin.key,
					path: descriptor.path,
					absolutePath: path.normalize(
						path.isAbsolute(descriptor.path)
							? descriptor.path
							: path.resolve(projectDirectory, descriptor.path)
					),
					locale: descriptor.locale,
					metadata: descriptor.metadata,
				})
			}
		} catch (error) {
			reportError(args.onError, error)
		}
	}

	return descriptors
}

function escapeGlobFilename(filename: string) {
	return filename.replace(/[\[\]*?{}]/g, (character) => {
		if (character === "[") return "[[]"
		if (character === "]") return "[]]"
		return `[${character}]`
	})
}

function isMissingFile(error: unknown) {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

async function fingerprint(filePath: string) {
	const content = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath))
	return fingerprintContent(content)
}

function fingerprintContent(content: string | NodeJS.ArrayBufferView) {
	return crypto.createHash("sha256").update(content).digest("hex")
}

function fingerprintWrite(mutation: Extract<FileSystemMutation, { type: "write" }>) {
	const hash = crypto.createHash("sha256")
	if (typeof mutation.data === "string") {
		const encoding =
			typeof mutation.options === "string"
				? mutation.options
				: (mutation.options?.encoding ?? "utf8")
		return hash.update(mutation.data, encoding).digest("hex")
	}
	if (ArrayBuffer.isView(mutation.data)) {
		return hash.update(mutation.data).digest("hex")
	}
	return undefined
}

function isPathWithin(parentPath: string, filePath: string) {
	const relativePath = path.relative(parentPath, filePath)
	return (
		relativePath === "" ||
		(relativePath !== ".." &&
			!relativePath.startsWith(`..${path.sep}`) &&
			!path.isAbsolute(relativePath))
	)
}

export function createResourceLoadTracker(fileSystem: typeof fs): {
	fs: typeof fs
	snapshot: ResourceLoadSnapshot
} {
	const snapshot = new Map<string, string | typeof MISSING_RESOURCE>()
	const trackedReadFile = async (...args: unknown[]) => {
		const filePath = path.normalize(String(args[0]))
		try {
			const content = await Reflect.apply(fileSystem.promises.readFile, fileSystem.promises, args)
			if (!snapshot.has(filePath)) snapshot.set(filePath, fingerprintContent(content))
			return content
		} catch (error) {
			if (isMissingFile(error) && !snapshot.has(filePath)) {
				snapshot.set(filePath, MISSING_RESOURCE)
			}
			throw error
		}
	}
	const promises = new Proxy(fileSystem.promises, {
		get(target, property, receiver) {
			if (property === "readFile") return trackedReadFile
			return Reflect.get(target, property, receiver)
		},
	})
	const trackedFileSystem = new Proxy(fileSystem, {
		get(target, property, receiver) {
			if (property === "promises") return promises
			return Reflect.get(target, property, receiver)
		},
	})
	return { fs: trackedFileSystem, snapshot }
}

function resourceWriteState(project: object) {
	let state = resourceWrites.get(project)
	if (!state) {
		state = {
			activeWrites: 0,
			revision: 0,
			refreshers: new Set(),
			trackedPaths: new Map(),
			expectedFingerprints: new Map(),
			suppressedPaths: new Set(),
			writesSucceeded: true,
		}
		resourceWrites.set(project, state)
	}
	return state
}

export async function runWithPluginResourceWrite<T>(
	project: object,
	write: (recordResourceWrite: (mutation: FileSystemMutation) => void) => Promise<T>
) {
	const state = resourceWriteState(project)
	if (state.activeWrites === 0) {
		state.revision += 1
		state.writesSucceeded = true
		state.expectedFingerprints.clear()
		state.suppressedPaths.clear()
		state.release = new Promise<void>((resolve) => {
			state.releaseWrite = resolve
		})
	}
	state.activeWrites += 1
	const recordResourceWrite = (mutation: FileSystemMutation) => {
		const normalizedPath = path.normalize(mutation.path)
		if (mutation.type === "write") {
			if (!state.trackedPaths.has(normalizedPath)) return
			const intendedFingerprint = fingerprintWrite(mutation)
			if (intendedFingerprint !== undefined) {
				state.expectedFingerprints.set(normalizedPath, intendedFingerprint)
			}
			return
		}
		for (const trackedPath of state.trackedPaths.keys()) {
			if (
				trackedPath === normalizedPath ||
				(mutation.recursive && isPathWithin(normalizedPath, trackedPath))
			) {
				state.expectedFingerprints.set(trackedPath, MISSING_RESOURCE)
			}
		}
	}
	try {
		return await write(recordResourceWrite)
	} catch (error) {
		state.writesSucceeded = false
		throw error
	} finally {
		state.activeWrites -= 1
		if (state.activeWrites === 0) {
			try {
				if (state.writesSucceeded) {
					for (const refresh of state.refreshers) await refresh()
				}
			} finally {
				state.releaseWrite?.()
				state.release = undefined
				state.releaseWrite = undefined
			}
		}
	}
}

export async function setupPluginResourceWatcher(args: {
	session: ProjectSession<InlangProject>
	loadSnapshot?: ResourceLoadSnapshot
	onError?(error: unknown): void
}): Promise<PluginResourceDescriptor[]> {
	const discovery = await args.session.runTask(() =>
		discoverPluginResourceDescriptors({ session: args.session, onError: args.onError })
	)
	if (discovery.status === "inactive") return []

	const descriptors = discovery.value
	const resourcePaths = [...new Set(descriptors.map((descriptor) => descriptor.absolutePath))]
	const fingerprints = new Map<string, string | typeof MISSING_RESOURCE>()
	const watchers: vscode.FileSystemWatcher[] = []
	const running = new Set<Promise<unknown>>()
	const pendingEvents = new Map<string, "create" | "change" | "delete">()
	const processingPaths = new Set<string>()
	let acceptingEvents = true
	let initializingFingerprints = true
	let changedDuringInitialization = false
	let changedAcrossLoadHandoff = false
	let debounceTimer: NodeJS.Timeout | undefined

	const requestReconciliation = () => {
		debounceTimer = undefined
		if (!acceptingEvents) return
		args.session.requestReconciliation()
	}

	const scheduleReload = () => {
		if (!acceptingEvents) return
		if (args.session.requestReconciliation({ deferStart: true }).status === "superseded") return
		if (debounceTimer) clearTimeout(debounceTimer)
		debounceTimer = setTimeout(requestReconciliation, DEBOUNCE_MS)
	}

	const processEvent = async (
		filePath: string,
		event: "create" | "change" | "delete"
	): Promise<void> => {
		if (!acceptingEvents) return
		const writeState = resourceWriteState(args.session.project)
		const writeRevision = writeState.revision
		if (writeState.activeWrites > 0) {
			await writeState.release
			if (writeState.writesSucceeded && writeState.suppressedPaths.has(filePath)) return
		}
		if (event === "delete") {
			if (fingerprints.get(filePath) === MISSING_RESOURCE) return
			fingerprints.set(filePath, MISSING_RESOURCE)
			scheduleReload()
			return
		}

		try {
			const nextFingerprint = await fingerprint(filePath)
			if (writeState.activeWrites > 0) await writeState.release
			if (writeState.revision !== writeRevision) {
				if (writeState.writesSucceeded && writeState.suppressedPaths.has(filePath)) return
				return processEvent(filePath, event)
			}
			if (!acceptingEvents || fingerprints.get(filePath) === nextFingerprint) return
			fingerprints.set(filePath, nextFingerprint)
			scheduleReload()
		} catch (error) {
			if (writeState.activeWrites > 0) await writeState.release
			if (writeState.revision !== writeRevision) {
				if (writeState.writesSucceeded && writeState.suppressedPaths.has(filePath)) return
				return processEvent(filePath, event)
			}
			if (isMissingFile(error)) {
				if (event === "create" || fingerprints.get(filePath) !== MISSING_RESOURCE) {
					fingerprints.set(filePath, MISSING_RESOURCE)
					scheduleReload()
				}
			} else {
				reportError(args.onError, error)
				scheduleReload()
			}
		}
	}

	const handleEvent = (filePath: string, event: "create" | "change" | "delete") => {
		if (!acceptingEvents) return
		if (initializingFingerprints) {
			changedDuringInitialization = true
			return
		}
		pendingEvents.set(filePath, event)
		if (processingPaths.has(filePath)) return
		processingPaths.add(filePath)
		const execution = args.session.runTask(async () => {
			try {
				while (acceptingEvents) {
					const pendingEvent = pendingEvents.get(filePath)
					if (!pendingEvent) return
					pendingEvents.delete(filePath)
					await processEvent(filePath, pendingEvent)
				}
			} finally {
				processingPaths.delete(filePath)
			}
		})
		running.add(execution)
		void execution.finally(() => running.delete(execution)).catch(() => undefined)
	}

	const writeState = resourceWriteState(args.session.project)
	const refreshAfterWrite = async () => {
		for (const [filePath, expectedFingerprint] of writeState.expectedFingerprints) {
			if (!fingerprints.has(filePath)) continue
			try {
				const currentFingerprint = await fingerprint(filePath)
				if (currentFingerprint !== expectedFingerprint) {
					fingerprints.set(filePath, currentFingerprint)
					scheduleReload()
					continue
				}
				fingerprints.set(filePath, currentFingerprint)
				writeState.suppressedPaths.add(filePath)
			} catch (error) {
				if (isMissingFile(error) && expectedFingerprint === MISSING_RESOURCE) {
					fingerprints.set(filePath, MISSING_RESOURCE)
					writeState.suppressedPaths.add(filePath)
				} else if (isMissingFile(error)) {
					fingerprints.set(filePath, MISSING_RESOURCE)
					scheduleReload()
				} else if (!isMissingFile(error)) {
					reportError(args.onError, error)
					scheduleReload()
				}
			}
		}
	}
	for (const filePath of resourcePaths) {
		writeState.trackedPaths.set(filePath, (writeState.trackedPaths.get(filePath) ?? 0) + 1)
	}
	writeState.refreshers.add(refreshAfterWrite)
	const controller = deactivateBeforeClose({
		dispose: async () => {
			acceptingEvents = false
			writeState.refreshers.delete(refreshAfterWrite)
			for (const filePath of resourcePaths) {
				const owners = writeState.trackedPaths.get(filePath) ?? 0
				if (owners <= 1) writeState.trackedPaths.delete(filePath)
				else writeState.trackedPaths.set(filePath, owners - 1)
			}
			if (debounceTimer) clearTimeout(debounceTimer)
			debounceTimer = undefined
			for (const watcher of watchers) watcher.dispose()
			await Promise.allSettled([...running])
			pendingEvents.clear()
			fingerprints.clear()
		},
	})
	if (!args.session.own(controller)) {
		await controller.dispose()
		return descriptors
	}

	for (const filePath of resourcePaths) {
		try {
			const watcher = vscode.workspace.createFileSystemWatcher(
				new vscode.RelativePattern(
					path.dirname(filePath),
					escapeGlobFilename(path.basename(filePath))
				)
			)
			watcher.onDidCreate(() => handleEvent(filePath, "create"))
			watcher.onDidChange(() => handleEvent(filePath, "change"))
			watcher.onDidDelete(() => handleEvent(filePath, "delete"))
			watchers.push(watcher)
		} catch (error) {
			reportError(args.onError, error)
		}
	}

	await args.session.runTask(async () => {
		for (const filePath of resourcePaths) {
			try {
				const currentFingerprint = await fingerprint(filePath)
				fingerprints.set(filePath, currentFingerprint)
				const loadedFingerprint = args.loadSnapshot?.get(filePath)
				if (
					args.loadSnapshot &&
					(loadedFingerprint === undefined || loadedFingerprint !== currentFingerprint)
				) {
					changedAcrossLoadHandoff = true
				}
			} catch (error) {
				if (isMissingFile(error)) {
					fingerprints.set(filePath, MISSING_RESOURCE)
					const loadedFingerprint = args.loadSnapshot?.get(filePath)
					if (
						args.loadSnapshot &&
						(loadedFingerprint === undefined || loadedFingerprint !== MISSING_RESOURCE)
					) {
						changedAcrossLoadHandoff = true
					}
				} else {
					reportError(args.onError, error)
					if (args.loadSnapshot) changedAcrossLoadHandoff = true
				}
			}
		}

		if (args.loadSnapshot) {
			for (const filePath of resourcePaths) {
				try {
					const verifiedFingerprint = await fingerprint(filePath)
					if (fingerprints.get(filePath) !== verifiedFingerprint) {
						fingerprints.set(filePath, verifiedFingerprint)
						changedAcrossLoadHandoff = true
					}
				} catch (error) {
					if (isMissingFile(error)) {
						if (fingerprints.get(filePath) !== MISSING_RESOURCE) {
							fingerprints.set(filePath, MISSING_RESOURCE)
							changedAcrossLoadHandoff = true
						}
					} else {
						reportError(args.onError, error)
						changedAcrossLoadHandoff = true
					}
				}
			}
		}
	})
	initializingFingerprints = false
	if (changedDuringInitialization || changedAcrossLoadHandoff) scheduleReload()

	return descriptors
}
