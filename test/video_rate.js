#!/usr/bin/env -S deno run --allow-all
// A live video key's rate through the gateway: frames Chrome shows per second, the gateway's encoding errors and the
// page's decode errors, for each key, over a window.
// Usage: deno run --allow-all test/video_rate.js --binary <zenoh-gateway> --connect <endpoint>... --encoding <name> --seconds 20 <key>...

import { $ } from "https://esm.sh/dax-sh@0.42.0"
import { parseArgs } from "jsr:@std/cli@1/parse-args"
import { launch } from "jsr:@astral/astral@0.5.6"
import { cleanup, freePort, killOnCleanup, lineCollector, releaseDir } from "./harness.js"
import { buildWeb } from "../tools/build_web.js"

const args = parseArgs(Deno.args, { string: ["binary", "connect", "encoding", "seconds"], collect: ["connect"], default: { seconds: "20" } })
const scratch = $.path(await Deno.makeTempDir({ prefix: "zenoh-gateway-video-rate-" }))
const webRoot = await buildWeb(scratch.join("web").toString())
const httpPort = freePort()
const configPath = scratch.join("zenoh.json5")
configPath.writeTextSync(JSON.stringify({ mode: "client", scouting: { multicast: { enabled: false } }, connect: { endpoints: args.connect, timeout_ms: 5000 } }))
const bridge = killOnCleanup($`${args.binary ?? releaseDir.join("zenoh-gateway").toString()} --port ${httpPort} --zenoh-config ${configPath} --serve ${webRoot}`
    .env("RUST_LOG", "warn,zenoh=error,zenoh_gateway::server=info").stdout("inherit").stderr("piped").noThrow().spawn())
const output = lineCollector(bridge.stderr(), "bridge")
await output.waitFor((line) => line.includes("listening on"), 30000).catch(() => {})
await new Promise((resolve) => setTimeout(resolve, 2000))

// (hidden or backgrounded, Chrome throttles video to a few fps)
const browser = await launch({ headless: !Deno.env.get("HEADED"), args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-media-suspend", "--disable-background-timer-throttling"] })
const page = await browser.newPage(`http://127.0.0.1:${httpPort}/test/blank.html`)
await page.evaluate((bridgeUrl, keys, encoding, seconds) => { window.measured = (async () => {
    const { connect } = await import("/client/zenoh_gateway.js")
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    window.stage = "connecting"
    const client = await connect(bridgeUrl)
    window.stage = "connected"
    const results = await Promise.all(keys.map(async (key) => {
        const subscription = client.subscribe(key, { encoding }, () => {})
        await subscription.ready()
        window.stage = `ready ${key}`
        const element = document.createElement("video")
        Object.assign(element, { muted: true, playsInline: true, srcObject: subscription.mediaStream })
        document.body.append(element)
        await element.play().catch(() => {})
        window.stage = `playing ${key}`
        // settle, then count shown frames over the window
        await sleep(3000)
        let shown = 0
        let counting = true
        const count = () => { if (counting) { shown++; element.requestVideoFrameCallback(count) } }
        element.requestVideoFrameCallback(count)
        await client.pollStats()
        const before = subscription.gatewayStats?.stats ?? {}
        await sleep(seconds * 1000)
        counting = false
        await client.pollStats()
        const stats = subscription.gatewayStats?.stats ?? {}
        return { key, fps: shown / seconds, size: `${element.videoWidth}x${element.videoHeight}`, received: (stats.received ?? 0) - (before.received ?? 0), sent: (stats.sent ?? 0) - (before.sent ?? 0), encodingErrors: (stats.encodingErrors ?? 0) - (before.encodingErrors ?? 0), lastEncodingError: stats.lastEncodingError, decodeErrors: subscription.decodeErrors, decodeMs: stats.decodeMs, encodeMs: stats.encodeMs }
    }))
    client.close()
    return results
})().then((results) => { window.results = results }, (error) => { window.results = { error: `${error}` } }) }, { args: [`http://127.0.0.1:${httpPort}`, args._.map(String), args.encoding, Number(args.seconds)] })
// (one long evaluate times out in astral: poll for the page's results instead)
let results = null
for (let waited = 0; !results && waited < (Number(args.seconds) + 60) * 1000; waited += 1000) {
    await new Promise((resolve) => setTimeout(resolve, 1000))
    results = await page.evaluate(() => window.results ?? null)
}
if (!Array.isArray(results)) {
    console.log(JSON.stringify(results ?? { error: "no results", stage: await page.evaluate(() => window.stage ?? null) }))
    results = []
}
for (const result of results) {
    console.log(JSON.stringify(result))
}
await browser.close()
await cleanup()
