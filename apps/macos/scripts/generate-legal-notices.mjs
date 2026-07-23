#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const macosDirectory = resolve(scriptDirectory, '..');
const repositoryDirectory = resolve(macosDirectory, '..', '..');
const legalDirectory = join(macosDirectory, 'Resources', 'Legal');
const noticesPath = join(legalDirectory, 'ThirdPartyNotices.md');
const manifestPath = join(legalDirectory, 'LegalNoticeManifest.json');
const legalSourceDirectory = join(legalDirectory, 'Sources');
const installedPackagesDirectory = join(repositoryDirectory, 'node_modules');
const productionLockfilePath = join(repositoryDirectory, 'pnpm-lock.yaml');
const packageResolvedPath = join(macosDirectory, 'Package.resolved');
const runtimeManifestPath = join(macosDirectory, 'Runtime', 'node-runtime.json');
const requireFromRepository = createRequire(join(repositoryDirectory, 'package.json'));
const nodeRuntimeArchitectures = ['arm64'];

const hash = (content) => createHash('sha256').update(content).digest('hex');
const normalized = (content) => `${content.replace(/\r\n/g, '\n').replace(/\n*$/, '')}\n`;
const projectPath = (path) => relative(repositoryDirectory, path).replaceAll('\\', '/');
const readJSON = (path) => JSON.parse(readFileSync(path, 'utf8'));
const readText = (path) => normalized(readFileSync(path, 'utf8'));

const knownNotices = {
    'swift-markdown': readText(join(legalSourceDirectory, 'Apache-2.0.txt')),
    'swift-cmark': readText(join(legalSourceDirectory, 'Swift-CMark-COPYING.txt')),
    sparkle: readText(join(legalSourceDirectory, 'Sparkle-LICENSE.txt')),
    barlow: readText(join(legalSourceDirectory, 'Barlow-OFL.txt')),
    'departure-mono-nerd-font': readText(join(legalSourceDirectory, 'DepartureMonoNerdFont-OFL.txt')),
    'nodejs-24-lts': readText(join(legalSourceDirectory, 'Node.js-LICENSE.txt')),
    'railgun-icon-artwork': normalized(`© 2026 Dante Teo. Railgun icon artwork is first-party material and is distributed under the Railgun MIT License.`),
    railgun: readText(join(repositoryDirectory, 'LICENSE'))
};

const standardLicenseNotices = {
    Apache: readText(join(legalSourceDirectory, 'Apache-2.0.txt')),
    'Apache-2.0': readText(join(legalSourceDirectory, 'Apache-2.0.txt')),
    'BSD-2-Clause': readText(join(legalSourceDirectory, 'BSD-2-Clause.txt')),
    'BSD-3-Clause': readText(join(legalSourceDirectory, 'BSD-3-Clause.txt')),
    'BlueOak-1.0.0': readText(join(legalSourceDirectory, 'BlueOak-1.0.0.txt')),
    'CC0-1.0': readText(join(legalSourceDirectory, 'CC0-1.0.txt')),
    ISC: readText(join(legalSourceDirectory, 'ISC.txt')),
    'LGPL-3.0-or-later': readText(join(legalSourceDirectory, 'LGPL-3.0-or-later.txt')),
    MIT: readText(join(repositoryDirectory, 'LICENSE')),
    'MIT-0': readText(join(legalSourceDirectory, 'MIT-0.txt')),
    WTFPL: readText(join(legalSourceDirectory, 'WTFPL.txt'))
};

const licenseIdentifiers = (expression) => expression
    .replaceAll(/[()]/g, '')
    .split(/\s+(?:AND|OR)\s+/)
    .map((identifier) => identifier.trim())
    .filter(Boolean);

const noticeFallback = (license) => {
    const notices = licenseIdentifiers(license).map((identifier) => {
        const notice = standardLicenseNotices[identifier];
        if (!notice) throw new Error(`No full bundled license text is available for ${identifier}.`);
        return notice.trimEnd();
    });
    return normalized(`Package metadata (package.json) declares the following license expression: ${license}.\n\n${notices.join('\n\n')}`);
};

const staticComponent = ({ identifier, kind, name, version, revision = null, archive = null, copyright = null, license, sourceLocation, licenseSource }) => {
    const notice = knownNotices[identifier];
    return {
        record: {
            identifier,
            kind,
            name,
            version,
            revision,
            archive,
            copyright,
            license,
            sourceLocation,
            licenseSource,
            noticeContentSHA256: hash(notice)
        },
        notice
    };
};

