import * as vscode from "vscode"
import { updateSetting } from "../utilities/settings/index.js"
import { state } from "../utilities/state.js"
import { CONFIGURATION } from "../configuration.js"
import { getPreviewLocale } from "../utilities/locale/getPreviewLocale.js"

const showPreviewLocalePicker = async (locales: string[]): Promise<string | undefined> => {
	const previewLocale = await getPreviewLocale()
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
		const settings = await state().project?.settings.get()
		const selectedLocale = await showPreviewLocalePicker(settings.locales)

		if (!selectedLocale) {
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
