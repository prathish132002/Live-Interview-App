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
        model: 'gemini-2.0-flash',
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: { responseMimeType: "application/json", responseSchema: responseSchema },
    });

    return JSON.parse(response.text || "{}");
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
    let responseSchema;

    if (sessionType === 'interview') {
         resumePrompt = "You are an expert technical interviewer. Analyze this candidate's resume. Extract only the absolute most critical keywords required to conduct a technical interview: Candidate Name, Key Skills (max 10), Previous Roles (Title & Company only), and Project Highlights (1 short sentence max per project). Be extremely concise. Example output format is a JSON object with these fields.";
         responseSchema = {
             type: Type.OBJECT,
             properties: {
                 candidateName: { type: Type.STRING },
                 keySkills: { type: Type.ARRAY, items: { type: Type.STRING } },
                 previousRoles: { type: Type.ARRAY, items: { type: Type.STRING } },
                 projectHighlights: { type: Type.ARRAY, items: { type: Type.STRING } }
             }
         };
    } else {
         resumePrompt = "You are an expert presentation coach and fact-checker. Analyze these slides/document. Extract ONLY the most essential KEY FACTS, DATA POINTS, and DEFINITIONS (max 10 total items) to fact-check the presenter. Be extremely concise. Return a JSON object.";
         responseSchema = {
            type: Type.OBJECT,
            properties: {
                keyFactsAndDataPoints: { type: Type.ARRAY, items: { type: Type.STRING } },
                mainArguments: { type: Type.ARRAY, items: { type: Type.STRING } }
            }
        };
    }

    const resumeResponse = await ai.models.generateContent({
        model: 'gemini-1.5-flash',
        contents: [{
            role: 'user',
            parts: [
                { inlineData: { mimeType: 'application/pdf', data: base64Data } },
                { text: resumePrompt }
            ]
        }],
        config: {
            responseMimeType: "application/json",
            responseSchema: responseSchema
        }
    });
    
    // We convert the JSON back to a highly compressed string for the system prompt
    try {
        const parsed = JSON.parse(resumeResponse.text || "{}");
        if (sessionType === 'interview') {
            return `Name: ${parsed.candidateName || 'Unknown'}. Skills: ${(parsed.keySkills || []).join(', ')}. Roles: ${(parsed.previousRoles || []).join(', ')}. Projects: ${(parsed.projectHighlights || []).join(' | ')}`;
        } else {
            return `Facts: ${(parsed.keyFactsAndDataPoints || []).join(' | ')}. Arguments: ${(parsed.mainArguments || []).join(' | ')}`;
        }
    } catch (e) {
        return resumeResponse.text || ""; // fallback 
    }
};

export const generateNextQuestion = async (
    transcript: TranscriptEntry[],
    sessionType: string,
    role: string,
    topics: string,
    level: string,
    resumeAnalysis: string,
    apiKey: string
): Promise<string> => {
    const ai = new GoogleGenAI({ apiKey });
    
    const conversationHistory = transcript.map(t => `${t.speaker === 'user' ? 'Candidate' : 'Interviewer'}: ${t.text}`).join("\n\n");
    
    const interviewPrompt = `You are a ${level} level interviewer for a ${role} position. 
    Focus Topics: ${topics}.
    ${resumeAnalysis ? `Candidate Background Summary: ${resumeAnalysis}` : ""}
    
    CONVERSATION HISTORY:
    ${conversationHistory}
    
    TASK: As the interviewer, Provide the NEXT single interview question or follow-up based on the conversation history. 
    Stay in character. Be concise. Ask only ONE question. 
    If the conversation is just beginning, greet the user professionally and ask the first core question.`;

    const result = await ai.models.generateContent({
        model: 'gemini-1.5-flash',
        contents: [{ role: 'user', parts: [{ text: interviewPrompt }] }]
    });
    return result.text || "";
};
