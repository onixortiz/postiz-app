# Fork touchpoints

This fork of [Postiz](https://github.com/gitroomhq/postiz-app) adds a 4-role
approval chain (Technical Writer → Creator → Reviewer → Monthly Reviewer). The
design is in [docs/designs/approval-workflow.md](docs/designs/approval-workflow.md)
and the operations guide in [docs/fork/runbook.md](docs/fork/runbook.md).

Almost all of the fork lives in its own files (`approvals/`, `briefs/`,
`dtos/approvals/`, the sweep workflow and activity, `scripts/fork/`). This file
lists the **upstream files** the fork changes. Every change in them is marked
with `// FORK: approvals` (or `# FORK` / `/* FORK */`), so `grep -rn "FORK"`
finds them all. With `APPROVALS_ENABLED` not `'true'`, every one of them
behaves as upstream, except the rows marked **always**.

## Upstream files

| File | Function or area | Why | What to check when upstream changes it |
|---|---|---|---|
| `libraries/nestjs-libraries/src/database/prisma/schema.prisma` | Block `FORK: approvals` at the end; inverse relations on `Organization`, `User`, `Comments` | The fork tables. Inverse relations create no columns | `scripts/fork/check-schema-additive.mjs` passes (CI runs it). A new value in `CreationMethod` is fine: `PostApprovalEvent.surface` uses it |
| `libraries/nestjs-libraries/src/database/prisma/posts/posts.service.ts` | `createPost` (try/finally, `typeForSave`, `afterSave`, `applyApprovalLists`), `changeDate`, `changePostStatus`, `deletePost`, `checkInternalPlug`, `checkPlugs`, `isAllowedMediaPath`, `createPublicComment` (`orgId`) | The gate at save time, plugs off | The four methods still exist and are still the only ones that write `QUEUE`. The loop of `createPost` still calls `createOrUpdatePost` once per channel. **always:** `createPublicComment` takes the `orgId` of the dashboard |
| `apps/orchestrator/src/activities/post.activity.ts` | Body of `getPostsList`, constructor | **The publish-time guarantee** | See "Check the guarantee" below |
| `apps/orchestrator/src/app.module.ts` | `ApprovalActivity` in `activities` | The sweep activity | — |
| `apps/orchestrator/src/workflows/index.ts` | `export * from './approval.sweep.workflow'` | The sweep workflow | — |
| `libraries/nestjs-libraries/src/temporal/infinite.workflow.register.ts` | Start of `approvalSweepWorkflow`, reconciliation at start | Runs the sweep next to `missingPostWorkflow` | Still started with `RUN_CRON`. **always:** it starts `approvalSweepWorkflow`, which does nothing with the fork off |
| `libraries/nestjs-libraries/src/database/prisma/database.module.ts` | Fork services in `providers` | DI | — |
| `apps/backend/src/api/api.module.ts` | `ApprovalsController`, `BriefsController`, `ApprovalsEnabledGuard` | The API of the flow | — |
| `apps/backend/src/api/routes/posts.controller.ts` | `createPost`, `changeDate`, `deletePost` pass the user; comments pass the org | The actor for the history | **always:** commenting checks the post belongs to the organization |
| `apps/backend/src/api/routes/public.controller.ts` | `assertPreviewIsPublic` on `/public/posts/:id` and its comments | The preview needs a session | — |
| `apps/backend/src/api/routes/integrations.controller.ts` | `assertPlugsEnabled` on the plug routes | Plugs publish without approval | — |
| `apps/backend/src/public-api/routes/v1/public.integrations.controller.ts` | `deletePost` passes `'API'` | Surface for the history | — |
| `libraries/nestjs-libraries/src/chat/tools/delete.post.tool.ts` | `deletePost` passes `'MCP'` | Surface for the history | — |
| `libraries/react-shared-libraries/src/helpers/variable.context.tsx` | `approvalsEnabled` | Frontend flag | — |
| `apps/frontend/src/app/(app)/layout.tsx` | `approvalsEnabled` prop | Frontend flag | — |
| `apps/frontend/src/components/new-launch/manage.modal.tsx` | `schedule` (type by stage, no questions), buttons, `ApprovalPanel` | The editor shows the flow and never promises a publication that won't happen | The save loop, the `saveAs` questions and the republish dialog are still where the `!approvalsEnabled &&` guards sit |
| `apps/frontend/src/components/new-launch/store.ts` | `briefId`, `setBriefId` | Post created from a topic | `reset()` still restores `initialState` |
| `apps/frontend/src/components/launches/calendar.tsx` | Drop without the republish dialog, rollback toast, stage badge, `usePostActions` exported | Calendar | The drop handler still calls `PUT /posts/:id/date` |
| `apps/frontend/src/components/launches/calendar.context.tsx` | `approvalStage` filter, `stagesByPostId` | Calendar | `setFiltersWrapper` still writes the url |
| `apps/frontend/src/components/launches/filters.tsx` | `ApprovalStageFilter` | "Stage" filter | — |
| `apps/frontend/src/components/launches/launches.component.tsx` | `OpenFromBrief` inside `CalendarWeekProvider` | Open the editor from a topic or the inbox | — |
| `apps/frontend/src/components/layout/top.menu.tsx` | "Approvals" and "Topics" entries | Menu | — |
| `apps/frontend/src/components/settings/teams.component.tsx` | `WorkflowRolesComponent` | Workflow roles | — |
| `apps/frontend/src/app/(app)/(preview)/p/[id]/page.tsx` | `/approvals/preview/:id` and redirect to login | The preview needs a session | — |
| `apps/frontend/src/components/preview/preview.comments.context.tsx` | Comments read from `/approvals/preview/:id/comments` | The preview needs a session | — |
| `apps/frontend/src/components/preview/comments.components.tsx` | `withSession` | No name or reCAPTCHA with a session | — |
| `apps/frontend/src/app/colors.scss`, `apps/frontend/tailwind.config.cjs` | `--approval-*` tokens | Stage badge colors | — |
| `libraries/react-shared-libraries/src/translation/locales/en/translation.json`, `.../es/translation.json` | Keys `approvals_*` | Texts of the fork | — |
| `package.json` | `test:fork`, `lint:fork` | Fork checks | — |
| `docker-compose.yaml` | `FORK_IMAGE`, `APPROVALS_ENABLED`, `RUN_CRON`, named Temporal volumes, ports on `127.0.0.1` | Deployment | Keep 7233 and 8080 off the public interface |
| `var/docker/docker-build.sh` | Build and push of `FORK_IMAGE` | Deployment | — |
| `.env.example` | Fork variables | Deployment | — |

### Brand (Alpine Socials)

The brand is not behind a flag: it applies always.

| File | What changed | What to check when upstream changes it |
|---|---|---|
| `apps/frontend/public/alpine-*.svg`, `favicon.ico`, `favicon.png` | Alpine logos and favicon (the originals are outside the repo) | Upstream replacing `favicon.*` brings back the Postiz icon |
| `apps/frontend/src/components/new-layout/logo.tsx`, `components/ui/logo-text.component.tsx` | The Alpine symbol and wordmark instead of the Postiz SVGs | — |
| `apps/frontend/src/app/(app)/auth/layout.tsx` | Alpine logo and tagline instead of the Postiz testimonials | — |
| `apps/frontend/src/app/(app)/(preview)/p/[id]/page.tsx` | Alpine logo in the preview header | — |
| `apps/frontend/src/app/colors.scss` and every file with a brand color | Purple `#612bd3`/`#612ad5` → blue `#001489`, pink `#fc69ff`/`#d82d7e` → orange `#FF6C2F`, other purples to blue tones | After a merge, `grep -rniE "#612bd3\|#612ad5\|#fc69ff\|#d82d7e" apps/frontend/src` must find nothing |
| Page titles (`'Postiz' : 'Gitroom'`), `logout.component.tsx`, en/es `translation.json` | "Postiz" → "Alpine Socials". The names of Postiz's own products (n8n node, CLI, connector, HubSpot and Farcaster apps) stay | `grep -rn "'Postiz' : 'Gitroom'" apps/frontend/src` must find nothing |

### Rules copied from upstream

These are not calls, they are copies of upstream logic. When upstream changes
the original, the copy has to follow.

| Copy | Original | What to compare |
|---|---|---|
| Fingerprint rules in `ApprovalGateService.fingerprintsOf` / `postStructure` / `mediaPath` | `PostsService.updateMedia` | How `updateMedia` rewrites `path`, `alt`, `thumbnail` and the `UPLOAD_DIRECTORY` prefix. A new rewrite that the fingerprint doesn't ignore makes approved posts fail at publish time with `fingerprint_drift` |
| `libraries/helpers/src/utils/is.allowed.media.path.ts` | The old body of `PostsService.isAllowedMediaPath` | Upstream may change the method again: move the change into the helper |
| `assertNotImpersonating` in `apps/backend/src/services/auth/approvals.guard.ts` | `auth.middleware.ts` (`req.user.isSuperAdmin && (cookies.impersonate \|\| headers.impersonate)`) | The condition that switches to the impersonated user |

## Updating from upstream

1.  `git fetch upstream` and `git merge upstream/main`.
2.  Go through every file in the table above.
3.  **Check the guarantee.** The current version of `postWorkflow` (today
    `postWorkflowV112`) calls `getPostsList` **after** its `sleep`, and when it
    gets `[]` it ends without publishing (`changeState(..., 'ERROR', 'No Post')`).
    If upstream adds a new workflow version, check it again in that version.
4.  Check that `createPost`, `changeDate`, `changePostStatus` and `deletePost`
    still exist in `posts.service.ts`, and both plug sources
    (`checkInternalPlug`, `checkPlugs`).
5.  `grep -rn "'QUEUE'" libraries/ apps/` and look at every hit, ternaries
    included. A new path can't publish without approval (step 3), but covering
    it avoids `BLOCKED_AT_PUBLISH` emails.
6.  Compare the fingerprint rules with `updateMedia` (table above).
7.  Compare the impersonation condition with `auth.middleware.ts`.
8.  `pnpm test:fork` (needs a Postgres in `FORK_TEST_DATABASE_URL`, see the
    runbook), `pnpm lint:fork` and `pnpm build`.
