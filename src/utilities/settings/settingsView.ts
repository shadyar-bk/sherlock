import * as vscode from "vscode"
import { CONFIGURATION } from "../../configuration.js"
import type { InlangProject } from "@inlang/sdk"
import { getProjectRuntime, type ActiveProjectLease } from "../project/projectRuntime.js"

export async function settingsPanel(args: { context: vscode.ExtensionContext }) {
	const lease = getProjectRuntime<InlangProject>().activeProject()
	if (!lease) return
	const panel = vscode.window.createWebviewPanel(
		"settingsPanel",
		lease.path.split("/").pop() ?? "Settings",
		vscode.ViewColumn.One,
		{
			enableScripts: true,
			localResourceRoots: [vscode.Uri.file(args.context.extensionPath)],
		}
	)

	panel.webview.html = await getWebviewContent({
		context: args.context,
		webview: panel.webview,
		lease,
	})

	const messageSubscription = panel.webview.onDidReceiveMessage(async (message) => {
		switch (message.command) {
			case "setSettings":
				const result = await lease.runTask(async () => {
					await lease.project.settings.set(message.settings)
				})
				if (result.status === "completed") {
					CONFIGURATION.EVENTS.ON_DID_SETTINGS_VIEW_CHANGE.fire()
				}
				break
		}
	})
	panel.onDidDispose(() => messageSubscription.dispose())
	if (
		!lease.own({
			dispose: () => {
				messageSubscription.dispose()
				panel.dispose()
			},
		})
	) {
		messageSubscription.dispose()
		panel.dispose()
	}
}

export async function getWebviewContent(args: {
	context: vscode.ExtensionContext
	webview: vscode.Webview
	lease?: ActiveProjectLease<InlangProject>
}): Promise<string> {
	const lease = args.lease ?? getProjectRuntime<InlangProject>().activeProject()
	if (!lease) return ""
	const styleUri = args.webview.asWebviewUri(
		vscode.Uri.joinPath(args.context.extensionUri, "assets", "settings-view.css")
	)

	const scriptUri = args.webview.asWebviewUri(
		vscode.Uri.joinPath(args.context.extensionUri, "assets", "settings-component.js")
	)

	const litHtmlUri = args.webview.asWebviewUri(
		vscode.Uri.joinPath(args.context.extensionUri, "assets", "lit-html.js")
	)

	const projectData = await lease.runTask(async () => ({
		settings: await lease.project.settings.get(),
		installedPlugins: await lease.project.plugins.get(),
	}))
	if (projectData.status !== "completed") return ""
	const { settings, installedPlugins } = projectData.value
	// TODO: Clarify how to derive validation rules from lix
	// const installedMessageLintRules = state().project.installed.messageLintRules()

	return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Settings</title>
            <link href="${styleUri}" rel="stylesheet" />
            <script type="module" src="${litHtmlUri}"></script>
            <script type="module" src="${scriptUri}"></script>
        </head>
        <body>
			<main>
				<h1>Project settings</h1>
				<div id="settings-container"></div>
			<main>
            <script type="module">
                import {html, render} from '${litHtmlUri}';
                const vscode = acquireVsCodeApi();
                
                // RENDER WEB COMPONENT
                const settingsContainer = document.getElementById('settings-container');
                const settingsElement = document.createElement('inlang-settings');
                settingsElement.installedPlugins = ${JSON.stringify(installedPlugins)};
                settingsElement.settings = ${JSON.stringify(settings)};

                settingsContainer.appendChild(settingsElement);

                // EVENTS
                document.querySelector('inlang-settings').addEventListener('set-settings', (event) => {
                    vscode.postMessage({
                        command: 'setSettings',
                        settings: event.detail.argument
                    });
                });
            </script>
        </body>
        </html>`
}
