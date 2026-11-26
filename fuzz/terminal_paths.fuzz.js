// The Workbench terminal turns image paths in whatever a program prints into links
// (imagePathsIn in src/renderer/dev/terminal-extras.js). Program output is untrusted: the scan must
// not throw or hang, and each path it reports must be the exact text at its index, ending in an
// image extension.
const { imagePathsIn } = require('../src/renderer/dev/terminal-extras.js');

const IMAGE = /\.(?:png|jpe?g|gif|webp)$/i;

module.exports.fuzz = function (data) {
  const text = data.toString('utf8');
  for (const { path, index } of imagePathsIn(text)) {
    if (text.substr(index, path.length) !== path) throw new Error(`path ${JSON.stringify(path)} is not at ${index}`);
    if (!IMAGE.test(path)) throw new Error(`not an image path: ${JSON.stringify(path)}`);
  }
};
