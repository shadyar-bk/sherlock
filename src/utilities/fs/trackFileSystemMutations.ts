import type { FileSystem } from "./createFileSystemMapper.js"

export type FileSystemMutation =
	| {
			type: "write"
			path: string
			data: Parameters<FileSystem["writeFile"]>[1]
			options: Parameters<FileSystem["writeFile"]>[2]
	  }
	| { type: "delete"; path: string; recursive: boolean }

export function trackFileSystemMutations(
	fileSystem: FileSystem,
	onDidMutate: (mutation: FileSystemMutation) => Promise<void> | void
): FileSystem {
	return new Proxy(fileSystem, {
		get(target, property, receiver) {
			if (property === "writeFile") {
				return async (...args: Parameters<FileSystem["writeFile"]>) => {
					await Reflect.apply(target.writeFile, target, args)
					await onDidMutate({
						type: "write",
						path: String(args[0]),
						data: args[1],
						options: args[2],
					})
				}
			}
			if (property === "rmdir" || property === "unlink") {
				return async (...args: unknown[]) => {
					await Reflect.apply(target[property], target, args)
					await onDidMutate({ type: "delete", path: String(args[0]), recursive: false })
				}
			}
			if (property === "copyFile") {
				return async (...args: Parameters<FileSystem["copyFile"]>) => {
					const copiedData = await target.readFile(args[0])
					await Reflect.apply(target.copyFile, target, args)
					await onDidMutate({
						type: "write",
						path: String(args[1]),
						data: copiedData,
						options: undefined,
					})
				}
			}
			if (property === "rm") {
				return async (...args: Parameters<FileSystem["rm"]>) => {
					await Reflect.apply(target.rm, target, args)
					await onDidMutate({
						type: "delete",
						path: String(args[0]),
						recursive: args[1]?.recursive === true,
					})
				}
			}
			return Reflect.get(target, property, receiver)
		},
	})
}
