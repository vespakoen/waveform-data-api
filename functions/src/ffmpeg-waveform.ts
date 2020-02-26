const Parser = require('binary-parser').Parser

function parse(data: Buffer) {
  const parser = new Parser()
    .endianess('little')
    .array('waves', { type: 'int16le', readUntil: 'eof' })

  const waves = parser.parse(data).waves

  // figure out the extremes
  let min = Infinity
  let max = -Infinity
  for (const wave of waves) {
    if (min > wave) { min = wave }
    if (max < wave) { max = wave }
  }

  // use the largest value away from 0
  if (Math.abs(min) < max) {
    min = -max
  } else {
    max = Math.abs(min)
  }

  // scale function
  function scale(value: number, fromMin: number, fromMax: number, toMin: number, toMax: number) {
    const fromRange = fromMax - fromMin
    const toRange = toMax - toMin
    return ((value - fromMin) * toRange / fromRange) + toMin
  }

  // resample
  const resampledWaves = []
  for (let j = 0; j < waves.length; j++) {
    resampledWaves[j] = Math.round(Math.abs(scale(waves[j], min, max, -1, 1)) * 10000) / 10000
  }

  return resampledWaves
}

export default parse