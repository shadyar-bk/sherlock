---
"vs-code-extension": minor
---

Remove the bundled inlang submodule and use published inlang npm packages instead. Machine translation support has been removed because it depended on unpublished inlang RPC packages, and the contributor setup now uses normal `pnpm install`, `pnpm run build`, and `pnpm test` flows.
