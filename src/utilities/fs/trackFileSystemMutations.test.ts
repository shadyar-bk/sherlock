import { describe, expect, it, vi } from "vitest"
import type { FileSystem } from "./createFileSystemMapper.js"
import { trackFileSystemMutations } from "./trackFileSystemMutations.js"

describe("trackFileSystemMutations", () => {
	it("reports successful resource writes and deletions after they reach disk", async () => {
		const operations: string[] = []
		const fileSystem = {
			writeFile: vi.fn(async () => {
				operations.push("write")
			}),
			unlink: vi.fn(async () => {
				operations.push("unlink")
			}),
		} as unknown as FileSystem
		const onDidMutate = vi.fn(() => {
			operations.push("record")
		})
		const tracked = trackFileSystemMutations(fileSystem, onDidMutate)

		await tracked.writeFile("/workspace/en.json", "saved")
		await tracked.unlink("/workspace/de.json")

		expect(operations).toEqual(["write", "record", "unlink", "record"])
		expect(onDidMutate).toHaveBeenNthCalledWith(1, {
			type: "write",
			path: "/workspace/en.json",
			data: "saved",
			options: undefined,
		})
		expect(onDidMutate).toHaveBeenNthCalledWith(2, {
			type: "delete",
			path: "/workspace/de.json",
			recursive: false,
		})
	})

	it("reports a successful copy as a write to its destination", async () => {
		const copied = new Uint8Array([1, 2, 3])
		const operations: string[] = []
		const fileSystem = {
			copyFile: vi.fn(async () => {
				operations.push("copy")
			}),
			readFile: vi.fn(async () => {
				operations.push("read source")
				return copied
			}),
		} as unknown as FileSystem
		const onDidMutate = vi.fn(() => {
			operations.push("record")
		})
		const tracked = trackFileSystemMutations(fileSystem, onDidMutate)

		await tracked.copyFile("/tmp/export.json", "/workspace/en.json")

		expect(fileSystem.copyFile).toHaveBeenCalledWith("/tmp/export.json", "/workspace/en.json")
		expect(fileSystem.readFile).toHaveBeenCalledWith("/tmp/export.json")
		expect(operations).toEqual(["read source", "copy", "record"])
		expect(onDidMutate).toHaveBeenCalledWith({
			type: "write",
			path: "/workspace/en.json",
			data: copied,
			options: undefined,
		})
	})

	it("does not report a mutation that failed", async () => {
		const writeError = new Error("disk full")
		const fileSystem = {
			writeFile: vi.fn(async () => Promise.reject(writeError)),
		} as unknown as FileSystem
		const onDidMutate = vi.fn()
		const tracked = trackFileSystemMutations(fileSystem, onDidMutate)

		await expect(tracked.writeFile("/workspace/en.json", "partial")).rejects.toBe(writeError)

		expect(onDidMutate).not.toHaveBeenCalled()
	})
})
