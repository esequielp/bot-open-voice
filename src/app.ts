import "dotenv/config"
import { join } from 'path'
import { fileURLToPath } from 'url';
import { createBot, createProvider, createFlow, addKeyword, EVENTS, utils } from '@builderbot/bot'
import { MemoryDB as Database } from '@builderbot/bot'
import { BaileysProvider as Provider } from '@builderbot/provider-baileys'
import { toAsk, httpInject } from "@builderbot-plugins/openai-assistants"
import { typing, recording, wait } from "./utils/presence"

import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';
import axios from 'axios';
import axiosical from 'axios';
import moment from 'moment-timezone';
import 'moment/locale/es.js';
import { encode } from 'gpt-3-encoder';
import express from 'express';
import fsdel from 'fs-extra';

let tiendaAbierta = true;
const PORT = process.env.PORT ?? 3011
const MAX_TOKENS = 500;
const ADMIN_NUMBER = process.env.ADMIN_NUMBER
const ASESOR_NUMBER = process.env.ASESOR_NUMBER
const ASSISTANT_ID = process.env?.ASSISTANT_ID ?? ''
const ASSISTANT_ID_DISCRIMINADOR = process.env?.ASSISTANT_ID_DISCRIMINADOR ?? ''
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? '';
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

const BUSSINESS_NAME = process.env.BUSSINESS_NAME ?? '';
const BUSSINESS_ADDRESS = process.env.BUSSINESS_ADDRESS ?? '';
const BUSSINESS_LAT: number = parseFloat(process.env.BUSSINESS_LAT as string);
const BUSSINESS_LONG: number = parseFloat(process.env.BUSSINESS_LONG as string);
const PAIS = process.env.PAIS ?? '';
const TIMEZONE_PAIS = process.env.TIMEZONE_PAIS ?? '';
const TIME_ZONE_HOUR = process.env.TIME_ZONE_HOUR ?? '';
const VOICE_ID = process.env.VOICE_ID ?? '';

const BASEROW_KEY = process.env.BASEROW_KEY ?? '';
const BASEROW_CUSTOMER_TABLE_ID = process.env.BASEROW_CUSTOMER_TABLE_ID ?? '';

const CAL_API_KEY = process.env.CAL_API_KEY ?? '';
const CAL_EVENT_TYPE_ID = parseInt(process.env.CAL_EVENT_TYPE_ID ?? '', 10);
axiosical.defaults.headers.common['Authorization'] = `Bearer ${CAL_API_KEY}`;
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const ASSISTANT_ID_AGENDA = process.env?.ASSISTANT_ID_AGENDA ?? ''


interface DistanceMatrixResponse {
    status: string;
    rows: Array<{
        elements: Array<{
            status: string;
            duration: { text: string; value: number };
            distance: { text: string; value: number };
            duration_in_traffic?: { text: string; value: number };
        }>;
    }>;
}

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const tmpDir = path.join(__dirname, 'tmp'); 
app.use('/tmp', express.static(tmpDir)); 

if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir);
}

// VERIFICA HORARIO DE ATENCION
const isWithinBusinessHours = () => {
    const now = moment().tz(TIMEZONE_PAIS);
    const day = now.day();
    const hour = now.hour();
    const minute = now.minute();
    const time = hour * 60 + minute; // Convertir a minutos

    const businessHours = {
        0: { start: 8 * 60, end: 17 * 60 }, // Domingo
        1: { start: 8 * 60, end: 17 * 60 }, // Lunes
        2: { start: 8 * 60, end: 17 * 60 }, // Martes
        3: { start: 8 * 60, end: 17 * 60 }, // Miércoles
        4: { start: 8 * 60, end: 17 * 60 }, // Jueves
        5: { start: 8 * 60, end: 17 * 60 }, // Viernes
    };

    const todayHours = businessHours[day];
    return time >= todayHours.start && time <= todayHours.end;
};

const outOfServiceFlow = addKeyword(EVENTS.ACTION)
    .addAnswer(`Lamentablemente, actualmente estamos fuera del horario de atención. 😔 Abrimos nuevamente en el siguiente horario:`)
    .addAnswer(`- Lunes a Viernes: 08:00 am - 05:00 pm`)
    .addAnswer(`Te responderé tan pronto como sea posible durante las próximas horas disponibles. Lamentamos cualquier inconveniente. 🙏`);

//ABRIR O CERRAR CHAT
const tiendaStatusFlow = addKeyword<Provider, Database>('openclose', { sensitive: true })
    .addAnswer('Por favor, selecciona una opción:\n\n1️⃣ Prender la tienda\n2️⃣ Apagar la tienda', { capture: true }, async (ctx, { state, flowDynamic }) => {
        const senderNumber = ctx.from;
        if (senderNumber !== ADMIN_NUMBER) {
            await flowDynamic('Este comando solo está disponible para el dueño de la tienda.');
            return;
        }

        const option = ctx.body.trim();
        if (option === '1') {
            tiendaAbierta = true;
            await flowDynamic('El chat esta ahora *activo* para atender.');
        } else if (option === '2') {
            tiendaAbierta = false;
            await flowDynamic('El chat esta ahora *apagado* para atender.');
        } else {
            await flowDynamic('No reconocí tu mensaje. Por favor responde con 1️⃣ Encender chat o 2️⃣ Apagar chat.');
        }
    });


