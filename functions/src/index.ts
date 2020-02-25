import * as functions from 'firebase-functions';
import fetch from 'node-fetch'
// @ts-ignore
const WaveformData = require('waveform-data')

export const waveformData = functions.https.onRequest((request, response) => {
    console.log(request.body)
    if (Array.isArray(request.body)) {
        const promises: Promise<any>[] = request.body.map(url =>
            fetch(url)
                .then(res => res.buffer())
                .then(buffer => WaveformData.create(buffer)
                    .resample({ width: 1000 })
                    .channel(0)
                    .max_array()
                )
        )
        Promise.all(promises).then(results => {
            response.send(JSON.stringify(results))
        }).catch(err => {
            response.status(400)
            response.send(err.message)        
        })
    } else {
        response.status(400)
        response.send('Invalid data')
    }
});
