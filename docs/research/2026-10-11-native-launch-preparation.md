# Native launch preparation

Status: implementation in progress. This completes group 2 of the
[daemon core checklist](2026-10-09-daemon-core-completion.md); it is not a claim
that the whole launch boundary or the daemon refactor is finished. No release
is authorized.

The healthy OpenCode v1 → v2 → v1 → current behavior was recorded from main
`10adc628d` in its own commit, `d5d796623`. Its fixture remains unchanged.
The earlier Claude/Codex and other-engine hook fixtures also remain unchanged.
The tests pin platform, replace host executable paths, and run under
`TZ=UTC TMPDIR=/tmp` with private configuration homes.

## Implemented mechanics

- Unknown executable versions remain retryable. An executable observation owns
  one resolved command and the file version that answered its version probe.
- Hook preparation inspects every destination before publication, preserves
  foreign commands and settings, rejects malformed or ambiguous configuration,
  follows only retained home/file aliases, and preserves existing permissions.
- Codex approvals and Hermes allowlists are prepared before changing their hook
  settings. OpenCode prepares both discovery surfaces before removing its v1
  plugin or installing its TUI plugin. Final confirmation checks every output.
- Atomic replacements use exclusive staging files, file synchronization, rename,
  and directory synchronization. A failed confirmation remains unavailable even
  when the intended bytes are already present; retry repeats the durability proof.
- Synchronization is asynchronous in eager code. A timed-out attempt retains its
  descriptor and destination reservations until the actual syscall settles. Its
  revoked authority prevents any later rename, removal, or acknowledgement.
  There are at most sixteen actual preparations, with at most thirty-two
  destinations each. Aliases reserve their canonical destinations together.
- Home adoption distinguishes a confirmed home from confirmed installed hooks.
  An in-flight installation does not acknowledge success or run twice. A stalled
  home leaves sibling installation and shutdown available.

The JSON command ownership rule checks the literal Harness notification protocol,
not merely the substring `notify.mjs`. Full TOML and YAML parsing preserves unknown
configuration instead of treating it as empty. Parsers are pinned to
`smol-toml` 1.9.0 and `yaml` 2.9.1. TOML depth and YAML lexer work are bounded;
no YAML aliases are expanded. The TOML pin includes the fix for
[GHSA-7w5x-hrqm-74c2](https://github.com/advisories/GHSA-7w5x-hrqm-74c2).
The YAML API is documented by its [maintainer](https://eemeli.org/yaml/).

Some old golden scenarios recorded destructive recovery of malformed/foreign
files. Those fixture bytes remain available for comparison; the scenario now
asserts exact preservation and an explicit unavailable result. Healthy scenarios
still compare against the former artifacts. Mode, alias, and unrelated temporary
file preservation are asserted explicitly.

## Validation checkpoint

On October 10, UTC, using Node 22.23.2 on macOS:

- `20261010T234958.425927Z-92785`: typecheck passed; 183 focused tests passed.
  These include blocked flush, deadline, retained descriptor/reservation,
  executable supersession, shutdown, independent home retry, and recovery cases.
- `20261010T234840.092679Z-87419`: all 441 hook golden cases passed. The focused
  suite in this earlier receipt failed a test that mixed a fake timer with the
  real monotonic clock; the later focused receipt above covers its correction.
- The native version golden passes unchanged in the focused suite.
- Core/harnessd coverage, launch integration, wiring mutations, private e2e,
  final architecture acceptance, and exact-head independent review are pending.
  This checkpoint is not landing evidence for those gates.

The same private workload compared main with the candidate in three alternating
pairs: thirteen installers, cold/current/changed-port/current. Both used the same
Node runtime, a fixture version executable, private homes, and no daemon or tmux.
Medians are descriptive measurements, not new numerical gates:

| Measurement | Main | Async durable candidate |
| --- | ---: | ---: |
| Total wall time, including imports | 558 ms | 3,368 ms |
| CPU | 156 ms | 518 ms |
| Peak RSS | 91 MiB | 107 MiB |
| Cold round maximum callback gap | 13.5 ms | 31.0 ms |
| First current round maximum callback gap | 3.0 ms | 5.8 ms |
| Changed-port maximum callback gap | 6.6 ms | 21.4 ms |
| Last current round maximum callback gap | 1.9 ms | 4.2 ms |

Durable preparation does more work than the former best-effort writes. An initial
synchronous implementation took a median 3,880 ms total and could block session
control while syncing. The asynchronous candidate leaves the event loop available
during those waits; callback gaps measure that distinction, not actual Stop latency.
Whole-launch cost, readiness, and unrelated Stop latency still require integration
measurement. There is no cross-request configuration or durability cache.

## Remaining integration for this change

Every create/fork/restart/retarget/restore/external-resume path must use a confirmed
snapshot for permission probing, versioned choices, hooks, native APIs, and argv.
The shell must execute that exact binary after its startup files, with a final
identity check. Missing engines need an installer-only phase that returns to core
preparation before native execution. An unknown version cannot be guessed as v1.

Preparation failures must become visible durable holds, including manual requests.
A held operation against a running pane must preserve the live row and process;
only inert panes may use the existing held-launch state. Startup hook coordination
must stop waiting for disk work only when these per-launch checks are wired.
Retries must preserve the original request and ownership, work independently, and
be revoked by Stop/Close. These caller migrations remain unfinished in this draft.

## Time accounting

This slice began October 10 at 22:49 UTC. The checkpoint above was reached about
an hour later, including implementation, focused validation and design review.
Implementation and validation overlapped; receipt durations describe individual
checks, not total delivery time. Merge and publication are both zero for this slice.
