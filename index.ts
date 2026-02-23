#!/usr/bin/env node
import mapWorkspaces from "@npmcli/map-workspaces";
import PackageJson from "@npmcli/package-json";

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rm,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";

function bold(str: string) {
  return `\x1b[1m${str}\x1b[0m`;
}

function green(str: string) {
  return `\x1b[32m${str}\x1b[0m`;
}

function red(str: string) {
  return `\x1b[31m${str}\x1b[0m`;
}

function dim(str: string) {
  return `\x1b[2m${str}\x1b[0m`;
}

function code(str: string) {
  return `\x1b[33m${str}\x1b[0m`;
}

type LpckRC = {
  presets: {
    name: string;
    path: string;
    prepack: string;
  }[];
};

const homeDir = os.homedir();
const LPCK_DIR = path.join(homeDir, ".lpck");
const LPCK_PACK_DIR = path.join(LPCK_DIR, "packs");
const LPCK_RC_PATH = path.join(LPCK_DIR, ".lpckrc");

async function pack(packageDir: string) {
  if (!existsSync(LPCK_PACK_DIR)) {
    mkdirSync(LPCK_PACK_DIR, { recursive: true });
  }

  await new Promise<void>((resolve, reject) => {
    console.log(
      dim("Packing..."),
      dim(`npm pack --pack-destination ${LPCK_PACK_DIR} --workspaces`),
    );

    const p = spawn(
      "npm",
      ["pack", "--pack-destination", LPCK_PACK_DIR, "--workspaces"],
      { stdio: ["ignore", "ignore", "inherit"], cwd: packageDir },
    );
    p.on("exit", (code) => (code === 0 ? resolve() : reject(code)));
  });
}

async function installAllPacks(packageDir: string, rawInstall?: boolean) {
  if (!existsSync(LPCK_PACK_DIR)) {
    return;
  }
  const files = readdirSync(LPCK_PACK_DIR);
  const tgzPaths = files
    .filter((f) => f.endsWith(".tgz"))
    .map((f) => path.join(LPCK_PACK_DIR, f));

  if (tgzPaths.length === 0) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const p = spawn(
      "npm",
      ["install", ...(rawInstall ? [] : tgzPaths), "--no-save"],
      {
        stdio: "inherit",
        cwd: packageDir,
      },
    );

    console.log(code(p.spawnargs.join(" ")));
    p.on("exit", (code) => (code === 0 ? resolve() : reject(code)));
  });
}

async function prepack(script: string, cwd: string) {
  console.info("Executing prepack script...", dim(script));

  const [command, ...args] = script.split(" ");

  await new Promise<void>((resolve, reject) => {
    const p = spawn(command, args, {
      stdio: ["ignore", "ignore", "inherit"],
      cwd,
    });
    p.on("exit", (code) => (code === 0 ? resolve() : reject(code)));
  });
}

async function getPackageJson(packageDir: string) {
  const packageJson = await new PackageJson().load(packageDir);
  return packageJson;
}

