import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { snapshotWorkspacePaths } from "./workspaceFixture.js"

const temporaryDirectories: string[] = []

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => fs.rm(directory, { recursive: true, force: true }))
	)
})

describe("workspace fixture restoration", () => {
	it("restores existing files and directories and removes only newly created roots", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "sherlock-fixture-test-"))
		temporaryDirectories.push(workspace)
		const settingsPath = path.join(workspace, "project.inlang/settings.json")
		const sourcePath = path.join(workspace, "src/app.js")
		const existingResources = path.join(workspace, "resources")
		const newCatalog = path.join(workspace, "catalog")
		await fs.mkdir(path.dirname(settingsPath), { recursive: true })
		await fs.mkdir(path.dirname(sourcePath), { recursive: true })
		await fs.mkdir(existingResources, { recursive: true })
		await fs.writeFile(settingsPath, "original settings")
		await fs.writeFile(sourcePath, "original source")
		await fs.writeFile(path.join(existingResources, "keep.json"), "original resource")
		const fixture = await snapshotWorkspacePaths([
			settingsPath,
			sourcePath,
			existingResources,
			newCatalog,
		])

		await fs.writeFile(settingsPath, "changed settings")
		await fs.writeFile(sourcePath, "changed source")
		await fs.rm(existingResources, { recursive: true })
		await fs.mkdir(newCatalog, { recursive: true })
		await fs.writeFile(path.join(newCatalog, "created.json"), "created")
		await fixture.restore()

		expect(await fs.readFile(settingsPath, "utf8")).toBe("original settings")
		expect(await fs.readFile(sourcePath, "utf8")).toBe("original source")
		expect(await fs.readFile(path.join(existingResources, "keep.json"), "utf8")).toBe(
			"original resource"
		)
		await expect(fs.stat(newCatalog)).rejects.toMatchObject({ code: "ENOENT" })
	})

	it("retains and reports the recovery backup when restoration fails", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "sherlock-fixture-test-"))
		temporaryDirectories.push(workspace)
		const blockedParent = path.join(workspace, "blocked")
		const targetPath = path.join(blockedParent, "settings.json")
		await fs.mkdir(blockedParent)
		await fs.writeFile(targetPath, "original")
		const fixture = await snapshotWorkspacePaths([targetPath])
		await fs.rm(blockedParent, { recursive: true })
		await fs.writeFile(blockedParent, "not a directory")

		const error = await fixture.restore().catch((caught) => caught)

		expect(error).toBeInstanceOf(AggregateError)
		const backupDirectory = String(error).match(/Recovery backup retained at (.+)$/)?.[1]
		expect(backupDirectory).toBeDefined()
		expect(await fs.readFile(path.join(backupDirectory!, "0"), "utf8")).toBe("original")
		temporaryDirectories.push(backupDirectory!)
	})
})
