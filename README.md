# lpck (Local Package)

A CLI tool for installing local npm packages from workspaces into another project — when `npm link` just won't cut it.

## The Problem

Testing local packages from an npm workspace in another project is frustratingly difficult:

- **`npm link` has poor workspace support** — It doesn't handle monorepos with multiple interconnected packages well
- **No dependency hoisting** — When installing multiple packages from the same workspace, `npm link` fails to properly hoist shared dependencies, leading to duplicate installations and version conflicts
- **Need a "real" install** — Sometimes you need to test how your package actually behaves when installed (not symlinked), but you don't want to publish it to a registry

`lpck` solves all of this by creating actual `.tgz` packages (via `npm pack`) and installing them locally.

## Installation

```bash
# Install from the github repository
npm install -g https://github.com/alschussler/lpck.git --install-links
```

## Usage

### Basic Usage

```bash
cd /path/to/your/target/project
lpck /path/to/source/workspace
```

**Example:**

```bash
# You're working on a project that depends on packages from your local monorepo
cd ~/projects/my-app

# Install packages from your local workspace
lpck ~/projects/my-component-library
```

### Using Presets

Presets let you save frequently used workspace paths and optional prepack scripts. Configuration is stored in `~/.lpck/.lpckrc`.

```bash
# Initialize the config file
lpck --init

# Use a preset
lpck -p my-preset
lpck --preset my-preset

# Use a preset but skip the prepack script
lpck -p my-preset --noPrepack

# List all presets
lpck --printPresets
```

### CLI Options

| Option | Short | Description |
|--------|-------|-------------|
| `--help` | `-h` | Show help information |
| `--preset <name>` | `-p` | Use a saved preset |
| `--printPresets` | | Print all configured presets |
| `--init` | | Initialize the `.lpckrc` config file |
| `--noPrepack` | | Skip the prepack script when using a preset |

## Configuration

The configuration file is located at `~/.lpck/.lpckrc` and uses JSON format:

```json
{
  "presets": [
    {
      "name": "my-preset",
      "path": "/path/to/workspace",
      "prepack": "npm run build"
    }
  ]
}
```

### Preset Options

| Field | Description |
|-------|-------------|
| `name` | The preset identifier used with `-p` |
| `path` | Absolute path to the workspace root |
| `prepack` | Command to run before packing (e.g., build script) |

## How It Works

`lpck` performs the following steps:

1. **Maps workspaces** — Scans the source directory and discovers all workspace packages
2. **Runs prepack** — If using a preset with a prepack script, executes it first
3. **Updates internal dependencies** — Temporarily rewrites workspace package dependencies to point to their packed `.tgz` files (so inter-workspace dependencies resolve correctly)
4. **Packs all workspaces** — Runs `npm pack --workspaces` to create `.tgz` archives for every workspace package
5. **Restores original dependencies** — Reverts the temporary dependency changes in the source workspace
6. **Installs into target** — Identifies which packed packages are dependencies of your target project and installs them
7. **Cleans up** — Removes the temporary `.tgz` files

Packed files are temporarily stored in `~/.lpck/packs/` and cleaned up after installation.

## Key Features

- ✅ **Full workspace support** — Properly handles npm workspaces and monorepos
- ✅ **Dependency hoisting** — Shared dependencies are correctly hoisted
- ✅ **Real installation** — Packages are installed as they would be from npm
- ✅ **Non-destructive** — Source workspace is restored to original state after packing
- ✅ **Selective installation** — Only installs packages that are actual dependencies of your target project
- ✅ **Presets** — Save frequently used workspaces with optional build commands
- ✅ **Prepack scripts** — Automatically build packages before packing

## Notes

- The source directory should be the **root** of an npm workspace (the directory containing the root `package.json` with a `workspaces` field)
- Your target project's `package.json` should already list the workspace packages as dependencies

## License

ISC
