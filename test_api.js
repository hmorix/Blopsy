import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";

dotenv.config();

console.log("Starting Gemini test...\n");

const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
});

async function testGemini() {

    try {

        const response = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: "Say hello in one line.",
        });

        console.log("✅ SUCCESS\n");

        console.log(response.text);

    } catch (error) {

        console.log("❌ ERROR\n");

        console.log(error);

    }
}

testGemini();