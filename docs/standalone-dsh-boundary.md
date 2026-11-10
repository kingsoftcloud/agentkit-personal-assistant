# Standalone DSH boundary

The Personal Assistant package is an independent DSH plugin. It may use only
public DSH plugin services and generic AgentEngine control-plane envelopes.

It must not import the AgentKit Studio package, refer to a Studio-only service,
or require Studio source paths at runtime. Studio is one possible DSH host; a
local DSH host, a packaged Host, and a cloud Runtime are valid independent
consumers.

The standalone boundary is checked by
`scripts/check-standalone-boundary.mjs`. DSH compatibility is tested against
the pinned `0.2.2-rc.1` public Session Controller and Connection contracts.
