// FIX: The 'LiveSession' type is not exported from the '@google/genai' module.
// We can infer it from the 'ai.live.connect' method's return type for type safety.
import { GoogleGenAI, LiveServerMessage, Modality, Type } from "@google/genai";
type LiveSession = Awaited<ReturnType<InstanceType<typeof GoogleGenAI>["live"]["connect"]>>;
import React, { useState, useRef, useEffect } from 'react';
import { createRoot } from 'react-dom/client';

// --- AUDIO HELPER FUNCTIONS ---
function decode(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

async function decodeAudioData(data: Uint8Array, ctx: AudioContext, sampleRate: number, numChannels: number): Promise<AudioBuffer> {
  const dataInt16 = new Int16Array(data.buffer);
  const frameCount = dataInt16.length / numChannels;
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);

  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) {
      channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
    }
  }
  return buffer;
}

function encode(bytes: Uint8Array): string {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function createBlob(data: Float32Array): { data: string; mimeType: string } {
  const l = data.length;
  const int16 = new Int16Array(l);
  for (let i = 0; i < l; i++) {
    // Clamp values to avoid overflow/corruption which can cause issues
    const val = Math.max(-1, Math.min(1, data[i]));
    int16[i] = val < 0 ? val * 32768 : val * 32767;
  }
  return {
    data: encode(new Uint8Array(int16.buffer)),
    mimeType: 'audio/pcm;rate=16000',
  };
}

async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => {
        if (typeof reader.result === 'string') {
            resolve(reader.result.split(',')[1]);
        } else {
            reject(new Error('File reading failed'));
        }
    };
    reader.onerror = reject;
  });
}

// --- TYPES ---
interface TranscriptEntry {
    speaker: string;
    text: string;
}

interface FeedbackData {
    summary: string;
    strengths: string[];
    improvements: string[];
    tips: string[];
    overall: number;
    relevance: number;
    clarity: number;
    conciseness: number;
}

// --- REACT COMPONENTS ---

