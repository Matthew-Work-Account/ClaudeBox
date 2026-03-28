# ClaudeBox — Instructions for Claude

You are running inside a ClaudeBox container. This is a sandboxed Docker environment with a firewall that only allows traffic to approved domains.

## Environment Facts

- **User**: `node` (uid 1000) — no sudo for general commands
- **OS**: Debian 12 (bookworm-slim)
- **Shell**: zsh
- **Workspace**: Your project is mounted at `/workspace/{project-name}` (read-write)
- **Pre-installed**: git, curl, wget, jq, python3, zsh
- **Claude Code**: Pre-installed at `/home/node/.local/bin/claude`

## What You CAN'T Do

- **No sudo** — root is locked down to two init scripts only
- **No apt-get** — you don't have root, so you can't install system packages
- **No unrestricted internet** — the firewall blocks all domains not in the allowlist
- **pip is restricted** — PEP 668 blocks system-wide pip installs unless you use `--break-system-packages`, and even then only allowlisted domains are reachable

## Language SDKs

SDKs are installed at container creation time based on language detection or config. If you're in a container, the SDK is already set up. Check what's available:

- `node --version` / `npm --version` — if Node was configured
- `dotnet --list-sdks` — if .NET was configured
- `python3 --version` — always available (system python)
- `go version` — if Go was configured
- `rustc --version` / `cargo --version` — if Rust was configured
- `java -version` / `javac -version` — if Java was configured

## If the User Wants a Different Framework/Language

**You cannot install a new language SDK at runtime.** The container must be recreated with the correct language. Tell the user:

> This container was set up for `{detected_language}`. To use a different language, exit and run:
> ```bash
> claudebox destroy
> # Then either set language in .claudebox.json or ~/.claudebox/config.json:
> # {"language": "node"}   (or python, dotnet, go, rust, java)
> claudebox init
> ```

Alternatively, they can create a `.claudebox.json` in their project root before running `claudebox init`:
```json
{
  "language": "node",
  "extra_domains": [],
  "extra_apt_packages": [],
  "extra_commands": []
}
```

## If a Package Install Fails

1. **Network timeout / connection refused** — The domain is probably not in the firewall allowlist. The user needs to add it to `extra_domains` in `.claudebox.json` or `~/.claudebox/config.json`, then recreate the container.
2. **Permission denied on apt** — You don't have root. The user can add packages to `extra_apt_packages` in config, then recreate.
3. **pip fails with externally-managed-environment** — Use `--break-system-packages` flag, but only if the target PyPI domain is allowlisted.

## Setting Up a Fresh Project

When starting a brand new project (empty directory), here's what to do:

1. **Check what SDK is available** using the version commands above
2. **Use the available SDK's scaffolding tools** (e.g., `dotnet new`, `npm init`, `cargo init`)
3. **If no SDK is available** (language=none), tell the user they need to set a language and recreate

## Firewall Allowlist by Language

Each language config opens specific domains:
- **node**: registry.npmjs.org, registry.yarnpkg.com
- **python**: pypi.org, files.pythonhosted.org
- **dotnet**: nuget.org, aka.ms, builds.dotnet.microsoft.com, *.dot.net, *.microsoft.com
- **go**: proxy.golang.org, sum.golang.org, storage.googleapis.com, *.golang.org
- **rust**: crates.io, static.crates.io, index.crates.io, static.rust-lang.org, *.rust-lang.org
- **java**: repo1.maven.org, plugins.gradle.org, services.gradle.org, downloads.gradle-dn.com
- **All containers**: github.com, api.anthropic.com, deb.debian.org

Users can add more via `extra_domains` and `extra_suffixes` in config.

## extra_commands Behavior

Commands in `extra_commands` run **as root** during container initialization (inside `install-language.sh`), after language setup completes. The node user's environment is sourced first (`/home/node/.env.sh`), so language-specific paths (e.g. `npm`, `pip3`) are available even though the process runs as root.

This is why commands in `extra_commands` can install system packages with `apt-get` or write to root-owned paths — they execute before the container hands off to the `node` user. If a command in `extra_commands` fails with a permission error at runtime, it cannot be fixed by adding `sudo`; it must be placed in `extra_commands` in config and the container recreated.

## Offline NuGet Packages (dotnet containers)

Private NuGet feeds (e.g. Azure DevOps Artifacts) require credentials.
ClaudeBox does not inject credentials into containers; use local package seeding
instead.

When the host directory `~/.claudebox/nuget-cache/` exists at `claudebox init`
time, it is bind-mounted read-only at `/home/node/.nuget-cache-seed` inside the
container, and a `NuGet.Config` is written to
`/home/node/.nuget/NuGet/NuGet.Config` that adds it as a local package source
alongside `nuget.org`.

To seed the cache, run on the host (not inside the container):

    claudebox dotnet seed-nuget-cache [--source <path>]
    # default source: ~/.nuget/packages

Re-seeding replaces the entire cache directory. The seed survives
`claudebox destroy` because it is stored on the host, not in a Docker volume.

If `dotnet restore` still fails for a private package, confirm the package is
present in `~/.claudebox/nuget-cache/` and that the project-level `nuget.config`
does not override package sources in a way that bypasses the local feed.

**NuGet cache layout**: NuGet stores packages at
`<package-id>/<version>/*.nupkg` inside the cache directory — `.nupkg` files
are two levels deep, not at the root. When troubleshooting a missing package,
look for `~/.claudebox/nuget-cache/<id>/<version>/<id>.<version>.nupkg`.

**Named volume coexistence**: The `claudebox-nuget` named volume (mounted at
`/home/node/.nuget/packages` read-write) is still present alongside the seed
bind-mount. It holds packages dotnet downloads or extracts at container
runtime. Do not remove the named volume from `dotnet.json`; without it,
dotnet restore for non-seeded packages fails.

**Why `~/.claudebox/nuget-cache/` and not a direct bind-mount of
`~/.nuget/packages`?** Docker Desktop on Mac and Windows does not include the
user's `~/.nuget/packages` in its default file-sharing scope. A direct
bind-mount of that path silently fails on non-Linux hosts. The
`~/.claudebox/` directory sits under the user home, which Docker Desktop
exposes by default.

## Codebase Index

| Path                  | Contents (WHAT)                                               | Read When (WHEN)                                         |
| --------------------- | ------------------------------------------------------------- | -------------------------------------------------------- |
| `claudebox.sh`        | Main CLI: all subcommands, registry helpers, container logic  | Adding/changing CLI commands, init/destroy flow          |
| `install.sh`          | Host installer: copies files to CLAUDEBOX_HOME                | Changing what gets installed or install locations        |
| `lib/config.sh`       | Config merge logic (base -> global -> local)                  | Understanding or changing config merge semantics         |
| `gui/`                | Python web dashboard: server, API, static SPA                 | Working on the GUI feature; see `gui/CLAUDE.md`          |
| `gui/README.md`       | GUI architecture decisions, invariants, key tradeoffs         | Understanding GUI design before modifying it             |
| `languages/`          | Per-language JSON configs (domains, packages, mounts)         | Adding a language or changing language-specific settings |
| `modules/`            | Optional module JSON definitions (e.g. SqlServer)             | Adding or modifying optional container modules           |
| `.devcontainer/`      | Devcontainer setup scripts run inside the container           | Changing container init, language install, env setup     |
| `README.md`           | User-facing setup and usage guide                             | Understanding user workflows before changing CLI UX      |