const welcomeDiscriminadorFlow = addKeyword<Provider, Database>(EVENTS.WELCOME)
    .addAction(async (ctx, { flowDynamic, state, provider, gotoFlow }) => {
        try {
            await typing(ctx, provider);
            const response = await toAsk(ASSISTANT_ID_DISCRIMINADOR, ctx.body, state);
            const intent = response.trim().toLowerCase();
            switch (intent) {
                case 'agente':
                    return gotoFlow(humanAgentFlow);

                case 'ubicacion':
                    return gotoFlow(ubicacionFlow);

                case 'agenda':
                    return gotoFlow(scheduleMeetingFlow);

                case 'cancelar reunion':
                    return gotoFlow(cancelReagendarFlow);

                case 'asistenteia':
                default:
                    return gotoFlow(asistenteAiFlow);
            }
        } catch (error) {
            console.error("Error en welcomeDiscriminadorFlow:", error);
        }
    });

//FLUJO ASISTENTE IA    
const asistenteAiFlow = addKeyword<Provider, Database>(EVENTS.ACTION)
    .addAction(async (ctx, ctxFn) => {
        try {
            const name = ctx.name;
            await ctxFn.state.update({ name: ctx.body });
            let resolved = false;
            new Promise(resolve => {
                ctxFn.provider.vendor.ev.process(
                    async (events) => {
                        if (events.call && !resolved) {
                            const { id, chatId } = events.call[0];
                            await ctxFn.provider.vendor.rejectCall(id, chatId);
                            resolved = true;
                            await ctxFn.flowDynamic(`*${events.call[0].isVideo ? 'Video' : 'Audio'} las llamadas* no están permitidas! Disculpe...`);
                        }
                    }
                );
            });
        } catch (error) {
            console.error('Error durante la acción inicial:', error.message);
        }
    })
    .addAction(async (ctx, { flowDynamic, gotoFlow, state, provider }) => {
        try {
            const senderNumber = ctx.from;
            console.log('Estado del chat :', tiendaAbierta);
            if (!tiendaAbierta) {
                await flowDynamic("⏳ ¡Hola! En este momento lamentablemente no podemos atenderte. 😔\n\nIntenta en unos minutos, ¡Gracias por tu paciencia y comprensión! 🙏`");
                return;
            }
            /*  if (!isWithinBusinessHours() && senderNumber !== ASESOR_NUMBER) {
                 return gotoFlow(outOfServiceFlow);
             } */
            await typing(ctx, provider);

            const userMessage = ctx.body.trim();
            const tokenCount = encode(userMessage).length;

            if (tokenCount > MAX_TOKENS) {
                await flowDynamic([
                    { body: `🚫 Tu consulta es demasiado larga y podría ser costosa. Por favor, intenta acortar tu mensaje.` }
                ]);
                return;
            }

            let response;

            try {
                response = await toAsk(ASSISTANT_ID, ctx.body, state);
                const chunks = response.split(/\n\n+/);
                for (const chunk of chunks) {
                    await flowDynamic([{ body: chunk.trim() }]);
                }

            } catch (error) {
                console.error('Error durante la llamada a la API de OpenAI:', error.message);
                await provider.vendor.sendMessage(ASESOR_NUMBER, { text: "El chatbot está presentando problemas" });
                await provider.vendor.sendMessage(ASESOR_NUMBER, { text: JSON.stringify(error) });

                if (error.status === 400 && error.message.includes("run is active")) {
                    console.error('Active run error:', error);
                    await flowDynamic([{ body: "Por favor, espera un momento mientras procesamos tu solicitud. Intenta nuevamente en unos minutos. ¡Gracias por tu paciencia! 🙏😊" }]);
                    return;
                } else if (error.status === 404) {
                    console.error('Resource not found:', error);
                    await flowDynamic([{ body: "Por favor, espera un momento mientras procesamos tu solicitud. Intenta nuevamente en unos minutos. ¡Gracias por tu paciencia! 🙏😊" }]);
                    return;
                } else if (error.type === 'server_error') {
                    console.error('Server error:', error);
                    await flowDynamic([{ body: "Por favor, espera un momento mientras procesamos tu solicitud. Intenta nuevamente en unos minutos. ¡Gracias por tu paciencia! 🙏😊" }]);
                    return;
                } else {
                    console.error('Unexpected error:', error);
                    await flowDynamic([{ body: "Por favor, espera un momento mientras procesamos tu solicitud. Intenta nuevamente en unos minutos. ¡Gracias por tu paciencia! 🙏😊" }]);
                    return;
                }
            }

        } catch (error) {
            console.error('Error general en asistenteAiFlow:', error.message);
            await flowDynamic([{ body: "Ocurrió un error inesperado. Por favor, intenta nuevamente más tarde. 🙏" }]);
        }
    });

