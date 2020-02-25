# audiowaveform-bin

npm package containing audiowaveform binary for linux to run in cloud functions

# install

```shell
npm install --save audiowaveform-bin
```

# use

```js
const audiowaveform = require('audiowaveform-bin')
audiowaveform(['-i', 'someinput.wav', '-o', 'someoutput.json', '--output-format', 'json'])
```
