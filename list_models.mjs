//  this script use for get to know your ai api key model name

import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";

dotenv.config();

const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
});

async function listModels() {

    try {

        const models = await ai.models.list();

        console.log("\nAVAILABLE MODELS:\n");

        for await (const model of models) {
            console.log(model.name);
        }

    } catch (err) {

        console.log(err);

    }
}

listModels();