// NOTA DE VOZ
const voiceNoteFlow = addKeyword<Provider, Database>(EVENTS.VOICE_NOTE)
    .addAction(async (ctx, { flowDynamic, state, provider, gotoFlow }) => {
        await recording(ctx, provider);
        try {
            const localPath = await provider.saveFile(ctx, { path: process.cwd() });
            const audioData = fs.createReadStream(localPath);

            // Transcripción del audio usando OpenAI Whisper
            const transcribeResponse = await openai.audio.transcriptions.create({
                file: audioData,
                model: 'whisper-1',
            });
            const transcription = transcribeResponse.text.toLowerCase();
            console.log('Transcripción:', transcription);
            const askToAiResponse = await toAsk(ASSISTANT_ID, transcription, state);
            console.log('Respuesta de AI:', askToAiResponse);
            const isShortResponse = transcription.length < 500;
            const hasNoImages = !/\.(jpeg|jpg|gif|png)/i.test(transcription);

            if (isShortResponse && hasNoImages) {
                try {
                    const audioUrl = await noteToVoiceFlow(askToAiResponse);
                    await flowDynamic([{ media: audioUrl }]);
                    //fs.unlinkSync(audioUrl);
                } catch (audioError) {
                    console.error('Error al generar el audio:', audioError);
                    //await flowDynamic('Hubo un error al generar el audio. Por favor, intenta nuevamente.');
                }
            }
            const response = await toAsk(ASSISTANT_ID_DISCRIMINADOR, transcription, state);
            const intent = response.trim().toLowerCase();

            switch (intent) {
                case 'agente':
                    return gotoFlow(humanAgentFlow);

                case 'ubicacion':
                    return gotoFlow(ubicacionFlow);

                case 'agenda':
                    return gotoFlow(scheduleMeetingFlow);

                case 'cancelar reunion':
                    return gotoFlow(cancelReagendarFlow);

                default:
                    break;
            }
            fs.unlinkSync(localPath);
        } catch (error) {
            console.error('Error al procesar la nota de voz:', error);
            await flowDynamic([{ body: 'Hubo un error al procesar la nota de voz. Por favor, intenta nuevamente.' }]);
        }
    });


// FUNCION PARA CONVERTIR TEXTO A VOZ
const noteToVoiceFlow = async (text: string) => {
    const pathSave = join(process.cwd(), `speech-${Date.now()}.mp3`)
    try {
        const mp3 = await openai.audio.speech.create({
            model: "tts-1",
            voice: "nova",
            input: text,
        });

        const buffer = Buffer.from(await mp3.arrayBuffer());
        await fs.promises.writeFile(pathSave, buffer);
        return pathSave;
    } catch (error) {
        console.error('Error al generar el audio:', error);
        //throw new Error('Error al generar el audio');
    }
};

//FUNCION PARA CONVERTIR TEXTO A VOZ CON ACENTO DE PAIS USANDO ELEVENLABS
async function callElevenLabsAPI(text: string): Promise<string> {
    const apiKey = process.env.XI_API_KEY;
    const apiUrl = 'https://api.ia-sales.com/v1/elevenlabs/text-to-speech?enable_logging=true';

    const data = {
        text: text,
        voice_settings: {
            stability: 0.5,
            similarity_boost: 0.8,
            use_speaker_boost: true,
        },
        model_id: "eleven_turbo_v2_5",
        voice_id: VOICE_ID
    };

    try {
        const response = await axios.post(apiUrl, data, {
            headers: {
                'xi-api-key': apiKey,
                'Content-Type': 'application/json',
            }
        });

        if (response.data && response.data.audioUrl) {
            return response.data.audioUrl;
        } else {
            //throw new Error('No se recibió una URL de audio válida.');
            console.error('No se recibió una URL de audio válida.');
        }
    } catch (error) {
        console.error('Error al llamar a la API de ElevenLabs:', error.message);
        return "Error al generar el audio. Por favor, intenta nuevamente más tarde.";
    }
}

//TRANSFERIR A UN HUMANO    
const tranferFlow = addKeyword<Provider, Database>(EVENTS.ACTION)
    .addAction(async (ctx, { provider }) => {
        const number = ctx.from
        const name = ctx.name;
        await provider.vendor.sendMessage(ASESOR_NUMBER, {
            text: `🚨 *¡Atención!* 🚨\n\nEl usuario *${name}* (📞 +${number}) necesita asesoría. ¡Por favor, asístelo lo antes posible! 😊`
        })
    });

//FLUJO LA UBICACION    
const ubicacionFlow = addKeyword<Provider, Database>(EVENTS.ACTION)
    .addAnswer(`📢 Por favor, recuerda verificar los horarios de atención. 😊`, { delay: 1000 }, async (ctx, { provider }) => {
        await typing(ctx, provider);
    })
    .addAction(
        async (ctx, { provider, flowDynamic }) => {
            await typing(ctx, provider);
            const number = ctx.key.remoteJid
            await provider.vendor.sendMessage(
                number, {
                location: {
                    degreesLatitude: BUSSINESS_LAT,
                    degreesLongitude: BUSSINESS_LONG,
                    name: BUSSINESS_NAME,
                    address: BUSSINESS_ADDRESS
                }
            }
            );
            await flowDynamic([{ body: '¿Te gustaría que calculemos el tiempo estimado de llegada a nuestra oficina?\n1️⃣ Sí\n2️⃣ No' }]);
        }
    )
    .addAnswer('', { delay: 2000, capture: true }, async (ctx, { flowDynamic, gotoFlow }) => {
        const respuesta = ctx.body.trim();

        if (respuesta === '1') {
            await flowDynamic('Por favor, envía tu ubicación actual para calcular el tiempo estimado de llegada.');
        } else if (respuesta === '2') {
            await flowDynamic('¡Gracias! Si necesitas algo más, no dudes en pedirlo. 😊');
        } else {
            await flowDynamic('No entendí tu respuesta. Por favor responde con 1️⃣ Sí o 2️⃣ No.');
            return gotoFlow(ubicacionFlow);
        }
    });

