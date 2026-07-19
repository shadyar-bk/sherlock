import { afterEach, describe, expect, it, vi } from "vitest"
import {
	disposeProjectRuntime,
	getProjectRuntime,
	installProjectRuntime,
	type ProjectRuntime,
} from "./projectRuntime.js"

afterEach(async () => {
	await disposeProjectRuntime()
})

describe("project runtime registry", () => {
	it("installs a single runtime and disposes it idempotently", async () => {
		let finishDisposal!: () => void
		const disposal = new Promise<void>((resolve) => {
			finishDisposal = resolve
		})
		const runtime: ProjectRuntime<{ close(): Promise<void> }> = {
			replaceProject: vi.fn(async () => ({ status: "committed" as const })),
			activeProject: vi.fn(() => undefined),
			lastRequestedProjectPath: vi.fn(() => undefined),
			dispose: vi.fn(() => disposal),
		}

		installProjectRuntime(runtime)
		expect(getProjectRuntime()).toBe(runtime)
		expect(() => installProjectRuntime(runtime)).toThrow("already initialized")

		const firstDisposal = disposeProjectRuntime()
		const secondDisposal = disposeProjectRuntime()
		expect(firstDisposal).toBe(secondDisposal)
		expect(runtime.dispose).toHaveBeenCalledTimes(1)
		expect(() => getProjectRuntime()).toThrow("not initialized")

		finishDisposal()
		await firstDisposal
		await disposeProjectRuntime()
		expect(runtime.dispose).toHaveBeenCalledTimes(1)
	})
})
