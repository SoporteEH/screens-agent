// Undoes inject-config.js so a local build doesn't leave the injected SERVER_URL sitting
// in tracked package.json, where it would become the production fallback if committed.
const fs = require('fs');
const path = require('path');

const packagePath = path.join(__dirname, '..', 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));

if (packageJson.config && packageJson.config.serverUrl) {
    packageJson.config.serverUrl = '';
    fs.writeFileSync(packagePath, JSON.stringify(packageJson, null, 2) + '\n');
    console.log('package.json serverUrl reset to empty.');
}
