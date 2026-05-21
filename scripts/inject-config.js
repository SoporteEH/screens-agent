/**
 * Injects SERVER_URL and AGENT_THEME into package.json
 */

const fs = require('fs');
const path = require('path');
const agentThemes = require('../config/agentThemes');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const SERVER_URL = process.env.SERVER_URL;
const AGENT_THEME = process.env.AGENT_THEME || 'default';

if (!SERVER_URL) {
    console.error('ERROR: SERVER_URL environment variable is required');
    console.error(
        'Usage: SERVER_URL=http://your-server.com AGENT_THEME=default node scripts/inject-config.js'
    );
    process.exit(1);
}

const packagePath = path.join(__dirname, '..', 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));

// Inject SERVER_URL into package.json config
packageJson.config = packageJson.config || {};
packageJson.config.serverUrl = SERVER_URL;

fs.writeFileSync(packagePath, JSON.stringify(packageJson, null, 2) + '\n');
console.log(`SERVER_URL injected into package.json: ${SERVER_URL}`);

// Theme injection
const themeColors = agentThemes[AGENT_THEME.toLowerCase()] || agentThemes.default;
let themeCssContent = ':root {\n';
for (const [prop, value] of Object.entries(themeColors)) {
    themeCssContent += `  ${prop}: ${value};\n`;
}
themeCssContent += '}\n';

const cssDir = path.join(__dirname, '..', 'css');
if (!fs.existsSync(cssDir)) {
    fs.mkdirSync(cssDir);
}

const cssFilePath = path.join(cssDir, 'theme.css');

try {
    fs.writeFileSync(cssFilePath, themeCssContent, 'utf8');
    console.log(`Theme file generated: ${cssFilePath} (${AGENT_THEME})`);
} catch (error) {
    console.error(`ERROR: Failed to generate theme CSS file:`, error);
    process.exit(1);
}

console.log(`package.json and Theme CSS updated with '${AGENT_THEME}'.`);
