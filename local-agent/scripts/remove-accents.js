/**
 * Script para eliminar acentos de logs y comentarios en codigo JS
 * Uso: node scripts/remove-accents.js
 */

const fs = require('fs');
const path = require('path');

const ACCENT_MAP = {
    'a': 'a', 'A': 'A',
    'e': 'e', 'E': 'E',
    'i': 'i', 'I': 'I',
    'o': 'o', 'O': 'O',
    'u': 'u', 'U': 'U',
    'n': 'n', 'N': 'N',
    'u': 'u', 'U': 'U',
};

function removeAccents(str) {
    return str.replace(/[aeiounuAEIOUNU]/g, (match) => ACCENT_MAP[match] || match);
}

function processFile(filePath) {
    const content = fs.readFileSync(filePath, 'utf8');
    const newContent = removeAccents(content);

    if (content !== newContent) {
        fs.writeFileSync(filePath, newContent, 'utf8');
        console.log(`✓ ${path.relative(process.cwd(), filePath)}`);
        return true;
    }
    return false;
}

function walkDir(dir, extensions = ['.js']) {
    let count = 0;
    const files = fs.readdirSync(dir);

    for (const file of files) {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);

        if (stat.isDirectory()) {
            if (file === 'node_modules' || file === '.git' || file === 'dist') continue;
            count += walkDir(filePath, extensions);
        } else if (extensions.some(ext => file.endsWith(ext))) {
            if (processFile(filePath)) count++;
        }
    }
    return count;
}

const targetDir = process.argv[2] || '.';
console.log(`Procesando: ${path.resolve(targetDir)}\n`);

const modified = walkDir(targetDir);
console.log(`\n${modified} archivos modificados.`);
