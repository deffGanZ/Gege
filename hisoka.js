// Note For User
// Set all settings in the file config.js including the list menu 
// for others pay to me. jas kiding
// jangan diperjualbelikan dalam keadaan masih ori hisoka. minimal tambah 5-8 command dulu

import config from "./config.js"
import { Client, Serialize } from "./lib/serialize.js"

import baileys from "@whiskeysockets/baileys"
const { useMultiFileAuthState, DisconnectReason, makeInMemoryStore, jidNormalizedUser, makeCacheableSignalKeyStore, PHONENUMBER_MCC } = baileys
import fs from "fs"
import axios from "axios"
import { Boom } from "@hapi/boom"
import Pino from "pino"
import NodeCache from "node-cache"
import chalk from "chalk"
import readline from "readline"
import { parsePhoneNumber } from "libphonenumber-js"
import open from "open"
import { tmpdir } from "os"
import Crypto from "crypto"
import ffmpegPath from "@ffmpeg-installer/ffmpeg"
import ff from 'fluent-ffmpeg'
import webp from "node-webpmux"
import path from "path"

global.api = async (name, options = {}) => new (await import("./lib/api.js")).default(name, options)

const database = (new (await import("./lib/database.js")).default())
const store = makeInMemoryStore({ logger: Pino({ level: "fatal" }).child({ level: "fatal" }) })

const pairingCode = !!config.options.pairingNumber || process.argv.includes("--pairing-code")
const useMobile = process.argv.includes("--mobile")

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const question = (text) => new Promise((resolve) => rl.question(text, resolve))