//FLUJO CALCULO DE TIEMPO DE LLEGADA
const calcularTiempoLlegadaFlow = addKeyword<Provider, Database>(EVENTS.LOCATION)
    .addAnswer("📍¡Ubicación recibida! Estamos calculando el tiempo estimado de llegada...", null,
        async (ctx, { provider, flowDynamic }) => {
            await typing(ctx, provider);
            const userLatitude = ctx.message.locationMessage.degreesLatitude;
            const userLongitude = ctx.message.locationMessage.degreesLongitude;

            try {
                const response = await axios.get<DistanceMatrixResponse>('https://maps.googleapis.com/maps/api/distancematrix/json', {
                    params: {
                        origins: `${userLatitude},${userLongitude}`,
                        destinations: `${BUSSINESS_LAT},${BUSSINESS_LONG}`,
                        key: GOOGLE_MAPS_API_KEY,
                        mode: 'driving',
                        departure_time: 'now',
                        traffic_model: 'best_guess',
                        region: 'co',
                        units: 'metric'
                    }
                });

                if (response.data.status === 'OK') {
                    const elements = response.data.rows[0]?.elements[0];
                    if (elements && elements.status === 'OK') {
                        const travelTimeInMinutes = Math.round(elements.duration.value / 60);
                        const distanceText = elements.distance.text;
                        const distanceInKm = parseFloat(distanceText.replace(' km', ''));

                        await flowDynamic(`🚗 El tiempo estimado de llegada a nuestra oficina es de aproximadamente ${travelTimeInMinutes} minutos.  Distancia : ${distanceInKm} km.`);
                    } else {
                        await flowDynamic(`😔 Lo siento, no pudimos calcular el tiempo de llegada con la información proporcionada.`);
                    }
                } else {
                    await flowDynamic(`😔 Hubo un problema al calcular el tiempo de llegada. Por favor, intenta nuevamente.`);
                }
            } catch (error) {
                console.error('Error al calcular el tiempo de llegada:', error);
                await flowDynamic(`😔 Hubo un problema al procesar tu solicitud. Por favor, intenta nuevamente.`);
            }
        }
    );


//FLUJO PARA AGENDAR  
const collectUserInfoMeetingFlow = addKeyword<Provider, Database>(EVENTS.ACTION)
    .addAnswer(
        '📅 *¡Nos encantaría programar una cita contigo!*\n\nPor favor, primero indícanos tu nombre completo.',
        { capture: true },
        async (ctx, { state, provider, gotoFlow }) => {
            await typing(ctx, provider);

            const nombreGuardado = await state.get('nombre');
            if (!nombreGuardado) {
                await state.update({ nombre: ctx.body });
            }

            const emailGuardado = await state.get('email');
            if (emailGuardado) {
                return gotoFlow(scheduleMeetingFlow);
            }
        }
    )
    .addAnswer(
        '✉️ ¿Podrías compartirme tu email, por favor?',
        { capture: true },
        async (ctx, { state, fallBack, gotoFlow, flowDynamic }) => {
            const emailGuardado = await state.get('email');
            if (!emailGuardado) {
                const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
                if (!emailRegex.test(ctx.body)) {
                    return fallBack("🚫 Ups, parece que el email no es válido. ¿Podrías revisarlo?");
                } else {
                    await state.update({ email: ctx.body });
                    const userAlreadyHasMeetingThisWeek = await hasMeetingInSameWeek(emailGuardado, moment().format('YYYY-MM-DD'));
                    if (userAlreadyHasMeetingThisWeek) {
                        await flowDynamic([{ body: "🚫 Ya tienes una reunión programada para esta semana." }]);
                        return;
                    }
                }
            }
            return gotoFlow(scheduleMeetingFlow);
        }
    );

