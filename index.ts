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
import { parseArgs, type ParseArgsOptionDescriptor } from "node:util";

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

type CliArgDescription = ParseArgsOptionDescriptor & {
  description: string;
};

type CliArgs = Record<string, CliArgDescription>;

type LpckRC = {
  presets: {
    name: string;
    path: string;
    prepack?: string;
  }[];
};

const homeDir = os.homedir();
const LPCK_DIR = path.join(homeDir, ".lpck");
const LPCK_PACK_DIR = path.join(LPCK_DIR, "packs");
const LPCK_RC_PATH = path.join(LPCK_DIR, ".lpckrc");

function getPackageName(packageJson: PackageJson) {
  return packageJson.content.name ?? "<NO-NAME>";
}

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
      { stdio: ["ignore", "ignore", "ignore"], cwd: packageDir },
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
  return `${getPackageName(packageJson)}-${packageJson.content.version}.tgz`
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

type UpdateToLocalPacksOptions = {
  dev?: boolean;
  peer?: boolean;
};

class WorkspaceHandler {
  #rootDir: string;

  #packagesInfos = new Map<string, WorkspaceInfo>();

  #rootPackage: PackageJson | null = null;

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
      this.#packagesInfos.set(getPackageName(this.#rootPackage), {
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
    if (!this.#rootPackage) {
      throw new Error("Root package not loaded");
    }
    