const swiftComponents = () => {
    const resolved = readJSON(packageResolvedPath);
    const pins = new Map(resolved.pins.map((pin) => [pin.identity, pin]));
    const component = (identifier, name, license, licenseFile) => {
        const pin = pins.get(identifier);
        if (!pin?.state.version || !pin.state.revision) {
            throw new Error(`Package.resolved does not contain a locked ${identifier} pin.`);
        }

        return staticComponent({
            identifier,
            kind: 'swift-package',
            name,
            version: pin.state.version,
            revision: pin.state.revision,
            license,
            sourceLocation: `apps/macos/Package.resolved#${identifier}`,
            licenseSource: `${pin.location}/blob/${pin.state.revision}/${licenseFile}`
        });
    };

    return [
        component('swift-markdown', 'Swift Markdown', 'Apache-2.0', 'LICENSE.txt'),
        component('swift-cmark', 'Swift CMark', 'BSD-2-Clause', 'COPYING'),
        component('sparkle', 'Sparkle', 'MIT', 'LICENSE')
    ];
};

const staticComponents = () => [
    ...swiftComponents(),
    nodeRuntimeComponent(),
    staticComponent({
        identifier: 'barlow',
        kind: 'font',
        name: 'Barlow',
        version: '1.208',
        license: 'OFL-1.1',
        sourceLocation: 'apps/macos/Resources/Fonts/Barlow-Regular.otf; apps/macos/Resources/Fonts/Barlow-Medium.otf; apps/macos/Resources/Fonts/Barlow-SemiBold.otf; apps/macos/Resources/Fonts/Barlow-Bold.otf',
        licenseSource: 'https://github.com/jpt/barlow/blob/main/OFL.txt'
    }),
    staticComponent({
        identifier: 'departure-mono-nerd-font',
        kind: 'font',
        name: 'Departure Mono Nerd Font',
        version: '1.422 / Nerd Fonts 3.4.0',
        license: 'OFL-1.1',
        sourceLocation: 'apps/macos/Resources/Fonts/DepartureMonoNerdFont-Regular.otf',
        licenseSource: 'https://github.com/ryanoasis/nerd-fonts/releases/tag/v3.4.0'
    }),
    staticComponent({
        identifier: 'railgun-icon-artwork',
        kind: 'first-party-artwork',
        name: 'Railgun icon artwork',
        version: '2026',
        copyright: '© 2026 Dante Teo',
        license: 'MIT',
        sourceLocation: 'apps/macos/Resources/RailgunIcon/RailgunIconMaster.svg; apps/macos/Resources/RailgunIcon/RailgunIconMaster-Monochrome.svg; apps/macos/Resources/RailgunIcon/RailgunIcon-1024.svg; apps/macos/Resources/RailgunIcon/RailgunIcon-1024.png',
        licenseSource: 'LICENSE'
    }),
    staticComponent({
        identifier: 'railgun',
        kind: 'first-party-software',
        name: 'Railgun',
        version: 'source checkout',
        copyright: '© 2026 Dante Teo',
        license: 'MIT',
        sourceLocation: 'LICENSE',
        licenseSource: 'LICENSE'
    })
];

const nodeRuntimeManifest = () => {
    const manifest = readJSON(runtimeManifestPath);
    const runtimeLicenseSHA256 = hash(readFileSync(join(legalSourceDirectory, 'Node.js-LICENSE.txt')));
    if (manifest.schemaVersion !== 1
        || manifest.name !== 'Node.js'
        || manifest.version !== '24.18.0'
        || manifest.license?.path !== 'LICENSE'
        || manifest.license?.sha256 !== runtimeLicenseSHA256
        || !nodeRuntimeArchitectures.every((architecture) => {
            const runtime = manifest.architectures?.[architecture];
            return runtime
                && typeof runtime.archive === 'string'
                && typeof runtime.url === 'string'
                && typeof runtime.sha256 === 'string'
                && typeof runtime.machoArchitecture === 'string';
        })) {
        throw new Error('Node runtime manifest is malformed.');
    }
    return manifest;
};

const nodeRuntimeComponent = () => {
    const runtime = nodeRuntimeManifest();
    const archives = nodeRuntimeArchitectures.map((architecture) => runtime.architectures[architecture].archive);
    const sourceMetadata = nodeRuntimeArchitectures.map((architecture) => {
        const entry = runtime.architectures[architecture];
        return `${architecture}: ${entry.url}#sha256=${entry.sha256}`;
    });

    return staticComponent({
        identifier: 'nodejs-24-lts',
        kind: 'node-runtime',
        name: 'Node.js 24 LTS',
        version: runtime.version,
        archive: archives.join('; '),
        license: 'MIT',
        sourceLocation: `apps/macos/Runtime/node-runtime.json; ${sourceMetadata.join('; ')}`,
        licenseSource: 'https://github.com/nodejs/node/blob/v24.18.0/LICENSE'
    });
};

