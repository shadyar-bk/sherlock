import type fs from "node:fs/promises"
import * as _path from "node:path"

export type FileSystem = typeof fs

/**
 * Map file system paths to a base path.
 * @param base The base path to map to.
 * @param fs The file system to map.
 * @returns The mapped file system.
 */
export function createFileSystemMapper(base: string, fs: FileSystem): FileSystem {
	// Prevent path issue on non Unix based system normalizing the <base> before using it
	const normalizedBase = _path.normalize(base)
	const resolveMappedPath = (filePath: Parameters<FileSystem["readFile"]>[0]) =>
		_path.normalize(
			String(filePath).startsWith(normalizedBase)
				? String(filePath)
				: _path.resolve(normalizedBase, String(filePath))
		)

	return {
		// TODO: Those expected typescript errors are because of overloads in node:fs/promises
		// @ts-expect-error
		readFile: async (
			path: Parameters<FileSystem["readFile"]>[0],
			options: Parameters<FileSystem["readFile"]>[1]
		): Promise<string | Uint8Array> => fs.readFile(resolveMappedPath(path), options),
		writeFile: (
			path: Parameters<FileSystem["writeFile"]>[0],
			data: Parameters<FileSystem["writeFile"]>[1],
			options: Parameters<FileSystem["writeFile"]>[2]
		) => fs.writeFile(resolveMappedPath(path), data, options),
		// @ts-expect-error
		mkdir: async (
			path: Parameters<FileSystem["mkdir"]>[0],
			options?: Parameters<FileSystem["mkdir"]>[1]
		) => fs.mkdir(resolveMappedPath(path), options),
		rmdir: (path: Parameters<FileSystem["rmdir"]>[0]) => fs.rmdir(resolveMappedPath(path)),
		rm: (path: Parameters<FileSystem["rm"]>[0], options: Parameters<FileSystem["rm"]>[1]) =>
			fs.rm(resolveMappedPath(path), options),
		unlink: (path: Parameters<FileSystem["unlink"]>[0]) => fs.unlink(resolveMappedPath(path)),
		// @ts-expect-error
		readdir: async (path: Parameters<FileSystem["readdir"]>[0]) =>
			fs.readdir(resolveMappedPath(path)),
		// @ts-expect-error
		readlink: async (path: Parameters<FileSystem["readlink"]>[0]) =>
			fs.readlink(resolveMappedPath(path)),
		symlink: async (
			path: Parameters<FileSystem["symlink"]>[0],
			target: Parameters<FileSystem["symlink"]>[1]
		) => fs.symlink(resolveMappedPath(path), resolveMappedPath(target)),
		// @ts-expect-error
		stat: async (path: Parameters<FileSystem["stat"]>[0]) => fs.stat(resolveMappedPath(path)),
		// @ts-expect-error
		lstat: async (path: Parameters<FileSystem["lstat"]>[0]) => fs.lstat(resolveMappedPath(path)),
		// @ts-expect-error
		watch: (
			path: Parameters<FileSystem["watch"]>[0],
			options: Parameters<FileSystem["watch"]>[1]
		) => fs.watch(resolveMappedPath(path), options),
		access: async (
			path: Parameters<FileSystem["access"]>[0],
			mode: Parameters<FileSystem["access"]>[1]
		) => fs.access(resolveMappedPath(path), mode),
		copyFile: async (
			src: Parameters<FileSystem["copyFile"]>[0],
			dest: Parameters<FileSystem["copyFile"]>[1],
			flags: Parameters<FileSystem["copyFile"]>[2]
		) => fs.copyFile(resolveMappedPath(src), resolveMappedPath(dest), flags),
	}
}
