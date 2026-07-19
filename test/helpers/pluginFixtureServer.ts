import fs from "node:fs/promises"
import { createServer, type Server } from "node:http"
import { createRequire } from "node:module"

export type PluginFixtureName = "i18next" | "json" | "t-function-matcher"

const require = createRequire(import.meta.url)
const pluginFixtures: Record<PluginFixtureName, { packageName: string; version: string }> = {
	i18next: { packageName: "@inlang/plugin-i18next", version: "6.2.3" },
	json: { packageName: "@inlang/plugin-json", version: "5.1.57" },
	"t-function-matcher": {
		packageName: "@inlang/plugin-t-function-matcher",
		version: "2.0.24",
	},
}

function routeFor(name: PluginFixtureName) {
	const fixture = pluginFixtures[name]
	return `/${name}-${fixture.version}.js`
}

export function pluginFixtureUrl(baseUrl: string, name: PluginFixtureName) {
	return `${baseUrl}${routeFor(name)}`
}

export function e2ePluginFixtureUrl(name: PluginFixtureName) {
	const baseUrl = process.env.SHERLOCK_E2E_PLUGIN_BASE_URL
	if (!baseUrl) throw new Error("SHERLOCK_E2E_PLUGIN_BASE_URL is not configured")
	return pluginFixtureUrl(baseUrl, name)
}

export async function startPluginFixtureServer() {
	const modules = new Map<string, string>()
	for (const [name, fixture] of Object.entries(pluginFixtures) as Array<
		[PluginFixtureName, (typeof pluginFixtures)[PluginFixtureName]]
	>) {
		modules.set(routeFor(name), await fs.readFile(require.resolve(fixture.packageName), "utf8"))
	}

	const server = createServer((request, response) => {
		const source = request.url ? modules.get(request.url) : undefined
		if (request.method !== "GET" || !source) {
			response.writeHead(404).end()
			return
		}
		response.writeHead(200, {
			"cache-control": "no-store",
			"content-type": "text/javascript; charset=utf-8",
		})
		response.end(source)
	})
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject)
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject)
			resolve()
		})
	})
	const address = server.address()
	if (!address || typeof address === "string") {
		await closeServer(server)
		throw new Error("Plugin fixture server did not bind to a TCP port")
	}
	return {
		baseUrl: `http://127.0.0.1:${address.port}`,
		close: () => closeServer(server),
	}
}

function closeServer(server: Server) {
	return new Promise<void>((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()))
	})
}