const trackedInputHashes = () => {
    const artworkPaths = [
        'apps/macos/Resources/RailgunIcon/RailgunIconMaster.svg',
        'apps/macos/Resources/RailgunIcon/RailgunIconMaster-Monochrome.svg',
        'apps/macos/Resources/RailgunIcon/RailgunIcon-1024.svg',
        'apps/macos/Resources/RailgunIcon/RailgunIcon-1024.png'
    ];
    const hashFile = (path) => hash(readFileSync(path));
    const legalSourceHashes = Object.fromEntries(readdirSync(legalSourceDirectory)
        .filter((name) => name.endsWith('.txt'))
        .sort()
        .map((name) => [name, hashFile(join(legalSourceDirectory, name))]));
    const artworkHashes = Object.fromEntries(artworkPaths.map((path) => [path, hashFile(join(repositoryDirectory, path))]));

    return {
        backendLockfileSHA256: hashFile(productionLockfilePath),
        packageResolvedSHA256: hashFile(packageResolvedPath),
        nodeRuntimeManifestSHA256: hashFile(runtimeManifestPath),
        railgunLicenseSHA256: hashFile(join(repositoryDirectory, 'LICENSE')),
        legalSourceHashes,
        artworkHashes
    };
};

const packageDirectories = (nodeModulesDirectory) => {
    const directories = [];
    const walk = (directory) => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
            const entryPath = join(directory, entry.name);
            if (entry.name.startsWith('@')) {
                for (const scopedEntry of readdirSync(entryPath, { withFileTypes: true })) {
                    if (scopedEntry.isDirectory()) walkPackage(join(entryPath, scopedEntry.name));
                }
            } else {
                walkPackage(entryPath);
            }
        }
    };
    const walkPackage = (directory) => {
        if (existsSync(join(directory, 'package.json'))) directories.push(directory);
        const nested = join(directory, 'node_modules');
        if (existsSync(nested)) walk(nested);
    };
    walk(nodeModulesDirectory);
    return directories;
};

const packageMetadata = () => {
    if (!existsSync(installedPackagesDirectory)) {
        throw new Error('Production package metadata is required to generate notices. Run pnpm install before generate-legal-notices.mjs --write.');
    }

    return new Map(packageDirectories(installedPackagesDirectory).map((directory) => {
        const metadata = readJSON(join(directory, 'package.json'));
        return [`${metadata.name}@${metadata.version}`, { directory, metadata }];
    }));
};

const packageKey = (name, version) => `${name}@${version}`;
const snapshotKey = (snapshots, name, version) => Object.keys(snapshots).find((key) => key === packageKey(name, version) || key.startsWith(`${packageKey(name, version)}(`));
const packageLockEntry = (packages, key) => packages[key] ?? packages[Object.keys(packages).find((candidate) => candidate === key || candidate.startsWith(`${key}(`))];
const parseSnapshotKey = (key) => {
    const separator = key.indexOf('@', key.startsWith('@') ? key.indexOf('/') + 1 : 0);
    const peerStart = key.indexOf('(', separator);
    return {
        name: key.slice(0, separator),
        version: key.slice(separator + 1, peerStart === -1 ? undefined : peerStart)
    };
};

const supportsMacOS = (entry = {}) => {
    const supportedOS = entry.os ?? [];
    const supportedCPU = entry.cpu ?? [];
    return (!supportedOS.length || supportedOS.includes('darwin'))
        && (!supportedCPU.length || supportedCPU.includes('arm64'));
};

// This is pnpm's production inventory: start from the production importer and
// traverse only the locked dependency graph. Development dependencies are never
// a root, and platform-incompatible optional packages are excluded.
const productionPackageInventory = () => {
    const lock = requireFromRepository('yaml').parse(readFileSync(productionLockfilePath, 'utf8'));
    const snapshots = lock.snapshots ?? {};
    const packages = lock.packages ?? {};
    const roots = Object.entries(lock.importers?.['.']?.dependencies ?? {});
    const visited = new Set();
    const visit = (name, version) => {
        const key = snapshotKey(snapshots, name, version);
        if (!key || visited.has(key)) return;
        const packageEntry = packageLockEntry(packages, key);
        if (!supportsMacOS(packageEntry)) return;
        visited.add(key);
        const snapshot = snapshots[key] ?? {};
        for (const [dependencyName, dependencyVersion] of Object.entries({
            ...(snapshot.dependencies ?? {}),
            ...(snapshot.optionalDependencies ?? {})
        })) {
            visit(dependencyName, dependencyVersion);
        }
    };

    roots.forEach(([name, value]) => visit(name, value.version));
    return [...visited].map((key) => ({ key, ...parseSnapshotKey(key) }))
        .sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));
};

const licenseFiles = (directory) => readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^(license|notice|copying)(?:\.|$)/i.test(entry.name))
    .map((entry) => join(directory, entry.name))
    .sort();

