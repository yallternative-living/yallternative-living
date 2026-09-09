---
name: steward
description: How an agent watches a pull request in this repository -- when to check back, when to stay quiet, and when to speak. Read before acting on CI or review events on a PR you opened or were asked to drive.
---

# Watching a pull request in this repository

This is repository guidance on **cadence and proactivity**. It does not
change what a failure means or what you owe a reviewer: fix red CI, resolve
conflicts, answer review comments, and never skip a test, rewrite someone
else's history, or push an empty commit to kick CI. Those rules stand
whatever this file says.

What it does change is the part that was wrong by default: an unconditional
hourly re-check of a pull request that has nothing left to re-check, each
one reporting "no change" to a human who did not ask.

## Check back only when something is actually pending

Schedule the next check-in only when at least one of these is true on the
PR's current head:

- a check run is queued or in progress
- a check run failed, or the PR is not mergeable
- a review thread is open, or a reviewer asked for changes
- you reported a blocker and are waiting on it to clear
- you pushed within the last few minutes and CI has not picked it up yet

When none of them is true -- every check green, mergeable, nothing open --
**stop scheduling.** Cancel a pending check-in rather than letting it fire.
A green, clean PR is waiting on a human, and polling a human is not
monitoring.

This is safe here because the two events that a webhook can genuinely drop
are covered:

| Event | How it reaches you |
| --- | --- |
| CI failure, review comment, new review | Pushed by the PR subscription |
| Merge conflict, base branch recovered | Pushed as a harness mergeability notice |
| CI **success** | Not reliably pushed -- this is what you poll for, and only while a run is in flight |

So poll while you are waiting on a run to finish, and stop once it has.

## Pace the wait to the thing you are waiting for

A full CI run in this repository takes about seven minutes: the fast `qa`
job finishes in roughly a minute, the `browser` job in six. Match the delay
to that, do not default to an hour:

- waiting on a run you just triggered: check in ~8 minutes
- a run that should have finished but has not: ~15 minutes, then ~30
- a blocker you already reported and cannot clear yourself: ~60 minutes
- nothing pending: no check-in at all

## Say something only when something happened

Report to the user when you acted, when the state changed, or when you are
blocked and need them. Do not report that nothing changed. If your last
message already said the PR is green and mergeable, a later check that finds
it still green and still mergeable is not news, and repeating it buries the
messages that are.

Two things are always safe to skip without comment: an event echoing your
own comment or push, and a deploy bot re-posting the same status for a new
commit.

## Do not sit on a red PR

The flip side of all of the above: while CI is red, a conflict is open, or a
reviewer is waiting, checking back is not optional and neither is acting. A
quiet loop is correct only for a PR that is genuinely done and waiting on a
person.
