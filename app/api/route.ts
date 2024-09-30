import Groq from "groq-sdk";
import { headers } from "next/headers";
import { z } from "zod";
import { zfd } from "zod-form-data";
import { unstable_after as after } from "next/server";
import { createClient } from "@deepgram/sdk";

const groq = new Groq();
const deepgram = createClient(process.env.DEEPGRAM_API_KEY!);

const schema = zfd.formData({
    input: z.union([zfd.text(), zfd.file()]),
    message: zfd.repeatableOfType(
        zfd.json(
            z.object({
                role: z.enum(["user", "assistant"]),
                content: z.string(),
            })
        )
    ),
});

export async function POST(request: Request) {
    console.time("transcribe " + request.headers.get("x-vercel-id") || "local");

    const { data, success } = schema.safeParse(await request.formData());
    if (!success) return new Response("Invalid request", { status: 400 });

    const transcript = await getTranscript(data.input);
    if (!transcript) return new Response("Invalid audio", { status: 400 });

    console.timeEnd(
        "transcribe " + request.headers.get("x-vercel-id") || "local"
    );
    console.time(
        "text completion " + request.headers.get("x-vercel-id") || "local"
    );

    const completion = await groq.chat.completions.create({
        model: "llama3-8b-8192",
        messages: [
            {
                role: "system",
                content: `- You are Engli, a friendly and helpful english language training assistant.
                - You have to keep the user talking in an engaging way.
                - English communication skills can only be developed by talking and thats why you are
                - Note down and clear any grammatical mistakes made by user
                - Respond briefly to the user's request, and do not provide unnecessary information.
                - If you don't understand the user's response, ask for clarification.
                - You do not have access to up-to-date information, so you should not provide real-time data.
                - You are not capable of performing actions other than responding to the user.
                - Do not use markdown, emojis, or other formatting in your responses. Respond in a way easily spoken by text-to-speech software.
                - User location is ${location()}.
                - The current time is ${time()}.
                `,
            },
            ...data.message,
            {
                role: "user",
                content: transcript,
            },
        ],
    });

    const response = completion.choices[0].message.content;
    console.timeEnd(
        "text completion " + request.headers.get("x-vercel-id") || "local"
    );

    console.time(
        "deepgram request " + request.headers.get("x-vercel-id") || "local"
    );

    try {
        const ttsResponse = await deepgram.speak.request(
            { text: response },
            {
                model: "aura-perseus-en",
                encoding: "linear16",
                container: "wav",
               
            }
        );

        const audioStream = await ttsResponse.getStream();
        const headers = await ttsResponse.getHeaders();

        console.timeEnd(
            "deepgram request " + request.headers.get("x-vercel-id") || "local"
        );

        console.time("stream " + request.headers.get("x-vercel-id") || "local");
        after(() => {
            console.timeEnd(
                "stream " + request.headers.get("x-vercel-id") || "local"
            );
        });

        return new Response(audioStream, {
            headers: {
                "Content-Type": "audio/wav",
                "X-Transcript": encodeURIComponent(transcript),
                "X-Response": encodeURIComponent(response),
                ...headers,
            },
        });
    } catch (error) {
        console.error("Deepgram TTS error:", error);
        return new Response("Voice synthesis failed", { status: 500 });
    }
}

function location() {
    const headersList = headers();

    const country = headersList.get("x-vercel-ip-country");
    const region = headersList.get("x-vercel-ip-country-region");
    const city = headersList.get("x-vercel-ip-city");

    if (!country || !region || !city) return "unknown";

    return `${city}, ${region}, ${country}`;
}

function time() {
    return new Date().toLocaleString("en-US", {
        timeZone: headers().get("x-vercel-ip-timezone") || undefined,
    });
}

async function getTranscript(input: string | File) {
    if (typeof input === "string") return input;

    try {
        const { text } = await groq.audio.transcriptions.create({
            file: input,
            model: "whisper-large-v3",
        });

        return text.trim() || null;
    } catch {
        return null; // Empty audio file
    }
}
