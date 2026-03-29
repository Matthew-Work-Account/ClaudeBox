# gui — CLAUDE.md

Python web dashboard for ClaudeBox. Runs on the host machine, not inside a container.

## Index

| File                  | Contents (WHAT)                                              | Read When (WHEN)                                    |
| --------------------- | ------------------------------------------------------------ | --------------------------------------------------- |
| `__init__.py`         | Package marker                                               | Importing gui as a module                           |
| `__main__.py`         | Entry point, arg parsing, ThreadingHTTPServer lifecycle      | Changing startup behavior, port handling, signals   |
| `server.py`           | HTTP request handler; GET/POST/DELETE routing; SSE stream handler for init, logs, and terminal | Adding API endpoints, debugging request flow        |
| `api.py`              | Registry read/write, config merge, module CRUD, config verify, docker inspect, file content reader, terminal session management (broadcaster, subscribe_terminal, unsubscribe_terminal, idle reaper), container destroy | Modifying container list, config, module operations, terminal, file viewer, dashboard backend |
| `static/index.html`   | SPA HTML shell, layout structure; loads vendored xterm.js and file viewer modal | Changing dashboard layout or adding UI sections     |
| `static/app.js`       | Vanilla JS SPA: container list, config viewer, command panel, file viewer, terminal tab, dashboard panel (pin management, grid rendering, fullscreen overlay, activity status) | Changing frontend behavior or adding UI features    |
| `static/style.css`    | Dashboard layout, status badges, terminal panel styles, file entry styles, light-mode sidebar overrides | Changing appearance or adding new UI components     |
| `static/vendor/`      | Vendored xterm.js 5.5.0 and addon-fit 0.10.0 (xterm.js, xterm.css, xterm-addon-fit.js) | Upgrading xterm.js version                          |
| `README.md`           | Architecture decisions, invariants, key tradeoffs            | Understanding design decisions before modifying     |
