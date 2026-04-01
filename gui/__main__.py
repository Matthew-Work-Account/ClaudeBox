"""
Entry point for `python3 -m gui`.

Starts a ThreadingHTTPServer on localhost (DL-001, RISK-001). Binds to 127.0.0.1
only to prevent remote access. On EADDRINUSE exits with a message naming the port
and suggesting --port rather than auto-incrementing (DL-006).
"""
import argparse
import errno
import signal
import sys
import threading
import webbrowser
from http.server import ThreadingHTTPServer

from .server import ClaudeBoxHandler
from . import api


def main():
    """Parse CLI args, start server, open browser, block until signal."""
    parser = argparse.ArgumentParser(description="ClaudeBox GUI Dashboard")
    parser.add_argument(
        "--port",
        type=int,
        default=19280,
        help="Port to listen on (default: 19280)",
    )
    args = parser.parse_args()

    server_address = ("127.0.0.1", args.port)
    try:
        httpd = ThreadingHTTPServer(server_address, ClaudeBoxHandler)
        # ThreadingHTTPServer handles each request in its own thread, preventing
        # concurrent SSE streams from blocking API requests. (ref: RISK-001)
    except OSError as exc:
        if exc.errno == errno.EADDRINUSE:
            print(
                f"Port {args.port} is already in use. "
                f"Use --port <number> to specify a different port."
            )
            sys.exit(1)
        raise

    shutdown_event = threading.Event()

    def _handle_signal(signum, frame):
        # Close all terminal sessions before shutting down so PTY processes are cleaned up.
        # api.py also registers a SIGTERM handler at import time, but __main__.py overrides it
        # here. Calling close_all_terminals() explicitly ensures the documented R-005 Layer 1
        # cleanup runs regardless of signal handler registration order.
        api.close_all_terminals()
        shutdown_event.set()

    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)

    server_thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    server_thread.start()

    url = f"http://127.0.0.1:{args.port}/"
    print(f"ClaudeBox GUI running at {url}")
    print("Press Ctrl+C to stop.")
    try:
        webbrowser.open(url)
    except Exception:
        pass

    shutdown_event.wait()
    httpd.shutdown()
    sys.exit(0)


if __name__ == "__main__":
    main()
