import { selectBundleNested, type InlangProject } from "@inlang/sdk"

export function selectBundleById(project: InlangProject, bundleId: string) {
	return selectBundleNested(project.db).where("bundle.id", "=", bundleId).executeTakeFirst()
}
