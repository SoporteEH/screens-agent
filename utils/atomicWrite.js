const fs = require('fs');

// A power cut mid-write leaves the old or the new content, never garbage.
function writeFileAtomic(filePath, data) {
    const tmp = `${filePath}.${process.pid}.tmp`;
    try {
        fs.writeFileSync(tmp, data);
        fs.renameSync(tmp, filePath);
    } catch (error) {
        try {
            fs.unlinkSync(tmp);
        } catch (_e) {
            /* nothing to clean up */
        }
        throw error;
    }
}

module.exports = { writeFileAtomic };
