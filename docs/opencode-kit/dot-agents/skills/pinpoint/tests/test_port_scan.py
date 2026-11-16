"""Port-binding contract tests (issue 0022).

The scan must skip a port that a real listener holds. This is the exact
regression that double-bound two relay daemons on 127.0.0.1:8791. The
real-world occupier is an ``HTTPServer``-family socket, which sets
``SO_REUSEADDR`` (``allow_reuse_address = 1``); the probe socket also
set ``SO_REUSEADDR``; and on Windows, a bind over a LISTENing port
succeeds precisely when both sockets opt into reuse (verified on the
dev box: reuse+reuse double-binds, every other combination is refused
— WSAEADDRINUSE or the WSAEACCES hijack guard). POSIX never allows a
bind over a live listener, which is why the bug only surfaced on
Windows. The assertions below pin the required behavior
platform-independently — red on Windows before the fix, green on every
platform after — following the test_platform.py paradigm: no branch may
regress silently just because this repo has no macOS runner.
"""

import socket

import pytest

from server_common import find_free_port


def occupy_port(reuse: bool = False) -> tuple:
    """Bind+listen a real TCP listener; return (port, socket).

    ``reuse=True`` mirrors the occupier that matters in production:
    every ``HTTPServer``-family listener (the relay daemon included)
    sets ``SO_REUSEADDR`` via ``allow_reuse_address = 1``.
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    if reuse:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(('127.0.0.1', 0))
    sock.listen(1)
    return sock.getsockname()[1], sock


def bindable(port: int) -> bool:
    """True when a plain (no-reuse) socket can bind this port now."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        try:
            probe.bind(('127.0.0.1', port))
            return True
        except OSError:
            return False


class TestScanSkipsOccupiedPorts:
    def test_reuse_listener_is_not_reported_free(self):
        # The 0022 regression: probe-with-reuse binds over a
        # reuse-listening daemon socket on Windows, so the occupied
        # port looks free and a second daemon double-binds it.
        port, sock = occupy_port(reuse=True)
        try:
            picked = find_free_port(port)
            assert picked != port, 'scan returned a port a listener holds'
            assert bindable(picked), 'scan returned a port we cannot bind'
        finally:
            sock.close()

    def test_plain_listener_is_not_reported_free(self):
        port, sock = occupy_port()
        try:
            picked = find_free_port(port)
            assert picked != port, 'scan returned a port a listener holds'
            assert bindable(picked), 'scan returned a port we cannot bind'
        finally:
            sock.close()

    def test_exhausted_range_raises_instead_of_returning_taken_port(self):
        port, sock = occupy_port(reuse=True)
        try:
            with pytest.raises(RuntimeError):
                find_free_port(port, span=1)
        finally:
            sock.close()


class TestScanContract:
    def test_invalid_port_fails_before_probing(self):
        with pytest.raises(ValueError):
            find_free_port(0)

    def test_invalid_span_raises(self):
        with pytest.raises(ValueError):
            find_free_port(8791, span=0)

    def test_result_stays_inside_the_scan_span(self):
        # A freshly released ephemeral port is the freest local port we
        # can name without racing the OS allocator; the scan may start
        # there but must not wander past preferred + span - 1.
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.bind(('127.0.0.1', 0))
        preferred = sock.getsockname()[1]
        sock.close()
        picked = find_free_port(preferred, span=5)
        assert preferred <= picked <= preferred + 4
        assert bindable(picked)


class TestListenReusePolicy:
    def test_policy_server_refuses_double_bind_over_daemon_listener(self):
        # The second half of 0022: the daemon's own listen socket also
        # set SO_REUSEADDR, which is what let it LISTEN over the first
        # daemon after the scan mis-reported the port free. A server
        # configured by the central policy must refuse that bind on
        # every platform: Windows because reuse is off (double-bind
        # hazard), POSIX because reuse never crosses a live listener.
        import socketserver

        from server_common import LISTEN_REUSE_ADDRESS

        class PolicyServer(socketserver.TCPServer):
            allow_reuse_address = LISTEN_REUSE_ADDRESS

        port, sock = occupy_port(reuse=True)
        try:
            with pytest.raises(OSError):
                PolicyServer(('127.0.0.1', port), None)
        finally:
            sock.close()
