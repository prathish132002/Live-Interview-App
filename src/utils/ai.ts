import { GoogleGenAI, Type } from "@google/genai";
import { TranscriptEntry, FeedbackData } from "../types";

export const generateFeedback = async (
    finalTranscript: TranscriptEntry[],
    sessionType: string,
    role: string,
    apiKey: string
): Promise<FeedbackData> => {
    if (finalTranscript.length === 0) {
        return { 
            summary: "No session data to analyze.", strengths: [], improvements: [], tips: [],
            overall: 0, relevance: 0, clarity: 0, conciseness: 0, technicalAccuracy: 0
        };
    }

    const ai = new GoogleGenAI({ apiKey });
    const fullTranscriptText = finalTranscript.map(entry => `${entry.speaker === 'user' ? 'Candidate' : 'Interviewer'}: ${entry.text}`).join('\n\n');
    
    const prompt = `Analyze this ${sessionType} transcript. Role: ${role}.
        TRANSCRIPT: ${fullTranscriptText}
        OUTPUT JSON: {summary, strengths[{strength, example}], improvements[{area, example, suggestion}], tips[], relevance(1-10), clarity(1-10), conciseness(1-10), technicalAccuracy(1-10), overall(1-10)}`;

    const responseSchema = {
        type: Type.OBJECT,
        properties: {
            summary: { type: Type.STRING },
            strengths: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { strength: { type: Type.STRING }, example: { type: Type.STRING } } } },
            improvements: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { area: { type: Type.STRING }, example: { type: Type.STRING }, suggestion: { type: Type.STRING } } } },
            tips: { type: Type.ARRAY, items: { type: Type.STRING } },
            relevance: { type: Type.INTEGER }, clarity: { type: Type.INTEGER }, conciseness: { type: Type.INTEGER }, technicalAccuracy: { type: Type.INTEGER }, overall: { type: Type.INTEGER },
        }
    };

    const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
        config: { responseMimeType: "application/json", responseSchema: responseSchema },
    });

    return JSON.parse(response.text);
};

export const analyzeResume = async (
    resumeFile: File,
    sessionType: string,
    apiKey: string
): Promise<string> => {
    const ai = new GoogleGenAI({ apiKey });
    const { fileToBase64 } = await import("./audio");
    const base64Data = await fileToBase64(resumeFile);
    
    let resumePrompt = "";
    if (sessionType === 'interview') {
         resumePrompt = "You are an expert technical interviewer. Analyze this candidate's resume. Extract the candidate's name (if available), key technical skills, detailed work history, and specifically the details of any projects mentioned. Provide a structured summary that an interviewer can use to ask specific, deep-dive questions about their actual experience. Focus on what they built, technologies used, and their specific role.";
    } else {
         resumePrompt = "You are an expert presentation coach and fact-checker. Analyze these slides/document. Extract a structured list of KEY FACTS, DATA POINTS, DEFINITIONS, and MAIN ARGUMENTS. I need to use this to fact-check the presenter in real-time if they say something wrong. Also summarize the intended narrative flow.";
    }

    const resumeResponse = await ai.models.generateContent({
        model: 'gemini-1.5-flash',
        contents: {
            parts: [
                { inlineData: { mimeType: 'application/pdf', data: base64Data } },
                { text: resumePrompt }
            ]
        }
    });
    return resumeResponse.text;
};
