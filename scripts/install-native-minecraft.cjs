'use strict';
// Add the pinned 26.3 dataset to the npm wrapper without vendoring every
// historic Java/Bedrock version a second time. The runtime data is the same
// dataset used by the tested standalone native update.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const vendor = path.join(root, 'vendor/mia-26.3');
const m = JSON.parse(fs.readFileSync(path.join(vendor, 'manifest.json')));
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
for (const info of [...Object.values(m.packages), m.dataArchive]) {
    if (sha(fs.readFileSync(path.join(vendor, info.file))) !== info.sha256)
        throw new Error('Native package checksum mismatch: ' + info.file);
}
const wrapper = path.dirname(require.resolve('minecraft-data/package.json', { paths: [root] }));
if (JSON.parse(fs.readFileSync(path.join(wrapper, 'package.json'))).version !== m.dataBase)
    throw new Error('The 26.3 data overlay requires minecraft-data@' + m.dataBase);
const target = path.join(wrapper, 'minecraft-data/data');
const files = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(vendor, m.dataArchive.file))));
for (const [name, content] of Object.entries(files)) {
    if (!name.startsWith('pc/') || name.split('/').includes('..') || sha(content) !== m.dataFiles[name])
        throw new Error('Invalid 26.3 data overlay file: ' + name);
    const destination = path.join(target, name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, content);
}
const pathsFile = path.join(target, 'dataPaths.json');
const paths = JSON.parse(fs.readFileSync(pathsFile));
Object.assign(paths.pc, JSON.parse(fs.readFileSync(path.join(vendor, 'data-paths.json'))));
fs.writeFileSync(pathsFile, JSON.stringify(paths));
const versionsFile = path.join(target, 'pc/common/versions.json');
const versions = JSON.parse(fs.readFileSync(versionsFile));
if (!versions.includes('26.3')) versions.push('26.3');
fs.writeFileSync(versionsFile, JSON.stringify(versions));
execFileSync(process.execPath, [path.join(wrapper, 'bin/generate_data.js')], { stdio: 'inherit' });
const data = require(wrapper)('26.3');
if (data?.version.version !== 777 || !data.supportFeature('sendsClientTickEndPacket'))
    throw new Error('Native 26.3 dataset failed verification.');
console.log('Installed native Minecraft 26.3 dataset (experimental, protocol 777).');
