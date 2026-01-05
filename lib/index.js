#!/usr/bin/env node
import mapWorkspaces from "@npmcli/map-workspaces";
import PackageJson from "@npmcli/package-json";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rm, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from 'node:os';
import { parseArgs } from "node:util";
function bold(str) {
    return `\x1b[1m${str}\x1b[0m`;
}
function green(str) {
    return `\x1b[32m${str}\x1b[0m`;
}
function red(str) {
    return `\x1b[31m${str}\x1b[0m`;
}
function dim(str) {
    return `\x1b[2m${str}\x1b[0m`;
}
function code(str) {
    return `\x1b[33m${str}\x1b[0m`;
}
const homeDir = os.homedir();
const LPCK_DIR = path.join(homeDir, '.lpck');
const LPCK_PACK_DIR = path.join(LPCK_DIR, 'packs');
const LPCK_RC_PATH = path.join(LPCK_DIR, '.lpckrc');
async function pack(packageDir) {
    if (!existsSync(LPCK_PACK_DIR)) {
        mkdirSync(LPCK_PACK_DIR, { recursive: true });
    }
    await new Promise((resolve, reject) => {
        console.log(dim('Packing...'), dim(`npm pack --pack-destination ${LPCK_PACK_DIR} --workspaces`));
        const p = spawn("npm", ["pack", '--pack-destination', LPCK_PACK_DIR, '--workspaces'], { stdio: ["ignore", "ignore", "inherit"], cwd: packageDir });
        p.on("exit", (code) => (code === 0 ? resolve() : reject(code)));
    });
}
async function install(targetPackageDir, dependenciesToInstall) {
    console.log(dim('Installing dependencies...'), dim(`npm install ${dependenciesToInstall.join(' ')}`));
    await new Promise((resolve, reject) => {
        const p = spawn("npm", ["install", ...dependenciesToInstall], { stdio: ["ignore", "ignore", "inherit"], cwd: targetPackageDir });
        p.on("exit", (code) => (code === 0 ? resolve() : reject(code)));
    });
}
async function prepack(script, cwd) {
    console.info('Executing prepack script...', dim(script));
    const [command, ...args] = script.split(' ');
    await new Promise((resolve, reject) => {
        const p = spawn(command, args, { stdio: ["ignore", "ignore", "inherit"], cwd });
        p.on("exit", (code) => (code === 0 ? resolve() : reject(code)));
    });
}
async function getPackageJson(packageDir) {
    const packageJson = await new PackageJson().load(packageDir);
    return packageJson;
}
async function getPackName(packageJson) {
    return `${packageJson.content.name}-${packageJson.content.version}.tgz`.replace(/@/g, '').replace(/\//g, '-');
}
function getPackDir(packName) {
    return path.join(LPCK_PACK_DIR, packName);
}
class OriginPackage {
    #originPackageDir;
    #originPackage;
    #workspacesInfos = new Map();
    constructor(originPackageDir) {
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
    getAvailablePackages() {
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
                    newDependencies[dependencyName] = getPackDir(this.#workspacesInfos.get(dependencyName).packName);
                }
            }
            workspacePackageJson.content.dependencies = newDependencies;
            await workspacePackageJson.save();
            console.info('Workspace dependency updated: ', bold(workspacePackageJson.content.name));
        }
    }
    async restoreDependencies() {
        console.info('Restoring workspaces dependencies to original dependencies...');
        for (const workspaceInfo of this.#workspacesInfos.values()) {
            if (Object.keys(workspaceInfo.oldDependencies).length === 0) {
                continue;
            }
            console.info('Restoring: ', bold(workspaceInfo.packageJson.content.name));
            workspaceInfo.packageJson.content.dependencies = workspaceInfo.oldDependencies;
            await workspaceInfo.packageJson.save();
        }
        console.info('Workspaces dependencies restored to original dependencies');
    }
}
class TargetPackage {
    #targetPackageDir;
    #targetPackage;
    constructor(targetPackageDir) {
        this.#targetPackageDir = targetPackageDir;
    }
    async load() {
        console.info('Loading target package...');
        this.#targetPackage = await getPackageJson(this.#targetPackageDir);
        console.info('Target package loaded: ', bold(this.#targetPackage.content.name));
    }
    async install(availablePackages) {
        console.info('Installing dependencies...');
        const dependencies = this.#targetPackage.content.dependencies;
        if (!dependencies) {
            console.info('No dependencies found in target package');
            return;
        }
        const dependencyNames = Object.keys(dependencies);
        const dependenciesToInstal = availablePackages.filter(availablePackage => dependencyNames.includes(availablePackage.name));
        const packDirs = dependenciesToInstal.map(availablePackage => getPackDir(availablePackage.packName));
        if (dependenciesToInstal.length === 0) {
            console.info('No dependencies to install found in target package');
            return;
        }
        console.info(`Installing dependencies: \n\t- ${dependenciesToInstal.map(d => bold(d.name)).join('\n\t- ')}`);
        await install(this.#targetPackageDir, packDirs);
        console.info('Dependencies installed');
    }
}
const ARGS_OPTIONS = {
    preset: {
        type: 'string',
        short: 'p',
    },
    help: {
        type: 'boolean',
        short: 'h',
        default: false,
    },
    printPresets: {
        type: 'boolean',
        default: false,
    },
    init: {
        type: 'boolean',
        default: false,
    },
    noPrepack: {
        type: 'boolean',
        default: false,
    }
};
class LPCK {
    #lpckRc;
    #args;
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
        this.#lpckRc = JSON.parse(readFileSync(LPCK_RC_PATH, 'utf8'));
    }
    #loadArgs(args) {
        const parsedArgs = parseArgs({
            args,
            options: ARGS_OPTIONS,
            allowPositionals: true,
            strict: true,
        });
        const { preset, printPresets, init, noPrepack } = parsedArgs.values;
        const hasPositionals = parsedArgs.positionals.length === 1;
        if (preset) {
            this.#args = {
                command: 'preset',
                path: preset,
                noPrepack,
            };
            return;
        }
        if (printPresets) {
            this.#args = {
                command: 'printPresets',
            };
            return;
        }
        if (init) {
            this.#args = {
                command: 'init',
            };
            return;
        }
        if (hasPositionals) {
            this.#args = {
                command: 'install',
                path: parsedArgs.positionals[0],
            };
            return;
        }
        this.#args = {
            command: 'help',
        };
    }
    #cleanUpPacks() {
        if (existsSync(LPCK_PACK_DIR)) {
            rmSync(LPCK_PACK_DIR, { recursive: true });
        }
    }
    #help() {
        console.info('Usage:', code('lpck <workspace-root-package-dir>'), 'or', code('lpck [options]'));
        console.info('Options:');
        console.info('  -h, --help: Show this help');
        console.info('  -p, --preset: The preset to use');
        console.info('  --printPresets: Print the presets');
        console.info('  --init: Initialize the LPCK RC');
        console.info('  --noPrepack: Do not execute the prepack script');
    }
    #printPresets() {
        if (this.#lpckRc.presets.length === 0) {
            console.info('No presets found at: ', LPCK_RC_PATH);
            return;
        }
        console.info(code(LPCK_RC_PATH), ': ', JSON.stringify(this.#lpckRc, null, 2));
    }
    #initRC() {
        console.info('Initializing LPCK RC...');
        if (existsSync(LPCK_RC_PATH)) {
            console.error('LPCK RC already exists at: ', LPCK_RC_PATH);
            process.exit(1);
            return;
        }
        const mockRc = { presets: [{
                    name: '<preset-name>',
                    path: '<preset-path>',
                    prepack: '<prepack-script>',
                }] };
        writeFileSync(LPCK_RC_PATH, JSON.stringify(mockRc, null, 2));
        console.info('LPCK RC initialized at: ', LPCK_RC_PATH);
    }
    async #install(originPackageDir) {
        const targetPackage = new TargetPackage(process.cwd());
        const originPackage = new OriginPackage(originPackageDir);
        await originPackage.load();
        try {
            await originPackage.updateDependencies();
            await originPackage.pack();
        }
        catch (error) {
            console.error(red(String(error)));
        }
        finally {
            await originPackage.restoreDependencies();
        }
        await targetPackage.load();
        await targetPackage.install(originPackage.getAvailablePackages());
        this.#cleanUpPacks();
        console.info(green('Done'));
    }
    async #preset(name) {
        console.info('Loading preset: ', code(name));
        const preset = this.#lpckRc.presets.find(preset => preset.name === name);
        if (!preset) {
            console.error('Preset ', code(name), ' not found');
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
            case 'install':
                await this.#install(this.#args.path);
                break;
            case 'preset':
                await this.#preset(this.#args.path);
                break;
            case 'printPresets':
                this.#printPresets();
                break;
            case 'help':
                this.#help();
                break;
            case 'init':
                this.#initRC();
                break;
            default:
                this.#help();
                break;
        }
    }
}
await (new LPCK()).run();
