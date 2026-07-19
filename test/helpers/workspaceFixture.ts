import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

type WorkspacePathSnapshot = {
	targetPath: string
	backupPath: string
	existed: boolean
}

export async function snapshotWorkspacePaths(targetPaths: string[]) {
	const backupDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "sherlock-workspace-fixture-"))
	const snapshots: WorkspacePathSnapshot[] = []

	try {
		for (const [index, targetPath] of targetPaths.entries()) {
			const backupPath = path.join(backupDirectory, String(index))
			let existed = true
			try {
				await fs.lstat(targetPath)
			} catch (error) {
				if (
					typeof error === "object" &&
					error !== null &&
					"code" in error &&
					error.code === "ENOENT"
				) {
					existed = false
				} else {
					throw error
				}
			}
			if (existed)
				await fs.cp(targetPath, backupPath, { recursive: true, preserveTimestamps: true })
			snapshots.push({ targetPath, backupPath, existed })
		}
	} catch (error) {
		await fs.rm(backupDirectory, { recursive: true, force: true })
		throw error
	}

	let restoration: Promise<void> | undefined
	return {
		restore() {
			if (restoration) return restoration
			restoration = (async () => {
				const errors: unknown[] = []
				for (let index = snapshots.length - 1; index >= 0; index -= 1) {
					const snapshot = snapshots[index]!
					try {
						await fs.rm(snapshot.targetPath, { recursive: true, force: true })
						if (snapshot.existed) {
							await fs.mkdir(path.dirname(snapshot.targetPath), { recursive: true })
							await fs.cp(snapshot.backupPath, snapshot.targetPath, {
								recursive: true,
								preserveTimestamps: true,
							})
						}
					} catch (error) {
						errors.push(error)
					}
				}
				if (errors.length > 0) {
					throw new AggregateError(
						errors,
						`Failed to restore E2E workspace fixture: ${errors.map(String).join("; ")}. Recovery backup retained at ${backupDirectory}`
					)
				}
				await fs.rm(backupDirectory, { recursive: true, force: true })
			})()
			return restoration
		},
	}
}
