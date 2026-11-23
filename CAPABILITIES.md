# Capability-aware Homey preview

This is the first stage of the proposed fork integration. The branch depends on
the exact capability-discovery library commit 0ed0bc0a4b80655d5251fb8b6e4547159f1b39a6
through a Git dependency. No npm release is needed for this preview.

## Behaviour

- Pairing queries the AC's capabilities after local authentication.
- New devices receive optional controls only for reported support.
- A failed capability query does not prevent pairing: basic controls remain, and
  supported optional controls can be added after a later successful restart.
- Capability snapshots are stored per device and merged with subsequent responses.
- Restarting refreshes support; a failed query preserves cached support.
- Existing Homey capabilities are never removed automatically, to preserve Flows.
- Existing devices retain unknown mode choices; new devices hide unknown choices.
- Explicitly unsupported modes/functions are rejected before a write.
- Temperature limits follow reported limits for the current mode, with reported
  half-degree support. Legacy defaults are not treated as hardware evidence.
- NetHome Plus and MSmartHome remain available.
- The intentional token/key clearing after an IP address change is unchanged.

The library now provides energy sensors and property/state commands for iECO,
ionisation, Outdoor Silent, JetCool, Follow Me and Self Clean. This Homey preview
does not yet expose these as new buttons or Flow cards. See the library STATE_ACCESS.md.
Nor does it add automatic rediscovery or connection recovery.

## Try it

```sh
git fetch origin
git switch --track origin/codex/capability-discovery
npm install
npm run test:capabilities
homey app run --remote
```

npm builds the Git library dependency using its prepare script. GitHub and npm
network access are needed. No Homey version bump or release publication is included.

## Validation

Library build and 25 library protocol/fixture tests passed. Homey TypeScript
compilation and six capability/helper tests passed against that built library,
using the installed SDK dependencies. The tests cover cache retention on network
failure and preserving existing controls. Registry/Git dependency installation and
a live Homey/AC test could not be performed in this execution environment.

Missing temperature/frost fields are now left unchanged in Homey rather than replaced with legacy defaults. No live Homey/AC writes were performed for these state tests.
