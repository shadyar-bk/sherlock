import { beforeEach, describe, expect, it, vi } from "vitest"
import { editorView } from "./editorView.js"
import { saveProject, saveProjectData } from "../../main.js"
import { handleUpdateBundle } from "./helper/handleBundleUpdate.js"
import { createMessage } from "./helper/createMessage.js"
import { selectBundleById } from "../project/selectBundleById.js"

const mocks = vi.hoisted(() => ({
	receiveMessage: undefined as undefined | ((message: unknown) => Promise<void>),
}))

vi.mock("vscode", () => ({
	ViewColumn: { One: 1 },
	workspace: { workspaceFolders: [{ uri: { fsPath: "/workspace" } }] },
	window: {
		createWebviewPanel: vi.fn(() => ({
			webview: {
				html: "",
				postMessage: vi.fn(),
				onDidReceiveMessage: vi.fn((callback) => {
					mocks.receiveMessage = callback
					return { dispose: vi.fn() }
				}),
			},
			onDidDispose: vi.fn(),
			onDidChangeViewState: vi.fn(),
			dispose: vi.fn(),
		})),
	},
}))
vi.mock("../../configuration.js", () => ({
	CONFIGURATION: {
		EVENTS: {
			ON_DID_EDIT_MESSAGE: { fire: vi.fn() },
			ON_DID_EDITOR_VIEW_CHANGE: { fire: vi.fn() },
		},
	},
}))
vi.mock("../messages/msg.js", () => ({ msg: vi.fn() }))
vi.mock("./helper/getUri.js", () => ({ getUri: vi.fn() }))
vi.mock("./helper/getNonce.js", () => ({ getNonce: vi.fn(() => "nonce") }))
vi.mock("./helper/handleBundleUpdate.js", () => ({
	handleUpdateBundle: vi.fn(async () => undefined),
}))
vi.mock("./helper/createMessage.js", () => ({
	createMessage: vi.fn(async () => undefined),
}))
vi.mock("../project/selectBundleById.js", () => ({
	selectBundleById: vi.fn(async () => ({ id: "welcome", messages: [] })),
}))
vi.mock("../../main.js", () => ({
	saveProject: vi.fn(async () => "saved"),
	saveProjectData: vi.fn(async () => undefined),
}))

