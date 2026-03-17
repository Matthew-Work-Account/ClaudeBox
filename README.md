# ClaudeBox

ClaudeBox launches [Claude Code](https://docs.anthropic.com/en/docs/claude-code) inside a sandboxed Docker container. It auto-detects project language, installs the appropriate SDK, copies your Claude config into the container, and restricts outbound network to approved endpoints.

---

## Getting Started

### Prerequisites

- **Docker** running on your machine
- **jq** installed on the host (`apt install jq` or `brew install jq`)
- **bash** (Linux/macOS/WSL). Windows users also need PowerShell 5.1+.

### Install

```bash
# Option 1: curl one-liner (no git clone required)
curl -fsSL https://raw.githubusercontent.com/Matthew-Work-Account/ClaudeBox/main/install.sh | bash
```

```bash
# Option 2: clone and install locally
git clone https://github.com/Matthew-Work-Account/ClaudeBox.git && cd ClaudeBox
bash install.sh
```

Installs to `~/.local/share/claudebox/` and adds a launcher at `~/.local/bin/claudebox`.
Restart your shell or run `source ~/.bashrc` after install.

**Windows (PowerShell 5.1+):**

```powershell
# Option 1: PowerShell one-liner (no git clone required)
irm https://raw.githubusercontent.com/Matthew-Work-Account/ClaudeBox/main/install.ps1 | iex
```

```powershell
# Option 2: clone and install locally
git clone https://github.com/Matthew-Work-Account/ClaudeBox.git
cd ClaudeBox
.\install.ps1
```

The installer copies `claudebox.ps1` to `%LOCALAPPDATA%\ClaudeBox\`, adds that
directory to your User PATH, and runs `install.sh` in WSL to set up the bash side.

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
claudebox upgrade        # Upgrade ClaudeBox to latest from git
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
| `claude_config_path/*` | `/home/node/.claude/` | **copied** at init |
| `~/.bash_histories/{container}` | `/home/node/.bash_history` | read-write |
| Named volumes (language-specific) | `/home/node/.{sdk}/` | read-write |

Everything in `claude_config_path` is **copied** into the container's
`/home/node/.claude/` at `claudebox init`. Existing files are not cleared, but
conflicts are overwritten. The container owns its copy and can modify it. Run
`claudebox refresh` to re-copy from the host when the source changes.

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
container.

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
| Claude config not visible in container | Run `claudebox refresh` to re-copy from host |
| `claudebox.ps1` can't find claudebox.sh | Run `bash install.sh` in WSL first |
