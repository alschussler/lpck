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
# Run directly with npx (recommended)
npx lpck <source-package-dir>

# Or install globally
npm install -g lpck
```

## Usage

```bash
cd /path/to/your/target/project
npx lpck /path/to/source/workspace
```

**Example:**

```bash
# You're working on a project that depends on packages from your local monorepo
cd ~/projects/my-app

# Install packages from your local workspace
npx lpck ~/projects/my-component-library
```

## How It Works

`lpck` performs the following steps:

1. **Maps workspaces** — Scans the source directory and discovers all workspace packages
2. **Updates internal dependencies** — Temporarily rewrites workspace package dependencies to point to their packed `.tgz` files (so inter-workspace dependencies resolve correctly)
3. **Packs all workspaces** — Runs `npm pack --workspaces` to create `.tgz` archives for every workspace package
4. **Restores original dependencies** — Reverts the temporary dependency changes in the source workspace
5. **Installs into target** — Identifies which packed packages are dependencies of your target project and installs them

All packed files are stored in a `.lpck` directory in your target project.

## Directory Structure

After running `lpck`, you'll see:

```
your-target-project/
├── .lpck/                          # Created by lpck
│   ├── my-package-1.0.0.tgz
│   ├── my-other-package-2.0.0.tgz
│   └── ...
├── node_modules/
├── package.json                    # Dependencies updated to point to .tgz files
└── ...
```

## Key Features

- ✅ **Full workspace support** — Properly handles npm workspaces and monorepos
- ✅ **Dependency hoisting** — Shared dependencies are correctly hoisted
- ✅ **Real installation** — Packages are installed as they would be from npm
- ✅ **Non-destructive** — Source workspace is restored to original state after packing
- ✅ **Selective installation** — Only installs packages that are actual dependencies of your target project

## Notes

- The source directory should be the **root** of an npm workspace (the directory containing the root `package.json` with a `workspaces` field)
- Your target project's `package.json` should already list the workspace packages as dependencies
- The `.lpck` directory can be added to `.gitignore`

## License

ISC
