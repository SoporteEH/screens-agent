/**
 * SERVER_URL y AGENT_THEME e inyecta en package.json
 */

const fs = require('fs');
const path = require('path');
const agentThemes = require('../config/agentThemes');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const SERVER_URL = process.env.SERVER_URL;
const AGENT_THEME = process.env.AGENT_THEME || 'default';


if (!SERVER_URL) {
    console.error('ERROR: SERVER_URL environment variable is required');
    console.error('Usage: SERVER_URL=http://your-server.com AGENT_THEME=LUCKIA node scripts/inject-config.js');
    process.exit(1);
}

const packagePath = path.join(__dirname, '..', 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));

// SERVER_URL en la configuración de package.json
packageJson.config = packageJson.config || {};
packageJson.config.serverUrl = SERVER_URL;

fs.writeFileSync(packagePath, JSON.stringify(packageJson, null, 2) + '\n');
console.log(`SERVER_URL inyectado en package.json: ${SERVER_URL}`);


// Inyección de Tema
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
    console.log(`Archivo de tema generado: ${cssFilePath} (${AGENT_THEME})`);
} catch (error) {
    console.error(`ERROR: Fallo al generar archivo CSS de tema:`, error);
    process.exit(1);
}

console.log(`package.json y Tema CSS actualizados con '${AGENT_THEME}'.`);
