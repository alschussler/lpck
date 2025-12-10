#!/usr/bin/env node
import mapWorkspaces from "@npmcli/map-workspaces";
import PackageJson from "@npmcli/package-json";

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

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

const LPCK_DIR = path.join(process.cwd(), '.lpck');

async function pack(packageDir: string) {
  if (!existsSync(LPCK_DIR)) {
    mkdirSync(LPCK_DIR);
  }

  await new Promise<void>((resolve, reject) => {
    console.log(dim('Packing...'), dim(`npm pack --pack-destination ${LPCK_DIR} --workspaces`));

    const p = spawn("npm", ["pack", '--pack-destination', LPCK_DIR, '--workspaces' ], { stdio: ["ignore", "ignore", "inherit"], cwd: packageDir });
    p.on("exit", (code) => (code === 0 ? resolve() : reject(code)));
  });
}

async function install(targetPackageDir: string, dependenciesToInstall: string[]) {
  console.log(dim('Installing dependencies...'), dim(`npm install ${dependenciesToInstall.join(' ')}`));
  
  await new Promise<void>((resolve, reject) => {
    const p = spawn("npm", ["install", ...dependenciesToInstall ], { stdio: ["ignore", "ignore", "inherit"], cwd: targetPackageDir });
    p.on("exit", (code) => (code === 0 ? resolve() : reject(code)));
  });
}

async function getPackageJson(packageDir: string) {
  const packageJson = await new PackageJson().load(packageDir);
  return packageJson;
}

async function getPackName(packageJson: PackageJson) {
  return `${packageJson.content.name}-${packageJson.content.version}.tgz`.replace(/@/g, '').replace(/\//g, '-');
}

type WorkspaceInfo = {
  packageJson: PackageJson;
  packName: string;
  oldDependencies: PackageJson.Content['dependencies'];
}

type AvailablePackage = {
  name: string;
  packName: string;
}

class OriginPackage {
  #originPackageDir: string;

  #originPackage: PackageJson;

  #workspacesInfos =  new Map<string, WorkspaceInfo>();

  constructor(originPackageDir: string) {
    this.#originPackageDir = originPackageDir;
  }

  async load() {
    console.info('Loading origin package...');
    this.#originPackage = await getPackageJson(this.#originPackageDir);

    console.info('Origin package root loaded: ', bold(this.#originPackage.content.name));
    console.info('Loading workspaces...');

    const map = await mapWorkspaces({ pkg: this.#originPackage.content, cwd: this.#originPackageDir });

    console.info('Workspaces loaded: ', dim(String(map.size)));

    for (const [key, value] of map.entries()) {
      const packageJson = await getPackageJson(value);
      this.#workspacesInfos.set(key, {
        packageJson,
        packName: await getPackName(packageJson),
        oldDependencies: structuredClone(packageJson.content.dependencies ?? {}),
      });
    }
  }

  getAvailablePackages(): AvailablePackage[] {
    return Array.from(this.#workspacesInfos.values()).map((workspaceInfo) => ({
      name: workspaceInfo.packageJson.content.name,
      packName: workspaceInfo.packName,
    }));
  }

  async pack() {
    await pack(this.#originPackageDir);
  }

  async updateDependencies() {
    console.info('Updating workspaces dependencies to locally packed packages...');

    for (const workspaceInfo of this.#workspacesInfos.values()) {
      const workspacePackageJson = workspaceInfo.packageJson;
      if (!workspacePackageJson.content.dependencies) {
        continue;
      }
  
      const newDependencies = structuredClone(workspacePackageJson.content.dependencies);
  
      for (const dependencyName of Object.keys(newDependencies)) {
        if (this.#workspacesInfos.has(dependencyName)) {
          newDependencies[dependencyName] = path.join(LPCK_DIR, this.#workspacesInfos.get(dependencyName)!.packName);
        }
      }
  
      // @ts-expect-error -- Wrong type definition
      await workspacePackageJson.update({ dependencies: newDependencies }).save({ sort: false });
      console.info('Workspace dependency updated: ', bold(workspacePackageJson.content.name));
    }
  }

  async restoreDependencies() {
    console.info('Restoring workspaces dependencies to original dependencies...');
    
    for (const workspaceInfo of this.#workspacesInfos.values()) {
      console.info('Restoring: ', bold(workspaceInfo.packageJson.content.name));
      // @ts-expect-error -- Wrong type definition
      await workspaceInfo.packageJson.update({ dependencies: workspaceInfo.oldDependencies }).save({ sort: false });
    }

    console.info('Workspaces dependencies restored to original dependencies');
  }
}

class TargetPackage {
  #targetPackageDir: string;

  #targetPackage: PackageJson;

  constructor(targetPackageDir: string) {
    this.#targetPackageDir = targetPackageDir;
  }

  async load() {
    console.info('Loading target package...');
    this.#targetPackage = await getPackageJson(this.#targetPackageDir);
    console.info('Target package loaded: ', bold(this.#targetPackage.content.name));
  }

  async install(availablePackages: AvailablePackage[]) {
    console.info('Installing dependencies...');

    const dependencies = this.#targetPackage.content.dependencies;
    if (!dependencies) {
      console.info('No dependencies found in target package');
      return;
    }

    const dependencyNames = Object.keys(dependencies);

    const dependenciesToInstal = availablePackages.filter(availablePackage => dependencyNames.includes(availablePackage.name));
    const packDirs = dependenciesToInstal.map(availablePackage => path.join(LPCK_DIR, availablePackage.packName));

    if (dependenciesToInstal.length === 0) {
      console.info('No dependencies to install found in target package');
      return;
    }

    console.info(`Installing dependencies: \n\t- ${dependenciesToInstal.map(d => bold(d.name)).join('\n\t- ')}`);

    await install(this.#targetPackageDir, packDirs);

    console.info('Dependencies installed');
  }
  
}

const args = process.argv.slice(2);
const [packageToInstallDir] = args;

if (!packageToInstallDir || packageToInstallDir.trim().startsWith('-')) {
  console.error("Provide the directory to the root of the workspace you want to install (", code("npx lpck <workspace-root-package-dir>"), ")");
  process.exit(1);
}

const targetPackage = new TargetPackage(process.cwd());
const originPackage = new OriginPackage(packageToInstallDir);
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
await targetPackage.install(originPackage.getAvailablePackages());

console.info(green('Done'));

