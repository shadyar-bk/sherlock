import * as vscode from "vscode"
import { CONFIGURATION } from "../../configuration.js"
import { getPreviewLocale } from "../locale/getPreviewLocale.js"

let statusBarItem: vscode.StatusBarItem | undefined = undefined
let updateGeneration = 0
let disposed = true

export const statusBar = async (args: { context: vscode.ExtensionContext }) => {
	disposed = false
	// when project view changes, status bar
	args.context.subscriptions.push(
		CONFIGURATION.EVENTS.ON_DID_PROJECT_TREE_VIEW_CHANGE.event(() => {
			void showStatusBar()
		})
	)
	// when value of previewLanguageTag changes, update status bar
	args.context.subscriptions.push(
		CONFIGURATION.EVENTS.ON_DID_PREVIEW_LOCALE_CHANGE.event(() => {
			void showStatusBar()
		})
	)

	await showStatusBar()
	args.context.subscriptions.push({
		dispose: () => {
			disposed = true
			updateGeneration += 1
			statusBarItem?.dispose()
			statusBarItem = undefined
		},
	})
}

export const showStatusBar = async () => {
	const generation = ++updateGeneration
	const previewLanguageTag = await getPreviewLocale()
	if (disposed || generation !== updateGeneration) return

	const nextStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
	nextStatusBarItem.command = "sherlock.previewLanguageTag"
	nextStatusBarItem.text = `Sherlock: ${previewLanguageTag}`
	nextStatusBarItem.tooltip = "Switch preview language"
	nextStatusBarItem.show()

	const previousStatusBarItem = statusBarItem
	statusBarItem = nextStatusBarItem
	previousStatusBarItem?.dispose()
}
