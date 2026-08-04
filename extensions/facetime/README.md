# OpenClaw FaceTime

Experimental source-only FaceTime carrier plugin for a dedicated Apple Silicon
Mac. The public setup, security, operation, and removal guides are:

- <https://docs.openclaw.ai/plugins/facetime>
- <https://docs.openclaw.ai/plugins/facetime-recovery>

The source has not been published to npm or ClawHub. Link this directory from a
trusted OpenClaw source checkout for development.

## Ownership boundaries

- `src/call-lifecycle.ts` owns the closed carrier/model state machine,
  generation fencing, serialized native commands, and the complete alias index.
- `src/pending-dial-store.ts` persists the one exact approved pending dial in
  plugin-owned SQLite state.
- `src/helper-rpc.ts` owns bounded loopback IPC with mutual authentication,
  connection-epoch message MACs, replay sequencing, and typed native
  postcondition projection.
- `src/helper-supervisor.ts` owns generation-bound LLDB injection and joins
  in-flight work on stop.
- `src/audio-pump.ts` owns the bounded framed parent/native media protocol.
- `native/Sources/FaceTimeAudioCapture/FaceTimeAudioCapture.swift` owns the
  process tap, bounded capture producer, exact carrier watchdog, and actual
  `AVAudioPlayerNode.dataPlayedBack` output consumption.
- `src/talk-driver.ts` owns provider response/tool generations and exact agent
  consult cancellation.

Carrier hangup is terminal only after a native ended event or stable complete
topology absence. A helper reply only acknowledges the request. Capture death,
Gateway handoff, and unproven shutdown escalate before local suppression is
released.

## Configuration

`ownerHandles` is the only caller list. Every accepted identity receives owner
authority. `realtime.toolPolicy` is one of `safe-read-only`, `owner`, or `none`;
invalid explicit values fail validation.

The helper endpoint is not configurable. Node and the native helper consume
`helper-endpoint.json`, bind loopback only, and derive the port from the user ID.
The helper creates each connection epoch and authenticates the Gateway before
accepting commands; every command, response, and event is direction-bound and
strictly sequenced within that epoch.

## Development checks

```bash
node scripts/run-vitest.mjs extensions/facetime
pnpm --dir extensions/facetime build:capture
pnpm --dir extensions/facetime check:helper:macabi
pnpm --dir extensions/facetime test:native
sh -n extensions/facetime/scripts/*.sh
(cd extensions/facetime && npm pack --dry-run)
```

`check:helper:macabi` uses an ephemeral build key and does not stage a helper,
inject, open apps, or change operator state. `test:native` does not install the
driver or restart Core Audio.

Do not run live calls, install/uninstall the driver, change SIP, enable developer
tools, or modify TCC during automated validation.

## Native and licensing boundary

The privileged driver script pins BlackHole v0.7.1 and its SHA-256, builds the
renamed `OpenClawBridge.driver` in a root-only temporary directory, and accepts
no caller-built artifact, digest, or compiler path. Before compilation it
requires the canonical Xcode bundle and its selected build tools to be
Apple-signed, root-owned, and not group/world writable, then performs a
transactional swap. Generated BlackHole/driver artifacts are GPL-3.0 and are
excluded from the package. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

The Objective-C helper contains adapted Apache-2.0 BlueBubbles source. Unused
link/member admission handlers, ZKSwizzle, CTBlockDescription, and the old
Xcode project were removed from the production surface.
