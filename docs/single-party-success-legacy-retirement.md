# Legacy handoff-success retirement

The Option 2 transition keeps two deliberately separate server paths:

- Updated clients write an exact claim generation. The legitimate claimer can complete without finder action.
- Older generation-less clients require both existing participant attestations. The server accepts them only inside the current durable-arrival window.

The legacy path must not be removed until supported Android and web versions using generation-bound completion have passed the normal release gates and generation-less completion traffic has remained absent for an agreed observation window. Retirement is a server-and-Rules change: remove the generation-less Rules allowance and the legacy mutual predicate together, retain historical documents read-only, and keep the shared idempotency marker and terminal records unchanged.

No client should reintroduce a finder approval screen during this transition. Legacy compatibility exists only for already-released clients.
