import path from "node:path"
import crypto from "node:crypto"
import type fs from "node:fs"
import * as vscode from "vscode"
import type { InlangProject } from "@inlang/sdk"
import { deactivateBeforeClose, type ProjectSession } from "../project/projectSession.js"

const DEBOUNCE_MS = 150
const MISSING_RESOURCE = Symbol("missing resource")

export type ResourceLoadSnapshot = ReadonlyMap<string, string | typeof MISSING_RESOURCE>

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
		if (debounceTimer) clearTimeout(debounceTimer)
		debounceTimer = setTimeout(requestReconciliation, DEBOUNCE_MS)
	}

	const processEvent = async (
		filePath: string,
		event: "create" | "change" | "delete"
	): Promise<void> => {
		if (!acceptingEvents) return
		if (event === "delete") {
			if (fingerprints.get(filePath) === MISSING_RESOURCE) return
			fingerprints.set(filePath, MISSING_RESOURCE)
			scheduleReload()
			return
		}

		try {
			const nextFingerprint = await fingerprint(filePath)
			if (!acceptingEvents || fingerprints.get(filePath) === nextFingerprint) return
			fingerprints.set(filePath, nextFingerprint)
			scheduleReload()
		} catch (error) {
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

	const controller = deactivateBeforeClose({
		dispose: async () => {
			acceptingEvents = false
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
