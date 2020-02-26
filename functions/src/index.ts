import * as functions from 'firebase-functions';
import fetch from 'node-fetch'
import ffmpegWaveform from './ffmpeg-waveform'
import { spawn } from 'child_process'
import sha1 from 'sha1'
import admin from 'firebase-admin'

admin.initializeApp(functions.config().firebase);

const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path

function urlToWaveform(url: string): Promise<number[]> {
    return fetch(url)
        .then(res => {
            return new Promise((resolve) => {
                const ffmpeg = spawn(ffmpegPath, ['-i', 'pipe:', '-ac', '1', '-filter:a', 'aresample=8000', '-map', '0:a', '-c:a', 'pcm_s16le', '-f', 'data', '-']);
                const bufs: Buffer[] = []
                ffmpeg.stdout.on('data', (data) => bufs.push(data))
                ffmpeg.on('close', (code) => resolve(ffmpegWaveform(Buffer.concat(bufs))))
                res.body.pipe(ffmpeg.stdin)
            })
        })
}

export const waveformData = functions.https.onRequest((request, response) => {
    console.log(request.body)
    if (Array.isArray(request.body)) {
        const promises: Promise<any>[] = request.body.map(url => {
            const hash = sha1(url)
            const ref = admin.database().ref(`peaks/${hash}`)
            return ref.once('value')
                .then(snap => {
                    const value = snap.val()
                    if (value) {
                        console.log('from cache', typeof value)
                        return value
                    } else {
                        console.log('downloading')
                        return urlToWaveform(url).then(peaks => {
                            console.log('got peaks', peaks.length)
                            const peaksStr = JSON.stringify(peaks)
                            return ref.set(peaksStr)
                                .then(() => peaksStr)
                        })
                    }
                })
        })
        Promise.all(promises).then(allPeaks => {
            response.send(`[${allPeaks.join(',')}]`)
        }).catch(err => {
            response.status(400)
            response.send(err.message)        
        })
    } else {
        response.status(400)
        response.send('Invalid data')
    }
});