// start connect to client
async function start() {
   process.on("unhandledRejection", (err) => console.error(err))

   const content = await database.read()
   if (content && Object.keys(content).length === 0) {
      global.db = {
         users: {},
         groups: {},
         ...(content || {}),
      }
      await database.write(global.db)
   } else {
      global.db = content
   }

   const { state, saveCreds } = await useMultiFileAuthState(`./${config.options.sessionName}`)
   const msgRetryCounterCache = new NodeCache() // for retry message, "waiting message"

   const hisoka = baileys.default({
      logger: Pino({ level: "fatal" }).child({ level: "fatal" }), // hide log
      printQRInTerminal: !pairingCode, // popping up QR in terminal log
      mobile: useMobile, // mobile api (prone to bans)
      auth: {
         creds: state.creds,
         keys: makeCacheableSignalKeyStore(state.keys, Pino({ level: "fatal" }).child({ level: "fatal" })),
      },
      browser: ['Chrome (Linux)', '', ''], // for this issues https://github.com/WhiskeySockets/Baileys/issues/328
      markOnlineOnConnect: true, // set false for offline
      generateHighQualityLinkPreview: true, // make high preview link
      getMessage: async (key) => {
         let jid = jidNormalizedUser(key.remoteJid)
         let msg = await store.loadMessage(jid, key.id)

         return msg?.message || ""
      },
      msgRetryCounterCache, // Resolve waiting messages
      defaultQueryTimeoutMs: undefined, // for this issues https://github.com/WhiskeySockets/Baileys/issues/276
   })
   // bind store, write store maybe
   store.bind(hisoka.ev)

   // push update name to store.contacts
   hisoka.ev.on("contacts.update", (update) => {
      for (let contact of update) {
         let id = jidNormalizedUser(contact.id)
         if (store && store.contacts) store.contacts[id] = { id, name: contact.notify }
      }
   })

   // bind extra client
   await Client({ hisoka, store })

   // login use pairing code
   // source code https://github.com/WhiskeySockets/Baileys/blob/master/Example/example.ts#L61
   if (pairingCode && !hisoka.authState.creds.registered) {
      if (useMobile) throw new Error('Cannot use pairing code with mobile api')

      let phoneNumber
      if (!!config.options.pairingNumber) {
         phoneNumber = config.options.pairingNumber.replace(/[^0-9]/g, '')

         if (!Object.keys(PHONENUMBER_MCC).some(v => phoneNumber.startsWith(v))) {
            console.log(chalk.bgBlack(chalk.redBright("Start with your country's WhatsApp code, Example : 62xxx")))
            process.exit(0)
         }
      } else {
         phoneNumber = await question(chalk.bgBlack(chalk.greenBright(`Please type your WhatsApp number : `)))
         phoneNumber = phoneNumber.replace(/[^0-9]/g, '')

         // Ask again when entering the wrong number
         if (!Object.keys(PHONENUMBER_MCC).some(v => phoneNumber.startsWith(v))) {
            console.log(chalk.bgBlack(chalk.redBright("Start with your country's WhatsApp code, Example : 62xxx")))

            phoneNumber = await question(chalk.bgBlack(chalk.greenBright(`Please type your WhatsApp number : `)))
            phoneNumber = phoneNumber.replace(/[^0-9]/g, '')
            rl.close()
         }
      }

      setTimeout(async () => {
         let code = await hisoka.requestPairingCode(phoneNumber)
         code = code?.match(/.{1,4}/g)?.join("-") || code
         console.log(chalk.black(chalk.bgGreen(`Your Pairing Code : `)), chalk.black(chalk.white(code)))
      }, 3000)
   }

   // login mobile API (prone to bans)
   // source code https://github.com/WhiskeySockets/Baileys/blob/master/Example/example.ts#L72
   if (useMobile && !hisoka.authState.creds.registered) {
      const { registration } = hisoka.authState.creds || { registration: {} }

      if (!registration.phoneNumber) {
         let phoneNumber = await question(chalk.bgBlack(chalk.greenBright(`Please type your WhatsApp number : `)))
         phoneNumber = phoneNumber.replace(/[^0-9]/g, '')

         // Ask again when entering the wrong number
         if (!Object.keys(PHONENUMBER_MCC).some(v => phoneNumber.startsWith(v))) {
            console.log(chalk.bgBlack(chalk.redBright("Start with your country's WhatsApp code, Example : 62xxx")))

            phoneNumber = await question(chalk.bgBlack(chalk.greenBright(`Please type your WhatsApp number : `)))
            phoneNumber = phoneNumber.replace(/[^0-9]/g, '')
         }

         registration.phoneNumber = "+" + phoneNumber
      }

      const phoneNumber = parsePhoneNumber(registration.phoneNumber)
      if (!phoneNumber.isValid()) throw new Error('Invalid phone number: ' + registration.phoneNumber)

      registration.phoneNumber = phoneNumber.format("E.164")
      registration.phoneNumberCountryCode = phoneNumber.countryCallingCode
      registration.phoneNumberNationalNumber = phoneNumber.nationalNumber

      const mcc = PHONENUMBER_MCC[phoneNumber.countryCallingCode]
      registration.phoneNumberMobileCountryCode = mcc

      async function enterCode() {
         try {
            const code = await question(chalk.bgBlack(chalk.greenBright(`Please Enter Your OTP Code : `)))
            const response = await hisoka.register(code.replace(/[^0-9]/g, '').trim().toLowerCase())
            console.log(chalk.bgBlack(chalk.greenBright("Successfully registered your phone number.")))
            console.log(response)
            rl.close()
         } catch (e) {
            console.error('Failed to register your phone number. Please try again.\n', e)
            await askOTP()
         }
      }

      // from this : https://github.com/WhiskeySockets/Baileys/blob/master/Example/example.ts#L110
      async function enterCaptcha() {
         const response = await sock.requestRegistrationCode({ ...registration, method: 'captcha' })
         const pathFile = path.join(process.cwd(), "temp", "captcha.png")
         fs.writeFileSync(pathFile, Buffer.from(response.image_blob, 'base64'))
         await open(pathFile)
         const code = await question(chalk.bgBlack(chalk.greenBright(`Please Enter Your Captcha Code : `)))
         fs.unlinkSync(pathFile)
         registration.captcha = code.replace(/["']/g, '').trim().toLowerCase()
      }

      async function askOTP() {
         if (!registration.method) {
            let code = await question(chalk.bgBlack(chalk.greenBright('What method do you want to use? "sms" or "voice" : ')))
            code = code.replace(/["']/g, '').trim().toLowerCase()

            if (code !== 'sms' && code !== 'voice') return await askOTP()

            registration.method = code
         }

         try {
            await hisoka.requestRegistrationCode(registration)
            await enterCode()
         } catch (e) {
            console.error('Failed to request registration code. Please try again.\n', e)
            if (e?.reason === 'code_checkpoint') {
               await enterCaptcha()
            }
            await askOTP()
         }
      }

      await askOTP()
   }
   
async function getBuffer (url, options) {
try {
options ? options : {}
const res = await axios({
method: "get",
url,
headers: {
'DNT': 1,
'Upgrade-Insecure-Request': 1
},
...options,
responseType: 'arraybuffer'
})
return res.data
} catch (err) {
return err
}
}
   
async function imageToWebp (media) {

    const tmpFileOut = path.join(tmpdir(), `${Crypto.randomBytes(6).readUIntLE(0, 6).toString(36)}.webp`)
    const tmpFileIn = path.join(tmpdir(), `${Crypto.randomBytes(6).readUIntLE(0, 6).toString(36)}.jpg`)

    fs.writeFileSync(tmpFileIn, media)

    await new Promise((resolve, reject) => {
        ff(tmpFileIn)
            .on("error", reject)
            .on("end", () => resolve(true))
            .addOutputOptions([
                "-vcodec",
                "libwebp",
                "-vf",
                "scale='min(320,iw)':min'(320,ih)':force_original_aspect_ratio=decrease,fps=15, pad=320:320:-1:-1:color=white@0.0, split [a][b]; [a] palettegen=reserve_transparent=on:transparency_color=ffffff [p]; [b][p] paletteuse"
            ])
            .toFormat("webp")
            .save(tmpFileOut)
    })

    const buff = fs.readFileSync(tmpFileOut)
    fs.unlinkSync(tmpFileOut)
    fs.unlinkSync(tmpFileIn)
    return buff
}

async function videoToWebp (media) {

    const tmpFileOut = path.join(tmpdir(), `${Crypto.randomBytes(6).readUIntLE(0, 6).toString(36)}.webp`)
    const tmpFileIn = path.join(tmpdir(), `${Crypto.randomBytes(6).readUIntLE(0, 6).toString(36)}.mp4`)

    fs.writeFileSync(tmpFileIn, media)

    await new Promise((resolve, reject) => {
        ff(tmpFileIn)
            .on("error", reject)
            .on("end", () => resolve(true))
            .addOutputOptions([
                "-vcodec",
                "libwebp",
                "-vf",
                "scale='min(320,iw)':min'(320,ih)':force_original_aspect_ratio=decrease,fps=15, pad=320:320:-1:-1:color=white@0.0, split [a][b]; [a] palettegen=reserve_transparent=on:transparency_color=ffffff [p]; [b][p] paletteuse",
                "-loop",
                "0",
                "-ss",
                "00:00:00",
                "-t",
                "00:00:05",
                "-preset",
                "default",
                "-an",
                "-vsync",
                "0"
            ])
            .toFormat("webp")
            .save(tmpFileOut)
    })

    const buff = fs.readFileSync(tmpFileOut)
    fs.unlinkSync(tmpFileOut)
    fs.unlinkSync(tmpFileIn)
    return buff
}

async function writeExifImg (media, metadata) {
    let wMedia = await imageToWebp(media)
    const tmpFileIn = path.join(tmpdir(), `${Crypto.randomBytes(6).readUIntLE(0, 6).toString(36)}.webp`)
    const tmpFileOut = path.join(tmpdir(), `${Crypto.randomBytes(6).readUIntLE(0, 6).toString(36)}.webp`)
    fs.writeFileSync(tmpFileIn, wMedia)

    if (metadata.packname || metadata.author) {
        const img = new webp.Image()
        const json = { "sticker-pack-id": `https://github.com/DikaArdnt/Hisoka-Morou`, "sticker-pack-name": metadata.packname, "sticker-pack-publisher": metadata.author, "emojis": metadata.categories ? metadata.categories : [""] }
        const exifAttr = Buffer.from([0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00])
        const jsonBuff = Buffer.from(JSON.stringify(json), "utf-8")
        const exif = Buffer.concat([exifAttr, jsonBuff])
        exif.writeUIntLE(jsonBuff.length, 14, 4)
        await img.load(tmpFileIn)
        fs.unlinkSync(tmpFileIn)
        img.exif = exif
        await img.save(tmpFileOut)
        return tmpFileOut
    }
}

hisoka.sendImageAsSticker = async (jid, path, quoted, options = {}) => {
let buff = Buffer.isBuffer(path) ? path : /^data:.*?\/.*?;base64,/i.test(path) ? Buffer.from(path.split`,`[1], 'base64') : /^https?:\/\//.test(path) ? await (await getBuffer(path)) : fs.existsSync(path) ? fs.readFileSync(path) : Buffer.alloc(0)
let buffer
if (options && (options.packname || options.author)) {
buffer = await writeExifImg(buff, options)
} else {
buffer = await imageToWebp(buff)}
await hisoka.sendMessage(jid, { sticker: { url: buffer }, ...options }, { quoted })
return buffer}

   // for auto restart when error client
   hisoka.ev.on("connection.update", async (update) => {
      const { lastDisconnect, connection, qr } = update
      if (connection) {
         console.info(`Connection Status : ${connection}`)
      }

      if (connection === "close") {
         let reason = new Boom(lastDisconnect?.error)?.output.statusCode
         if (reason === DisconnectReason.badSession) {
            console.log(`Bad Session File, Please Delete Session and Scan Again`)
            process.send('reset')
         } else if (reason === DisconnectReason.connectionClosed) {
            console.log("Connection closed, reconnecting....")
            await start()
         } else if (reason === DisconnectReason.connectionLost) {
            console.log("Connection Lost from Server, reconnecting...")
            await start()
         } else if (reason === DisconnectReason.connectionReplaced) {
            console.log("Connection Replaced, Another New Session Opened, Please Close Current Session First")
            process.exit(1)
         } else if (reason === DisconnectReason.loggedOut) {
            console.log(`Device Logged Out, Please Scan Again And Run.`)
            process.exit(1)
         } else if (reason === DisconnectReason.restartRequired) {
            console.log("Restart Required, Restarting...")
            await start()
         } else if (reason === DisconnectReason.timedOut) {
            console.log("Connection TimedOut, Reconnecting...")
            process.send('reset')
         } else if (reason === DisconnectReason.multideviceMismatch) {
            console.log("Multi device mismatch, please scan again")
            process.exit(0)
         } else {
            console.log(reason)
            process.send('reset')
         }
      }

      if (connection === "open") {
         hisoka.sendMessage(config.options.owner[0] + "@s.whatsapp.net", {
            text: `${hisoka?.user?.name || "Hisoka"} has Connected...`,
         })
      }
   })

   // write session
   hisoka.ev.on("creds.update", saveCreds)

   // messages
   hisoka.ev.on("messages.upsert", async (message) => {
      if (!message.messages) return
      const m = await Serialize(hisoka, message.messages[0])
      await (await import(`./event/message.js?v=${Date.now()}`)).default(hisoka, m, message)
   })

   // group participants update
   hisoka.ev.on("group-participants.update", async (message) => {
      await (await import(`./event/group-participants.js?v=${Date.now()}`)).default(hisoka, message)
   })

   // group update
   hisoka.ev.on("groups.update", async (update) => {
      await (await import(`./event/group-update.js?v=${Date.now()}`)).default(hisoka, update)
   })

   // auto reject call when user call
   hisoka.ev.on("call", async (json) => {
      if (config.options.antiCall) {
         for (const id of json) {
            if (id.status === "offer") {
               let msg = await hisoka.sendMessage(id.from, {
                  text: `Maaf untuk saat ini, Kami tidak dapat menerima panggilan, entah dalam group atau pribadi\n\nJika Membutuhkan bantuan ataupun request fitur silahkan chat owner :p`,
                  mentions: [id.from],
               })
               hisoka.sendContact(id.from, config.options.owner, msg)
               await hisoka.rejectCall(id.id, id.from)
            }
         }
      }
   })

   // rewrite database every 30 seconds
   setInterval(async () => {
      if (global.db) await database.write(global.db)
   }, 30000) // write database every 30 seconds

   return hisoka
}

start()