function getPackName(packageJson: PackageJson) {
  return `${packageJson.content.name}-${packageJson.content.version}.tgz`
    .replace(/@/g, "")
    .replace(/\//g, "-");
}

function getPackDir(packName: string) {
  return path.join(LPCK_PACK_DIR, packName);
}

type DepsMap = PackageJson.Content["dependencies"];

type WorkspaceInfo = {
  packageJson: PackageJson;
  packName: string;
  oldDependencies: DepsMap;
  oldDevDependencies: DepsMap;
  oldPeerDependencies: DepsMap;
};

type AvailablePackage = {
  name: string;
  packName: string;
};

class WorkspaceHandler {
  #rootDir: string;

  #packagesInfos = new Map<string, WorkspaceInfo>();

  #rootPackage: PackageJson;

  #isWorkspace = false;

  constructor(rootDir: string) {
    this.#rootDir = rootDir;
  }

  async load(includeWorkspaceRoot = true) {
    this.#rootPackage = await getPackageJson(this.#rootDir);

    const map = await mapWorkspaces({
      pkg: this.#rootPackage.content,
      cwd: this.#rootDir,
    });

    for (const [key, value] of map.entries()) {
      const packageJson = await getPackageJson(value);
      this.#packagesInfos.set(key, {
        packageJson,
        packName: getPackName(packageJson),
        oldDependencies: structuredClone(
          packageJson.content.dependencies ?? {},
        ),
        oldDevDependencies: structuredClone(
          packageJson.content.devDependencies ?? {},
        ),
        oldPeerDependencies: structuredClone(
          packageJson.content.peerDependencies ?? {},
        ),
      });
    }

    this.#isWorkspace = map.size > 0;

    if (includeWorkspaceRoot) {
      this.#packagesInfos.set(this.#rootPackage.content.name, {
        packageJson: this.#rootPackage,
        packName: getPackName(this.#rootPackage),
        oldDependencies: structuredClone(
          this.#rootPackage.content.dependencies ?? {},
        ),
        oldDevDependencies: structuredClone(
          this.#rootPackage.content.devDependencies ?? {},
        ),
        oldPeerDependencies: structuredClone(
          this.#rootPackage.content.peerDependencies ?? {},
        ),
      });
    }
  }

  isWorkspace(): boolean {
    return this.#isWorkspace;
  }

  getPackages(): PackageJson[] {
    return Array.from(this.#packagesInfos.values()).map(
      (packageInfo) => packageInfo.packageJson,
    );
  }

  getRootPackage(): PackageJson {
    return this.#rootPackage;
  }

  getRootDir(): string {
    return this.#rootDir;
  }

  async updateToLocalPacks(availablePackages?: AvailablePackage[]) {
    const availableDependencies: AvailablePackage[] = availablePackages
      ? availablePackages
      : Array.from(this.#packagesInfos.values()).map((pck) => ({
          name: pck.packageJson.content.name,
          packName: getPackName(pck.packageJson),
        }));

    const used = [];

    for (const packageInfo of this.#packagesInfos.values()) {
      const workspacePackageJson = packageInfo.packageJson;
      const content = workspacePackageJson.content;
      let changed = false;

      for (const depType of [
        "dependencies",
        "devDependencies",
        "peerDependencies",
      ] as const) {
        const deps = content[depType];
        if (!deps) continue;

        const newDeps = structuredClone(deps);
        for (const dependencyName of Object.keys(newDeps)) {
          if (
            availableDependencies.some((pck) => pck.name === dependencyName)
          ) {
            const depToUse = availableDependencies.find(
              (pck) => pck.name === dependencyName,
            )!;
            used.push(depToUse.name);
            newDeps[dependencyName] = getPackDir(depToUse.packName);
            changed = true;
          }
        }
        content[depType] = newDeps;
      }

      if (changed) {
        await workspacePackageJson.save();
      }

      return used;
    }
  }

  async restore() {
    for (const packageInfo of this.#packagesInfos.values()) {
      const content = packageInfo.packageJson.content;

      let changed = false;
      if (Object.keys(packageInfo.oldDependencies).length > 0) {
        content.dependencies = packageInfo.oldDependencies;
        changed = true;
      }
      if (Object.keys(packageInfo.oldDevDependencies).length > 0) {
        content.devDependencies = packageInfo.oldDevDependencies;
        changed = true;
      }
      if (Object.keys(packageInfo.oldPeerDependencies).length > 0) {
        content.peerDependencies = packageInfo.oldPeerDependencies;
        changed = true;
      }

      if (changed) {
        await packageInfo.packageJson.save();
      }
    }
  }

  async pack() {
    await pack(this.#rootDir);
  }
}

class OriginWorkspace {
  #workspaceHandler: WorkspaceHandler;

  constructor(originPackageDir: string) {
    this.#workspaceHandler = new WorkspaceHandler(originPackageDir);
  }

  async load() {
    console.info("Loading origin package...");

    await this.#workspaceHandler.load(false);

    const rootPackage = this.#workspaceHandler.getRootPackage();

    console.info(
      "Origin package root loaded: ",
      bold(rootPackage.content.name),
    );
    console.info("Loading workspaces...");

    console.info(
      "Workspaces loaded: ",
      dim(String(this.#workspaceHandler.getPackages().length)),
    );
  }

  getAvailablePackages(): AvailablePackage[] {
    return this.#workspaceHandler.getPackages().map((packageJson) => ({
      name: packageJson.content.name,
      packName: getPackName(packageJson),
    }));
  }

  async pack() {
    await this.#workspaceHandler.pack();
  }

  async updateDependencies() {
    console.info(
      "Updating workspaces dependencies to locally packed packages...",
    );

    await this.#workspaceHandler.updateToLocalPacks();
  }

  async restoreDependencies() {
    console.info(
      "Restoring workspaces dependencies to original dependencies...",
    );

    await this.#workspaceHandler.restore();

    console.info("Workspaces dependencies restored to original dependencies");
  }
}

class TargetWorkspace {
  #workspaceHandler: WorkspaceHandler;

  constructor(targetPackageDir: string) {
    this.#workspaceHandler = new WorkspaceHandler(targetPackageDir);
  }

  async load() {
    console.info("Loading target package...");

    await this.#workspaceHandler.load();

    const rootPackage = this.#workspaceHandler.getRootPackage();

    console.info("Target package loaded: ", bold(rootPackage.content.name));
  }

  async install(availablePackages: AvailablePackage[], rawInstall: boolean) {
    await this.#workspaceHandler.updateToLocalPacks(availablePackages);

    await installAllPacks(this.#workspaceHandler.getRootDir(), rawInstall);

    console.info("Dependencies installed");
  }
}

const ARGS_OPTIONS = {
  preset: {
    type: "string",
    short: "p",
  },
  help: {
    type: "boolean",
    short: "h",
    default: false,
  },
  printPresets: {
    type: "boolean",
    default: false,
  },
  init: {
    type: "boolean",
    default: false,
  },
  noPrepack: {
    type: "boolean",
    default: false,
  },
  rawInstall: {
    type: "boolean",
    default: false,
  },
} satisfies ParseArgsOptionsConfig;

type Command = keyof typeof ARGS_OPTIONS | "install";

type ExecutionArgs = {
  command: Command;
  path?: string;
  noPrepack?: boolean;
  rawInstall?: boolean;
};

class LPCK {
  #lpckRc: LpckRC;

