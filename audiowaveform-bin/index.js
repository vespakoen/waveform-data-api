const execFile = require('child_process').execFile

module.exports = function (args, cb) {
  execFile(__dirname + '/build/release/audiowaveform', args, cb)
}
