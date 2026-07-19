import * as vscode from "vscode"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CONFIGURATION } from "../../configuration.js"
import { getPreviewLocale } from "../locale/getPreviewLocale.js"
import { showStatusBar, statusBar } from "./statusBar.js"

const createdItems: Array<{
	dispose: ReturnType<typeof vi.fn>
	command?: string
	text?: string
	tooltip?: string
	show: ReturnType<typeof vi.fn>
}> = []

vi.mock("vscode", () => ({
	window: {
		createStatusBarItem: vi.fn(() => {
			const item = {
				dispose: vi.fn(),
				command: undefined,
				text: undefined,
				tooltip: undefined,
				show: vi.fn(),
			}
			createdItems.push(item)
			return item
		}),
	},
	StatusBarAlignment: { Right: 1 },
	commands: { registerCommand: vi.fn() },
	CodeActionKind: { QuickFix: "quickfix" },
	EventEmitter: class {
		fire = vi.fn()
		event = vi.fn(() => ({ dispose: vi.fn() }))
	},
}))

vi.mock("../locale/getPreviewLocale.js", () => ({
	getPreviewLocale: vi.fn(),
}))

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise
	})
	return { promise, resolve }
}

const activeContexts: vscode.ExtensionContext[] = []

async function activateStatusBar() {
	const context = { subscriptions: [] } as unknown as vscode.ExtensionContext
	activeContexts.push(context)
	await statusBar({ context })
	return context
}

describe("statusBar", () => {
	beforeEach(() => {
		createdItems.length = 0
		vi.clearAllMocks()
		vi.mocked(getPreviewLocale).mockResolvedValue("en")
	})

	afterEach(() => {
		for (const context of activeContexts.splice(0)) {
			for (let index = context.subscriptions.length - 1; index >= 0; index -= 1) {
				context.subscriptions[index]!.dispose()
			}
		}
	})

	it("subscribes to project and locale changes and creates the initial item", async () => {
		const context = await activateStatusBar()

		expect(context.subscriptions).toHaveLength(3)
		expect(CONFIGURATION.EVENTS.ON_DID_PROJECT_TREE_VIEW_CHANGE.event).toHaveBeenCalled()
		expect(CONFIGURATION.EVENTS.ON_DID_PREVIEW_LOCALE_CHANGE.event).toHaveBeenCalled()
		expect(createdItems.at(-1)?.text).toBe("Sherlock: en")
	})

	it("replaces and disposes the existing item", async () => {
		await activateStatusBar()
		const firstItem = createdItems.at(-1)!
		vi.mocked(getPreviewLocale).mockResolvedValueOnce("de")

		await showStatusBar()

		expect(firstItem.dispose).toHaveBeenCalledTimes(1)
		expect(createdItems.at(-1)?.text).toBe("Sherlock: de")
	})

	it("keeps only the newest concurrent update", async () => {
		await activateStatusBar()
		const slow = deferred<string>()
		const fast = deferred<string>()
		vi.mocked(getPreviewLocale)
			.mockImplementationOnce(() => slow.promise)
			.mockImplementationOnce(() => fast.promise)

		const slowUpdate = showStatusBar()
		const fastUpdate = showStatusBar()
		fast.resolve("de")
		await fastUpdate
		slow.resolve("en")
		await slowUpdate

		expect(createdItems).toHaveLength(2)
		expect(createdItems.at(-1)?.text).toBe("Sherlock: de")
	})

	it("does not recreate the item after disposal", async () => {
		const context = await activateStatusBar()
		const inFlight = deferred<string>()
		vi.mocked(getPreviewLocale).mockImplementationOnce(() => inFlight.promise)
		const update = showStatusBar()

		context.subscriptions.at(-1)?.dispose()
		inFlight.resolve("de")
		await update

		expect(createdItems).toHaveLength(1)
		expect(createdItems[0]?.dispose).toHaveBeenCalledTimes(1)
	})
})