describe("editorView", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.receiveMessage = undefined
		vi.mocked(saveProject).mockResolvedValue("saved")
	})

	it("does not export an unchanged project during session disposal", async () => {
		const project = {}
		const view = editorView({
			extensionUri: {} as never,
			initialBundleId: "welcome",
			lease: {
				path: "/workspace/project.inlang",
				project,
				isCurrent: () => false,
			} as any,
		})

		await view.dispose({ persist: true })

		expect(saveProjectData).not.toHaveBeenCalled()
	})

	it("persists a dirty focused edit during extension shutdown", async () => {
		const project = {
			db: {},
			settings: { get: vi.fn(async () => ({ locales: [] })) },
		}
		const lease = {
			path: "/workspace/project.inlang",
			project,
			isCurrent: () => true,
			runTask: async <T>(task: () => Promise<T>) => ({
				status: "completed" as const,
				value: await task(),
			}),
		}
		const view = editorView({
			extensionUri: {} as never,
			initialBundleId: "welcome",
			lease: lease as any,
		})
		await view.createOrShowPanel()
		await mocks.receiveMessage?.({
			command: "change",
			change: {
				entity: "variant",
				entityId: "variant-id",
				newData: { id: "variant-id", pattern: [] },
			},
		})

		await view.dispose({ persist: true })

		expect(saveProjectData).toHaveBeenCalledWith(project, "/workspace/project.inlang")
	})

	it("retries a failed blur save during extension shutdown", async () => {
		const project = {
			db: {},
			settings: { get: vi.fn(async () => ({ locales: [] })) },
		}
		const lease = {
			path: "/workspace/project.inlang",
			project,
			isCurrent: () => true,
			runTask: async <T>(task: () => Promise<T>) => ({
				status: "completed" as const,
				value: await task(),
			}),
		}
		const view = editorView({
			extensionUri: {} as never,
			initialBundleId: "welcome",
			lease: lease as any,
		})
		await view.createOrShowPanel()
		await mocks.receiveMessage?.({
			command: "change",
			change: { entity: "variant", entityId: "variant-id", newData: { id: "variant-id" } },
		})
		vi.mocked(saveProject).mockResolvedValueOnce("failed")
		await mocks.receiveMessage?.({ command: "persist-edit" })

		await view.dispose({ persist: true })

		expect(saveProjectData).toHaveBeenCalledWith(project, "/workspace/project.inlang")
	})

	it("does not let an older save acknowledge a newer edit", async () => {
		let finishSave!: (status: "saved") => void
		const saving = new Promise<"saved">((resolve) => {
			finishSave = resolve
		})
		vi.mocked(saveProject).mockReturnValueOnce(saving)
		const project = {
			db: {},
			settings: { get: vi.fn(async () => ({ locales: [] })) },
		}
		const lease = {
			path: "/workspace/project.inlang",
			project,
			isCurrent: () => true,
			runTask: async <T>(task: () => Promise<T>) => ({
				status: "completed" as const,
				value: await task(),
			}),
		}
		const view = editorView({
			extensionUri: {} as never,
			initialBundleId: "welcome",
			lease: lease as any,
		})
		await view.createOrShowPanel()
		await mocks.receiveMessage?.({
			command: "change",
			change: { entity: "variant", entityId: "first", newData: { id: "first" } },
		})
		const firstPersist = mocks.receiveMessage?.({ command: "persist-edit" })
		await vi.waitFor(() => expect(saveProject).toHaveBeenCalledOnce())
		await mocks.receiveMessage?.({
			command: "change",
			change: { entity: "variant", entityId: "second", newData: { id: "second" } },
		})
		finishSave("saved")
		await firstPersist

		await view.dispose({ persist: true })

		expect(saveProjectData).toHaveBeenCalledWith(project, "/workspace/project.inlang")
	})

	it("waits for a matching structural update before acknowledging its revision", async () => {
		let finishSecondUpdate!: () => void
		const secondUpdate = new Promise<void>((resolve) => {
			finishSecondUpdate = resolve
		})
		let finishBundleQuery!: (value: { id: string; messages: never[] }) => void
		const bundleQuery = new Promise<{ id: string; messages: never[] }>((resolve) => {
			finishBundleQuery = resolve
		})
		vi.mocked(handleUpdateBundle).mockResolvedValueOnce(undefined)
		vi.mocked(createMessage).mockReturnValueOnce(secondUpdate)
		const project = {
			db: {},
			settings: { get: vi.fn(async () => ({ locales: [] })) },
		}
		const runTask = vi.fn(async <T>(task: () => Promise<T>) => ({
			status: "completed" as const,
			value: await task(),
		}))
		const view = editorView({
			extensionUri: {} as never,
			initialBundleId: "welcome",
			lease: {
				path: "/workspace/project.inlang",
				project,
				isCurrent: () => true,
				runTask,
			} as any,
		})
		await view.createOrShowPanel()
		vi.mocked(selectBundleById).mockReturnValueOnce(bundleQuery as never)
		const firstChange = mocks.receiveMessage?.({
			command: "change",
			persist: true,
			change: { entity: "variant", entityId: "first", newData: { id: "first" } },
		})
		await vi.waitFor(() => expect(selectBundleById).toHaveBeenCalledTimes(2))
		const secondChange = mocks.receiveMessage?.({
			command: "create-message",
			message: { id: "second" },
		})
		expect(runTask).toHaveBeenCalledTimes(4)

		finishBundleQuery({ id: "welcome", messages: [] })
		await Promise.resolve()
		expect(saveProject).not.toHaveBeenCalled()

		finishSecondUpdate()
		await Promise.all([firstChange, secondChange])
		expect(saveProject).toHaveBeenCalledOnce()
	})
})
