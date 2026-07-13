#!/usr/bin/env python3
"""A real pseudo-terminal harness for the CLI's TTY-only code paths.

Piping a child process's output through an ordinary subprocess pipe can
never make `process.stdout.isTTY` true in that child — a pipe is not a
terminal, no matter how it's wired up. That makes the staggered TTY checkup,
the closing score-card ordering, and the share prompt permanently
unreachable from a plain subprocess spawn: those branches only run when
stdout genuinely is a terminal.

A pseudo-terminal (pty) is the only way to make that true from a test. This
harness forks the target command onto the slave end of a real pty, so the
child inherits a genuine TTY on fd 0/1/2; watches the growing transcript for
known interactive-prompt tails and types a canned reply the instant one
appears, so the child never blocks waiting on a human; and reports the full
captured transcript plus exit status as one JSON line on ITS OWN stdout — a
plain pipe back to the caller (only the CHILD sees the pty).

python3's standard library ships everything this needs (pty, fcntl, termios,
select) with no extra install step, and this repository already treats
python3 as a soft dependency: tests that need it skip cleanly, rather than
failing, when it — or a working pty — isn't available on the machine running
them.

Usage:
    python3 pty_run.py <timeout_seconds> <cmd> [args...]

The environment is inherited as-is from whatever spawned this process (the
caller sets it up before spawning); this script never touches it.

Output contract — one line, on this process's own stdout, printed once at
the very end:
    {"exit": <int|null>, "timedOut": <bool>, "output": "<full utf-8 capture>"}
`exit` is the child's real exit code, a negative signal number if a signal
killed it, or null if the hard deadline fired first (in which case the child
is SIGKILLed rather than left to run past its budget).
"""
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import time

# Matches the same escape sequences the product's own ASCII-sweep law
# strips (see format.ts's stripAnsi) — CSI sequences of the form
# ESC [ <params> <final-letter>. Prompt-tail matching below runs on the
# stripped text so cursor-position/bracketed-paste sequences a real
# terminal's line discipline may interleave never break a suffix match.
ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")

# Every interactive prompt this CLI can print, keyed by its literal tail
# (after trailing whitespace is stripped — the real prompts all end with a
# trailing space that a line-buffered capture may or may not preserve at a
# chunk boundary), mapped to the reply that answers it "no"/"skip" so a
# fully-automated run never blocks on human input.
PROMPT_REPLIES = (
    ("[q/Esc] Finish without copying", "q"),  # raw-key final menu: quit immediately
    ("[Y/n]", "\n"),  # savings recommendation: Enter accepts the default
    ("[y/N]", "n\n"),  # enable/revert consent: default answer is "no"
    ("[s/a]", "s\n"),  # branch-ambiguity question: pick (s)ubscription
)


def set_winsize(fd: int, rows: int, cols: int) -> None:
    """A pty's window size defaults to 0x0 on some platforms until set
    explicitly. Left at 0x0, some TTY-aware output logic behaves as though
    there is no room to draw anything — so this must run before the child
    gets far enough to query it."""
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def decode_exit_status(status: int) -> "int | None":
    """Portable decode of a raw waitpid() status. `os.waitstatus_to_exitcode`
    would do this in one call but only exists on python>=3.9; WIFEXITED /
    WEXITSTATUS / WIFSIGNALED / WTERMSIG work on every python3 a dev machine
    might have, matching this repo's soft-dependency stance on python3."""
    if os.WIFEXITED(status):
        return os.WEXITSTATUS(status)
    if os.WIFSIGNALED(status):
        return -os.WTERMSIG(status)
    return None


