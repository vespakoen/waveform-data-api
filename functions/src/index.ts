import * as functions from 'firebase-functions';
import fetch from 'node-fetch'
import ffmpegWaveform from './ffmpeg-waveform'
import { spawn } from 'child_process'
import sha1 from 'sha1'
import admin from 'firebase-admin'
import fs from 'fs'
const downsampler = require("downsample-lttb")

admin.initializeApp(functions.config().firebase);

const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path
const ffprobePath = require('@ffprobe-installer/ffprobe').path

function downsample(numbers: number[], targetLength: number) {
    const pairs = numbers.map((number, i) => [i, number])
    return downsampler.processData(pairs, targetLength)
        .map((pair: [number, number]) => pair[1])
}

function probeJson(file: string) {
    return new Promise((resolve, reject) => {
        const ffprobe = spawn(ffprobePath, ['-i', file, '-v', 'quiet', '-select_streams', 'a:0', '-print_format', 'json', '-show_format', '-show_streams', '-hide_banner'])
        const probeBufs: Buffer[] = []
        ffprobe.stdout.on('data', (data) => probeBufs.push(data))
        ffprobe.on('close', (code) => {
            if (code !== 0) {
                reject(`ffprobe exited with code: ${code}`)
                return
            }
            const ffprobeData = JSON.parse(Buffer.concat(probeBufs).toString())
            resolve(ffprobeData)
        })
    })
}

function ffmpegBuffer(file: string, sampleRate: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const ffmpeg = spawn(ffmpegPath, ['-i', file, '-ac', '1', '-filter:a', 'aresample=' + sampleRate, '-map', '0:a', '-c:a', 'pcm_s16le', '-f', 'data', '-']);
        const bufs: Buffer[] = []
        ffmpeg.stdout.on('data', (data) => bufs.push(data))
        ffmpeg.on('close', (code) => {
            if (code !== 0) {
                reject(`ffmpeg exited with code: ${code}`)
                return
            }
            resolve(Buffer.concat(bufs))
        })
    })
}

function urlToWaveform(url: string, samples: number): Promise<{ peaks: number[], info: any }> {
    return fetch(url)
        .then(res => {
            return new Promise((resolve, reject) => {
                const hash = sha1(url)
                const tmpFile = '/tmp/' + hash
                const writeStream = fs.createWriteStream(tmpFile)
                res.body.pipe(writeStream)
                writeStream.on('error', reject)
                writeStream.on('close', async () => {
                    const ffprobeData: any = await probeJson(tmpFile)
                    let sampleRate = 1000
                    if (ffprobeData.format.duration < 1) {
                        sampleRate = sampleRate / ffprobeData.format.duration
                    }
                    const ffmpegData = await ffmpegBuffer(tmpFile, sampleRate)
                    fs.unlinkSync(tmpFile)
                    const peaks = ffmpegWaveform(ffmpegData)
                    resolve({
                        info: ffprobeData,
                        peaks: downsample(peaks, samples)
                    })
                })
            })
        })
}

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
                    return urlToWaveform(url, samples).then((data: any) => {
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
});
