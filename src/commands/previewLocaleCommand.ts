import * as vscode from "vscode"
import { updateSetting } from "../utilities/settings/index.js"
import { CONFIGURATION } from "../configuration.js"
import { getPreviewLocale } from "../utilities/locale/getPreviewLocale.js"
import type { InlangProject } from "@inlang/sdk"
import { getProjectRuntime } from "../utilities/project/projectRuntime.js"

const showPreviewLocalePicker = async (
	locales: string[],
	previewLocale: string | undefined
): Promise<string | undefined> => {
	const quickPick = vscode.window.createQuickPick()
	quickPick.placeholder = "Select a language"
	quickPick.items = locales.map((locale) => ({ label: locale }))
	quickPick.activeItems = quickPick.items.filter((item) => item.label === previewLocale)

	try {
		return await new Promise((resolve) => {
			quickPick.onDidAccept(() => {
				resolve(quickPick.selectedItems[0]?.label)
				quickPick.hide()
			})
			quickPick.onDidHide(() => resolve(undefined))
			quickPick.show()
		})
	} finally {
		quickPick.dispose()
	}
}

export const previewLocaleCommand = {
	command: "sherlock.previewLanguageTag",
	title: "Sherlock: Change preview language tag",
	register: vscode.commands.registerCommand,
	callback: async () => {
		const lease = getProjectRuntime<InlangProject>().activeProject()
		if (!lease) return
		const preview = await lease.runTask(async () => {
			const settings = await lease.project.settings.get()
			return {
				locales: settings.locales,
				previewLocale: await getPreviewLocale(lease.project),
			}
		})
		if (preview.status !== "completed") return
		const selectedLocale = await showPreviewLocalePicker(
			preview.value.locales,
			preview.value.previewLocale
		)

		if (!selectedLocale || !lease.isCurrent()) {
			return
		}

		// TODO: Update key for locale
		await updateSetting("previewLanguageTag", selectedLocale)

		CONFIGURATION.EVENTS.ON_DID_EDIT_MESSAGE.fire()
		CONFIGURATION.EVENTS.ON_DID_EXTRACT_MESSAGE.fire()
		CONFIGURATION.EVENTS.ON_DID_CREATE_MESSAGE.fire()
		CONFIGURATION.EVENTS.ON_DID_PREVIEW_LOCALE_CHANGE.fire(selectedLocale)
	},
}
