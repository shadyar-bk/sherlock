import { beforeEach, describe, expect, it, vi } from "vitest"
import { linterDiagnostics } from "./linterDiagnostics.js"

const mocks = vi.hoisted(() => ({
	setDiagnostics: vi.fn(),
	projectChangeListener: undefined as (() => void) | undefined,
}))

vi.mock("vscode", () => ({
	window: {
		activeTextEditor: {
			document: { getText: vi.fn(() => "m.hello()"), uri: { path: "/workspace/page.ts" } },
		},
		onDidChangeActiveTextEditor: vi.fn(),
	},
	workspace: { onDidChangeTextDocument: vi.fn() },
	languages: {
		createDiagnosticCollection: vi.fn(() => ({
			set: mocks.setDiagnostics,
			dispose: vi.fn(),
		})),
	},
	Range: class {},
	Position: class {},
	Diagnostic: class {},
}))

vi.mock("../configuration.js", () => ({
	CONFIGURATION: {
		EVENTS: {
			ON_DID_PROJECT_CHANGE: {
				event: vi.fn((listener: () => void) => {
					mocks.projectChangeListener = listener
					return { dispose: vi.fn() }
				}),
			},
		},
	},
}))

vi.mock("../utilities/helper.js", () => ({
	getExtensionApi: vi.fn(async () => ({ messageReferenceMatchers: [] })),
}))

vi.mock("./lintRuleResolver.js", () => ({ resolveLintRules: vi.fn(async () => []) }))
vi.mock("../utilities/project/selectBundleById.js", () => ({ selectBundleById: vi.fn() }))
vi.mock("../utilities/utils.js", () => ({ handleError: vi.fn() }))

describe("linterDiagnostics", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.projectChangeListener = undefined
	})

	it("refreshes exactly once from the coherent project-change signal", async () => {
		await linterDiagnostics({
			subscriptions: [],
			fs: {} as never,
			session: {
				project: {},
				runTask: async <T>(task: () => Promise<T>) => ({
					status: "completed" as const,
					value: await task(),
				}),
			} as never,
		})

		expect(mocks.setDiagnostics).not.toHaveBeenCalled()
		mocks.projectChangeListener?.()
		await vi.waitFor(() => expect(mocks.setDiagnostics).toHaveBeenCalledTimes(1))
	})

	it("does not publish diagnostics computed by an inactive session", async () => {
		await linterDiagnostics({
			subscriptions: [],
			fs: {} as never,
			session: {
				project: {},
				runTask: async <T>(task: () => Promise<T>) => {
					await task()
					return { status: "inactive" as const }
				},
			} as never,
		})

		mocks.projectChangeListener?.()
		await Promise.resolve()
		expect(mocks.setDiagnostics).not.toHaveBeenCalled()
	})
})
