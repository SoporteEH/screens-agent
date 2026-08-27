// Derives the publish channel from the version. electron-builder does neither on its own:
// channel defaults to "latest" regardless of a -beta version (so a beta would write
// latest.yml and stable agents would install it), and releaseType defaults to "draft"
// (invisible to anonymous downloads, so no agent could ever fetch it).
const fs = require('fs');
const path = require('path');

const packagePath = path.join(__dirname, '..', 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
const version = packageJson.version;
const isPrerelease = version.includes('-beta');

packageJson.build.publish.channel = isPrerelease ? 'beta' : 'latest';
packageJson.build.publish.releaseType = isPrerelease ? 'prerelease' : 'release';

fs.writeFileSync(packagePath, JSON.stringify(packageJson, null, 2) + '\n');
console.log(
    `Publish: channel=${packageJson.build.publish.channel} releaseType=${packageJson.build.publish.releaseType} (version ${version})`
);
