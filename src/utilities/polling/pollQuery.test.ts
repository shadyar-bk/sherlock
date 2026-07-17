import { afterEach, describe, expect, it, vi } from "vitest"
import { pollQuery } from "./pollQuery.js"

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise
	})
	return { promise, resolve }
}

afterEach(() => {
	vi.useRealTimers()
})

describe("pollQuery", () => {
	it("never overlaps a slow query", async () => {
		vi.useFakeTimers()
		const first = deferred<number>()
		const query = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(2)
		const subscription = pollQuery(query, 100).subscribe(vi.fn())

		await vi.advanceTimersByTimeAsync(500)
		expect(query).toHaveBeenCalledTimes(1)

		first.resolve(1)
		await Promise.resolve()
		await vi.advanceTimersByTimeAsync(100)
		expect(query).toHaveBeenCalledTimes(2)
		await subscription.unsubscribe()
	})

	it("waits for an in-flight query and suppresses its stale result on unsubscribe", async () => {
		const queryResult = deferred<number>()
		const subscriber = vi.fn()
		const subscription = pollQuery(() => queryResult.promise, 100).subscribe(subscriber)
		let settled = false
		const disposal = subscription.unsubscribe().then(() => {
			settled = true
		})

		await Promise.resolve()
		expect(settled).toBe(false)
		queryResult.resolve(1)
		await disposal

		expect(subscriber).not.toHaveBeenCalled()
	})
})
