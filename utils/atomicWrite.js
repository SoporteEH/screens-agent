const fs = require('fs');

// A power cut mid-write leaves the old or the new content, never garbage.
function writeFileAtomic(filePath, data) {
    const tmp = `${filePath}.${process.pid}.tmp`;
    try {
        fs.writeFileSync(tmp, data);
        fs.renameSync(tmp, filePath);
    } catch (error) {
        try {
            fs.rmSync(tmp, { force: true });
        } catch {
            // Keep the write error: it is the one worth logging.
        }
        throw error;
    }
}

module.exports = { writeFileAtomic };
