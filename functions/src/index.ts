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

function urlToWaveform(url: string): Promise<{ peaks: number[], data: any }> {
    return fetch(url)
        .then(res => {
            return new Promise((resolve, reject) => {
                const hash = sha1(url)
                const tmpFile = '/tmp/' + hash
                const writeStream = fs.createWriteStream(tmpFile)
                res.body.pipe(writeStream)
                writeStream.on('error', reject)
                writeStream.on('close', () => {
                    const ffprobe = spawn(ffprobePath, ['-i', tmpFile, '-v', 'quiet', '-select_streams', 'a:0', '-print_format', 'json', '-show_format', '-show_streams', '-hide_banner'])
                    const probeBufs: Buffer[] = []
                    ffprobe.stdout.on('data', (data) => probeBufs.push(data))
                    ffprobe.on('close', () => {
                        const ffprobeData = JSON.parse(Buffer.concat(probeBufs).toString())
                        let sampleRate = 1000
                        if (ffprobeData.format.duration < 1) {
                            sampleRate = sampleRate / ffprobeData.format.duration
                        }
                        const ffmpeg = spawn(ffmpegPath, ['-i', tmpFile, '-ac', '1', '-filter:a', 'aresample=' + sampleRate, '-map', '0:a', '-c:a', 'pcm_s16le', '-f', 'data', '-']);
                        const bufs: Buffer[] = []
                        ffmpeg.stdout.on('data', (data) => bufs.push(data))
                        ffmpeg.on('close', () => {
                            fs.unlinkSync(tmpFile)
                            const peaks = ffmpegWaveform(Buffer.concat(bufs))
                            resolve({
                                data: ffprobeData,
                                peaks: downsample(peaks, 2000)
                            })
                        })
                    })
                })
            })
        })
}

export const waveformData = functions.https.onRequest((request, response) => {
    // console.log(request.body)
    if (Array.isArray(request.body)) {
        const promises: Promise<any>[] = request.body.map(url => {
            const hash = sha1(url)
            const ref = admin.database().ref(`peaks/${hash}`)
            return ref.once('value')
                .then(snap => {
                    const value = snap.val()
                    if (value) {
                        return {
                            data: JSON.parse(value.data),
                            peaks: JSON.parse(value.peaks)
                        }
                    } else {
                        return urlToWaveform(url).then(info => {
                            console.log('peaks', info.peaks.length)
                            const dataStr = JSON.stringify(info.data)
                            const peaksStr = JSON.stringify(info.peaks)
                            return ref.set({ data: dataStr, peaks: peaksStr })
                                .then(() => info)
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
    } else {
        response.status(400)
        response.send('Invalid data')
    }
});
