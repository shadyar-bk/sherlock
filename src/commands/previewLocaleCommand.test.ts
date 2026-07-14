import { describe, it, expect, vi, beforeEach } from "vitest"
import * as vscode from "vscode"
import * as settings from "../utilities/settings/index.js"
import { previewLocaleCommand } from "./previewLocaleCommand.js"
import { CONFIGURATION } from "../configuration.js"
import { state } from "../utilities/state.js"
import { getPreviewLocale } from "../utilities/locale/getPreviewLocale.js"

vi.mock("vscode", () => ({
	window: { createQuickPick: vi.fn() },
	commands: { registerCommand: vi.fn() },
}))
vi.mock("../utilities/settings/index.js", () => ({ updateSetting: vi.fn() }))
vi.mock("../utilities/locale/getPreviewLocale.js", () => ({ getPreviewLocale: vi.fn() }))
vi.mock("../utilities/settings/statusBar.js", () => ({
	showStatusBar: vi.fn(),
}))
vi.mock("../utilities/state.js", () => ({
	state: vi.fn(),
}))
vi.mock("../configuration.js", () => ({
	CONFIGURATION: {
		EVENTS: {
			ON_DID_CREATE_MESSAGE: { fire: vi.fn() },
			ON_DID_EDIT_MESSAGE: { fire: vi.fn() },
			ON_DID_EXTRACT_MESSAGE: { fire: vi.fn() },
			ON_DID_PREVIEW_LOCALE_CHANGE: { fire: vi.fn() },
		},
	},
}))

const createQuickPickMock = (selectedLocale?: string) => {
	let acceptListener: (() => void) | undefined
	let hideListener: (() => void) | undefined

	const quickPick = {
		activeItems: [] as { label: string }[],
		dispose: vi.fn(),
		hide: vi.fn(() => hideListener?.()),
		items: [] as { label: string }[],
		onDidAccept: vi.fn((listener: () => void) => {
			acceptListener = listener
		}),
		onDidHide: vi.fn((listener: () => void) => {
			hideListener = listener
		}),
		placeholder: "",
		selectedItems: [] as { label: string }[],
		show: vi.fn(() => {
			if (!selectedLocale) {
				hideListener?.()
				return
			}

			quickPick.selectedItems = [{ label: selectedLocale }]
			acceptListener?.()
		}),
	}

	return quickPick
}

describe("previewLocaleCommand", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(getPreviewLocale).mockResolvedValue("en")
		vi.mocked(state).mockReturnValue({
			project: {
				// @ts-expect-error
				settings: {
					get: vi.fn().mockResolvedValue({
						baseLocale: "ckb",
						locales: ["ckb", "en", "fr"],
					}),
				},
			},
		})
	})

	it("should register the command", () => {
		expect(previewLocaleCommand.command).toBe("sherlock.previewLanguageTag")
		expect(previewLocaleCommand.title).toBe("Sherlock: Change preview language tag")
		expect(previewLocaleCommand.register).toBe(vscode.commands.registerCommand)
	})

	it("should show language tags and update setting if a tag is selected", async () => {
		const quickPick = createQuickPickMock("fr")
		vi.mocked(vscode.window.createQuickPick).mockReturnValue(quickPick as never)

		await previewLocaleCommand.callback()

		expect(quickPick.items).toEqual([{ label: "ckb" }, { label: "en" }, { label: "fr" }])
		expect(quickPick.activeItems).toEqual([{ label: "en" }])
		expect(quickPick.placeholder).toBe("Select a language")
		expect(settings.updateSetting).toHaveBeenCalledWith("previewLanguageTag", "fr")
		expect(CONFIGURATION.EVENTS.ON_DID_EDIT_MESSAGE.fire).toHaveBeenCalledTimes(1)
		expect(CONFIGURATION.EVENTS.ON_DID_CREATE_MESSAGE.fire).toHaveBeenCalledTimes(1)
		expect(CONFIGURATION.EVENTS.ON_DID_EXTRACT_MESSAGE.fire).toHaveBeenCalledTimes(1)
		expect(CONFIGURATION.EVENTS.ON_DID_PREVIEW_LOCALE_CHANGE.fire).toHaveBeenCalledTimes(1)
	})

	it("should not update setting if no tag is selected", async () => {
		const quickPick = createQuickPickMock()
		vi.mocked(vscode.window.createQuickPick).mockReturnValue(quickPick as never)

		await previewLocaleCommand.callback()

		expect(settings.updateSetting).not.toHaveBeenCalled()
		expect(CONFIGURATION.EVENTS.ON_DID_EDIT_MESSAGE.fire).not.toHaveBeenCalled()
		expect(CONFIGURATION.EVENTS.ON_DID_CREATE_MESSAGE.fire).not.toHaveBeenCalled()
		expect(CONFIGURATION.EVENTS.ON_DID_EXTRACT_MESSAGE.fire).not.toHaveBeenCalled()
		expect(CONFIGURATION.EVENTS.ON_DID_PREVIEW_LOCALE_CHANGE.fire).not.toHaveBeenCalled()
	})
})