//FLUJO AGENDAR
const scheduleMeetingFlow = addKeyword<Provider, Database>(EVENTS.ACTION)
    .addAction(async (ctx, { state, provider, gotoFlow, flowDynamic }) => {
        await typing(ctx, provider);
        await state.update({ agenteHumano: false });
        await state.update({ scheduleMeeting: true });
        const telefono = ctx.from;

        try {
            const clienteData = await consultarCliente(telefono);
            if (!clienteData || clienteData.success === false) {
                await flowDynamic(clienteData.message || 'Disculpe Por favor, intenta más tarde.');
                return;
            }
            if (clienteData.results && clienteData.results.length > 0) {
                const nombreCliente = clienteData.results[0].Nombre;
                const emailCliente = clienteData.results[0].Email;
                await state.update({ nombre: nombreCliente });
                await state.update({ email: emailCliente });
            } else {
                // Redirigir al flujo de registro y luego volver a este flujo
                await state.update({ returnTo: 'scheduleMeetingFlow' }); // Guardamos la intención de volver al flujo
                return gotoFlow(registerCustomerFlow); // Redirigimos al registro
            }
            await flowDynamic([
                { body: '📅 *Horarios de Reuniones* 📅\n\nNuestro horario de reuniones es de:\n\n🕘 9:00 AM a 1:00 PM\n🕒 3:00 PM a 6:00 PM\n\nPor favor, elige una hora dentro de estos rangos para programar tu reunión. ¡Gracias! 😊' }
            ]);
            await flowDynamic('😊 Ahora, por favor ingresa la fecha y hora en uno de los siguientes formatos:\n\n- *20 agosto 9 am*\n- *mañana a las 3 pm*\n- *martes de la semana que viene a las 9 am*\n');

        } catch (error) {
            console.error('Error al consultar la información del cliente:', error);
        }
    })
    .addAnswer(
        '',
        { capture: true },
        async (ctx, { state, provider, flowDynamic, gotoFlow, fallBack }) => {
            try {
                const nomb = await state.get('nombre');
                const ema = await state.get('email');

                if (!nomb || !ema) {
                    return;
                }
                await typing(ctx, provider);
                const today = moment().format('DD/MM/YYYY');
                ctx.body = ctx.body.trim() + ', hoy es:' + today;

                const resp = await toAsk(ASSISTANT_ID_AGENDA, ctx.body, state);
                if (resp === 'null') {
                    return fallBack('🚫 Disculpa, hubo un error al verificar la fecha. Por favor, escribe uno de los formatos recomendados.');
                }

                await state.update({ fecha_resp: resp });

                const nombre = await state.get('nombre');
                const email = await state.get('email');

                const [date] = resp.split(' ');
                // Verifica si el usuario ya tiene una reunión en la semana
                const userAlreadyHasMeetingThisWeek = await hasMeetingInSameWeek(email, date);
                if (userAlreadyHasMeetingThisWeek) {
                    await flowDynamic([{ body: '🚫 Ya tienes una reunión programada para esta semana.' }]);
                    await state.update({ nombre: null, email: null, fecha: null, fecha_resp: null });
                    return gotoFlow(cancelReagendarFlow);
                }

                const fecha = convertirFormatoFecha(resp);
                await state.update({ fecha });

                // Mostrar la confirmación de los detalles al usuario
                await flowDynamic([
                    { body: `📋 Estos son los detalles de tu reunión:\n\n🧑 Nombre: *${nombre}*\n📧 Email: *${email}*\n📅 Fecha y hora: *${fecha}*` },
                ]);

                await flowDynamic([{ body: '✅ Si todo es correcto, por favor responde con:\n\n1️⃣ Sí\n2️⃣ No' }]);
            } catch (error) {
                console.error("Error en scheduleMeetingFlow:", error);
            }
        }
    )
    .addAnswer(
        '',
        { capture: true },
        async (ctx, { state, provider, gotoFlow, fallBack, flowDynamic }) => {
            await typing(ctx, provider);
            const confirmacion = ctx.body.trim().toLowerCase();
            if (confirmacion === '1' || confirmacion === 'sí') {
                return gotoFlow(confirmarReservaFlow);
            } else if (confirmacion === '2' || confirmacion === 'no') {
                await state.update({ nombre: null, email: null, fecha: null, fecha_resp: null });
                await flowDynamic([{ body: 'Vamos a volver a pedir tus datos para la reunión. 😊' }]);
                return gotoFlow(scheduleMeetingFlow);
            } else {
                return fallBack('😊 Por favor, responda con (1) Sí o (2) No para confirmar los datos.');
            }
        }
    );


// Flujo que confirma la reserva si los datos son correctos
const confirmarReservaFlow = addKeyword<Provider, Database>(EVENTS.ACTION)
    .addAction(async (ctx, { state, provider, flowDynamic, gotoFlow }) => {
        try {
            const nombre = await state.get('nombre');
            const email = await state.get('email');
            const fecha = await state.get('fecha_resp');
            const telefono = ctx.from;
            const [date, startTime] = fecha.split(' ');

            const availabilityResult = await checkAvailability(date, startTime);
            if (availabilityResult.message) {
                await flowDynamic(availabilityResult.message);
                return;
            }

            if (availabilityResult.available) {
                try {
                    const start = new Date(`${date}T${startTime}:${TIME_ZONE_HOUR}`).toISOString();
                    //const start = moment.tz(`${date}T${startTime}:${TIME_ZONE_HOUR}`, TIMEZONE_PAIS).toISOString();
                    const bookingData = {
                        responses: {
                            email: email,
                            name: nombre,
                            notes: `Teléfono: ${telefono}`,
                            guests: [],
                            phone: telefono
                        },
                        start: start,
                        eventTypeId: CAL_EVENT_TYPE_ID,
                        timeZone: TIMEZONE_PAIS,
                        language: 'es',
                        location: '',
                        metadata: {},
                        hasHashedBookingLink: false,
                        hashedLink: null
                    };

                    await axios.post(`https://api.cal.com/v1/bookings`, bookingData, {
                        params: {
                            apiKey: CAL_API_KEY
                        },
                        headers: {
                            'Content-Type': 'application/json'
                        }
                    });

                    await flowDynamic([{ body: '🎉 ¡Tu reunión ha sido reservada con éxito! 📧 No olvides revisar tu correo para más detalles. 😊' }]);

                    const formattedDate = moment(date).format('DD/MM/YYYY');
                    const formattedTime = moment(startTime, 'HH:mm').format('hh:mm A');

                    await provider.vendor.sendMessage(ASESOR_NUMBER, {
                        text: `📅 *¡Nueva Reunión Agendada!* 📅\n\nEl usuario *${nombre}* (📞 +${telefono}) ha programado una reunión para el *${formattedDate}* a la *${formattedTime}*.\n\n📧 Email: ${email}\n\n🔔 ¡Por favor, revisa y prepárate para la reunión! 😊`
                    });

                    await state.update({ nombre: null, email: null, fecha: null, fecha_resp: null });
                    return;
                } catch (error: any) {
                    console.error('Error al crear la reserva:', error.response?.data || error.message);
                    await flowDynamic([{ body: 'Ocurrió un error al crear la reserva. Inténtelo de nuevo.' }]);
                }
            } else {
                await flowDynamic([
                    { body: '🚫 Lo siento, la hora solicitada no está disponible.' },
                    {
                        body: availabilityResult.alternatives?.length
                            ? `Aquí tienes algunas horas alternativas disponibles para el mismo día:\n\n${availabilityResult.alternatives.map(time => `⏰ ${moment(time, 'HH:mm').format('hh:mm A')}`).join('\n')}`
                            : 'No hay alternativas disponibles en este día.'
                    }
                ]);
                return gotoFlow(scheduleMeetingFlow);
            }
        } catch (error) {
            console.error("Error en confirmarReservaFlow:", error);
        }
    });


