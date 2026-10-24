# AgentKit Personal Assistant

`@kingsoftcloud/agentkit-personal-assistant` is the standalone DSH plugin project for the cloud personal assistant. DSH remains the host/runtime foundation; this repository owns the assistant product surface, multi-Bot registry, and the explicit boundary to a user's dedicated Cloud Computer.

This repository is an executable broker-backed implementation. It does not create a Pod or expose a computer outside the loopback broker; a deployment supplies the two images and the per-user `Computer Broker` sidecar boundary.

## Design boundary

One cloud sub-user owns one Personal Assistant Pod. The Pod is planned to run two independently versioned images and two containers:

- `personal-assistant-runtime`: DSH plus this plugin, sessions, Bot orchestration, memory, schedules, approvals, and the gateway adapter.
- `personal-assistant-computer`: Linux GUI/browser/terminal and the Computer Broker server.

A single user can create several logical Bots in the assistant runtime. Each Bot has its own `botId`, system prompt revision, memory namespace, and tool policy. Bots can share the user's Computer only through a lease. The lease prevents two Bots from driving the same GUI at the same time.

The plugin does not use a DSH private module or a profile name as a tenant boundary. DSH loader inputs are limited to `package.json.dsh.bundle.patch` and `package.json.dsh.client.{platform,inject,external,immediately}`; the package root and `./client` exports are the Host and browser entrypoints. It uses public DSH injection names and a versioned application protocol. The runtime stores sessions, Bot memory records, and schedules as profile-local JSON collections under `ASSISTANT_STATE_PATH`; the PVC is retained independently from the plugin bundle lifecycle.

## Package surfaces

- `@kingsoftcloud/agentkit-personal-assistant` — DSH Host entry (`apply`, `createRuntime`).
- `@kingsoftcloud/agentkit-personal-assistant/client` — browser-safe gateway adapter plus the public DSH `inject/apply` entry that contributes the default-closed panel and sidebar row.
- `@kingsoftcloud/agentkit-personal-assistant/bot-registry` — multi-Bot identity and policy registry.
- `@kingsoftcloud/agentkit-personal-assistant/computer-broker` — runtime-side broker client and lease manager.
- `@kingsoftcloud/agentkit-personal-assistant/computer-broker-protocol` — validated v1 message shapes.
- `@kingsoftcloud/agentkit-personal-assistant/manifest` — application metadata manifest.
- `@kingsoftcloud/agentkit-personal-assistant/plugin-manifest` — validators for the DSH package subset and application metadata.

The application manifest records `metadata.defaultEnabled: false` and `metadata.autoConnect: false`. Those are AgentKit product metadata, validated by `src/plugin-manifest.mjs`; DSH itself only reads the supported `package.json.dsh` fields. Studio can ship the package in its catalog without showing a panel or opening a cloud connection until the user enables it.

## Multi-Bot example

```js
import { createRuntime } from '@kingsoftcloud/agentkit-personal-assistant'

const runtime = createRuntime(ctx, {
  enabled: true,
  profileId: 'user-profile-1',
  bots: [
    {
      botId: 'researcher',
      displayName: 'Researcher',
      systemPromptRevision: 'researcher@2026-10-23.1',
      memoryNamespace: 'assistant:user-profile-1:bot:researcher',
      toolPolicy: {
        mode: 'allowlist',
        allow: ['browser.search', 'files.read'],
        requireApproval: ['files.write'],
      },
    },
  ],
})

// No real Computer is connected unless computerTransport was supplied.
const bot = runtime.registry.require('researcher')
console.log(bot.memoryNamespace)
```

## Computer Broker contract

The runtime sends validated messages through a supplied transport (the runtime image uses the localhost HTTP transport):

- `computer.status`
- `computer.lease.acquire`
- `computer.lease.release`
- `computer.action`

Every lease and action is bound to `userId`, `assistantId`, `botId`, `computerId`, and `taskId`. The implemented tool surface covers bounded browser actions and `terminal.exec`; the runtime cannot access a display or a host shell directly. `createMockComputerBroker()` is available only for contract tests and marks every result as `simulated: true`.

## Development

```sh
npm test
npm run check
npm run pack:check
```

The client entry uses the documented DSH `slots` service and contributes an inert default-closed panel/sidebar row. It uses no private DSH source; a later UI revision can replace the text components while keeping the same disabled-by-default and no-auto-connect contract.

## Reference and licensing

The multi-Bot/persistent-state shape was informed by public behavior in [DeepSeek-Bot](https://github.com/Fei2411/DeepSeek-Bot). No DeepSeek-Bot source is copied in this skeleton. If code is later reused, preserve its Apache-2.0 license and notices as described in [`NOTICE`](./NOTICE).

## Computer-backed capabilities

The browser and code-execution capabilities are implemented as broker-backed DSH
 tools. `createComputerToolset()` registers the bounded browser actions and
`cloud_bash`/`cloud_run_code` actions only after a Bot task requests them. The
first action acquires a per-computer lease; `dispose()` releases it. The runtime
never launches Chromium or a shell itself. The `personal-assistant-computer`
image runs `computer-agentd` and owns those operations, including CDP, GUI,
terminal isolation, and egress policy.

The same project exports `ScheduleManager`, `PersonalAssistantStateStore`, and
the managed workspace contract. The runtime exposes `GET/POST /v1/sessions`,
durable session `messages` and `turns`, `GET/POST /v1/memory`, and
`GET/POST/DELETE /v1/schedules`; all are profile-local and persist under the
paths injected by runtime-service (`WORKSPACE_PATH` and the assistant state
path). The standalone HTTP runtime persists a submitted turn as `queued` until
a DSH Session Controller bridge is present; it never runs a fake local
inference loop.

When the Host process has injected the public DSH `sessionController`, the Host
entry exposes `runtime.submitTurn(...)`. It resolves or creates the requested
Session and calls `sessionController.prompt(...)`; the returned receipt is
marked `execution: "dsh-session-controller"` only after DSH accepts the prompt.
A Host without that service fails with
`DSH_SESSION_CONTROLLER_UNAVAILABLE`. The standalone cloud HTTP artifact still
has no in-process DSH Host, so its durable HTTP turn endpoint remains an
explicit queue until runtime-service supplies a Session Controller bridge; it
must never be presented as completed model work.
