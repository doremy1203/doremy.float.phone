# Contributing

Thanks for taking an interest in Float Phone. This repository is a derivative fork; please preserve upstream attribution, the AGPL-3.0-only license, and the third-party asset notices in [NOTICE](./NOTICE).

## Before opening a change

1. Read the [README](./README.md), [privacy and permissions notes](./docs/隐私与权限说明.md), and [public release gates](./docs/公开分享发布门禁.md).
2. Use Node.js 22 or newer and npm.
3. Create a focused branch from the latest `main`; avoid mixing unrelated application changes.
4. Explain the user-visible problem, affected platform, expected behavior, and any known limitations.

## Local validation

```bash
npm ci
npx tsc --noEmit
npm run test:life
npm run check:sdk
npm run check:weixin
npm run check:push
npm run build
```

The existing codebase has a legacy ESLint warning backlog; CI currently allows a fixed baseline of at most 689 legacy warnings while still failing on lint errors. Explicit `any` remains an error; do not add new instances, and reduce the warning baseline as nearby code is cleaned. Please do not add warnings in touched code, and reduce nearby warnings when changes make that safe.

If a change affects Android, also run the Android shell build and permission / bridge contract checks through the repository workflows. If it changes a Supabase Edge Function, SQL schema, deployment artifact, or environment variable, update the corresponding deployment documentation and generated artifacts where required.

## Pull requests

- Keep pull requests small and focused; include before/after behavior and test evidence.
- Add regression tests for bug fixes. Prefer behavior tests over source-text assertions when practical.
- Do not claim device compatibility based only on a successful web build. Include device model, Android version, WebView version, permissions and reproduction steps for hardware findings.
- Update README / docs when setup, supported platforms, permissions, deployment steps or known limitations change.
- Do not commit `.env.local`, populated environment files, API keys, Supabase service-role keys, cookies, signing keystores, APKs, user backups, diagnostics containing personal data, or generated local build output.
- Check third-party asset and font licenses before adding files. Not every bundled asset is covered by the repository's AGPL license; consult [NOTICE](./NOTICE).

## Scope and review

A feature being present in the UI is not proof that its full workflow works. Please describe what was actually tested, distinguish automated checks from real-device verification, and record any cloud deployment steps that remain manual.
