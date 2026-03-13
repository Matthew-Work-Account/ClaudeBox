# ClaudeBox

ClaudeBox launches [Claude Code](https://docs.anthropic.com/en/docs/claude-code) inside a sandboxed Docker container. It auto-detects project language, installs the appropriate SDK, copies your Claude config into the container, and restricts outbound network to approved endpoints.

---

## Getting Started

### Prerequisites

- **Docker** running on your machine
- **jq** installed on the host (`apt install jq` or `brew install jq`)
- **Claude Code** logged in once on the host (`~/.claude/.credentials.json` must exist)
- **bash** (Linux/macOS/WSL). Windows users also need PowerShell 5.1+.

### Install

```bash
git clone <repo-url> && cd claudebox
bash install.sh
```

Installs to `~/.local/share/claudebox/` and adds a launcher at `~/.local/bin/claudebox`.
Restart your shell or run `source ~/.bashrc` after install.

**Windows (PowerShell):** Copy `claudebox.ps1` to a directory on your `$PATH`. It
delegates to the WSL install above via the well-known path
`~/.local/share/claudebox/claudebox.sh`.

### Usage

```bash
claudebox init           # Create container for current directory
claudebox                # Resume (reconnect) existing container
claudebox stop           # Stop container
claudebox destroy        # Remove container
claudebox refresh        # Re-copy claude config into running container
claudebox ref <dir>      # Copy host directory in as a read-only reference
claudebox prune [<name>] # Remove references
claudebox config         # Run configuration wizard
```

---

## How It Works

### Container Naming

Containers are named `claudebox-{dirname}-{hash4}` where `{dirname}` is the
leaf folder name and `{hash4}` is the first 4 hex characters of the SHA-256
hash of the full path. Prevents collisions when multiple repos share the same
leaf name (e.g. `api`, `web`, `core` in a monorepo).

### File Layout After Install

```
~/.local/share/claudebox/    # CLAUDEBOX_HOME: all ClaudeBox files
~/.local/bin/claudebox       # Thin launcher (sets CLAUDEBOX_HOME, exec)
~/.claudebox/config.json     # Global config (created on first run)
.claudebox.json              # Per-project config (optional, in project root)
```

### Mount and Copy Layout

| Host Path | Container Path | Mode |
|-----------|---------------|------|
| Project directory | `/workspace/{project}` | read-write |
| `~/.claude/settings.json` | `/home/node/.claude/settings.json` | bind-mount ro |
| `~/.claude/.credentials.json` | `/home/node/.claude/.credentials.json` | bind-mount ro |
| `claude_config_path/{subfolder}` | `/home/node/.claude/{subfolder}` | **copied** at init |
| `~/.bash_histories/{container}` | `/home/node/.bash_history` | read-write |
| Named volumes (language-specific) | `/home/node/.{sdk}/` | read-write |

Claude config subfolders (`agents`, `conventions`, `output-styles`, `skills`)
are **copied** into the container at `claudebox init`, not bind-mounted. The
container owns its copy and can modify it. Run `claudebox refresh` to re-copy
from the host when the source changes. Credentials and settings remain
bind-mounted (read-only) because the container must not modify them.

### Language Detection

`claudebox init` detects language from root-level file markers (e.g. `*.csproj`
-> dotnet, `package.json` -> node). Override by setting `"language": "python"`
(or any supported language) in your config. Supported: `dotnet`, `node`,
`python`, `go`, `rust`, `java`.

### Firewall

The container uses `iptables` to restrict outbound traffic to:

- GitHub (including releases and raw content)
- npm registry
- Anthropic API
- Docker internal DNS
- Private IP ranges
- Language-specific registries (e.g. NuGet for dotnet, PyPI for python)
- Any domains listed in `extra_domains` in your config

All other outbound connections are blocked.

### API Key

If `ANTHROPIC_API_KEY` is set in the host environment, it is passed into the
container. Otherwise Claude Code uses `~/.claude/.credentials.json`.

---

## Configuration

Run `claudebox config` to create or update `~/.claudebox/config.json` via the
interactive wizard. Config supports progressive disclosure: essential settings
(language, claude_config_path) first, advanced settings behind an optional
prompt.

Per-project `.claudebox.json` overlays the global config. Merge semantics:
scalars use the local value; arrays are concatenated (global first, then local).

## Project Structure

```
claudebox/
├── claudebox.sh            # Main CLI (subcommand dispatch, container lifecycle)
├── claudebox.ps1           # PowerShell WSL shim for Windows
├── install.sh              # Installer (copies to CLAUDEBOX_HOME)
├── lib/
│   ├── config.sh           # Config loading, merging, cb_copy_claude_config
│   ├── detect.sh           # Language detection from file markers
│   └── wizard.sh           # Interactive config wizard
├── languages/              # Declarative language provider JSON definitions
├── .devcontainer/          # Dockerfile, firewall init, language installer
└── scc/                    # Claude Code config (copied into containers)
```

---

## Troubleshooting

| Problem | Solution |
|---------|---------|
| `Docker is not running` | Start Docker and try again |
| `No container found` | Run `claudebox init` first |
| Container already exists | Run `claudebox` to resume, or `claudebox destroy` then `init` |
| Missing credentials warning | Run `claude` once on the host to create `~/.claude/.credentials.json` |
| Claude config not visible in container | Run `claudebox refresh` to re-copy from host |
| `claudebox.ps1` can't find claudebox.sh | Run `bash install.sh` in WSL first |
