# PlatformClaw help motions

Eight silent Remotion compositions explain Chat, Spaces, Automations, Skills, Skill
Workshop, Skill Hub, Memory, and Credentials. The existing page-help dialog loads
the Player only while open. Korean and English share the same motion code,
timelines, mascot, and assets; the app passes `lang=ko` or `lang=en` to the Player.

The examples use synthetic Ulysses, Thetis, and Vanguard projects with Jira and
Confluence. Terminal commands are typed without Enter or invented execution
output. These compositions do not contact product services or use credentials.

## Edit and rebuild

This authoring tool has its own pinned dependency graph, separate from the Lit
Control UI. React/DOM 19.2.3 and Remotion/Player 4.0.537 are fixed. Do not merge its
dependencies into the product workspace or upgrade them as part of a copy edit.

Use Linux for installation and final build proof. The product checkout must
already have its normal dependencies installed; the build uses its pinned
`oxfmt` to format generated public assets:

```sh
cd tools/platformclaw-help
pnpm install --frozen-lockfile
pnpm build
pnpm check
pnpm studio
```

From the repository root, run the repository type checker against this project:

```sh
node scripts/run-tsgo.mjs -p tools/platformclaw-help/tsconfig.json
```

Studio opens the same eight compositions. Set the `locale` prop to `ko` or `en`
to inspect copy. Chat is 15 seconds, Memory 20 seconds, Spaces/Cron 18 seconds,
and the other four compositions 14 seconds. Keep text typing linear, complete
the last character before the next action, and check English wrapping.

`pnpm build` extracts the canonical mascot and light theme from this checkout,
records the product revision and source hashes, and bundles browser JS/CSS into
`ui/public/help-video`. It does not render a video. The generated manifest binds
the authoring sources and dependency lock to the served files. `pnpm check` and
the product UI production build reject stale output and unexpected old chunks.

The normal product UI build copies these frozen assets through Vite's existing
public directory. Operators do not need the authoring dependencies to serve the
help motions. Do not add render, TTS, music generation, deployment, or external
service calls to the help build.