const App = () => {
    const [screen, setScreen] = useState('home'); // setup, briefing, interview, feedback, home
    const [settings, setSettings] = useState({
        role: 'Software Engineer',
        topics: 'React, TypeScript, and System Design',
        voice: 'Zephyr',
        language: 'English',
        mode: 'standard', // standard, timed
    });
    const [resumeFile, setResumeFile] = useState<File | null>(null);
    const [resumeAnalysis, setResumeAnalysis] = useState<string>('');
    const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [timeLeft, setTimeLeft] = useState<number | null>(null);
    const [briefingText, setBriefingText] = useState('');
    const [feedback, setFeedback] = useState<FeedbackData | null>(null);
    const [showFullTranscript, setShowFullTranscript] = useState(false);


    const sessionRef = useRef<LiveSession | null>(null);
    const timerRef = useRef<NodeJS.Timeout | null>(null);
    const isSessionActive = useRef(false);
    
    // Buffer to hold partial transcription data that hasn't been committed to state yet
    const transcriptionBuffer = useRef({ input: '', output: '' });

    const audioRefs = useRef<{
      inputAudioContext: AudioContext | null;
      outputAudioContext: AudioContext | null;
      stream: MediaStream | null;
      inputNode: GainNode | null;
      outputNode: GainNode | null;
      scriptProcessor: ScriptProcessorNode | null;
      source: MediaStreamAudioSourceNode | null;
    }>({
      inputAudioContext: null,
      outputAudioContext: null,
      stream: null,
      inputNode: null,
      outputNode: null,
      scriptProcessor: null,
      source: null,
    });
    
    useEffect(() => {
        if (timeLeft === null || timeLeft <= 0) {
            if (timerRef.current) clearInterval(timerRef.current);
            return;
        }

        timerRef.current = setInterval(() => {
            setTimeLeft(prevTime => (prevTime ? prevTime - 1 : 0));
        }, 1000);

        return () => {
          if (timerRef.current) clearInterval(timerRef.current);
        };
    }, [timeLeft]);

    // Cleanup audio resources properly to avoid "Network Error" due to max AudioContexts or conflicts
    const cleanupAudioResources = async () => {
        isSessionActive.current = false;
        if (timerRef.current) clearInterval(timerRef.current);
        
        if (sessionRef.current) {
            try {
                // Use close() but catch errors if session is already bad
                sessionRef.current.close(); 
            } catch (e) {
                console.debug("Session already closed or failed to close:", e);
            }
            sessionRef.current = null;
        }

        if (audioRefs.current.stream) {
            audioRefs.current.stream.getTracks().forEach(track => track.stop());
            audioRefs.current.stream = null;
        }

        if (audioRefs.current.scriptProcessor) {
            audioRefs.current.scriptProcessor.disconnect();
            audioRefs.current.scriptProcessor = null;
        }
        
        if(audioRefs.current.source) {
            audioRefs.current.source.disconnect();
            audioRefs.current.source = null;
        }

        // Close input context
        if (audioRefs.current.inputAudioContext && audioRefs.current.inputAudioContext.state !== 'closed') {
            try {
                await audioRefs.current.inputAudioContext.close();
            } catch (e) { console.error("Error closing input context", e); }
        }
        audioRefs.current.inputAudioContext = null;

        // Close output context
        if (audioRefs.current.outputAudioContext && audioRefs.current.outputAudioContext.state !== 'closed') {
             try {
                await audioRefs.current.outputAudioContext.close();
            } catch (e) { console.error("Error closing output context", e); }
        }
        audioRefs.current.outputAudioContext = null;
    };

    const handleStartInterview = async () => {
        setIsLoading(true);
        setScreen('briefing');
        setError(null);
        setBriefingText('');
        
        // Ensure clean state before starting briefing generation
        await cleanupAudioResources();

        let currentResumeAnalysis = '';

        try {
            const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
            
            if (resumeFile) {
                try {
                    const base64Data = await fileToBase64(resumeFile);
                    const resumePrompt = "You are an expert technical interviewer. Analyze this candidate's resume. Extract the candidate's name (if available), key technical skills, detailed work history, and specifically the details of any projects mentioned. Provide a structured summary that an interviewer can use to ask specific, deep-dive questions about their actual experience. Focus on what they built, technologies used, and their specific role.";
                    
                    const resumeResponse = await ai.models.generateContent({
                        model: 'gemini-2.5-flash',
                        contents: {
                            parts: [
                                { inlineData: { mimeType: 'application/pdf', data: base64Data } },
                                { text: resumePrompt }
                            ]
                        }
                    });
                    currentResumeAnalysis = resumeResponse.text;
                    setResumeAnalysis(currentResumeAnalysis);
                } catch (resumeErr: any) {
                    console.error("Resume analysis failed", resumeErr);
                }
            } else {
                setResumeAnalysis('');
            }

            let textPrompt = `Generate a short, friendly, and professional welcome message for a job interview. The role is '${settings.role}' and the topics are '${settings.topics}'. Welcome the candidate, state the role and topics, and wish them luck. The message must be entirely in ${settings.language}.`;
            
            if (currentResumeAnalysis) {
                textPrompt += `\n\nContext: The candidate has uploaded a resume. Here is the summary: ${currentResumeAnalysis}. Acknowledge that you have reviewed their resume and mention that you will be asking questions about their projects.`;
            }
            
            const textResponse = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: textPrompt,
            });
            const generatedText = textResponse.text;
            setBriefingText(generatedText);

            const audioResponse = await ai.models.generateContent({
                model: "gemini-2.5-flash-preview-tts",
                contents: [{ parts: [{ text: generatedText }] }],
                config: {
                    responseModalities: [Modality.AUDIO],
                    speechConfig: {
                        voiceConfig: { prebuiltVoiceConfig: { voiceName: settings.voice } },
                    },
                },
            });

            const base64Audio = audioResponse.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
            if (base64Audio) {
                audioRefs.current.outputAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
                const audioBuffer = await decodeAudioData(decode(base64Audio), audioRefs.current.outputAudioContext, 24000, 1);
                const source = audioRefs.current.outputAudioContext.createBufferSource();
                source.buffer = audioBuffer;
                source.connect(audioRefs.current.outputAudioContext.destination);
                source.start();
                source.onended = () => {
                    setIsLoading(false);
                };
            } else {
                setIsLoading(false);
            }
        } catch (err: any) {
            console.error("Failed to prepare briefing:", err);
            setError(`Failed to prepare briefing: ${err.message}. Please try again.`);
            setScreen('setup');
            setIsLoading(false);
        }
    };


    const startLiveSession = async () => {
        // Double check cleanup to ensure no lingering connections cause 503s
        await cleanupAudioResources();
        
        // Small delay to ensure browser releases mic fully
        await new Promise(resolve => setTimeout(resolve, 200));

        setIsLoading(true);
        setError(null);
        setTranscript([]);
        transcriptionBuffer.current = { input: '', output: '' }; // Reset buffer
        setTimeLeft(null);
        setFeedback(null);
        isSessionActive.current = true;

        try {
            const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

            audioRefs.current.inputAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
            // Important: Resume context immediately to avoid suspended state
            await audioRefs.current.inputAudioContext.resume();

            audioRefs.current.outputAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });

            audioRefs.current.stream = await navigator.mediaDevices.getUserMedia({ 
                audio: {
                    channelCount: 1,
                    sampleRate: 16000,
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                } 
            });

            let nextStartTime = 0;
            const sources = new Set<AudioBufferSourceNode>();
            
            // Structured Interview Logic
            let systemInstructionText = `
            You are an expert technical interviewer for the role of '${settings.role}' with a focus on '${settings.topics}'. 
            Language: ${settings.language} (STRICTLY).

            Follow this EXACT interview structure. Do not deviate.

            STAGE 1: WARM-UP
            - Ask 3 high-level behavioral warm-up questions (e.g., "Tell me about yourself","what is your strengths" "Why this role?").
            - Ask exactly ONE question at a time.
            - Wait for the candidate's answer.

            STAGE 2: RESUME DEEP-DIVE
            - After the 3rd warm-up question is answered, say exactly: "Now I'll review your resume and ask follow-ups."
            - Then, analyze the provided RESUME CONTEXT below.
            - Ask up to 5 targeted follow-up questions about specific projects, roles, or skills from the resume.
            - If the resume lacks details on a topic, politely say: "I don't see [topic] on your resume — could you elaborate?" then ask the question.
            - Ask ONE question at a time.

            STAGE 3: TECHNICAL
            - After the resume section, move to technical questions.
            - Ask 2-3 technical questions tied to the skills (${settings.topics}).
            - For coding concepts, propose a short scenario or task.
            - Ask ONE question at a time.

            STAGE 4: CLOSING
            - Provide a final short scorecard (Communication, Technical, Fit) and suggestions.

            CRITICAL RULES FOR EVERY TURN:
            1. AFTER EVERY CANDIDATE RESPONSE, you must provide:
               - Short Feedback (4-6 sentences).
               - A Suggested Improvement (actionable tips).
            2. ONLY THEN ask your next question.
            3. Keep questions concise.
            4. Be professional and friendly.
            `;
            
            if (resumeAnalysis) {
                systemInstructionText += `\n\n=== CANDIDATE RESUME CONTEXT ===\n${resumeAnalysis}\n================================`;
            } else {
                systemInstructionText += `\n\n(No resume provided. Skip Stage 2 specific references and ask general experience questions instead).`;
            }
            
            if (settings.mode === 'timed') {
                systemInstructionText += `\nNOTE: This is a timed interview. The user has 90 seconds to respond to each question.`
            }

            const sessionPromise = ai.live.connect({
                model: 'gemini-2.5-flash-native-audio-preview-09-2025',
                callbacks: {
                    onopen: () => {
                        if (!isSessionActive.current) return;
                        setIsLoading(false);
                        setScreen('interview');
                        
                        if (!audioRefs.current.inputAudioContext || !audioRefs.current.stream) return;
                        
                        const source = audioRefs.current.inputAudioContext.createMediaStreamSource(audioRefs.current.stream);
                        audioRefs.current.source = source;
                        
                        const scriptProcessor = audioRefs.current.inputAudioContext.createScriptProcessor(4096, 1, 1);
                        audioRefs.current.scriptProcessor = scriptProcessor;

                        scriptProcessor.onaudioprocess = (audioProcessingEvent) => {
                            if (!isSessionActive.current) return;
                            const inputData = audioProcessingEvent.inputBuffer.getChannelData(0);
                            const pcmBlob = createBlob(inputData);
                            sessionPromise.then((session) => {
                                if (isSessionActive.current) {
                                    session.sendRealtimeInput({ media: pcmBlob });
                                }
                            });
                        };
                        source.connect(scriptProcessor);
                        scriptProcessor.connect(audioRefs.current.inputAudioContext.destination);
                    },
                    onmessage: async (message: LiveServerMessage) => {
                       if (!isSessionActive.current) return;
                       
                       // Accumulate transcription in buffer
                       if (message.serverContent?.inputTranscription) {
                            transcriptionBuffer.current.input += message.serverContent.inputTranscription.text;
                        } 
                       if (message.serverContent?.outputTranscription) {
                            transcriptionBuffer.current.output += message.serverContent.outputTranscription.text;
                        }

                        if (message.serverContent?.turnComplete) {
                           // Commit buffer to state
                           const input = transcriptionBuffer.current.input.trim();
                           const output = transcriptionBuffer.current.output.trim();

                           if (input) {
                                setTranscript(prev => [...prev, { speaker: 'user', text: input }]);
                                if(timerRef.current) clearInterval(timerRef.current);
                                setTimeLeft(null);
                           }
                           if (output) {
                                setTranscript(prev => [...prev, { speaker: 'interviewer', text: output }]);
                                if (settings.mode === 'timed') {
                                    setTimeLeft(90);
                                }
                           }
                           
                           // Clear buffer
                           transcriptionBuffer.current.input = '';
                           transcriptionBuffer.current.output = '';
                        }

                        const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
                        if (base64Audio && audioRefs.current.outputAudioContext) {
                            const outputAudioContext = audioRefs.current.outputAudioContext;
                            nextStartTime = Math.max(nextStartTime, outputAudioContext.currentTime);
                            const audioBuffer = await decodeAudioData(decode(base64Audio), outputAudioContext, 24000, 1);
                            const source = outputAudioContext.createBufferSource();
                            source.buffer = audioBuffer;
                            source.connect(outputAudioContext.destination);
                            source.addEventListener('ended', () => sources.delete(source));
                            source.start(nextStartTime);
                            nextStartTime += audioBuffer.duration;
                            sources.add(source);
                        }
                    },
                    onerror: (e: ErrorEvent) => {
                        console.error('Session error:', e);
                        setError('Connection error: The service is currently unavailable or the connection was lost. Please refresh and try again.');
                        // Don't call stopInterview here as it might trigger recursive state updates
                        isSessionActive.current = false;
                        setIsLoading(false);
                    },
                    onclose: (e: CloseEvent) => {
                        console.log('Session closed.');
                        isSessionActive.current = false;
                    },
                },
                config: {
                    responseModalities: [Modality.AUDIO],
                    speechConfig: {
                        voiceConfig: { prebuiltVoiceConfig: { voiceName: settings.voice } },
                    },
                    // FIX: Pass string directly to systemInstruction to avoid strict type parsing errors on backend
                    systemInstruction: systemInstructionText,
                    inputAudioTranscription: {},
                    outputAudioTranscription: {},
                },
            });
            sessionRef.current = await sessionPromise;

        } catch (err: any) {
            console.error("Failed to start interview:", err);
            setError(`Failed to start interview: ${err.message}. Please check microphone permissions and try again.`);
            setIsLoading(false);
            cleanupAudioResources();
        }
    };
    
    const generateFeedback = async (finalTranscript: TranscriptEntry[]) => {
        if (finalTranscript.length === 0) {
            setFeedback({ 
                summary: "No interview data to analyze. The session was too short.", 
                strengths: [],
                improvements: [],
                tips: [],
                overall: 0, relevance: 0, clarity: 0, conciseness: 0 
            });
            return;
        }
        setIsLoading(true);
        setError(null);

        try {
            const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
            const fullTranscriptText = finalTranscript.map(entry => `${entry.speaker === 'user' ? 'Candidate' : 'Interviewer'}: ${entry.text}`).join('\n\n');
            
            const prompt = `As an expert hiring manager, analyze the following interview transcript for the role of '${settings.role}'. 
            
            TRANSCRIPT:
            ${fullTranscriptText}
            
            TASKS:
            1. Evaluate the candidate's answers based on Relevance, Clarity, and Conciseness (1-10).
            2. Provide a detailed summary.
            3. Identify 3 specific strengths demonstrated in the transcript.
            4. Identify 3 specific areas for improvement.
            5. Provide 3 actionable tips for the next interview.
            
            Output strictly in JSON.
            `;

            const responseSchema = {
                type: Type.OBJECT,
                properties: {
                    summary: { type: Type.STRING, description: "Executive summary of the candidate's performance." },
                    strengths: { type: Type.ARRAY, items: { type: Type.STRING }, description: "List of 3 specific strengths." },
                    improvements: { type: Type.ARRAY, items: { type: Type.STRING }, description: "List of 3 specific areas for improvement." },
                    tips: { type: Type.ARRAY, items: { type: Type.STRING }, description: "List of 3 actionable coaching tips." },
                    relevance: { type: Type.INTEGER, description: "Score 1-10" },
                    clarity: { type: Type.INTEGER, description: "Score 1-10" },
                    conciseness: { type: Type.INTEGER, description: "Score 1-10" },
                    overall: { type: Type.INTEGER, description: "Overall Score 1-10" },
                },
                required: ["summary", "strengths", "improvements", "tips", "relevance", "clarity", "conciseness", "overall"],
            };

            const response = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: prompt,
                config: {
                    responseMimeType: "application/json",
                    responseSchema: responseSchema,
                },
            });

            const feedbackData = JSON.parse(response.text);
            setFeedback(feedbackData);
            // Ensure the latest transcript is visible in the feedback screen
            setTranscript(finalTranscript);

        } catch (err: any) {
            console.error("Failed to generate feedback:", err);
            setError(`Failed to generate feedback: ${err.message}.`);
        } finally {
            setIsLoading(false);
        }
    };

    const stopInterview = async () => {
        // Capture final buffer state before cleaning up
        const finalInput = transcriptionBuffer.current.input.trim();
        const finalOutput = transcriptionBuffer.current.output.trim();
        
        const finalTranscript = [...transcript];
        
        // Flush any partial speech that wasn't "turned completed" yet
        if (finalInput) {
            finalTranscript.push({ speaker: 'user', text: finalInput });
        }
        if (finalOutput) {
            finalTranscript.push({ speaker: 'interviewer', text: finalOutput });
        }
        
        await cleanupAudioResources();
        setScreen('feedback');
        generateFeedback(finalTranscript);
    };

    const handleSettingsChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      const { name, value } = e.target;
      setSettings(prev => ({ ...prev, [name]: value }));
    };

    return (
        <>
            <style>{`
                :root {
                    --primary-color: #3A86FF;
                    --secondary-color: #FFBE0B;
                    --text-color: #333333;
                    --bg-start: #E0EFFF;
                    --bg-end: #F0E8FF;
                    --card-bg: rgba(255, 255, 255, 0.85);
                    --border-color: #E0E0E0;
                    --error-color: #FF3B30;
                    --success-color: #34C759;
                }
                body {
                    font-family: 'Poppins', sans-serif;
                    background: #f8f9fa; /* Replaced static gradient with neutral base for animation */
                    color: var(--text-color);
                    margin: 0;
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    min-height: 100vh;
                    -webkit-font-smoothing: antialiased;
                    -moz-osx-font-smoothing: grayscale;
                    overflow-x: hidden;
                }
                
                /* Dynamic Background Animation */
                .background-wrapper {
                    position: fixed;
                    top: 0;
                    left: 0;
                    width: 100%;
                    height: 100%;
                    z-index: -1;
                    overflow: hidden;
                }
                
                .orb {
                    position: absolute;
                    border-radius: 50%;
                    filter: blur(80px);
                    opacity: 0.7;
                    animation: float 20s infinite ease-in-out alternate;
                }
                
                .orb-1 {
                    top: -10%;
                    left: -10%;
                    width: 60vw;
                    height: 60vw;
                    background: radial-gradient(circle, #E0EFFF, #3A86FF 90%);
                    opacity: 0.4;
                    animation-duration: 25s;
                }
                
                .orb-2 {
                    bottom: -10%;
                    right: -10%;
                    width: 50vw;
                    height: 50vw;
                    background: radial-gradient(circle, #F0E8FF, #9b5de5 90%);
                    opacity: 0.3;
                    animation-delay: -5s;
                }
                
                .orb-3 {
                    top: 40%;
                    left: 40%;
                    width: 30vw;
                    height: 30vw;
                    background: radial-gradient(circle, #FFBE0B, transparent);
                    opacity: 0.2;
                    animation-duration: 18s;
                    animation-delay: -10s;
                }
                
                .grid-overlay {
                    position: absolute;
                    top: 0;
                    left: 0;
                    width: 100%;
                    height: 100%;
                    background-image: 
                        linear-gradient(rgba(58, 134, 255, 0.05) 1px, transparent 1px),
                        linear-gradient(90deg, rgba(58, 134, 255, 0.05) 1px, transparent 1px);
                    background-size: 60px 60px;
                    mask-image: radial-gradient(circle at center, black 40%, transparent 100%);
                    animation: pulseGrid 8s infinite alternate ease-in-out;
                    pointer-events: none;
                }
                
                @keyframes float {
                    0% { transform: translate(0, 0) rotate(0deg) scale(1); }
                    33% { transform: translate(30px, -40px) rotate(5deg) scale(1.1); }
                    66% { transform: translate(-20px, 20px) rotate(-5deg) scale(0.95); }
                    100% { transform: translate(0, 0) rotate(0deg) scale(1); }
                }

                @keyframes pulseGrid {
                    0% { opacity: 0.3; transform: scale(1); }
                    100% { opacity: 0.6; transform: scale(1.02); }
                }

                .container {
                    width: 100%;
                    max-width: 800px;
                    margin: 20px;
                    padding: 40px;
                    background-color: var(--card-bg);
                    backdrop-filter: blur(20px);
                    border-radius: 24px;
                    box-shadow: 0 16px 32px rgba(0,0,0,0.05);
                    border: 1px solid rgba(255, 255, 255, 0.6);
                    box-sizing: border-box;
                    transition: transform 0.3s ease, box-shadow 0.3s ease;
                }
                h1, h2 {
                    color: var(--primary-color);
                    text-align: center;
                    margin-bottom: 30px;
                    font-weight: 600;
                }
                 h1 {
                    font-size: 2.5rem;
                }
                h2 {
                    font-size: 2rem;
                }
                h3 {
                    font-size: 1.2rem;
                    font-weight: 600;
                    margin-bottom: 15px;
                }
                .form-group {
                    margin-bottom: 25px;
                }
                label {
                    display: block;
                    font-weight: 500;
                    margin-bottom: 10px;
                    color: #555;
                }
                input, select {
                    width: 100%;
                    padding: 14px;
                    border: 1px solid var(--border-color);
                    border-radius: 12px;
                    box-sizing: border-box;
                    font-family: 'Poppins', sans-serif;
                    font-size: 1rem;
                    background-color: #fff;
                    transition: border-color 0.2s, box-shadow 0.2s;
                }
                input:focus, select:focus {
                    outline: none;
                    border-color: var(--primary-color);
                    box-shadow: 0 0 0 3px rgba(58, 134, 255, 0.25);
                }
                input[type="file"] {
                    padding: 10px;
                    background-color: #fff;
                }
                input[type="file"]::file-selector-button {
                    margin-right: 15px;
                    padding: 8px 16px;
                    border-radius: 8px;
                    background-color: #e0e0e0;
                    border: none;
                    cursor: pointer;
                    font-family: inherit;
                    font-weight: 500;
                    color: var(--text-color);
                    transition: background-color 0.2s;
                }
                input[type="file"]::file-selector-button:hover {
                    background-color: #d0d0d0;
                }
                .button {
                    width: 100%;
                    padding: 15px;
                    font-size: 1.1rem;
                    font-weight: 600;
                    color: white;
                    background-color: var(--primary-color);
                    border: none;
                    border-radius: 12px;
                    cursor: pointer;
                    transition: background-color 0.3s, transform 0.2s ease-in-out;
                    margin-top: 10px;
                }
                .button:hover:not(:disabled) {
                    background-color: #3178E6;
                    transform: scale(1.02);
                    box-shadow: 0 4px 15px rgba(58, 134, 255, 0.3);
                }
                .button:active:not(:disabled) {
                    transform: scale(0.99);
                }
                .button:disabled {
                    background-color: #A9CBEF;
                    cursor: not-allowed;
                    transform: scale(1);
                    box-shadow: none;
                }
                .button.secondary {
                  background-color: #6c757d;
                  color: white;
                }
                .button.secondary:hover:not(:disabled) {
                  background-color: #5a6268;
                  box-shadow: 0 4px 15px rgba(0, 0, 0, 0.2);
                }
                .transcript-container {
                  height: 400px;
                  overflow-y: auto;
                  background-color: #f8f9fa;
                  border: 1px solid var(--border-color);
                  border-radius: 12px;
                  padding: 20px;
                  margin-bottom: 20px;
                }
                .transcript-bubble {
                  padding: 12px 18px;
                  border-radius: 20px;
                  margin-bottom: 12px;
                  max-width: 80%;
                  line-height: 1.5;
                }
                .transcript-bubble.user {
                  background-color: var(--primary-color);
                  color: white;
                  margin-left: auto;
                  border-bottom-right-radius: 5px;
                }
                .transcript-bubble.interviewer {
                  background-color: #E9ECEF;
                  color: var(--text-color);
                  margin-right: auto;
                  border-bottom-left-radius: 5px;
                }
                 .transcript-bubble strong {
                    display: block;
                    margin-bottom: 4px;
                    font-weight: 600;
                }
                .error {
                    color: var(--error-color);
                    text-align: center;
                    margin-top: 20px;
                    background-color: rgba(255, 59, 48, 0.1);
                    padding: 10px;
                    border-radius: 8px;
                }
                .timer {
                    text-align: center;
                    font-size: 2.2rem;
                    font-weight: 700;
                    margin-bottom: 20px;
                    color: var(--primary-color);
                    transition: color 0.5s ease;
                }
                .timer.warning {
                    color: var(--secondary-color);
                }
                .briefing-text {
                    background-color: #eaf2ff;
                    border-left: 5px solid var(--primary-color);
                    padding: 20px;
                    margin: 25px 0;
                    border-radius: 8px;
                    font-style: normal;
                    font-size: 1.05rem;
                    line-height: 1.6;
                    color: #445;
                }
                .feedback-container {
                    text-align: center;
                }
                .score-overall-container {
                    margin: 20px 0 40px;
                }
                .score-circle {
                    width: 150px;
                    height: 150px;
                    border-radius: 50%;
                    background: linear-gradient(135deg, rgba(255,255,255,0.5) 0%, rgba(255,255,255,0) 100%);
                    border: 10px solid;
                    border-image-slice: 1;
                    border-image-source: linear-gradient(to right, var(--primary-color), var(--secondary-color));
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    flex-direction: column;
                    margin: 0 auto;
                    font-size: 1.2rem;
                    color: var(--primary-color);
                    box-shadow: 0 8px 20px rgba(0,0,0,0.08);
                }
                .score-circle span {
                    font-size: 3.5rem;
                    font-weight: 700;
                    line-height: 1;
                }
                .scores-detailed {
                    display: flex;
                    justify-content: space-around;
                    margin-bottom: 30px;
                    padding-bottom: 20px;
                    border-bottom: 1px solid var(--border-color);
                }
                .score-item {
                    text-align: center;
                }
                .score-item h4 {
                    margin: 0 0 8px 0;
                    font-weight: 500;
                    color: #777;
                    font-size: 0.9rem;
                    text-transform: uppercase;
                }
                .score-item p {
                    margin: 0;
                    font-size: 1.8rem;
                    font-weight: 600;
                    color: var(--text-color);
                }
                .feedback-section {
                    text-align: left;
                    background-color: #f8f9fa;
                    padding: 20px;
                    border-radius: 12px;
                    margin-bottom: 20px;
                    box-shadow: 0 2px 8px rgba(0,0,0,0.03);
                }
                .feedback-section h3 {
                    margin-top: 0;
                    color: var(--primary-color);
                    border-bottom: 1px solid #e0e0e0;
                    padding-bottom: 10px;
                    margin-bottom: 15px;
                }
                .feedback-list {
                    padding-left: 20px;
                }
                .feedback-list li {
                    margin-bottom: 8px;
                    color: #444;
                    line-height: 1.5;
                }
                .feedback-summary {
                    text-align: left;
                    background-color: #f0f7ff;
                    padding: 25px;
                    border-radius: 12px;
                    margin-bottom: 30px;
                    border-left: 4px solid var(--primary-color);
                }
                
                .transcript-toggle {
                    background: none;
                    border: none;
                    color: #666;
                    text-decoration: underline;
                    cursor: pointer;
                    margin: 10px 0 20px;
                    font-size: 0.9rem;
                }
                
                .transcript-view {
                    text-align: left;
                    max-height: 300px;
                    overflow-y: auto;
                    background: white;
                    border: 1px solid #eee;
                    padding: 15px;
                    border-radius: 8px;
                    margin-bottom: 20px;
                    font-size: 0.9rem;
                }

                .spinner {
                  border: 4px solid #f3f3f3;
                  width: 40px;
                  height: 40px;
                  border-radius: 50%;
                  border-top-color: var(--primary-color);
                  animation: spin 1s linear infinite;
                  margin: 20px auto;
                }
                @keyframes spin {
                  0% { transform: rotate(0deg); }
                  100% { transform: rotate(360deg); }
                }

                /* New Styles for Home */
                .home-hero {
                    text-align: center;
                    padding: 20px 0;
                }
                .home-title {
                    font-size: 3rem;
                    color: var(--primary-color);
                    margin-bottom: 15px;
                    font-weight: 700;
                    letter-spacing: -1px;
                }
                .home-subtitle {
                    font-size: 1.2rem;
                    color: #666;
                    margin-bottom: 40px;
                    line-height: 1.6;
                    max-width: 600px;
                    margin-left: auto;
                    margin-right: auto;
                }
                .features-grid {
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
                    gap: 30px;
                    margin-bottom: 50px;
                }
                .feature-card {
                    background: rgba(255,255,255,0.6);
                    padding: 25px;
                    border-radius: 16px;
                    text-align: center;
                    border: 1px solid rgba(255,255,255,0.8);
                    transition: transform 0.3s ease;
                }
                .feature-card:hover {
                    transform: translateY(-5px);
                    background: rgba(255,255,255,0.9);
                    box-shadow: 0 10px 20px rgba(0,0,0,0.05);
                }
                .feature-icon {
                    font-size: 2.5rem;
                    margin-bottom: 15px;
                    display: block;
                }
                .feature-title {
                    font-weight: 600;
                    margin-bottom: 10px;
                    color: var(--text-color);
                    font-size: 1.1rem;
                }
                .feature-desc {
                    font-size: 0.9rem;
                    color: #777;
                    line-height: 1.5;
                }
                .start-btn-large {
                    padding: 18px 40px;
                    font-size: 1.3rem;
                    border-radius: 50px; /* Pill shape */
                    background: linear-gradient(90deg, var(--primary-color), #3178E6);
                    box-shadow: 0 10px 25px rgba(58, 134, 255, 0.4);
                }
                .start-btn-large:hover {
                    transform: translateY(-2px);
                    box-shadow: 0 15px 30px rgba(58, 134, 255, 0.5);
                }

                /* Tooltip Styles */
                .tooltip-container {
                    position: relative;
                    display: inline-block;
                    margin-left: 10px;
                    cursor: help;
                }
                .info-icon {
                    background: var(--primary-color);
                    color: white;
                    width: 20px;
                    height: 20px;
                    border-radius: 50%;
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 12px;
                    font-weight: bold;
                    font-family: serif;
                }
                .tooltip-content {
                    visibility: hidden;
                    width: 260px;
                    background-color: #444;
                    color: #fff;
                    text-align: left;
                    border-radius: 8px;
                    padding: 12px;
                    position: absolute;
                    z-index: 10;
                    bottom: 135%;
                    left: 50%;
                    margin-left: -130px;
                    opacity: 0;
                    transition: opacity 0.3s;
                    font-size: 0.85rem;
                    line-height: 1.5;
                    font-weight: normal;
                    box-shadow: 0 5px 15px rgba(0,0,0,0.2);
                }
                .tooltip-content::after {
                    content: "";
                    position: absolute;
                    top: 100%;
                    left: 50%;
                    margin-left: -6px;
                    border-width: 6px;
                    border-style: solid;
                    border-color: #444 transparent transparent transparent;
                }
                .tooltip-container:hover .tooltip-content {
                    visibility: visible;
                    opacity: 1;
                }
                .tooltip-content strong {
                    color: #FFBE0B;
                    display: inline-block;
                    margin-bottom: 2px;
                }

            `}</style>
            
            <div className="background-wrapper">
                <div className="orb orb-1"></div>
                <div className="orb orb-2"></div>
                <div className="orb orb-3"></div>
                <div className="grid-overlay"></div>
            </div>

            <div className="container">
                {screen === 'home' && (
                    <div className="home-hero">
                        <h1 className="home-title">Ace Your Interview</h1>
                        <p className="home-subtitle">
                            Master your communication skills with our AI-powered coach. 
                            Practice real-time conversations, get instant feedback, and build confidence.
                        </p>
                        
                        <div className="features-grid">
                            <div className="feature-card">
                                <span className="feature-icon">🎙️</span>
                                <div className="feature-title">Live Voice Simulation</div>
                                <div className="feature-desc">Interactive audio interviews that feel just like the real thing.</div>
                            </div>
                            <div className="feature-card">
                                <span className="feature-icon">📄</span>
                                <div className="feature-title">Resume Analysis</div>
                                <div className="feature-desc">Tailored questions based on your specific resume and projects.</div>
                            </div>
                            <div className="feature-card">
                                <span className="feature-icon">📊</span>
                                <div className="feature-title">Instant Feedback</div>
                                <div className="feature-desc">Detailed scoring on clarity, relevance, and conciseness.</div>
                            </div>
                        </div>

                        <button className="button start-btn-large" onClick={() => setScreen('setup')}>
                            Start Practicing Now
                        </button>
                    </div>
                )}
                {screen === 'setup' && (
                    <div>
                        <h1>Configure Interview</h1>
                        <div className="form-group">
                            <label htmlFor="role">Job Role</label>
                            <input type="text" id="role" name="role" value={settings.role} onChange={handleSettingsChange} />
                        </div>
                        <div className="form-group">
                            <label htmlFor="topics">Skills / Topics</label>
                            <input type="text" id="topics" name="topics" value={settings.topics} onChange={handleSettingsChange} />
                        </div>
                         <div className="form-group">
                            <label htmlFor="language">Interview Language</label>
                            <select id="language" name="language" value={settings.language} onChange={handleSettingsChange}>
                                <option value="English">English</option>
                                <option value="Hindi">Hindi</option>
                                <option value="Telugu">Telugu</option>
                                <option value="Spanish">Spanish</option>
                                <option value="French">French</option>
                                <option value="German">German</option>
                                <option value="Japanese">Japanese</option>
                            </select>
                        </div>
                        <div className="form-group">
                            <label htmlFor="voice">Interviewer Voice</label>
                            <select id="voice" name="voice" value={settings.voice} onChange={handleSettingsChange}>
                                <option value="Zephyr">Zephyr (Male)</option>
                                <option value="Puck">Puck (Male)</option>
                                <option value="Charon">Charon (Male)</option>
                                <option value="Kore">Kore (Female)</option>
                                <option value="Fenrir">Fenrir (Female)</option>
                            </select>
                        </div>
                        <div className="form-group">
                            <label htmlFor="mode" style={{ display: 'flex', alignItems: 'center' }}>
                                Practice Mode
                                <div className="tooltip-container">
                                    <span className="info-icon">i</span>
                                    <div className="tooltip-content">
                                        <strong>Standard:</strong> Natural conversation without strict time limits.<br/>
                                        <strong>Timed:</strong> You have 90 seconds to answer each question for pressure training.
                                    </div>
                                </div>
                            </label>
                            <select id="mode" name="mode" value={settings.mode} onChange={handleSettingsChange}>
                                <option value="standard">Standard Interview</option>
                                <option value="timed">Timed Response (90s)</option>
                            </select>
                        </div>
                         <div className="form-group">
                            <label htmlFor="resume">Upload Resume (PDF - Optional)</label>
                            <input 
                                type="file" 
                                id="resume" 
                                accept=".pdf" 
                                onChange={(e) => setResumeFile(e.target.files ? e.target.files[0] : null)} 
                            />
                        </div>
                        <button className="button" onClick={handleStartInterview} disabled={isLoading}>
                            {isLoading ? 'Preparing...' : 'Start Interview'}
                        </button>
                        {error && <p className="error">{error}</p>}
                    </div>
                )}
                {screen === 'briefing' && (
                    <div>
                        <h2>Interview Briefing</h2>
                        <div className="briefing-text">
                           {briefingText || 'Generating briefing...'}
                        </div>
                        <p style={{textAlign: 'center'}}>The AI interviewer will now provide a spoken welcome. Please listen.</p>
                        <button className="button" onClick={startLiveSession} disabled={isLoading}>
                            {isLoading ? 'Please Wait...' : 'Ready to Begin'}
                        </button>
                         {error && <p className="error">{error}</p>}
                    </div>
                )}
                {screen === 'interview' && (
                     <div>
                        <h2>Interview in Progress...</h2>
                        {settings.mode === 'timed' && timeLeft !== null && (
                            <div className={`timer ${timeLeft <= 10 ? 'warning' : ''}`}>
                                {timeLeft}s
                            </div>
                        )}
                        <div className="transcript-container">
                            {transcript.map((entry, index) => (
                                <div key={index} className={`transcript-bubble ${entry.speaker}`}>
                                    <strong>{entry.speaker === 'user' ? 'You' : 'Interviewer'}:</strong> {entry.text}
                                </div>
                            ))}
                        </div>
                        <button className="button secondary" onClick={stopInterview}>End Interview</button>
                    </div>
                )}
                 {screen === 'feedback' && (
                    <div>
                        <h2>Interview Feedback</h2>
                        {isLoading && (
                          <div>
                            <div className="spinner"></div>
                            <p style={{textAlign: 'center'}}>Analyzing your performance...</p>
                          </div>
                        )}
                        {error && <p className="error">{error}</p>}
                        {feedback && !isLoading && (
                            <div className="feedback-container">
                                <div className="score-overall-container">
                                    <div className="score-circle">
                                        <span>{feedback.overall}</span>/10
                                    </div>
                                    <h3>Overall Score</h3>
                                </div>

                                <div className="scores-detailed">
                                    <div className="score-item">
                                        <h4>Relevance</h4>
                                        <p>{feedback.relevance}/10</p>
                                    </div>
                                    <div className="score-item">
                                        <h4>Clarity</h4>
                                        <p>{feedback.clarity}/10</p>
                                    </div>
                                    <div className="score-item">
                                        <h4>Conciseness</h4>
                                        <p>{feedback.conciseness}/10</p>
                                    </div>
                                </div>

                                <div className="feedback-summary">
                                    <h3>Executive Summary</h3>
                                    <p>{feedback.summary}</p>
                                </div>
                                
                                <div className="feedback-section">
                                    <h3>💪 Strengths</h3>
                                    <ul className="feedback-list">
                                        {feedback.strengths.map((item, i) => <li key={i}>{item}</li>)}
                                    </ul>
                                </div>

                                <div className="feedback-section">
                                    <h3>📈 Areas for Improvement</h3>
                                    <ul className="feedback-list">
                                        {feedback.improvements.map((item, i) => <li key={i}>{item}</li>)}
                                    </ul>
                                </div>
                                
                                <div className="feedback-section">
                                    <h3>🚀 Actionable Tips</h3>
                                    <ul className="feedback-list">
                                        {feedback.tips.map((item, i) => <li key={i}>{item}</li>)}
                                    </ul>
                                </div>
                                
                                <button className="transcript-toggle" onClick={() => setShowFullTranscript(!showFullTranscript)}>
                                    {showFullTranscript ? "Hide Transcript" : "View Analyzed Transcript"}
                                </button>
                                
                                {showFullTranscript && (
                                    <div className="transcript-view">
                                        {transcript.map((entry, index) => (
                                            <div key={index} style={{marginBottom: '10px'}}>
                                                <strong>{entry.speaker === 'user' ? 'You' : 'Interviewer'}:</strong> {entry.text}
                                            </div>
                                        ))}
                                    </div>
                                )}

                                <button className="button" onClick={() => {
                                    setScreen('home');
                                    setTranscript([]);
                                    setFeedback(null);
                                    setResumeAnalysis('');
                                    setResumeFile(null);
                                    setShowFullTranscript(false);
                                }}>
                                    Back to Home
                                </button>
                            </div>
                        )}
                    </div>
                )}
            </div>
        </>
    );
};

const container = document.getElementById('root');
if (container) {
    const root = createRoot(container);
    root.render(<React.StrictMode><App /></React.StrictMode>);
}