# Native launch preparation

Status: hook durability mechanics are in final validation. They are part of
group 2 of the [daemon core checklist](2026-10-09-daemon-core-completion.md).
The whole-launch integration below remains in progress in a separate worktree;
neither group 2 nor the daemon refactor is complete. No release is authorized.

The healthy OpenCode v1 → v2 → v1 → current behavior was recorded from main
`10adc628d` in its own commit, `d5d796623`. Its fixture remains unchanged.
The earlier Claude/Codex and other-engine hook fixtures also remain unchanged.
The tests pin platform, replace host executable paths, and run under
`TZ=UTC TMPDIR=/tmp` with private configuration homes.

## Implemented mechanics

- Executable observations retain their identity. An executable observation owns
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

## Remaining launch integration

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
be revoked by Stop/Close. These caller migrations remain unfinished; the mechanics
PR does not enable the draft whole-launch integration.

## Time accounting

This slice began October 10 at 22:49 UTC. The checkpoint above was reached about
an hour later, including implementation, focused validation and design review.
Implementation and validation overlapped; receipt durations describe individual
checks, not total delivery time. Merge and publication are both zero for this slice.

## Independent review corrections

Review of `7a2cedfd1` identified eight races or preservation gaps: staging-file
replacement during a flush, stale second-file preflight, destination alias changes
before dispatch, joining owners/deadlines, an expiring removal deadline, changed
managed-Node commands joining old work, Hermes profile-pool starvation, and umask
changing existing shared permissions. Each now has a regression and an implementation
fix; final exact-head approval remains pending. Filesystem confirmations use at most
two libuv slots, leaving capacity for native transcript reads. Queued work cancels
before dispatch when its owner or deadline expires.

The October 11 00:06 UTC receipt passed typecheck and all 441 unchanged golden
cases. Focused checks passed 192 of 193; the 19-home Hermes capacity case exceeded
the test's five-second total timeout (each individual preparation has its own
five-second deadline). Its total test allowance is now 20 seconds for the five
sequential waves; the per-preparation production deadline and assertions are unchanged.
The matched three-pair measurement reported median baseline/candidate totals of
586.6/3328.5 ms, CPU 142.3/623.6 ms, and peak RSS 91.4/109.5 MiB. Cold-install
maximum timer gaps were 11.5/59.2 ms. These results show the extra durability cost;
they do not prove native-read latency under a stalled filesystem. Final acceptance
will measure that separately after launch integration.

Review of `ace259746` found four additional gaps: a joining deadline could pass
before its timer callback, an alias join could acknowledge a different route,
OpenCode could credit a newer installation to a revoked older caller, and shell
globs/newlines could cause a foreign command to be mistaken for an owned hook.
The corrections have regressions. Each confirmed publication also retains its
exact file and alias facts for the later launch guard; an alias join retains its
own route. The OpenCode follow deadline includes the original preparation.

The integration worktree's 00:33 UTC receipt passed typecheck and focused hooks
and launch tests. A later expanded run exposed a local type annotation error in
the unfinished held-launch integration and one native-process fixture failure
under load; the isolated native-version rerun passed all eleven tests without a
production change. These are development evidence, not the final mechanics gate.
The mechanics branch integrates main `93d49e9c8` (routing changes only) and runs
its own final gates, independent review, mutations and private e2e lanes.

Review of `28264b32a` found three remaining mechanics defects: custom Codex
profile callers discarded the asynchronous installation result; a proof capture
could adopt a peer edit between verification and its own filesystem reads; and
OpenCode reservation/final-proof reads could outlive the original deadline.
The callers now await installation before pane creation or external takeover,
proofs must still match the original publication, and the original deadline is
checked across reservation and final acknowledgement. Regressions also cover
owner revocation while waiting. The revoked-joiner mutation now uses an oracle
that actually joins while the caller still owns its request.

The mechanics gate at 00:49 UTC passed typecheck, architecture, harnessd coverage
and 441 golden cases. Core and affected tests exposed three obsolete test
fixtures after the asynchronous API change: a removed mock export, an unawaited
Pi installation and the former unknown-OpenCode-version expectation. The
00:56 UTC receipt (`20261011T005625.232631Z-71860`) covers their corrections and
all three review fixes: typecheck, 203 focused cases and 316 affected cases pass
(five environment-gated cases remain skipped). Full core coverage, private e2e,
assertion-failing mutations and exact-head approval are still required.

Final review of `1f71fd298` identified a prerequisite: refusing an unknown
OpenCode version also prevents a clean machine from reaching its existing pane
installer. This mechanics slice therefore preserves main's legacy TUI preparation
for that case. Unknown-version launch holds belong with installer-only continuation
in the whole-launch change. A create regression now covers the absent-version
route; no claim is made that this PR completes native launch safety.

The first mutation run caught nine faults but four test oracles were inadequate
(two type errors, an early-join timeout and a reservation fixture that reached the
wrong filesystem read). Their assertions/fixture now target the intended behavior.
The unknown-version mutant is deferred with its prerequisite, leaving twelve.
The 01:04 UTC full gate passed typecheck, architecture, harnessd and all 441 hook
goldens; core reported three handoff-publication timeouts under concurrent disk
work. Its remaining tests were interrupted for the required review correction.
The private e2e run passed three eager-hook cases and failed the Codex case because
the local bundle omitted the required macOS process-control helper. The corrected
run must embed the matching locally built helper; it is not a production change.

Linux CI on `1f71fd298` found that removing the legacy null-version cache changes
the old unknown-version command trace. That policy change is deferred with the
whole-launch snapshot, keeping the launch golden unchanged in this mechanics PR.
CI also exposed a transient native directory-enumeration hold when another test
changed an ancestor under `/tmp`. The Stop/archive regression now checks that this
specific hold preserves the row and retries it at most twice; all other errors
still fail immediately. This changes no production identity rule.

At 01:15 UTC, typecheck, 201 focused native cases, architecture, harnessd at 100%
and 359 affected cases passed (five environment-gated cases skipped). All 2,393
core tests passed; the coverage gate identified one uncovered synchronous-false
installer result. The test named for synchronous/asynchronous holds now exercises
both. The no-OpenCode golden assertion also returns to its unchanged former
artifact alongside the deferred policy. No golden fixture bytes were rerecorded.
All twelve deliberate mutations failed assertions in receipt
`20261011T011530.711952Z-59124`; final core/golden gates and private e2e remain.