def main() -> None:
    if len(sys.argv) < 3:
        sys.stderr.write("usage: pty_run.py <timeout_seconds> <cmd> [args...]\n")
        sys.exit(2)

    timeout_seconds = float(sys.argv[1])
    cmd = sys.argv[2:]

    pid, master = pty.fork()
    if pid == 0:
        # Child: pty.fork() has already made the pty slave our controlling
        # terminal on fd 0/1/2, so all that's left is to become the target
        # command. This never returns on success; only a failed exec falls
        # through, and os._exit (not sys.exit) skips any parent-side cleanup
        # that would otherwise run twice.
        try:
            os.execvpe(cmd[0], cmd, os.environ)
        except OSError:
            os._exit(127)

    # ---- parent from here on ----
    set_winsize(master, 40, 120)

    deadline = time.monotonic() + timeout_seconds
    chunks: list[bytes] = []
    handled_len = 0  # watermark into the decoded transcript-so-far
    timed_out = False
    child_exited = False
    exit_status: "int | None" = None

    while True:
        if not child_exited:
            try:
                wpid, wstatus = os.waitpid(pid, os.WNOHANG)
            except ChildProcessError:
                wpid, wstatus = 0, 0
            if wpid == pid:
                child_exited = True
                exit_status = wstatus

        if time.monotonic() >= deadline:
            timed_out = True
            break

        try:
            ready, _, _ = select.select([master], [], [], 0.05)
        except OSError:
            break

        if ready:
            try:
                data = os.read(master, 4096)
            except OSError:
                # EIO once the child has exited and its pty slave has no
                # remaining open fds (the common case on both Linux and
                # darwin) — nothing more will ever arrive.
                break
            if data:
                chunks.append(data)
            elif child_exited:
                break
        elif child_exited:
            # Nothing waiting, and the child is already gone: the drain
            # this iteration's read would have done found nothing, so
            # there is nothing left to wait for.
            break

        # Autorespond to whichever known prompt the not-yet-handled tail of
        # the transcript ends with, exactly once per prompt: advance
        # handled_len past the whole transcript-so-far the moment a reply is
        # sent, so the same prompt text can never fire a second reply.
        transcript = b"".join(chunks).decode("utf-8", errors="replace")
        tail = ANSI_RE.sub("", transcript[handled_len:]).rstrip()
        for needle, reply in PROMPT_REPLIES:
            if tail.endswith(needle):
                try:
                    os.write(master, reply.encode("utf-8"))
                except OSError:
                    pass
                handled_len = len(transcript)
                break

    # A completed reap always trumps a same-tick deadline crossing: if the
    # child's own exit was observed above, this run did not time out,
    # regardless of which check happened to fire first in that iteration.
    if child_exited:
        timed_out = False

    if timed_out:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            _, wstatus = os.waitpid(pid, 0)
            exit_status = wstatus
        except ChildProcessError:
            pass
    elif not child_exited:
        # The loop broke (typically the EIO above) before a WNOHANG poll
        # ever caught the exit — reap now, blocking, to get a real status.
        try:
            _, wstatus = os.waitpid(pid, 0)
            exit_status = wstatus
        except ChildProcessError:
            pass

    # Final non-blocking drain: a pty keeps buffered output readable for a
    # moment even after its writer is gone, so one more pass catches
    # anything written between the loop's last check and the exit/kill.
    while True:
        try:
            ready, _, _ = select.select([master], [], [], 0)
        except OSError:
            break
        if not ready:
            break
        try:
            data = os.read(master, 4096)
        except OSError:
            break
        if not data:
            break
        chunks.append(data)

    try:
        os.close(master)
    except OSError:
        pass

    # Decoded ONCE, here, over the complete byte buffer — never per-chunk —
    # so a multi-byte character split across a chunk boundary decodes
    # correctly instead of producing a stray replacement character wherever
    # it happened to be cut.
    output = b"".join(chunks).decode("utf-8", errors="replace")
    exit_code = None if timed_out else (decode_exit_status(exit_status) if exit_status is not None else None)

    print(json.dumps({"exit": exit_code, "timedOut": timed_out, "output": output}))
    sys.exit(0)


if __name__ == "__main__":
    main()
