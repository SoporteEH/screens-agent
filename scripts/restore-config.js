// Undoes the build-time mutations of package.json (inject-config.js, set-release-channel.js)
// so a local build doesn't leave the injected SERVER_URL sitting in a tracked file, where it
// would become the production fallback if committed.
const fs = require('fs');
const path = require('path');

const packagePath = path.join(__dirname, '..', 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
let changed = false;

if (packageJson.config && packageJson.config.serverUrl) {
    packageJson.config.serverUrl = '';
    changed = true;
}

const publish = packageJson.build && packageJson.build.publish;
for (const key of ['channel', 'releaseType']) {
    if (publish && key in publish) {
        delete publish[key];
        changed = true;
    }
}

if (changed) {
    fs.writeFileSync(packagePath, JSON.stringify(packageJson, null, 2) + '\n');
    console.log('package.json build-time values reset.');
}
