import { beforeEach, describe, expect, it, vi } from "vitest"
import { messagePreview } from "./messagePreview.js"

const mocks = vi.hoisted(() => ({
	setDecorations: vi.fn(),
	getPreviewLocale: vi.fn(),
	getSetting: vi.fn(),
	getExtensionApi: vi.fn(),
	getSelectedBundleByBundleIdOrAlias: vi.fn(),
}))

vi.mock("vscode", () => ({
	Position: class Position {
		constructor(
			public line: number,
			public character: number
		) {}
	},
	Range: class Range {
		constructor(
			public start: unknown,
			public end: unknown
		) {}
	},
	ThemeColor: class ThemeColor {
		constructor(public id: string) {}
	},
	window: {
		activeTextEditor: {
			document: {
				fileName: "/workspace/src/page.ts",
				getText: vi.fn(() => "m.root_title()"),
			},
			setDecorations: mocks.setDecorations,
		},
		createTextEditorDecorationType: vi.fn(() => ({ key: "preview" })),
		onDidChangeActiveTextEditor: vi.fn(),
	},
	workspace: {
		getConfiguration: vi.fn(() => ({ get: vi.fn(() => true) })),
		onDidChangeConfiguration: vi.fn(),
		onDidChangeTextDocument: vi.fn(),
	},
}))

vi.mock("../utilities/state.js", () => ({
	state: () => ({
		project: {
			settings: {
				get: vi.fn(async () => ({ baseLocale: "ckb", locales: ["ckb", "en"] })),
			},
		},
	}),
}))

vi.mock("./contextTooltip.js", () => ({
	contextTooltip: vi.fn(async () => undefined),
}))

vi.mock("../utilities/locale/getPreviewLocale.js", () => ({
	getPreviewLocale: mocks.getPreviewLocale,
}))

vi.mock("../utilities/settings/index.js", () => ({
	getSetting: mocks.getSetting,
}))

vi.mock("../utilities/helper.js", () => ({
	getExtensionApi: mocks.getExtensionApi,
	getSelectedBundleByBundleIdOrAlias: mocks.getSelectedBundleByBundleIdOrAlias,
}))

vi.mock("../configuration.js", () => ({
	CONFIGURATION: {
		EVENTS: {
			ON_DID_CREATE_MESSAGE: { event: vi.fn() },
			ON_DID_EDIT_MESSAGE: { event: vi.fn() },
			ON_DID_EXTRACT_MESSAGE: { event: vi.fn() },
			ON_DID_PREVIEW_LOCALE_CHANGE: { event: vi.fn() },
		},
	},
}))

describe("messagePreview", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.getPreviewLocale.mockResolvedValue("en")
		mocks.getSetting.mockResolvedValue("transparent")
		mocks.getExtensionApi.mockResolvedValue({
			messageReferenceMatchers: [
				vi.fn(async () => [
					{
						bundleId: "root_title",
						position: {
							start: { line: 1, character: 1 },
							end: { line: 1, character: 15 },
						},
					},
				]),
			],
		})
		mocks.getSelectedBundleByBundleIdOrAlias.mockResolvedValue({
			messages: [
				{
					locale: "ckb",
					variants: [
						{
							messageId: "root_title_ckb",
							matches: [{ type: "catchall-match" }],
							pattern: [{ type: "text", value: "سەردێڕ" }],
						},
					],
				},
				{
					locale: "en",
					variants: [
						{
							messageId: "root_title_en",
							matches: [{ type: "catchall-match" }],
							pattern: [{ type: "text", value: "Root title" }],
						},
					],
				},
			],
		})
	})

	it("renders the message for the selected preview locale", async () => {
		await messagePreview({ context: { subscriptions: [] } as never })

		await vi.waitFor(() => {
			expect(mocks.setDecorations).toHaveBeenCalledWith(expect.anything(), [
				expect.objectContaining({
					renderOptions: expect.objectContaining({
						after: expect.objectContaining({ contentText: "Root title" }),
					}),
				}),
			])
		})
	})
})
