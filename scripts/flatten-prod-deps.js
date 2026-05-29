#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.join(__dirname, '..');
const pkgPath = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const original = JSON.parse(JSON.stringify(pkg.dependencies || {}));

const listJson = execSync('pnpm list --prod --depth=Infinity --json', {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
});
const listData = JSON.parse(listJson);

const collected = { ...original };
function walk(node) {
    if (!node || !node.dependencies) return;
    for (const [name, info] of Object.entries(node.dependencies)) {
        if (collected[name]) {
            walk(info);
            continue;
        }
        collected[name] = info.version ? info.version : '*';
        walk(info);
    }
}
for (const proj of listData) walk(proj);

pkg.dependencies = collected;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

const added = Object.keys(collected).filter((k) => !original[k]);
console.log(`Flattened ${Object.keys(original).length} direct deps -> ${Object.keys(collected).length} total`);
console.log(`Added ${added.length} transitive deps as direct: ${added.slice(0, 10).join(', ')}${added.length > 10 ? ', ...' : ''}`);
