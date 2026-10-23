# AgentKit Personal Assistant

`@kingsoftcloud/agentkit-personal-assistant` is the standalone DSH plugin project for the cloud personal assistant. DSH remains the host/runtime foundation; this repository owns the assistant product surface, multi-Bot registry, and the explicit boundary to a user's dedicated Cloud Computer.

This repository is an initial, executable contract skeleton. It does **not** claim to connect to a real Cloud Computer, create a Pod, control a display, or execute a terminal command. A deployment must provide a documented `Computer Broker` transport before those operations can be enabled.

## Design boundary

One cloud sub-user owns one Personal Assistant Pod. The Pod is planned to run two independently versioned images and two containers:

- `personal-assistant-runtime`: DSH plus this plugin, sessions, Bot orchestration, memory, schedules, approvals, and the gateway adapter.
- `personal-assistant-computer`: Linux GUI/browser/terminal and the Computer Broker server.

A single user can create several logical Bots in the assistant runtime. Each Bot has its own `botId`, system prompt revision, memory namespace, and tool policy. Bots can share the user's Computer only through a lease. The lease prevents two Bots from driving the same GUI at the same time.

The plugin does not use a DSH private module or a profile name as a tenant boundary. It uses public DSH injection names and a versioned application protocol. Persistent storage, session persistence, and real Computer authentication will be wired by the host integration once their public contracts are available.

## Package surfaces

- `@kingsoftcloud/agentkit-personal-assistant` — DSH Host entry (`apply`, `createRuntime`).
- `@kingsoftcloud/agentkit-personal-assistant/client` — browser-safe client adapter for the official gateway/remotes service.
- `@kingsoftcloud/agentkit-personal-assistant/bot-registry` — multi-Bot identity and policy registry.
- `@kingsoftcloud/agentkit-personal-assistant/computer-broker` — runtime-side broker client and lease manager.
- `@kingsoftcloud/agentkit-personal-assistant/computer-broker-protocol` — validated v1 message shapes.
- `@kingsoftcloud/agentkit-personal-assistant/manifest` — plugin manifest.

The manifest is intentionally `defaultEnabled: false` and `autoConnect: false`. Studio can ship the package in its catalog without showing a panel or opening a cloud connection until the user enables it.

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

The runtime sends validated messages through a supplied transport:

- `computer.status`
- `computer.lease.acquire`
- `computer.lease.release`
- `computer.action`

Every lease and action is bound to `assistantId`, `botId`, `computerId`, and `taskId`. The action surface is intentionally small (`open`, `screenshot`, `click`, `type`, `files.*`, `terminal.exec`, and so on). The runtime cannot access a display or a host shell directly. `createMockComputerBroker()` is available only for contract tests and marks every result as `simulated: true`.

## Development

```sh
npm test
npm run check
npm run pack:check
```

The project uses only Node built-ins for the skeleton and has no dependency on DSH private source. The eventual UI should be built on the documented DSH client gateway/remotes APIs and should keep the same disabled-by-default behavior.

## Reference and licensing

The multi-Bot/persistent-state shape was informed by public behavior in [DeepSeek-Bot](https://github.com/Fei2411/DeepSeek-Bot). No DeepSeek-Bot source is copied in this skeleton. If code is later reused, preserve its Apache-2.0 license and notices as described in [`NOTICE`](./NOTICE).
