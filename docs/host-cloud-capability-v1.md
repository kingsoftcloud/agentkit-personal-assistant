# Generic DSH Host cloud capability v1

The standalone plugin can run in any DSH Host that exposes the generic service
`agentkitHostCloud`. The Host owns cloud credentials, configuration and client
construction; the consumer owns its product adapter and never imports Host
product code.

The provider is registered during Host activation with this shape:

```js
ctx.provide('agentkitHostCloud', Object.freeze({
  storeDir: '/absolute/host-owned/plugin-state',
  env: process.env,
  fetchImpl: async (url, init) => fetch(url, init),
  configuration: configurationPromise,
  getClient: async () => serverClient,
  getDeploymentClient: async () => deploymentClient,
}))
```

`configuration` resolves to the Host configuration object and must expose the
existing `resolve()` method. `fetchImpl` is optional when the consumer can use
the Host runtime transport. `getClient()` is the read and action client;
`getDeploymentClient()` is the deployment client and is optional for Hosts that
only support read-only operation. Each getter may create or cache its client,
but it must not return credentials to the consumer page.

The consumer may lazily construct its own adapter from this capability. It must
not assume a Studio package, a Studio service name, or a particular Host
implementation. A Host that still exposes the pre-decoupling service may be
accepted as a migration fallback, but new integrations must use the generic
capability above. The compatibility boundary is the DSH kernel service
registration and the documented object shape, so Host and plugin releases can
iterate independently.
