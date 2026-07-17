type QueryFunction<T> = () => Promise<T>
type Subscriber<T> = (value: T) => void

interface Subscription {
	unsubscribe: () => Promise<void>
}

/**
 * Creates a polling mechanism that periodically executes a query function
 * and notifies subscribers of the results.
 *
 * @param queryFn - Function that returns a Promise with the query result
 * @param interval - Optional polling interval in milliseconds (default: 2000ms)
 * @returns An object with a subscribe method
 */
export function pollQuery<T>(queryFn: QueryFunction<T>, interval: number = 2000) {
	return {
		subscribe(subscriber: Subscriber<T>): Subscription {
			let isDestroyed = false
			let timeout: NodeJS.Timeout | undefined
			let inFlight: Promise<void> | undefined

			const executeQuery = async () => {
				if (isDestroyed || inFlight) return
				const execution = (async () => {
					try {
						const result = await queryFn()
						if (!isDestroyed) {
							subscriber(result)
						}
					} catch (error) {
						if (!isDestroyed) console.error("Poll query error:", error)
					} finally {
						if (!isDestroyed) timeout = setTimeout(executeQuery, interval)
					}
				})()
				inFlight = execution
				await execution
				if (inFlight === execution) inFlight = undefined
			}

			// Execute initial query
			executeQuery()

			// Return subscription object
			return {
				unsubscribe: async () => {
					isDestroyed = true
					if (timeout) clearTimeout(timeout)
					// Do not let the owning project close SQLite while this query is still using it.
					// The pinned inlang/Kysely APIs do not expose cooperative query cancellation.
					await inFlight
				},
			}
		},
	}
}
