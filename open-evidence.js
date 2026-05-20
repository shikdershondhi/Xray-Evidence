const { execFile } = require('child_process');
const path = require('path');

const htmlPath = path.join(__dirname, 'xray-md-evidence.html');
const command = process.platform === 'win32'
  ? 'cmd'
  : process.platform === 'darwin'
    ? 'open'
    : 'xdg-open';
const args = process.platform === 'win32'
  ? ['/c', 'start', '', htmlPath]
  : [htmlPath];

execFile(command, args, error => {
  if (error) {
    console.error(`Open ${htmlPath} in your browser.`);
    process.exitCode = 1;
  }
});
