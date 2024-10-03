import { headers } from "next/headers";
import Groq from "groq-sdk"; // Importing Groq SDK
import { z } from "zod";
import { zfd } from "zod-form-data";
import { createClient } from "@deepgram/sdk";
import fs from "fs";  // For file operations if needed

// Initialize the Deepgram and Groq clients
const deepgram = createClient(process.env.DEEPGRAM_API_KEY!);
const groq = new Groq(); // Assuming Groq SDK is properly initialized

// Zod schema to validate incoming form data
const schema = zfd.formData({
  input: z.union([zfd.text(), zfd.file()]),  // Input can be text or file
  message: zfd.repeatableOfType(
    zfd.json(
      z.object({
        role: z.enum(["user", "assistant"]),  // Role can be user or assistant
        content: z.string(),  // Content is the text of the message
      })
    )
  ),
});

// Main POST request handler
export async function POST(request: Request) {
  console.time("transcribe " + (request.headers.get("x-vercel-id") || "local"));

  const { data, success } = schema.safeParse(await request.formData());
  if (!success) return new Response("Invalid request", { status: 400 });

  const transcript = await getTranscript(data.input);
  if (!transcript) return new Response("Invalid audio", { status: 400 });

  console.timeEnd("transcribe " + (request.headers.get("x-vercel-id") || "local"));
  console.time("text completion " + (request.headers.get("x-vercel-id") || "local"));

  // Chat completion using Groq
  const completion = await groq.chat.completions.create({
    model: "llama3-8b-8192", // Model being used for chat completion
    messages: [
      {
        role: "system",
        content: `- You are Engli, a friendly and helpful english language training assistant.
        - You have to keep the user talking in an engaging way.
        - English communication skills can only be developed by talking and that's why you are
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
        content: transcript,  // Use the transcript as input for chat completion
      },
    ],
  });

  const response = completion.choices[0].message.content;
  console.timeEnd("text completion " + (request.headers.get("x-vercel-id") || "local"));

  console.time("deepgram request " + (request.headers.get("x-vercel-id") || "local"));

  try {
  // Making the Deepgram TTS request
  const ttsResponse = await deepgram.speak.request(
    { text: response },
    {
      model: "aura-asteria-en",  // Update model as necessary
      encoding: "linear16",
      container: "wav",
    }
  );

  // Get the audio stream and check if it's null
  const audioStream = await ttsResponse.getStream();

  if (!audioStream) {
    console.error("No audio stream returned from Deepgram TTS");
    return new Response("No audio stream", { status: 500 });
  }

  const audioBuffer = await getAudioBuffer(audioStream);  // Convert stream to buffer

  console.timeEnd("deepgram request " + (request.headers.get("x-vercel-id") || "local"));

  return new Response(audioBuffer, {
    headers: {
      "Content-Type": "audio/wav",
      "X-Transcript": encodeURIComponent(transcript),
      "X-Response": encodeURIComponent(response),
    },
  });
} catch (error) {
  console.error("Deepgram TTS error:", error);
  return new Response("Voice synthesis failed", { status: 500 });
}


// Helper function to convert audio stream to buffer
async function getAudioBuffer(stream: ReadableStream) {
  const reader = stream.getReader();
  const chunks = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  const dataArray = chunks.reduce(
    (acc, chunk) => Uint8Array.from([...acc, ...chunk]),
    new Uint8Array(0)
  );

  return Buffer.from(dataArray.buffer);
}

// Helper function to extract user's location from headers
function location() {
  const headersList = headers();
  const country = headersList.get("x-vercel-ip-country");
  const region = headersList.get("x-vercel-ip-country-region");
  const city = headersList.get("x-vercel-ip-city");

  if (!country || !region || !city) return "unknown";
  return `${city}, ${region}, ${country}`;
}

// Helper function to get the current time based on user's timezone
function time() {
  return new Date().toLocaleString("en-US", {
    timeZone: headers().get("x-vercel-ip-timezone") || undefined,
  });
}

// Helper function to get the transcript from audio or text input
async function getTranscript(input: string | File) {
  if (typeof input === "string") return input;

  try {
    const { text } = await groq.audio.transcriptions.create({
      file: input,
      model: "whisper-large-v3",  // Whisper model for transcription
    });

    return text.trim() || null;
  } catch {
    return null; // Handle audio transcription failure
  }
}