const metadataFor = (metadataByPackage, name, version) => {
    const exact = metadataByPackage.get(packageKey(name, version));
    if (exact) return exact;

    throw new Error(`No staged package metadata for locked production package ${name}@${version}.`);
};

const backendComponents = () => {
    const metadataByPackage = packageMetadata();
    return productionPackageInventory().map(({ name, version }) => {
        const { directory, metadata } = metadataFor(metadataByPackage, name, version);
        const files = licenseFiles(directory);
        const license = metadata.license;
        if (!license && files.length === 0) {
            throw new Error(`${name}@${version} has no attributable license material.`);
        }

        const notice = files.length > 0
            ? normalized(files.map((file) => `Source: ${projectPath(file)}\n\n${readText(file)}`).join('\n'))
            : noticeFallback(license);
        const source = projectPath(directory);
        return {
            record: {
                identifier: `npm:${name}@${version}`,
                kind: 'backend-production-package',
                name,
                version,
                revision: null,
                archive: null,
                copyright: null,
                license: license ?? 'See bundled license material',
                sourceLocation: `pnpm-lock.yaml#${name}@${version}`,
                licenseSource: files.length > 0 ? files.map(projectPath).join('; ') : `${source}/package.json`,
                noticeContentSHA256: hash(notice)
            },
            notice
        };
    });
};

const catalog = () => {
    const components = [...staticComponents(), ...backendComponents()];
    const inputHashes = trackedInputHashes();
    const notices = normalized([
        '# Railgun legal notices',
        '',
        'This catalog is generated from the locked Swift packages and the pnpm production dependency closure for Railgun. Node runtime inputs are pinned in apps/macos/Runtime/node-runtime.json.',
        '',
        ...components.flatMap(({ record, notice }) => [
            `## ${record.name} (${record.version})`,
            '',
            `- Identifier: ${record.identifier}`,
            `- License: ${record.license}`,
            `- Source: ${record.sourceLocation}`,
            `- License source: ${record.licenseSource}`,
            `- Notice SHA-256: ${record.noticeContentSHA256}`,
            '',
            '### Notice',
            '',
            '```text',
            notice.trimEnd(),
            '```',
            ''
        ])
    ].join('\n'));
    return {
        manifest: {
            schemaVersion: 2,
            backendLockfileSHA256: inputHashes.backendLockfileSHA256,
            inputHashes,
            noticesSHA256: hash(notices),
            components: components.map(({ record }) => record)
        },
        notices
    };
};

const writeCatalog = () => {
    const { manifest, notices } = catalog();
    mkdirSync(legalDirectory, { recursive: true });
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(noticesPath, notices);
};

const checkTrackedCatalog = () => {
    if (!existsSync(manifestPath) || !existsSync(noticesPath)) {
        throw new Error('Legal notices are missing. Run apps/macos/scripts/generate-legal-notices.mjs --write.');
    }

    const manifest = readJSON(manifestPath);
    const notices = readFileSync(noticesPath, 'utf8');
    const inputHashes = trackedInputHashes();
    const components = Array.isArray(manifest.components) ? manifest.components : [];
    const identifiers = components.map(({ identifier }) => identifier);
    const hasDuplicateIdentifiers = new Set(identifiers).size !== identifiers.length;
    if (manifest.schemaVersion !== 2
        || manifest.backendLockfileSHA256 !== inputHashes.backendLockfileSHA256
        || JSON.stringify(manifest.inputHashes) !== JSON.stringify(inputHashes)
        || manifest.noticesSHA256 !== hash(notices)
        || !Array.isArray(manifest.components)
        || hasDuplicateIdentifiers
        || components.some(({ identifier, noticeContentSHA256 }) => !identifier || !noticeContentSHA256 || !notices.includes(`Identifier: ${identifier}`))) {
        throw new Error('Legal notices are stale or incomplete. Run apps/macos/scripts/generate-legal-notices.mjs --write.');
    }
};

const checkCatalog = () => {
    const skipInstalledPackages = process.env.RAILGUN_LEGAL_SKIP_INSTALLED_PACKAGES === '1';
    if (skipInstalledPackages || !existsSync(installedPackagesDirectory)) {
        checkTrackedCatalog();
        return;
    }

    const { manifest, notices } = catalog();
    const expectedManifest = `${JSON.stringify(manifest, null, 2)}\n`;
    if (!existsSync(manifestPath) || !existsSync(noticesPath)
        || readFileSync(manifestPath, 'utf8') !== expectedManifest
        || readFileSync(noticesPath, 'utf8') !== notices) {
        throw new Error('Legal notices are stale. Run apps/macos/scripts/generate-legal-notices.mjs --write.');
    }
};

if (process.argv[2] === '--write') {
    writeCatalog();
} else if (process.argv[2] === '--check') {
    checkCatalog();
} else {
    throw new Error('usage: generate-legal-notices.mjs --write|--check');
}
