import * as functions from 'firebase-functions'
import fetch from 'node-fetch'
import { spawn } from 'child_process'
import sha1 from 'sha1'
import admin from 'firebase-admin'
import fs from 'fs'
// const downsampler = require("downsample-lttb")

admin.initializeApp(functions.config().firebase)

const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path
const ffprobePath = require('@ffprobe-installer/ffprobe').path

// function downsample(numbers: number[], targetLength: number) {
//     const pairs = numbers.map((number, i) => [i, number])
//     return downsampler.processData(pairs, targetLength)
//         .map((pair: [number, number]) => pair[1])
// }

function probeJson(file: string) {
    return new Promise((resolve, reject) => {
        const ffprobe = spawn(ffprobePath, ['-i', file, '-v', 'quiet', '-select_streams', 'a:0', '-print_format', 'json', '-show_format', '-show_streams', '-hide_banner'])
        const bufs: Buffer[] = []
        const errBufs: Buffer[] = []
        ffprobe.stdout.on('data', (data) => bufs.push(data))
        ffprobe.stderr.on('data', (data) => errBufs.push(data))
        ffprobe.on('close', (code) => {
            if (code !== 0) {
                reject(new Error(`ffprobe exited with code: ${code}, stderr: ${Buffer.concat(errBufs).toString()}`))
                return
            }
            const ffprobeData = JSON.parse(Buffer.concat(bufs).toString())
            resolve(ffprobeData)
        })
    })
}

function ffmpegBuffer(file: string, sampleRate: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const ffmpeg = spawn(ffmpegPath, ['-i', file, '-ac', '1', '-filter:a', 'aresample=' + sampleRate, '-map', '0:a', '-c:a', 'pcm_s16le', '-f', 'data', '-']);
        const bufs: Buffer[] = []
        const errBufs: Buffer[] = []
        ffmpeg.stdout.on('data', (data) => bufs.push(data))
        ffmpeg.stderr.on('data', (data) => errBufs.push(data))
        ffmpeg.on('close', (code) => {
            if (code !== 0) {
                reject(new Error(`ffmpeg exited with code: ${code}, stderr: ${Buffer.concat(errBufs).toString()}`))
                return
            }
            resolve(Buffer.concat(bufs))
        })
    })
}

function bufferToPeaks(buffer: Buffer, length: number, samplesPerSample: number) {
    const waves = []
    let totalMax = -Infinity
    const steps = Math.floor(buffer.length / length) || 1
    for (var i = 0; i < buffer.length - steps; i += steps) {
        let max = 0
        for (var j = 0; j < Math.min(steps, samplesPerSample); j++) {
            const value = Math.abs(buffer.readInt16LE(i + j))
            if (value > max) {
                max = value
            }
        }
        waves.push(max)
        if (max > totalMax) {
            totalMax = max
        }
    }
    return waves.map(wave => Math.round((wave / totalMax) * 10000) / 10000)
  }
  

function urlToWaveform(url: string, samples: number, samplesPerSample: number): Promise<{ peaks: number[], info: any }> {
    return fetch(url)
        .then(res => {
            return new Promise((resolve, reject) => {
                const hash = sha1(url)
                const tmpFile = '/tmp/' + hash
                const writeStream = fs.createWriteStream(tmpFile)
                res.body.pipe(writeStream)
                writeStream.on('error', reject)
                writeStream.on('close', async () => {
                    try {
                        const ffprobeData: any = await probeJson(tmpFile)
                        const sampleRate = Math.round(Math.max(samples / ffprobeData.format.duration, 800))
                        const ffmpegData = await ffmpegBuffer(tmpFile, sampleRate)
                        fs.unlinkSync(tmpFile)
                        const peaks = bufferToPeaks(ffmpegData, samples, samplesPerSample)
                        resolve({
                            info: ffprobeData,
                            peaks
                        })
                    } catch (err) {
                        reject(err)
                    }
                })
            })
        })
}

// function test() {
//     // urlToWaveform('https://firebasestorage.googleapis.com/v0/b/sound-stable.appspot.com/o/sounds%2F0038f518b722d78e4dbe533758415c430c95f0cd.wav?alt=media&token=88222d3c-42b2-4af3-b35a-5768a2773ccf', 5000).then((data: any) => {
//     urlToWaveform('https://firebasestorage.googleapis.com/v0/b/sound-stable.appspot.com/o/sounds%2F0028c5b3cb91cfe3f1c60a79569da7cd822bd2b1.wav?alt=media&token=9aff1c1e-f041-41f5-afb8-7cda8e4b426d', 2000).then((data: any) => {
//         console.log(JSON.stringify(data.peaks))
//     }).catch(err => console.error(err))
// }

// test()

export const waveformData = functions.https.onRequest((request, response) => {
    // console.log(request.body)
    if (!request.body || !Array.isArray(request.body.urls) || !Number.isInteger(request.body.samples) || !Array.isArray(request.body.fields)) {
        response.status(400)
        response.send(JSON.stringify({
            error: 'Invalid request, request body should look like this: {"urls": ["https://link.to/sound.wav", "http://link.to/sound.mp3"], "samples": 1000, "fields": ["peaks", "info"]}'
        }))
    }
    const urls: string[] = request.body.urls
    const samples: number = request.body.samples
    const fields: string[] = request.body.fields
    const samplesPerSample: number = request.body.samplesPerSample || 5
    const promises: Promise<any>[] = urls.map(url => {
        const hash = sha1(url + ',' + samples)
        const ref = admin.database().ref(`peaks/${hash}`)
        return ref.once('value')
            .then(snap => {
                const value = snap.val()
                if (value) {
                    const result: any = {}
                    fields.forEach(field => {
                        result[field] = JSON.parse(value[field])
                    })
                    return result
                } else {
                    return urlToWaveform(url, samples, samplesPerSample).then((data: any) => {
                        const save: any = {}
                        Object.keys(data).forEach(key => {
                            save[key] = JSON.stringify(data[key])
                        })
                        const result: any = {}
                        fields.forEach(field => {
                            result[field] = data[field]
                        })
                        return ref.set(save)
                            .then(() => result)
                    })
                }
            })
    })
    Promise.all(promises).then(allInfo => {
        response.send(JSON.stringify(allInfo))
    }).catch(err => {
        response.status(400)
        response.send(err.message)        
    })
})