// Cancelar o reagendar reunión
const cancelReagendarFlow = addKeyword<Provider, Database>(['cancelar', 'reagendar'])
    .addAction(
        async (ctx, { state, flowDynamic, provider, gotoFlow }) => {
            try {
                await state.update({ agenteHumano: false });
                await state.update({ scheduleMeeting: false });
                await state.update({ cancelMeeting: true });
                const telefono = ctx.from;
                const clienteData = await consultarCliente(telefono);
                if (!clienteData || clienteData.success === false) {
                    await flowDynamic(clienteData.message || 'Disculpe Por favor, intenta más tarde.');
                    return;
                }
                if (!clienteData.results || clienteData.results.length === 0) {
                    return gotoFlow(registerCustomerFlow);
                }

                const email = clienteData.results[0].Email;

                if (!validateEmail(email)) {
                    await flowDynamic('🚫 El correo recuperado no es válido. Por favor, contacta al soporte.');
                    return;
                }

                await state.update({ email });
                const booking = await getUpcomingMeetingByEmail(email);

                if (!booking) {
                    await flowDynamic('🔍 No se encontró ninguna reunión asociada a este correo.');
                    return;
                }

                const meetingDate = moment(booking.startTime).tz(TIMEZONE_PAIS).format('dddd, DD MMMM YYYY, h:mm A');
                await state.update({ meetingDate: meetingDate });
                await flowDynamic(`📅 Esta es la fecha de tu reunión: ${meetingDate}. ¿Qué deseas hacer? Escribe: 1 ó 2\n\n1️⃣ Cancelar la reunión\n2️⃣ Reagendar la reunión`);
            } catch (error) {
                console.error("Error en cancelReagendarFlow:", error);
                await flowDynamic('🚫 Hubo un error al procesar tu solicitud. Inténtalo más tarde.');
            }
        }
    )
    .addAnswer('', { capture: true }, async (ctx, { state, provider, flowDynamic, gotoFlow }) => {
        const option = ctx.body.trim();
        const email = await state.get('email');
        const name = ctx.name;
        const telefono = ctx.from;
        const date = await state.get('meetingDate');
        if (option === '1') {
            await cancelMeetingByEmail(email);
            await flowDynamic([
                { body: '✅ ¡Tu reunión ha sido cancelada con éxito! Si necesitas programar otra reunión o tienes alguna consulta, no dudes en contactarnos. ¡Estamos aquí para ayudarte! 😊' }
            ]);

            await provider.vendor.sendMessage(ASESOR_NUMBER, {
                text: `🚨 *¡Reunión Cancelada!* 🚨\n\nEl usuario *${name}* (📞 +${telefono}) ha cancelado su reunión programada para el *${date}*.\n\n📧 Email: ${email}\n\n🔔 Por favor, toma nota de esta cancelación.`
            });

        } else if (option === '2') {
            await flowDynamic('🔄 Vamos a reagendar tu reunión. ¡No te preocupes, es muy fácil! 😊');
            await cancelMeetingByEmail(email);
            await provider.vendor.sendMessage(ASESOR_NUMBER, {
                text: `📅 *¡Reunión Reagendada!* 📅\n\nEl usuario *${name}* (📞 +${telefono}) ha decidido reagendar su reunión programada para el *${date}*.\n\n📧 Email: ${email}\n\n🔔 Por favor, toma nota de esta cancelación.`
            });
            return gotoFlow(scheduleMeetingFlow);
        } else {
            await flowDynamic('⚠️ Opción no válida. Por favor selecciona 1️⃣ para cancelar o 2️⃣ para reagendar.');
        }
    });

//CONSULTA REUNIONES
async function getUpcomingMeetingByEmail(email: string) {
    try {
        const fechaActual = moment().format();
        const response = await axios.get(`https://api.cal.com/v1/bookings`, {
            params: {
                attendeeEmail: email,
                apiKey: CAL_API_KEY,
                eventTypeId: CAL_EVENT_TYPE_ID
            }
        });

        const bookings = response.data.bookings;
        const futureMeetings = bookings.filter((booking: any) => {
            const meetingDate = moment(booking.startTime);
            const isAfterGivenDate = meetingDate.isAfter(fechaActual);
            const isAccepted = booking.status === "ACCEPTED";
            return isAfterGivenDate && isAccepted;
        });

        // Ordenar las reuniones por la fecha más cercana
        const sortedMeetings = futureMeetings.sort((a: any, b: any) => {
            return moment(a.startTime).diff(moment(b.startTime));
        });

        if (sortedMeetings.length > 0) {
            //console.log("Próxima reunión encontrada: ", sortedMeetings[0]);
            return sortedMeetings[0];
        } else {
            //console.log("No se encontraron reuniones futuras.");
            return null;
        }
    } catch (error) {
        console.error('Error al obtener la reunión:', error);
        return null;
    }
}

// FUNCION PARA VALIDAR EMAILS
function validateEmail(email: string): boolean {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
}

