import { createBot, createProvider, createFlow, addKeyword } from '@builderbot/bot'
import { MemoryDB as Database } from '@builderbot/bot'
import { BaileysProvider as Provider } from '@builderbot/provider-baileys'
import { generateAudio } from './openai'
import { typing, recording } from "./utils/presence"
import { join } from 'path'

const PORT = process.env.PORT ?? 3009

const welcomeFlow = addKeyword<Provider, Database>(['hi', 'hello', 'hola'])
    .addAnswer(`te voy enviar audio...`)
    .addAction(async (ctx, { flowDynamic }) => {
        const text = `Hola ${ctx.name} como estas? Bienvenido a builderbot esto es una prueba de como se comporta la api de openai`
        const path = await generateAudio(text)
        await flowDynamic([{
            media: path
        }])
    })

//ARCHIVOS MEDIA
const mediaFlow = addKeyword<Provider, Database>('enviar_media', { sensitive: true })
    .addAnswer(`Send image from Local`, { media: join(process.cwd(), 'assets', 'sample.png') })
    .addAction(async (ctx, { provider }) => {
        await typing(ctx, provider);
    })
    .addAnswer(`💪 Estos son los tipos de archivos que puedes enviar...`, { delay: 500 })
    .addAction(async (ctx, { provider }) => {
        await typing(ctx, provider);
    })
    .addAnswer(`Imagenes: .jpg, .png`, { media: join(process.cwd(), 'assets', 'AI-SALES-SERVICES.png'), delay: 500 })
    .addAction(async (ctx, { provider }) => {
        await recording(ctx, provider);
    })
    .addAnswer(`Audios: .mp3`, { media: join(process.cwd(), 'assets', 'aisales-chatbot-audio.mp3'), delay: 500 })
    .addAction(async (ctx, { provider }) => {
        await typing(ctx, provider);
    })
    .addAnswer(`Archivos: .pdf`, { media: join(process.cwd(), 'assets', 'AI_SALES_Info.pdf'), delay: 500 })
    .addAction(async (ctx, { provider }) => {
        await typing(ctx, provider);
    })
    .addAnswer(`Videos: .mp4`, { media: join(process.cwd(), 'assets', 'Ai-Sales-Video.mp4'), delay: 10000 })
    .addAction(async (ctx, { provider }) => {
        await typing(ctx, provider);
    })
    .addAnswer(
        "🎉\n ¡No dejes pasar esta oportunidad! 🎉\n\n" +
        "Mejora la interacción con tus clientes y aumenta tus ventas con nuestros planes de Asistente IA de **AI-SALES.COM**.\n\n" +
        "✨ **AI-SALES Basic:** $120 mensual\n" +
        "✨ **AI-SALES Pro:** $150 mensual\n\n" +
        "🔥 Aprovecha descuentos exclusivos pagando por adelantado.\n\n" +
        "📅 ¿Listo para asegurar el crecimiento de tu negocio? Presiona 5 para comprar ahora! 😊"
    )


const main = async () => {
    const adapterFlow = createFlow([welcomeFlow,mediaFlow])

    const adapterProvider = createProvider(Provider)
    const adapterDB = new Database()

    const { handleCtx, httpServer } = await createBot({
        flow: adapterFlow,
        provider: adapterProvider,
        database: adapterDB,
    })

    adapterProvider.server.post(
        '/v1/messages',
        handleCtx(async (bot, req, res) => {
            const { number, message, urlMedia } = req.body
            await bot.sendMessage(number, message, { media: urlMedia ?? null })
            return res.end('sended')
        })
    )

    adapterProvider.server.post(
        '/v1/register',
        handleCtx(async (bot, req, res) => {
            const { number, name } = req.body
            await bot.dispatch('REGISTER_FLOW', { from: number, name })
            return res.end('trigger')
        })
    )

    adapterProvider.server.post(
        '/v1/samples',
        handleCtx(async (bot, req, res) => {
            const { number, name } = req.body
            await bot.dispatch('SAMPLES', { from: number, name })
            return res.end('trigger')
        })
    )

    adapterProvider.server.post(
        '/v1/blacklist',
        handleCtx(async (bot, req, res) => {
            const { number, intent } = req.body
            if (intent === 'remove') bot.blacklist.remove(number)
            if (intent === 'add') bot.blacklist.add(number)

            res.writeHead(200, { 'Content-Type': 'application/json' })
            return res.end(JSON.stringify({ status: 'ok', number, intent }))
        })
    )

    httpServer(+PORT)
}

main()