  #args: ExecutionArgs;

  constructor() {
    this.#loadRC();
    this.#loadArgs(process.argv.slice(2));
    this.#createRequiredFolders();
  }

  #createRequiredFolders() {
    if (!existsSync(LPCK_PACK_DIR)) {
      mkdirSync(LPCK_PACK_DIR, { recursive: true });
    }
  }

  #loadRC() {
    if (!existsSync(LPCK_RC_PATH)) {
      this.#lpckRc = { presets: [] };
      return;
    }

    this.#lpckRc = JSON.parse(readFileSync(LPCK_RC_PATH, "utf8")) as LpckRC;
  }

  #loadArgs(args: string[]) {
    const parsedArgs = parseArgs({
      args,
      options: ARGS_OPTIONS,
      allowPositionals: true,
      strict: true,
    });

    const { preset, printPresets, init, noPrepack, rawInstall } =
      parsedArgs.values;
    const hasPositionals = parsedArgs.positionals.length === 1;

    if (preset) {
      this.#args = {
        command: "preset",
        path: preset,
        noPrepack,
      };

      return;
    }

    if (printPresets) {
      this.#args = {
        command: "printPresets",
      };

      return;
    }

    if (init) {
      this.#args = {
        command: "init",
      };

      return;
    }

    if (hasPositionals) {
      this.#args = {
        command: "install",
        path: parsedArgs.positionals[0],
        rawInstall,
      };

      return;
    }

    this.#args = {
      command: "help",
    };
  }

  #cleanUpPacks() {
    if (existsSync(LPCK_PACK_DIR)) {
      console.info("Cleaning up packs...");
      rmSync(LPCK_PACK_DIR, { recursive: true });
    }
  }

  #help() {
    console.info(
      "Usage:",
      code("lpck <workspace-root-package-dir>"),
      "or",
      code("lpck [options]"),
    );
    console.info("Options:");
    console.info("  -h, --help: Show this help");
    console.info("  -p, --preset: The preset to use");
    console.info("  --printPresets: Print the presets");
    console.info("  --init: Initialize the LPCK RC");
    console.info("  --noPrepack: Do not execute the prepack script");
    console.info(
      "  --rawInstall: Run install without specifying the packages to install",
    );
  }

  #printPresets() {
    if (this.#lpckRc.presets.length === 0) {
      console.info("No presets found at: ", LPCK_RC_PATH);
      return;
    }

    console.info(
      code(LPCK_RC_PATH),
      ": ",
      JSON.stringify(this.#lpckRc, null, 2),
    );
  }

  #initRC() {
    console.info("Initializing LPCK RC...");

    if (existsSync(LPCK_RC_PATH)) {
      console.error("LPCK RC already exists at: ", LPCK_RC_PATH);
      process.exit(1);
      return;
    }

    const mockRc: LpckRC = {
      presets: [
        {
          name: "<preset-name>",
          path: "<preset-path>",
          prepack: "<prepack-script>",
        },
      ],
    };

    writeFileSync(LPCK_RC_PATH, JSON.stringify(mockRc, null, 2));
    console.info("LPCK RC initialized at: ", LPCK_RC_PATH);
  }

  async #install(originPackageDir: string) {
    const targetPackage = new TargetWorkspace(process.cwd());
    const originPackage = new OriginWorkspace(originPackageDir);
    await originPackage.load();

    try {
      await originPackage.updateDependencies();
      await originPackage.pack();
    } catch (error) {
      console.error(red(String(error)));
    } finally {
      await originPackage.restoreDependencies();
    }

    await targetPackage.load();
    await targetPackage.install(
      originPackage.getAvailablePackages(),
      this.#args.rawInstall,
    );

    this.#cleanUpPacks();
    console.info(green("Done"));
  }

  async #preset(name: string) {
    console.info("Loading preset: ", code(name));

    const preset = this.#lpckRc.presets.find((preset) => preset.name === name);

    if (!preset) {
      console.error("Preset ", code(name), " not found");
      process.exit(1);
      return;
    }

    if (preset.prepack && !this.#args.noPrepack) {
      await prepack(preset.prepack, preset.path);
    }

    await this.#install(preset.path);
  }

  async run() {
    switch (this.#args.command) {
      case "install":
        await this.#install(this.#args.path!);
        break;
      case "preset":
        await this.#preset(this.#args.path!);
        break;
      case "printPresets":
        this.#printPresets();
        break;
      case "help":
        this.#help();
        break;
      case "init":
        this.#initRC();
        break;
      default:
        this.#help();
        break;
    }
  }
}

await new LPCK().run();