// CANCELAR REUNION
async function cancelMeetingByEmail(email: string) {
    try {
        const booking = await getUpcomingMeetingByEmail(email);
        //console.log("este es el booking id : " + booking.id);
        if (booking) {
            await axios.delete(`https://api.cal.com/v1/bookings/${booking.id}`, {
                params: {
                    apiKey: process.env.CAL_API_KEY
                }
            });
            return true;
        }
    } catch (error) {
        console.error('Error al cancelar la reunión:', error);
    }
    return false;
}
//FUNCION PARA CONVERTIR EL FORMATO DE FECHA
function convertirFormatoFecha(fecha: string): string {
    const [fechaPart, horaPart] = fecha.split(' ');
    const [año, mes, dia] = fechaPart.split('-');
    const [hora, minutos] = horaPart.split(':');

    let periodo = 'AM';
    let horaInt = parseInt(hora, 10);

    if (horaInt >= 12) {
        periodo = 'PM';
        if (horaInt > 12) {
            horaInt -= 12;
        }
    } else if (horaInt === 0) {
        horaInt = 12;
    }
    const hora12 = `${horaInt.toString().padStart(2, '0')}:${minutos} ${periodo}`;
    return `${dia}/${mes}/${año} ${hora12}`;
}

//FUNCION PARA CHEQUEAR SI UN USUARIO TIENE UNA REUNION EN LA SEMANA
async function hasMeetingInSameWeek(email: string, targetDate: string): Promise<boolean> {
    const targetMoment = moment(targetDate).tz(TIMEZONE_PAIS);
    const startOfTargetWeek = targetMoment.clone().startOf('isoWeek').toISOString();
    const endOfTargetWeek = targetMoment.clone().endOf('isoWeek').toISOString();

    console.log('Semana objetivo:', startOfTargetWeek, '-', endOfTargetWeek);

    const response = await axios.get('https://api.cal.com/v1/bookings', {
        params: {
            apiKey: process.env.CAL_API_KEY,
            attendeeEmail: email
        }
    });

    const bookings = response.data.bookings;
    console.log('Reuniones encontradas:', bookings.length);

    const meetingsInSameWeek = bookings.filter((booking: any) => {
        const meetingStartTime = moment(booking.startTime).tz(TIMEZONE_PAIS);
        return meetingStartTime.isBetween(startOfTargetWeek, endOfTargetWeek, null, '[]') && booking.status === "ACCEPTED";
    });
    console.log('Reuniones en la misma semana:', meetingsInSameWeek.length);

    return meetingsInSameWeek.length > 0;
}

//FUNCION QUE VERIFICA LA DISPONIBILIDAD EN EL CALENDARIO
async function checkAvailability(date: string, startTime: string): Promise<{ available: boolean; alternatives?: string[], message?: string }> {
    const formattedStartTime = moment(`${date}T${startTime}:${TIME_ZONE_HOUR}`).format('HH:mm');
    const endDate = moment(date).add(1, 'day').format('YYYY-MM-DD');
    try {
        const slotsResponse = await axios.get(`https://api.cal.com/v1/slots`, {
            params: {
                eventTypeId: CAL_EVENT_TYPE_ID,
                startTime: date,
                endTime: endDate,
                timeZone: TIMEZONE_PAIS,
                apiKey: CAL_API_KEY,
            }
        });

        const slots = slotsResponse.data.slots[date] || [];
        const availableSlots = slots.map(slot => moment(slot.time).format('HH:mm'));
        console.log('Slots disponibles:', availableSlots);
        const isAvailable = availableSlots.includes(formattedStartTime);

        if (isAvailable) {
            return { available: true };
        } else {
            return { available: false, alternatives: availableSlots };
        }
    } catch (error) {
        console.error('Error checking availability:', error.message);
        // Devuelve un mensaje amigable al usuario en lugar de lanzar el error
        return { available: false, alternatives: [], message: "Hubo un problema al verificar la disponibilidad. Por favor, intenta nuevamente más tarde." };
    }
}

// FLUJO PARA REDIRIGIR A EL AGENTE HUMANO
const humanAgentFlow = addKeyword<Provider, Database>('humano')
    .addAction(async (ctx, { state, flowDynamic, gotoFlow }) => {
        await state.update({ scheduleMeeting: false });
        await state.update({ agenteHumano: true });
        const telefono = ctx.from;
        const name = ctx.name;
        try {
            const clienteData = await consultarCliente(telefono);
            if (!clienteData || clienteData.success === false) {
                await flowDynamic(clienteData.message || 'Disculpe Por favor, intenta más tarde.');
                return;
            }
            if (clienteData.results && clienteData.results.length > 0) {
                const nombreCliente = clienteData.results[0].Nombre;
                await flowDynamic([{ body: `${nombreCliente},🙌 Un Asesor 🧑‍💼 ha sido notificado y se pondrá en contacto con usted en breve. ¡Gracias por su paciencia!!🙏` }]);
                return gotoFlow(tranferFlow);
            } else {
                return gotoFlow(registerCustomerFlow);
            }
        } catch (error) {
            console.error('Error al consultar la información del cliente:', error);
        }
    })

