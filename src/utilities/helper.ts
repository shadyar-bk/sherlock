import { type IdeExtensionConfig, type InlangProject } from "@inlang/sdk"
import { state } from "./state.js"

export const getExtensionApi = async (
	project: InlangProject | undefined = state().project
): Promise<IdeExtensionConfig | undefined> => {
	if (!project) return undefined
	return (await project.plugins.get()).find((plugin) => plugin?.meta?.["app.inlang.ideExtension"])
		?.meta?.["app.inlang.ideExtension"] as IdeExtensionConfig | undefined
}
