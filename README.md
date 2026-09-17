# Sovereign Vault

This repository contains the extracted **Sovereign Vault** source snapshot and a Vercel-ready Vite + React + TypeScript project scaffold.

## Important source note

The uploaded ZIP contained only three files: a metadata README and placeholder `src/App.tsx` / `src/index.css` files. It did **not** contain the original AppDeploy application screens, components, data layer, or business logic. The current UI therefore transparently identifies the snapshot and its limitation rather than pretending to reproduce the missing application.

## Local development

```bash
npm install
npm run dev
```

## Production build

```bash
npm run build
npm run preview
```

The build output is `dist/`. `vercel.json` configures Vercel to use the Vite framework, `npm run build`, and the `dist` output directory, with SPA fallback routing.

## Deployment

Import this GitHub repository into Vercel and keep the detected defaults:

- Framework preset: **Vite**
- Build command: `npm run build`
- Output directory: `dist`
- Install command: `npm install`

Once the complete AppDeploy export is available, replace the fallback `src/App.tsx` and `src/index.css` with the real source and retain the project configuration unless the export supplies its own build setup.
