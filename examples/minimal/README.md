# Sherlock Minimal Example

Tiny workspace for testing the Sherlock extension in an Extension Development Host.

From the Sherlock repo, run the `Run Extension` VS Code launch config. The default debug workspace is this folder.

Once the Extension Development Host opens, inspect `src/app.js`. Sherlock should detect the `t("...")` message references and load messages from `messages/en.json` and `messages/de.json`.
