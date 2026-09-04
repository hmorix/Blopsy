import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";

dotenv.config();

console.log("Starting test...\n");

const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
});

async function main() {

    try {

        const response = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: "Hello",
        });

        console.log("SUCCESS:\n");

        console.log(response.text);

    } catch (err) {

        console.log("FAILED:\n");

        console.log(err);

    }

}

main();