import { state } from "../state.js"
import { getSetting } from "../settings/index.js"
import type { InlangProject } from "@inlang/sdk"

export async function getPreviewLocale(project: InlangProject | undefined = state().project) {
	if (!project) return undefined
	const settings = await project.settings.get()
	const baseLocale = settings.baseLocale
	const previewLanguageTag = ((await getSetting("previewLanguageTag")) as string) || baseLocale

	const isPreviewLangAvailable = settings.locales.includes(previewLanguageTag)
	return isPreviewLangAvailable ? previewLanguageTag : baseLocale
}
