# Float UI / Interaction Design Rules

This document is the implementation contract for visual changes in `doremy.float.phone`.
It is inspired by public design-system references such as Awesome DESIGN.md and Better Design; it does not copy any company's proprietary branding or page.

## Product premise

Float is a personalised Android phone shell with many different mini-apps. A single global theme must not flatten every app into the same generic dashboard. Keep each app's established behaviour and saved theme settings, then create a clear visual identity within that app's scope.

## Visual direction by feature

### Life system — preserve existing theme and prioritise scene chat

- Respect the life system's existing scene theme, accent colour, opacity, custom CSS and saved appearance settings. Do not impose an extra default palette or decorative card layer.
- Render action/narration as standalone centered text and spoken dialogue separately; the avatar identifies the speaker, so do not repeat the name inside the speech bubble.
- Keep controls compact and leave the available height to the conversation. Avoid oversized rounded cards, repeated labels and decoration that shifts the layout.

### Photo wall — full-wall scrapbook

- Browse mode is a read-only panoramic wall or a timeline of memory posters; editing controls belong in edit mode.
- Use Polaroids, handwritten notes, paper, tape and subtle shadows. The wall itself should feel like a composition, not a grid of generic cards.
- Never let decorative overlays block selecting, flipping, moving, zooming, drawing or exporting photos.

### Watch together — portrait chat-first companionship

- Keep the default experience portrait-oriented, with a responsive 16:9 video area, an avatar/radio-wave companion header, and a discussion area that scrolls independently.
- Do not redesign this app as a cinema/landscape/fullscreen experience. Do not reintroduce danmaku or fullscreen overlays that compete with the WebView video surface.
- Keep video selection, global companion controls, settings and discussion actions reachable without covering the player or pushing the message composer off-screen.
- External content retrieval, playback resolution, transcription, keyframe analysis and full-video understanding are separate stages and must be labelled/configured accordingly.
- Prefer stable touch targets and explicit fallback states. A URL that cannot be extracted may still use an official embedded player when supported.

## Shape, type and hierarchy

- Use medium radii (roughly 10–18 px) for most panels. Reserve fully rounded pills for compact actions or status chips.
- One screen should have one dominant surface and a clearly secondary layer; use spacing, contrast and typography before adding more borders.
- Use icon families consistently. Icons should support labels, not replace touchable button areas.
- Avoid truncation where the actual task needs reading; allow long content to wrap in the conversation and notes areas.

## Motion language

- Motion should communicate a real state change: entry, focus, connection, location transition, expansion, saving or a completed action.
- Prefer transform and opacity for transitions; do not animate layout dimensions in a way that shifts controls or the video player.
- Use restrained 160–360 ms transitions for interactions and longer, low-amplitude ambient motion only for a clear focal element.
- Scene transitions should connect to actual state updates (for example, a short camera-like pan/crossfade when the selected location changes). Do not add unrelated airplane, portal or travel animations just for spectacle.
- Respect `prefers-reduced-motion`, WebView frame budgets, Android safe areas and touch input.

## 3D miniature scenes

- Three.js / React Three Fiber may be used for genuinely spatial features such as a dollhouse, miniature room or garden; do not add 3D to a screen that does not benefit from spatial exploration.
- Load the 3D canvas only when the feature is opened. Use a dynamic client-side boundary, a modest device-pixel ratio, compressed assets and an accessible 2.5D/static fallback.
- Stop or reduce the render loop when hidden, avoid expensive post-processing on mobile, dispose of resources, and keep accessible DOM controls separate from the canvas.
- Interactions must call existing application actions; clicking a chair, door or character should never create a parallel copy of life-system state.
- Prove performance on mobile WebView before making 3D the only route into a feature.

## Non-negotiable regression guardrails

- Do not change feature logic, user data shape, API calls or persisted settings for a visual-only task.
- Keep editable prompts and user customisations intact.
- Preserve keyboard focus, full-button hit targets, reduced-motion support, responsive layout and viewport safe areas.
- Before accepting visual work, run TypeScript and production build validation and inspect the relevant screen at a narrow mobile viewport and a desktop viewport.


## Current implementation alignment (2026-10-24)

The design contract follows the current app architecture, not abandoned intermediate experiments. The photo wall is a panoramic scrapbook canvas with isolated browse/edit/placement/doodle modes. The life system preserves its established scene theme and separates narration/actions from dialogue. Watch Together remains portrait chat-first rather than a cinema/fullscreen/danmaku interface. See [the audited development diff timeline](./docs/从诊断开始的开发差异台账.md) for the evolution and the current cross-repository baseline.