//CONSULTAR CLIENTE, VERIFICA SI EXISTE EN BASEROW.IO
async function consultarCliente(telefono) {
    const url = `https://api.baserow.io/api/database/rows/table/${BASEROW_CUSTOMER_TABLE_ID}/?user_field_names=true&search=${telefono}`;
    const headers = {
        'Authorization': `Token ${BASEROW_KEY}`,
        'Content-Type': 'application/json'
    };
    try {
        const response = await axios.get(url, { headers });
        return response.data;
    } catch (error) {
        console.error('Error al consultar la API de Baserow:', error);
        return { success: false, message: "Error al consultar los datos del cliente. Por favor, intenta nuevamente más tarde." };
    }
}
//REGISTRAR CLIENTE EN BASEROW.IO 
const registerCustomerFlow = addKeyword(EVENTS.ACTION)
    .addAnswer('😊 ¿Me podrías indicar tu nombre completo, por favor?', { capture: true }, async (ctx, { state }) => {
        await state.update({ nombre: ctx.body });
    })
    .addAnswer('✉️ ¿Podrías compartirme tu email, por favor?', { capture: true }, async (ctx, { state, fallBack }) => {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(ctx.body)) {
            return fallBack("🚫 Ups, parece que el email no es válido. ¿Podrías revisarlo?");
        } else {
            await state.update({ email: ctx.body });
        }
    })
    .addAction(async (ctx, { gotoFlow, flowDynamic, state }) => {
        const telefono = ctx.from ? ctx.from : 'Número no disponible';

        const data = {
            "Telefono": telefono,
            "Activo": true,
            "Nombre": state.get('nombre'),
            "Email": state.get('email')
        };

        try {
            await axios.post(`https://api.baserow.io/api/database/rows/table/${BASEROW_CUSTOMER_TABLE_ID}/?user_field_names=true`, data, {
                headers: {
                    'Authorization': `Token ${BASEROW_KEY}`,
                    'Content-Type': 'application/json'
                }
            });


            if (state.get('returnTo')) {
                return gotoFlow(scheduleMeetingFlow);
            }
            if (state.get('agenteHumano')) {
                await flowDynamic('¡Muchas gracias! 🙌 En unos minutos, un representante de ventas 🧑‍💼 se pondrá en contacto contigo.');
                return gotoFlow(tranferFlow);
            }
            if (state.get('cancelMeeting')) {
                return gotoFlow(cancelReagendarFlow);
            }

        } catch (error) {
            console.error('Error al conectar con la API de Baserow:', error);
        }
    });

//FLUJO PARA BLOQUEAR UN USUARIO
const blockUserFlow = addKeyword<Provider, Database>('mute', { sensitive: true })
    .addAnswer('😊 Por favor, ingresa el número que deseas silenciar:', { capture: true }, async (ctx, { flowDynamic, state, provider }) => {
        await typing(ctx, provider);
        const senderNumber = ctx.from;
        if (senderNumber !== ADMIN_NUMBER) {
            await flowDynamic('Este comando solo está disponible para el dueño de la tienda.');
            return;
        }

        await state.update({ numberToBlock: senderNumber });
        await flowDynamic(`¿Qué te gustaría hacer con el número ${senderNumber}?\n\n1️⃣ Bloquear el número\n2️⃣ Desbloquear el número`);
    })
    .addAnswer('', { capture: true }, async (ctx, { flowDynamic, blacklist, state, fallBack, provider }) => {
        await typing(ctx, provider);
        const action = ctx.body.trim();
        const numberToBlock = state.get('numberToBlock');

        if (action === '1') {
            blacklist.add(numberToBlock);
            await flowDynamic(`🚫 ¡El número ${numberToBlock} ha sido silenciado exitosamente!`);
        } else if (action === '2') {
            blacklist.remove(numberToBlock);
            await flowDynamic(`✅ ¡El número ${numberToBlock} ha sido desbloqueado exitosamente!`);
        } else {
            return fallBack('😅 Lo siento, no entendí. Por favor, responde con 1️⃣ para bloquear o 2️⃣ para desbloquear.');
        }
    });

//LIMPIAR DIRECTORIO TMP    
async function cleanMp3Files() {
    const rootDir = process.cwd(); // Obtiene el directorio raíz del proyecto

    try {
        const files = await fs.promises.readdir(rootDir); // Lee todos los archivos en el directorio raíz

        for (const file of files) {
            const filePath = path.join(rootDir, file);

            // Verifica si el archivo tiene extensión .mp3 o .opus
            if (file.endsWith('.mp3') || file.endsWith('.opus')) {
                await fs.promises.unlink(filePath); // Elimina el archivo
                console.log(`Archivo eliminado: ${filePath}`);
            }
        }

        console.log('Archivos .mp3 y .opus eliminados con éxito.');
    } catch (error) {
        console.error('Error al limpiar el directorio:', error);
    }
}


const main = async () => {
    const adapterFlow = createFlow([
        tiendaStatusFlow,
        welcomeDiscriminadorFlow,
        asistenteAiFlow,
        voiceNoteFlow,
        humanAgentFlow,
        tranferFlow,
        ubicacionFlow,
        calcularTiempoLlegadaFlow,
        scheduleMeetingFlow,
        collectUserInfoMeetingFlow,
        confirmarReservaFlow,
        cancelReagendarFlow,
        registerCustomerFlow,
        blockUserFlow
    ]);
    const adapterProvider = createProvider(Provider, {
        experimentalSyncMessage: 'Ups vuelvelo a intentar',
    });
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

// Ejecutar cada 12 horas
setInterval(() => {
    console.log('Ejecutando limpieza de /...');
    cleanMp3Files().catch(error => console.error('Error en limpieza de /:', error));
}, 60 * 1000);
//}, 12 * 60 * 60 * 1000); // 12 horas en milisegundos