    return this.#rootPackage;
  }

  getRootDir(): string {
    return this.#rootDir;
  }

  async updateToLocalPacks(
    availablePackages?: AvailablePackage[],
    options?: UpdateToLocalPacksOptions,
  ) {
    const depTypes = ["dependencies"];
    if (options?.dev) {
      depTypes.push("devDependencies");
    }
    if (options?.peer) {
      depTypes.push("peerDependencies");
    }

    const availableDependencies: AvailablePackage[] = availablePackages
      ? availablePackages
      : Array.from(this.#packagesInfos.values()).map((pck) => ({
          name: getPackageName(pck.packageJson),
          packName: getPackName(pck.packageJson),
        })) as AvailablePackage[];

    const used = [];

    for (const packageInfo of this.#packagesInfos.values()) {
      const workspacePackageJson = packageInfo.packageJson;
      const content = workspacePackageJson.content;
      let changed = false;

      for (const depType of depTypes) {
        const deps = content[depType];
        if (!deps) {
          continue;
        }

        const newDeps = structuredClone<Record<string, string>>(deps as Record<string, string>);
        for (const dependencyName of Object.keys(newDeps)) {
          const depToUse = availableDependencies.find(
            (pck) => pck.name === dependencyName,
          );

          if (depToUse) {
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
    }

    return used;
  }

  async restore() {
    for (const packageInfo of this.#packagesInfos.values()) {
      const content = packageInfo.packageJson.content;

      let changed = false;
      if (Object.keys(packageInfo.oldDependencies ?? {}).length > 0) {
        content.dependencies = packageInfo.oldDependencies;
        changed = true;
      }
      if (Object.keys(packageInfo.oldDevDependencies ?? {}).length > 0) {
        content.devDependencies = packageInfo.oldDevDependencies;
        changed = true;
      }
      if (Object.keys(packageInfo.oldPeerDependencies ?? {}).length > 0) {
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
      bold(getPackageName(rootPackage)),
    );
    console.info("Loading workspaces...");

    console.info(
      "Workspaces loaded: ",
      dim(String(this.#workspaceHandler.getPackages().length)),
    );
  }

  getAvailablePackages(): AvailablePackage[] {
    return this.#workspaceHandler.getPackages().map((packageJson) => ({
      name: getPackageName(packageJson),
      packName: getPackName(packageJson),
    }));
  }

  async pack() {
    await this.#workspaceHandler.pack();
  }

  async updateDependencies(options?: UpdateToLocalPacksOptions) {
    console.info(
      "Updating workspaces dependencies to locally packed packages...",
    );

    await this.#workspaceHandler.updateToLocalPacks(undefined, options);
  }

  async restoreDependencies() {
    console.info(
      "Restoring workspaces dependencies to original dependencies...",
    );

    await this.#workspaceHandler.restore();

    console.info("Workspaces dependencies restored to original dependencies");
  }
}

type InstallOptions = {
  rawInstall?: boolean;
} & UpdateToLocalPacksOptions;

class TargetWorkspace {
  #workspaceHandler: WorkspaceHandler;

  constructor(targetPackageDir: string) {
    this.#workspaceHandler = new WorkspaceHandler(targetPackageDir);
  }

  async load() {
    console.info("Loading target package...");

    await this.#workspaceHandler.load();

    const rootPackage = this.#workspaceHandler.getRootPackage();

    console.info("Target package loaded: ", bold(getPackageName(rootPackage)));
  }

  async install(
    availablePackages: AvailablePackage[],
    options: InstallOptions,
  ) {
    await this.#workspaceHandler.updateToLocalPacks(availablePackages, options);

    await installAllPacks(
      this.#workspaceHandler.getRootDir(),
      options.rawInstall,
    );

    console.info("Dependencies installed");
  }
}

const ARGS_OPTIONS = {
  preset: {
    type: "string",
    short: "p",
    description: "Use a saved preset",
  },
  help: {
    type: "boolean",
    short: "h",
    default: false,
    description: "Show this help",
  },
  printPresets: {
    type: "boolean",
    default: false,
    description: "Print all configured presets",
  },
  init: {
    type: "boolean",
    default: false,
    description: "Initialize the .lpckrc config file",
  },
  prepack: {
    type: "boolean",
    default: false,
    description: "Run the preset's prepack script before packing",
  },
  dev: {
    type: "boolean",
    default: false,
    description: "Also update and install devDependencies to local packs",
  },
  peer: {
    type: "boolean",
    default: false,
    description: "Also update and install peerDependencies to local packs",
  },
  rawInstall: {
    type: "boolean",
    default: false,
    description: "Run npm install without passing pack paths",
  },
  clean: {
    type: "boolean",
    default: false,
    description: "Remove all packed .tgz files from ~/.lpck/packs/",
  },
  addPreset: {
    type: "boolean",
    default: false,
    description: "Create or update a preset by name and path",
  },
  prepackCmd: {
    type: "string",
    description: "Optional prepack command used with --addPreset",
  },
} satisfies CliArgs;

type Command = keyof typeof ARGS_OPTIONS | "install";

type ExecutionArgs = {
  command: Command;
  name?: string;
  path?: string;
  prepack?: boolean;
  prepackCmd?: string;
  dev?: boolean;
  peer?: boolean;
  rawInstall?: boolean;
};

class LPCK {
  #lpckRc: LpckRC = { presets: [] };

  #args: ExecutionArgs = { command: "help" };

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
      allowNegative: true,
    });

    const {
      preset,
      printPresets,
      init,
      prepack,
      prepackCmd,
      rawInstall,
      dev,
      peer,
      clean,
      addPreset,
    } =
      parsedArgs.values;
    const hasInstallPositional = !addPreset && parsedArgs.positionals.length === 1;

    if (preset) {
      this.#args = {
        command: "preset",
        path: preset,
        rawInstall,
        prepack,
        dev,
        peer,
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

    if (clean) {
      this.#args = {
        command: "clean",
      };

      return;
    }

    if (addPreset) {
      this.#args = {
        command: "addPreset",
        name: parsedArgs.positionals[0],
        path: parsedArgs.positionals[1],
        prepackCmd,
      };

      return;
    }

    if (hasInstallPositional) {
      this.#args = {
        command: "install",
        path: parsedArgs.positionals[0],
        rawInstall,
        dev,
        peer,
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
    for (const [key, value] of Object.entries(ARGS_OPTIONS) as [string, CliArgDescription][]) {
      const flag = `${value.short ? `-${value.short}, ` : ""}--${key}`;
      console.info(`  ${flag}: ${value.description}`);
    }
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

  async #validatePresetPath(presetPath: string) {
    try {
      const packageJson = await getPackageJson(presetPath);
      const packageContent = packageJson.content;
      const hasWorkspaces = Boolean(packageContent.workspaces);
      const hasPackageName = Boolean(packageContent.name);
      const hasPackageVersion = Boolean(packageContent.version);
      return hasWorkspaces || (hasPackageName && hasPackageVersion);
    } catch {
      return false;
    }
  }

  async #addPreset(name?: string, presetPath?: string) {
    if (!name) {
      console.error("Missing preset name. Usage:", code("lpck --addPreset <name> <path>"));
      process.exit(1);
    }

    if (!presetPath) {
      console.error("Missing preset path. Usage:", code("lpck --addPreset <name> <path>"));
      process.exit(1);
    }

    const resolvedPath = path.resolve(presetPath);

    if (!existsSync(resolvedPath)) {
      console.error("Preset path does not exist:", code(resolvedPath));
      process.exit(1);
    }

    const isValidPresetPath = await this.#validatePresetPath(resolvedPath);

    if (!isValidPresetPath) {
      console.error(
        "Preset path must contain a package.json with name and version, or a workspace root with workspaces:",
        code(resolvedPath),
      );
      process.exit(1);
    }

    const presetIndex = this.#lpckRc.presets.findIndex(
      (preset) => preset.name === name,
    );

    const presetToSave = {
      name,
      path: resolvedPath,
      ...(this.#args.prepackCmd ? { prepack: this.#args.prepackCmd } : {}),
    };

    if (presetIndex >= 0) {
      this.#lpckRc.presets[presetIndex] = presetToSave;
    } else {
      this.#lpckRc.presets.push(presetToSave);
    }

    writeFileSync(LPCK_RC_PATH, JSON.stringify(this.#lpckRc, null, 2));

    console.info(
      presetIndex >= 0 ? "Preset updated:" : "Preset added:",
      code(name),
    );
  }

  async #install(originPackageDir: string) {
    const targetPackage = new TargetWorkspace(process.cwd());
    const originPackage = new OriginWorkspace(originPackageDir);
    await originPackage.load();

    try {
      await originPackage.updateDependencies({
        dev: this.#args.dev,
        peer: this.#args.peer,
      });
      await originPackage.pack();
    } catch (error) {
      console.error(red(String(error)));
    } finally {
      await originPackage.restoreDependencies();
    }

    await targetPackage.load();
    await targetPackage.install(originPackage.getAvailablePackages(), {
      dev: this.#args.dev,
      peer: this.#args.peer,
      rawInstall: this.#args.rawInstall,
    });

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

    if (preset.prepack && this.#args.prepack) {
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
      case "clean":
        this.#cleanUpPacks();
        break;
      case "addPreset":
        await this.#addPreset(this.#args.name, this.#args.path);
        break;
      default:
        this.#help();
        break;
    }
  }
}

await new LPCK().run();
