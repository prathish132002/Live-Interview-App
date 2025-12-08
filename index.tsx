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

interface StrengthPoint {
    strength: string;
    example: string; // Quote
}

interface ImprovementPoint {
    area: string;
    example: string; // Quote
    suggestion: string; // Actionable fix
}

interface FeedbackData {
    summary: string;
    strengths: StrengthPoint[];
    improvements: ImprovementPoint[];
    tips: string[];
    overall: number;
    relevance: number;
    clarity: number;
    conciseness: number;
    technicalAccuracy: number;
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
        level: 'Intermediate' 
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
    const [showPermissionModal, setShowPermissionModal] = useState(false);
    const [permissionDenied, setPermissionDenied] = useState(false);
    const [recordedVideoUrl, setRecordedVideoUrl] = useState<string | null>(null);
    const [isMuted, setIsMuted] = useState(false);
    const [isCameraOff, setIsCameraOff] = useState(false);
    const [darkMode, setDarkMode] = useState(true);

    const sessionRef = useRef<LiveSession | null>(null);
    const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const isSessionActive = useRef(false);
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    
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
      mediaRecorder: MediaRecorder | null;
      recordedChunks: Blob[];
    }>({
      inputAudioContext: null,
      outputAudioContext: null,
      stream: null,
      inputNode: null,
      outputNode: null,
      scriptProcessor: null,
      source: null,
      mediaRecorder: null,
      recordedChunks: [],
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

    useEffect(() => {
        const html = document.documentElement;
        if (darkMode) {
            html.classList.add('dark');
        } else {
            html.classList.remove('dark');
        }
    }, [darkMode]);

    // Cleanup audio resources properly to avoid "Network Error" due to max AudioContexts or conflicts
    const cleanupAudioResources = async () => {
        isSessionActive.current = false;
        if (timerRef.current) clearInterval(timerRef.current);
        
        if (sessionRef.current) {
            try {
                // Use close() but catch errors if session is already bad
                // Note: live.close() isn't always exposed or async in all versions, but good practice
                // In @google/genai, close is synchronous usually or handled by disposing
                // If the session object has a close method, call it.
                // Assuming sessionRef.current is the return from connect(), which is an object.
                // The connect method returns a Session object.
                // We'll just null it out as the main cleanup.
            } catch (e) {
                console.debug("Session already closed or failed to close:", e);
            }
            sessionRef.current = null;
        }

        if (audioRefs.current.mediaRecorder && audioRefs.current.mediaRecorder.state !== 'inactive') {
            try {
                audioRefs.current.mediaRecorder.stop();
            } catch (e) { console.error("Error stopping recorder", e); }
        }

        if (audioRefs.current.stream) {
            audioRefs.current.stream.getTracks().forEach(track => track.stop());
            audioRefs.current.stream = null;
        }
        
        if (videoRef.current) {
            videoRef.current.srcObject = null;
        }

        if (audioRefs.current.scriptProcessor) {
            try {
                audioRefs.current.scriptProcessor.disconnect();
            } catch(e) {}
            audioRefs.current.scriptProcessor = null;
        }
        
        if(audioRefs.current.source) {
            try {
                audioRefs.current.source.disconnect();
            } catch(e) {}
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
        
        audioRefs.current.mediaRecorder = null;
        
        // Wait a tick to let browser clean up handles
        await new Promise(resolve => setTimeout(resolve, 100));
    };

    const handleStartInterview = async () => {
        setIsLoading(true);
        setScreen('briefing');
        setError(null);
        setBriefingText('');
        setRecordedVideoUrl(null); // Reset previous recording
        
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

    const confirmPermission = () => {
        setPermissionDenied(false);
        setShowPermissionModal(false);
        startLiveSession();
    };

    const startRecording = (stream: MediaStream) => {
        audioRefs.current.recordedChunks = [];
        let mimeType = 'video/webm';
        
        // Simple mime detection
        if (!MediaRecorder.isTypeSupported(mimeType)) {
             mimeType = 'video/mp4'; // Safari
             if(!MediaRecorder.isTypeSupported(mimeType)) {
                mimeType = ''; // Default/Fallback
             }
        }
        
        const options = mimeType ? { mimeType } : undefined;
        try {
            const recorder = new MediaRecorder(stream, options);
            recorder.ondataavailable = (e) => {
                if (e.data.size > 0) {
                    audioRefs.current.recordedChunks.push(e.data);
                }
            };
            recorder.start();
            audioRefs.current.mediaRecorder = recorder;
        } catch (e) {
            console.error("MediaRecorder init failed", e);
        }
    };

    const stopRecording = (): Promise<string | null> => {
        return new Promise((resolve) => {
            const recorder = audioRefs.current.mediaRecorder;
            if (!recorder || recorder.state === 'inactive') {
                resolve(null);
                return;
            }

            recorder.onstop = () => {
                let blobType = 'video/webm';
                if (recorder.mimeType) {
                    blobType = recorder.mimeType;
                } else if (audioRefs.current.recordedChunks.length > 0) {
                    blobType = audioRefs.current.recordedChunks[0].type || 'video/webm';
                }
                
                const blob = new Blob(audioRefs.current.recordedChunks, { type: blobType });
                const url = URL.createObjectURL(blob);
                resolve(url);
            };
            recorder.stop();
        });
    };

    const toggleMute = () => {
        if (audioRefs.current.stream) {
            audioRefs.current.stream.getAudioTracks().forEach(track => {
                track.enabled = !track.enabled;
            });
            setIsMuted(!isMuted);
        }
    };

    const toggleCamera = () => {
        if (audioRefs.current.stream) {
            audioRefs.current.stream.getVideoTracks().forEach(track => {
                track.enabled = !track.enabled;
            });
            setIsCameraOff(!isCameraOff);
        }
    };

    const startLiveSession = async () => {
        // Double check cleanup to ensure no lingering connections cause 503s
        await cleanupAudioResources();
        
        // Reset mute/camera states
        setIsMuted(false);
        setIsCameraOff(false);

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

            // Request video along with audio
            // Enhanced audio constraints for better input quality
            audioRefs.current.stream = await navigator.mediaDevices.getUserMedia({ 
                audio: {
                    channelCount: 1,
                    sampleRate: 16000,
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true, // Native AGC is good, but we add software normalization too
                },
                video: {
                    width: { ideal: 640 },
                    height: { ideal: 480 },
                    facingMode: "user"
                }
            });

            // START RECORDING THE STREAM
            startRecording(audioRefs.current.stream);

            let nextStartTime = 0;
            const sources = new Set<AudioBufferSourceNode>();
            
            // Structured Interview Logic
            let systemInstructionText = `
            You are a Senior HR + Technical Interviewer from a top global company.  
Role: '${settings.role}'  
Technical Focus: '${settings.topics}'  
Interview Level: '${settings.level}'   // basic | intermediate | advanced
Language: ${settings.language} (STRICTLY).

GLOBAL INTERVIEWER RULES:
- Ask ONE question at a time.
- After EVERY candidate response, provide:
  • Short Feedback (1–3 sentences)
  • One Improvement Suggestion
- If an answer is unclear, ask ONE probing follow-up.
- Maintain a professional, realistic HR tone.
- Do NOT reuse any real interview questions the user experienced—only the *style*.
- Never skip or reorder stages.

The interview consists of the following stages:
STAGE 1 — HR Warm-Up  
STAGE 2 — Resume Analysis  
STAGE 3 — Technical Questions  
STAGE 4 — Behavioral Scenarios  
STAGE 5 — Final Evaluation  

Depending on '${settings.level}', use the appropriate question set below.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LEVEL 1 — BASIC INTERVIEW (Beginner-Friendly)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

STAGE 1 — HR WARM-UP (2 Questions)
1. “Tell me about yourself.”
2. “Why are you interested in this role?”

STAGE 2 — RESUME ANALYSIS (2–3 Questions)
1. “Tell me about one project on your resume.”
2. “What skill or tool are you most comfortable with?”
3. If missing: “I see <skill> mentioned but not described—can you explain your experience?”

STAGE 3 — TECHNICAL (2 Questions)
1. “Explain a simple concept from your field.”
2. Ask 1 role-related question based on '${settings.topics}'.

STAGE 4 — BEHAVIORAL (1 Question)
1. “Tell me about a time you solved a small challenge.”

STAGE 5 — FINAL EVALUATION
- Provide scores (Communication, Basics, Fit)
- Provide 2 improvement tips  
- Provide simple verdict (Selected / Practice More)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LEVEL 2 — INTERMEDIATE INTERVIEW (Balanced)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

STAGE 1 — HR WARM-UP (3 Questions)
1. “Walk me through who you are professionally.”
2. “Share something about yourself that isn’t on the resume.”
3. “What motivates you to apply for this role?”

STAGE 2 — RESUME ANALYSIS (4–5 Questions)
1. “Tell me about a project you’re most confident in.”
2. “What challenge did you face and how did you overcome it?”
3. “How have you applied <skill/tool> in your resume?”
4. If unclear: “I see <topic>, but the details are missing—can you explain more?”
5. “Which achievement or experience reflects your strongest ability?”

STAGE 3 — TECHNICAL (3–4 Questions)
1. “Explain one core concept from your field in simple terms.”
2. “If something you built isn’t working, how would you troubleshoot?”
3. Ask 1–2 technical questions directly from '${settings.topics}'.

STAGE 4 — BEHAVIORAL (2 Questions)
1. “Tell me about a situation where you managed multiple tasks.”
2. “Share a time when your first solution didn’t work.”

STAGE 5 — FINAL EVALUATION
- Scores (Communication, Technical, Logic, Fit)
- 3 improvement tips
- Verdict (Recommended / Needs Improvement)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LEVEL 3 — ADVANCED INTERVIEW (FAANG-Style)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

STAGE 1 — ADVANCED HR WARM-UP (3 Questions)
1. “Give me a structured walkthrough of your background.”
2. “Share a personal insight about yourself not mentioned anywhere in your resume.”
3. “What specific value can you bring to this role compared to other candidates?”

STAGE 2 — RESUME INTELLIGENCE ANALYSIS (5–6 Questions)
1. “Describe your most technically complex project and your exact contribution.”
2. “Tell me about a decision you made that directly improved a project outcome.”
3. “How have you applied <coding language/tool> in a real scenario?”
4. If missing: “<topic> is listed but unclear—clarify your hands-on experience.”
5. “Which achievement demonstrates your highest potential?”
6. “Which experience aligns most with this role?”

STAGE 3 — DEEP TECHNICAL (4–5 Questions)
1. “Explain a core concept in your field and break it down for a beginner.”
2. “Imagine a system you built behaves unexpectedly—how would you isolate the issue?”
3. “When evaluating two possible solutions, how do you choose the optimal one?”
4. Ask 1–2 advanced questions tied to '${settings.topics}'.

STAGE 4 — SENIOR BEHAVIORAL (2 Questions)
1. “Describe a time you had to manage conflicting priorities under pressure.”
2. “Explain a situation where your approach failed and how you recovered.”

STAGE 5 — FINAL EVALUATION
- Scores (Communication, Technical Depth, Problem-Solving, Professionalism, Role Fit)
- 4 improvement suggestions
- Final verdict (Strong Candidate / Recommended / Needs Work)


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
                        
                        // Attach stream to video element
                        if (videoRef.current) {
                            videoRef.current.srcObject = audioRefs.current.stream;
                        }

                        const source = audioRefs.current.inputAudioContext.createMediaStreamSource(audioRefs.current.stream);
                        audioRefs.current.source = source;
                        
                        // Use a slightly smaller buffer for stability (2048 instead of 4096)
                        const scriptProcessor = audioRefs.current.inputAudioContext.createScriptProcessor(2048, 1, 1);
                        audioRefs.current.scriptProcessor = scriptProcessor;

                        scriptProcessor.onaudioprocess = (audioProcessingEvent) => {
                            if (!isSessionActive.current) return;
                            const inputData = audioProcessingEvent.inputBuffer.getChannelData(0);

                            // --- SOFTWARE AUDIO PROCESSING STAGE ---
                            // 1. Calculate RMS (Volume)
                            let sum = 0;
                            for (let i = 0; i < inputData.length; i++) {
                                sum += inputData[i] * inputData[i];
                            }
                            const rms = Math.sqrt(sum / inputData.length);

                            // 2. Noise Gate: If volume is below threshold, silence it to prevent noise hallucinations
                            const NOISE_THRESHOLD = 0.02; 
                            if (rms < NOISE_THRESHOLD) {
                                for (let i = 0; i < inputData.length; i++) {
                                    inputData[i] = 0;
                                }
                            } else {
                                // 3. Dynamic Normalization: Boost quiet speech
                                // Target a reasonable RMS (e.g., 0.15) without clipping
                                const TARGET_RMS = 0.15;
                                const MAX_GAIN = 5.0; // Max boost factor
                                
                                // Calculate gain needed to reach target, but clamp it
                                // We add a small epsilon to rms to avoid division by zero
                                let gain = TARGET_RMS / (rms + 0.0001);
                                gain = Math.min(gain, MAX_GAIN);
                                gain = Math.max(gain, 1.0); // Don't reduce volume, only boost

                                if (gain > 1.0) {
                                    for (let i = 0; i < inputData.length; i++) {
                                        inputData[i] *= gain;
                                    }
                                }
                            }
                            // --- END PROCESSING ---

                            const pcmBlob = createBlob(inputData);
                            sessionPromise.then((session) => {
                                if (isSessionActive.current) {
                                    try {
                                        session.sendRealtimeInput({ media: pcmBlob });
                                    } catch (err) {
                                        // Ignore send errors if session is closing/closed
                                        console.debug("Error sending audio input:", err);
                                    }
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
                        // Prevent recursive error setting if user navigates away
                        if (isSessionActive.current) {
                            setError('Connection Interrupted: The live session lost network connection. Please try starting the interview again.');
                        }
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
            // Enhanced error handling for permissions
            if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError' || err.message.includes('permission') || err.message.includes('denied')) {
                setPermissionDenied(true);
                setShowPermissionModal(true); // Re-open or keep open the modal to show the error
                setError(null);
            } else {
                setError(`Failed to start interview: ${err.message}. Please check microphone permissions and try again.`);
                setShowPermissionModal(false);
            }
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
                overall: 0, relevance: 0, clarity: 0, conciseness: 0, technicalAccuracy: 0
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
            1. Evaluate the candidate's answers based on Relevance, Clarity, Conciseness, and Technical Accuracy (1-10).
            2. Provide a detailed summary.
            3. Identify 3 specific strengths. YOU MUST QUOTE THE TRANSCRIPT to support each strength.
            4. Identify 3 specific areas for improvement. YOU MUST QUOTE THE TRANSCRIPT where the candidate struggled, and provide a SPECIFIC suggestion on how to say it better.
            5. Provide 3 general actionable tips for the next interview.
            
            Output strictly in JSON.
            `;

            const responseSchema = {
                type: Type.OBJECT,
                properties: {
                    summary: { type: Type.STRING, description: "Executive summary of the candidate's performance." },
                    strengths: { 
                        type: Type.ARRAY, 
                        items: { 
                            type: Type.OBJECT,
                            properties: {
                                strength: { type: Type.STRING },
                                example: { type: Type.STRING, description: "Quote from transcript supporting this strength" }
                            },
                            required: ["strength", "example"]
                        },
                        description: "List of 3 specific strengths with evidence." 
                    },
                    improvements: { 
                        type: Type.ARRAY, 
                        items: { 
                             type: Type.OBJECT,
                             properties: {
                                 area: { type: Type.STRING },
                                 example: { type: Type.STRING, description: "Quote from transcript showing the weakness" },
                                 suggestion: { type: Type.STRING, description: "How to rephrase or improve this answer" }
                             },
                             required: ["area", "example", "suggestion"]
                        }, 
                        description: "List of 3 specific areas for improvement with quotes and fixes." 
                    },
                    tips: { type: Type.ARRAY, items: { type: Type.STRING }, description: "List of 3 general actionable coaching tips." },
                    relevance: { type: Type.INTEGER, description: "Score 1-10" },
                    clarity: { type: Type.INTEGER, description: "Score 1-10" },
                    conciseness: { type: Type.INTEGER, description: "Score 1-10" },
                    technicalAccuracy: { type: Type.INTEGER, description: "Score 1-10" },
                    overall: { type: Type.INTEGER, description: "Overall Score 1-10" },
                },
                required: ["summary", "strengths", "improvements", "tips", "relevance", "clarity", "conciseness", "technicalAccuracy", "overall"],
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
        
        // Stop recording and get URL
        const videoUrl = await stopRecording();
        setRecordedVideoUrl(videoUrl);

        await cleanupAudioResources();
        setScreen('feedback');
        generateFeedback(finalTranscript);
    };

    const handleSettingsChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
      const { name, value } = e.target;
      setSettings(prev => ({ ...prev, [name]: value }));
    };

    return (
        <>
            <style>{`
                :root {
                    --primary-color: #6C63FF;
                    --secondary-color: #3AF2FF;
                    --accent-color: #5E9CFF;
                    --text-color: #333333;
                    --bg-dark: #0B0E14;
                    --card-bg: rgba(255, 255, 255, 0.9);
                    --border-color: #E0E0E0;
                    --error-color: #FF3B30;
                    --success-color: #34C759;
                }
                
                /* Custom styles mostly for setup/interview/feedback screens 
                   The Home screen now uses Tailwind
                */
                .app-container {
                    font-family: 'Poppins', sans-serif;
                    background: var(--bg-dark);
                    color: white;
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    min-height: 100vh;
                    width: 100%;
                }
                
                /* Only apply this container style when NOT on home screen */
                .container {
                    width: 100%;
                    max-width: 800px;
                    margin: 20px;
                    padding: 40px;
                    background-color: var(--card-bg);
                    border-radius: 24px;
                    box-shadow: 0 16px 32px rgba(0,0,0,0.1);
                    border: 1px solid rgba(255, 255, 255, 0.6);
                    box-sizing: border-box;
                    color: var(--text-color); /* Reset text color for form readability */
                    position: relative;
                    z-index: 10;
                }
                
                /* Keep form styles readable on white container */
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
                    color: #333;
                }
                input:focus, select:focus {
                    outline: none;
                    border-color: var(--primary-color);
                    box-shadow: 0 0 0 3px rgba(108, 99, 255, 0.25);
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
                    background-color: #564FCC;
                    transform: scale(1.02);
                    box-shadow: 0 4px 15px rgba(108, 99, 255, 0.3);
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
                    color: var(--secondary-color);
                    display: inline-block;
                    margin-bottom: 2px;
                }

                /* Modal Styles */
                .modal-overlay {
                    position: fixed;
                    top: 0;
                    left: 0;
                    width: 100%;
                    height: 100%;
                    background: rgba(0, 0, 0, 0.7);
                    backdrop-filter: blur(8px);
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    z-index: 1000;
                }
                .modal-content {
                    background: #fff;
                    padding: 30px;
                    border-radius: 16px;
                    max-width: 400px;
                    text-align: center;
                    box-shadow: 0 20px 40px rgba(0,0,0,0.4);
                    animation: popIn 0.3s ease-out;
                    color: #333;
                }
                @keyframes popIn {
                    0% { transform: scale(0.8); opacity: 0; }
                    100% { transform: scale(1); opacity: 1; }
                }
                .modal-icon {
                    font-size: 3rem;
                    margin-bottom: 20px;
                    display: block;
                }
                .modal-btn-group {
                    display: flex;
                    gap: 15px;
                    margin-top: 25px;
                }
                .modal-btn-secondary {
                    background-color: #e0e0e0;
                    color: #333;
                }
                .modal-btn-secondary:hover {
                    background-color: #d0d0d0;
                }
                
                /* Other helper classes for Briefing/Feedback */
                .transcript-container {
                  height: 400px;
                  overflow-y: auto;
                  background-color: #f8f9fa;
                  border: 1px solid var(--border-color);
                  border-radius: 12px;
                  padding: 20px;
                  margin-bottom: 20px;
                  color: #333;
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
                    display: grid;
                    grid-template-columns: repeat(4, 1fr);
                    gap: 15px;
                    margin-bottom: 30px;
                    padding-bottom: 20px;
                    border-bottom: 1px solid var(--border-color);
                }
                .score-item { text-align: center; }
                .score-item h4 { margin: 0 0 8px 0; font-weight: 500; color: #777; font-size: 0.8rem; text-transform: uppercase; }
                .score-item p { margin: 0; font-size: 1.5rem; font-weight: 600; color: #333; }
                
                .feedback-section {
                    text-align: left;
                    background-color: #fff;
                    padding: 20px;
                    border-radius: 12px;
                    margin-bottom: 20px;
                    box-shadow: 0 2px 10px rgba(0,0,0,0.05);
                }
                .feedback-list li { margin-bottom: 8px; color: #444; line-height: 1.5; }
                .feedback-summary {
                    text-align: left;
                    background-color: #f0f7ff;
                    padding: 25px;
                    border-radius: 12px;
                    margin-bottom: 30px;
                    border-left: 4px solid var(--primary-color);
                    color: #444;
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
                    color: #333;
                }
                
                /* Feedback Cards */
                .feedback-card {
                    background: #f8f9fa;
                    border-left: 4px solid #ccc;
                    padding: 15px;
                    margin-bottom: 15px;
                    border-radius: 8px;
                }
                .feedback-card.strength { border-left-color: var(--success-color); background: #f0fff4; }
                .feedback-card.improvement { border-left-color: var(--error-color); background: #fff5f5; }
                
                .feedback-header { font-weight: 600; font-size: 1.05rem; margin-bottom: 8px; color: #333; }
                .feedback-quote { 
                    font-style: italic; 
                    color: #666; 
                    font-size: 0.9rem; 
                    margin-bottom: 8px; 
                    padding-left: 10px;
                    border-left: 2px solid rgba(0,0,0,0.1);
                }
                .feedback-suggestion {
                    background: rgba(255,255,255,0.6);
                    padding: 8px;
                    border-radius: 6px;
                    font-size: 0.9rem;
                    color: #444;
                }
                .feedback-suggestion strong { color: var(--primary-color); }

                /* Video Preview Styles */
                .video-preview-container {
                    width: 100%;
                    max-width: 200px;
                    height: 150px;
                    background: #000;
                    border-radius: 12px;
                    overflow: hidden;
                    margin-bottom: 10px;
                    box-shadow: 0 4px 10px rgba(0,0,0,0.2);
                    position: absolute;
                    top: 40px;
                    right: 40px;
                    z-index: 20;
                    border: 2px solid rgba(255,255,255,0.2);
                }
                .user-video-feed {
                    width: 100%;
                    height: 100%;
                    object-fit: cover;
                }

                .video-controls {
                    position: absolute;
                    bottom: 10px;
                    left: 50%;
                    transform: translateX(-50%);
                    display: flex;
                    gap: 10px;
                    z-index: 25;
                }
                .control-btn {
                    background: rgba(0,0,0,0.6);
                    border: none;
                    color: white;
                    width: 32px;
                    height: 32px;
                    border-radius: 50%;
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 14px;
                    transition: background 0.2s;
                }
                .control-btn:hover {
                    background: rgba(0,0,0,0.8);
                }
                .control-btn.off {
                    background: var(--error-color);
                }
                
                @media (max-width: 600px) {
                    .video-preview-container {
                        position: relative;
                        top: 0;
                        right: 0;
                        margin: 0 auto 20px auto;
                    }
                }
                
                /* Tailwind Gradient Override for Home */
                .gradient-bg {
                  background-image: linear-gradient(135deg, #0da6f2 0%, #79C2FF 50%, #C061FF 100%);
                }
                
                /* Override material symbols for specific tropical design in Setup */
                .material-symbols-outlined {
                    font-variation-settings:
                    'FILL' 0,
                    'wght' 400,
                    'GRAD' 0,
                    'opsz' 24
                }

            `}</style>
            
            {screen === 'home' ? (
               <div className="relative flex min-h-screen w-full flex-col group/design-root overflow-hidden">
                <div className="absolute inset-0 z-0">
                    <div className="absolute -top-1/4 left-0 w-full h-full bg-primary/30 dark:bg-primary/20 rounded-full blur-[100px] opacity-50 dark:opacity-30"></div>
                    <div className="absolute -bottom-1/4 right-0 w-full h-full bg-[#C061FF]/30 dark:bg-[#C061FF]/20 rounded-full blur-[100px] opacity-50 dark:opacity-30"></div>
                </div>
                <div className="relative z-10 flex h-full flex-1 flex-col px-4">
                    <div className="flex items-center py-4">
                        <div className="flex size-10 shrink-0 items-center justify-center">
                            <span className="material-symbols-outlined text-3xl text-zinc-900 dark:text-white">
                                chat_bubble
                            </span>
                        </div>
                        <h2 className="text-zinc-900 dark:text-white text-lg font-bold leading-tight tracking-[-0.015em] flex-1 ml-2">InterviewPrep</h2>
                        <div className="flex w-12 items-center justify-end">
                            <button 
                                onClick={() => setDarkMode(!darkMode)}
                                className="flex h-12 w-12 cursor-pointer items-center justify-center overflow-hidden rounded-full bg-transparent text-zinc-900 dark:text-white"
                            >
                                <span className="material-symbols-outlined text-2xl">
                                    {darkMode ? 'light_mode' : 'dark_mode'}
                                </span>
                            </button>
                        </div>
                    </div>
                    <div className="flex flex-1 flex-col justify-center pb-8">
                        <div className="flex flex-col items-center">
                            <h1 className="text-zinc-900 dark:text-white text-[40px] font-black leading-tight tracking-tighter text-center pt-8 pb-3">Land Your Dream Job</h1>
                            <p className="text-zinc-700 dark:text-zinc-300 text-base font-normal leading-normal pb-8 pt-1 px-4 text-center max-w-sm">Practice with AI-powered mock interviews and expert-curated questions.</p>
                            <div className="w-full max-w-md rounded-xl bg-white/40 dark:bg-zinc-800/50 backdrop-blur-lg p-6 shadow-lg border border-white/20 dark:border-zinc-700/50">
                                <div className="flex w-full flex-col items-stretch gap-4">
                                    <button 
                                        onClick={() => setScreen('setup')}
                                        className="flex min-w-[84px] cursor-pointer items-center justify-center overflow-hidden rounded-2xl h-14 px-5 gradient-bg text-white text-base font-bold leading-normal tracking-[0.015em] w-full shadow-md hover:scale-[1.02] transition-transform duration-200"
                                    >
                                        <span className="truncate">Start Interview</span>
                                    </button>
                                    <button className="flex min-w-[84px] cursor-pointer items-center justify-center overflow-hidden rounded-2xl h-14 px-5 bg-transparent text-zinc-900 dark:text-white text-base font-bold leading-normal tracking-[0.015em] w-full border-2 border-zinc-900 dark:border-white hover:bg-zinc-900/5 dark:hover:bg-white/5 transition-colors duration-200">
                                        <span className="truncate">Explore Questions</span>
                                    </button>
                                </div>
                            </div>
                            <div className="flex w-full justify-center mt-12">
                                <div className="w-full max-w-xs h-auto">
                                    <img 
                                        className="w-full h-full object-contain mix-blend-luminosity dark:mix-blend-normal opacity-80 dark:opacity-100" 
                                        alt="Stylized illustration of two people having a conversation with speech bubbles" 
                                        src="https://lh3.googleusercontent.com/aida-public/AB6AXuCDgIGXHMStBstKY_Tp-66XwArV85fQf4wcrHINGda6gjgrDlJQEEdlupqRt7Q8A7XBH2mpg0zmzEoPchkITcL7B_YpfNElPia8BZZPAyBlg7lYpin6HXIt-J6LnnzkiJRmzuOGqckIxBxvad9bjKkakbg14Sg3JvmY-EpIXz_sFwrHV1WXPs_ZSvkaOKnPonc-Mv2N85cAy--hcLAdCWZ453BCRjLFvpQiwsr7v6DaKezq5o0ToTbzM2iD-RlYxPWXCzysOo96w2et"
                                    />
                                </div>
                            </div>
                        </div>
                        <div className="mt-16 w-full max-w-md mx-auto">
                            <h3 className="text-2xl font-bold text-zinc-900 dark:text-white text-center">Guidelines</h3>
                            <div className="mt-6 space-y-4">
                                <div className="flex items-start gap-4">
                                    <div className="flex-shrink-0 mt-1 flex h-6 w-6 items-center justify-center rounded-full bg-blue-100 dark:bg-blue-900/50">
                                        <span className="material-symbols-outlined text-sm text-blue-600 dark:text-blue-300">mic</span>
                                    </div>
                                    <div>
                                        <h4 className="font-bold text-zinc-800 dark:text-zinc-100">Find a Quiet Space</h4>
                                        <p className="text-zinc-600 dark:text-zinc-400 text-sm mt-1">Ensure your microphone can hear you clearly without background noise for best results.</p>
                                    </div>
                                </div>
                                <div className="flex items-start gap-4">
                                    <div className="flex-shrink-0 mt-1 flex h-6 w-6 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/50">
                                        <span className="material-symbols-outlined text-sm text-green-600 dark:text-green-300">lightbulb</span>
                                    </div>
                                    <div>
                                        <h4 className="font-bold text-zinc-800 dark:text-zinc-100">Think Before You Speak</h4>
                                        <p className="text-zinc-600 dark:text-zinc-400 text-sm mt-1">Take a moment to structure your thoughts. It's okay to pause and think.</p>
                                    </div>
                                </div>
                                <div className="flex items-start gap-4">
                                    <div className="flex-shrink-0 mt-1 flex h-6 w-6 items-center justify-center rounded-full bg-purple-100 dark:bg-purple-900/50">
                                        <span className="material-symbols-outlined text-sm text-purple-600 dark:text-purple-300">task_alt</span>
                                    </div>
                                    <div>
                                        <h4 className="font-bold text-zinc-800 dark:text-zinc-100">Review Your Feedback</h4>
                                        <p className="text-zinc-600 dark:text-zinc-400 text-sm mt-1">After each session, review the AI feedback to identify areas for improvement.</p>
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* Testimonials Section */}
                        <div className="mt-16 w-full max-w-4xl mx-auto px-4">
                            <h3 className="text-2xl font-bold text-zinc-900 dark:text-white text-center mb-8">What Our Users Say</h3>
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                                {/* Testimonial 1 */}
                                <div className="bg-white/40 dark:bg-zinc-800/50 backdrop-blur-lg p-6 rounded-xl border border-white/20 dark:border-zinc-700/50 shadow-sm transition-transform hover:scale-[1.02] duration-200">
                                    <p className="text-zinc-700 dark:text-zinc-300 text-sm italic mb-4">"This AI coach helped me ace my System Design round at a top tech company! The real-time feedback is incredible."</p>
                                    <div className="flex items-center gap-3">
                                         <div className="h-10 w-10 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center text-blue-600 dark:text-blue-400 font-bold">AC</div>
                                         <div>
                                            <div className="text-sm font-bold text-zinc-900 dark:text-white">Alex Chen</div>
                                            <div className="text-xs text-zinc-500 dark:text-zinc-400">Software Engineer</div>
                                         </div>
                                    </div>
                                </div>
                                {/* Testimonial 2 */}
                                <div className="bg-white/40 dark:bg-zinc-800/50 backdrop-blur-lg p-6 rounded-xl border border-white/20 dark:border-zinc-700/50 shadow-sm transition-transform hover:scale-[1.02] duration-200">
                                    <p className="text-zinc-700 dark:text-zinc-300 text-sm italic mb-4">"The detailed breakdown of my communication style was a game changer. I feel much more confident now."</p>
                                    <div className="flex items-center gap-3">
                                         <div className="h-10 w-10 rounded-full bg-purple-100 dark:bg-purple-900/30 flex items-center justify-center text-purple-600 dark:text-purple-400 font-bold">SJ</div>
                                         <div>
                                            <div className="text-sm font-bold text-zinc-900 dark:text-white">Sarah Jones</div>
                                            <div className="text-xs text-zinc-500 dark:text-zinc-400">Product Manager</div>
                                         </div>
                                    </div>
                                </div>
                                {/* Testimonial 3 */}
                                <div className="bg-white/40 dark:bg-zinc-800/50 backdrop-blur-lg p-6 rounded-xl border border-white/20 dark:border-zinc-700/50 shadow-sm transition-transform hover:scale-[1.02] duration-200">
                                    <p className="text-zinc-700 dark:text-zinc-300 text-sm italic mb-4">"I love the timed mode. It really prepares you for the pressure of actual interviews. Highly recommended!"</p>
                                    <div className="flex items-center gap-3">
                                         <div className="h-10 w-10 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center text-green-600 dark:text-green-400 font-bold">MB</div>
                                         <div>
                                            <div className="text-sm font-bold text-zinc-900 dark:text-white">Michael Brown</div>
                                            <div className="text-xs text-zinc-500 dark:text-zinc-400">Data Scientist</div>
                                         </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            ) : (
                screen === 'setup' ? (
                   <div className="bg-tropical-coral dark:bg-tropical-turquoise font-display min-h-screen">
                    <div className="relative flex h-auto min-h-screen w-full flex-col group/design-root overflow-hidden">
                        <div className="absolute inset-0 z-0">
                            <div className="absolute inset-0 bg-tropical-coral dark:bg-tropical-turquoise"></div>
                            <div className="absolute top-[-30%] left-[-20%] h-[70%] w-[120%] rounded-full bg-pastel-yellow/60 dark:bg-pastel-yellow/60 blur-3xl" style={{filter: 'blur(100px)'}}></div>
                            <div className="absolute bottom-[-30%] right-[-20%] h-[60%] w-[110%] rounded-full bg-pastel-pink/50 dark:bg-pastel-pink/50 blur-3xl" style={{filter: 'blur(120px)'}}></div>
                            <div className="absolute top-[15%] right-[-25%] h-[50%] w-[90%] rotate-12 rounded-full bg-pastel-yellow/40 dark:bg-pastel-yellow/40 blur-3xl" style={{filter: 'blur(90px)'}}></div>
                        </div>
                        <div className="relative flex items-center p-4 pb-2 justify-between bg-transparent z-10">
                            <button onClick={() => setScreen('home')} className="text-deep-navy dark:text-white flex size-10 items-center justify-center cursor-pointer transition-transform hover:scale-110">
                                <span className="material-symbols-outlined text-2xl">arrow_back</span>
                            </button>
                            <h2 className="text-deep-navy dark:text-white text-lg font-bold leading-tight tracking-tight flex-1 text-center">Interview Setup</h2>
                            <div className="size-10 shrink-0"></div>
                        </div>
                        <main className="relative flex-1 px-4 pt-4 pb-8 z-10 flex flex-col items-center">
                            <div className="flex flex-col gap-6 w-full max-w-[480px]">
                                <div className="flex flex-wrap items-end gap-4 w-full">
                                    <label className="flex flex-col min-w-40 flex-1">
                                        <p className="text-deep-navy dark:text-white text-base font-medium leading-normal pb-2">Target Role</p>
                                        <input 
                                            name="role"
                                            value={settings.role}
                                            onChange={handleSettingsChange}
                                            className="form-input flex w-full min-w-0 flex-1 resize-none overflow-hidden rounded-xl text-deep-navy dark:text-deep-navy focus:outline-0 focus:ring-2 focus:ring-mango-orange/50 border border-pastel-pink/50 dark:border-pastel-pink/50 bg-airy-cream dark:bg-airy-cream backdrop-blur-sm focus:border-mango-orange h-14 placeholder:text-deep-navy/60 dark:placeholder:text-deep-navy/60 p-[15px] text-base font-normal leading-normal" 
                                            placeholder="e.g. Product Manager" 
                                        />
                                    </label>
                                </div>
                                <div className="flex flex-wrap items-end gap-4 w-full">
                                    <label className="flex flex-col min-w-40 flex-1">
                                        <p className="text-deep-navy dark:text-white text-base font-medium leading-normal pb-2">Key Topics / Skills</p>
                                        <textarea 
                                            name="topics"
                                            value={settings.topics}
                                            onChange={handleSettingsChange}
                                            className="form-input flex w-full min-w-0 flex-1 resize-none overflow-hidden rounded-xl text-deep-navy dark:text-deep-navy focus:outline-0 focus:ring-2 focus:ring-mango-orange/50 border border-pastel-pink/50 dark:border-pastel-pink/50 bg-airy-cream dark:bg-airy-cream backdrop-blur-sm focus:border-mango-orange min-h-36 placeholder:text-deep-navy/60 dark:placeholder:text-deep-navy/60 p-[15px] text-base font-normal leading-normal" 
                                            placeholder="e.g. A/B testing, user research"
                                        />
                                    </label>
                                </div>
                                <button 
                                    onClick={() => fileInputRef.current?.click()}
                                    className="flex items-center gap-4 bg-airy-cream dark:bg-airy-cream backdrop-blur-sm p-3 min-h-14 justify-between border-2 border-dashed border-pastel-pink/70 dark:border-pastel-pink/70 rounded-xl w-full cursor-pointer hover:bg-white/60 transition-colors"
                                >
                                    <div className="flex items-center gap-4 w-full">
                                        <div className="text-deep-navy dark:text-deep-navy flex items-center justify-center rounded-lg bg-pastel-yellow/50 dark:bg-pastel-yellow/50 shrink-0 size-10">
                                            <span className="material-symbols-outlined">upload_file</span>
                                        </div>
                                        <p className="text-deep-navy dark:text-deep-navy text-base font-normal leading-normal flex-1 truncate text-left">
                                            {resumeFile ? resumeFile.name : "Upload Resume (PDF - Optional)"}
                                        </p>
                                        {resumeFile && (
                                            <span className="material-symbols-outlined text-green-600">check_circle</span>
                                        )}
                                    </div>
                                    <input 
                                        type="file" 
                                        accept=".pdf" 
                                        ref={fileInputRef} 
                                        onChange={(e) => setResumeFile(e.target.files ? e.target.files[0] : null)}
                                        className="hidden"
                                    />
                                </button>
                                <div className="flex flex-col gap-4 w-full">
                                    <div className="relative">
                                        <select 
                                            name="voice"
                                            value={settings.voice}
                                            onChange={handleSettingsChange}
                                            className="absolute opacity-0 w-full h-full cursor-pointer z-10 top-0 left-0"
                                        >
                                            <option value="Zephyr">Zephyr (Balanced)</option>
                                            <option value="Puck">Puck (Energetic)</option>
                                            <option value="Charon">Charon (Deep)</option>
                                            <option value="Kore">Kore (Calm)</option>
                                            <option value="Fenrir">Fenrir (Authoritative)</option>
                                        </select>
                                        <div className="flex items-center gap-4 bg-airy-cream dark:bg-airy-cream backdrop-blur-sm px-4 min-h-14 justify-between rounded-xl border border-pastel-pink/50 dark:border-pastel-pink/50">
                                            <p className="text-deep-navy dark:text-deep-navy text-base font-normal leading-normal flex-1 truncate">Interviewer Voice</p>
                                            <div className="flex items-center gap-2">
                                                <span className="text-deep-navy/70 dark:text-deep-navy/70">{settings.voice}</span>
                                                <div className="text-deep-navy/70 dark:text-deep-navy/70 flex size-7 shrink-0 items-center justify-center">
                                                    <span className="material-symbols-outlined">unfold_more</span>
                                                </div>
                                            </div>
                                        </div>
                                    </div>

                                    <div className="relative">
                                        <select 
                                            name="language"
                                            value={settings.language}
                                            onChange={handleSettingsChange}
                                            className="absolute opacity-0 w-full h-full cursor-pointer z-10 top-0 left-0"
                                        >
                                            <option value="English">English</option>
                                            <option value="Spanish">Spanish</option>
                                            <option value="French">French</option>
                                            <option value="German">German</option>
                                            <option value="Hindi">Hindi</option>
                                        </select>
                                        <div className="flex items-center gap-4 bg-airy-cream dark:bg-airy-cream backdrop-blur-sm px-4 min-h-14 justify-between rounded-xl border border-pastel-pink/50 dark:border-pastel-pink/50">
                                            <p className="text-deep-navy dark:text-deep-navy text-base font-normal leading-normal flex-1 truncate">Language</p>
                                            <div className="flex items-center gap-2">
                                                <span className="text-deep-navy/70 dark:text-deep-navy/70">{settings.language}</span>
                                                <div className="text-deep-navy/70 dark:text-deep-navy/70 flex size-7 shrink-0 items-center justify-center">
                                                    <span className="material-symbols-outlined">unfold_more</span>
                                                </div>
                                            </div>
                                        </div>
                                    </div>

                                    <div className="relative">
                                         <select 
                                            name="level"
                                            value={settings.level}
                                            onChange={handleSettingsChange}
                                            className="absolute opacity-0 w-full h-full cursor-pointer z-10 top-0 left-0"
                                        >
                                            <option value="Basic">Beginner</option>
                                            <option value="Intermediate">Intermediate</option>
                                            <option value="Advanced">Advanced</option>
                                        </select>
                                        <div className="flex items-center gap-4 bg-airy-cream dark:bg-airy-cream backdrop-blur-sm px-4 min-h-14 justify-between rounded-xl border border-pastel-pink/50 dark:border-pastel-pink/50">
                                            <p className="text-deep-navy dark:text-deep-navy text-base font-normal leading-normal flex-1 truncate">Difficulty Level</p>
                                            <div className="flex items-center gap-2">
                                                <span className="text-deep-navy/70 dark:text-deep-navy/70">{settings.level}</span>
                                                <div className="text-deep-navy/70 dark:text-deep-navy/70 flex size-7 shrink-0 items-center justify-center">
                                                    <span className="material-symbols-outlined">unfold_more</span>
                                                </div>
                                            </div>
                                        </div>
                                    </div>

                                    <div className="relative">
                                         <select 
                                            name="mode"
                                            value={settings.mode}
                                            onChange={handleSettingsChange}
                                            className="absolute opacity-0 w-full h-full cursor-pointer z-10 top-0 left-0"
                                        >
                                            <option value="standard">Standard</option>
                                            <option value="timed">Timed (90s)</option>
                                        </select>
                                        <div className="flex items-center gap-4 bg-airy-cream dark:bg-airy-cream backdrop-blur-sm px-4 min-h-14 justify-between rounded-xl border border-pastel-pink/50 dark:border-pastel-pink/50">
                                            <p className="text-deep-navy dark:text-deep-navy text-base font-normal leading-normal flex-1 truncate">Practice Mode</p>
                                            <div className="flex items-center gap-2">
                                                <span className="text-deep-navy/70 dark:text-deep-navy/70">{settings.mode === 'timed' ? 'Timed' : 'Standard'}</span>
                                                <div className="text-deep-navy/70 dark:text-deep-navy/70 flex size-7 shrink-0 items-center justify-center">
                                                    <span className="material-symbols-outlined">unfold_more</span>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                                {error && <div className="text-white font-bold bg-red-500/80 p-3 rounded-xl">{error}</div>}
                            </div>
                        </main>
                        <footer className="sticky bottom-0 bg-tropical-coral/80 dark:bg-tropical-turquoise/80 backdrop-blur-sm p-4 pt-2 z-10 w-full flex justify-center">
                            <div className="flex flex-col gap-3 w-full max-w-[480px]">
                                <button 
                                    onClick={handleStartInterview} 
                                    disabled={isLoading}
                                    className="flex w-full items-center justify-center rounded-full bg-sunny-yellow h-14 text-deep-navy text-lg font-bold leading-tight tracking-tight transition-all hover:bg-mango-orange shadow-lg hover:scale-[1.02]"
                                >
                                    {isLoading ? 'Preparing Session...' : 'Start Interview'}
                                </button>
                                <button 
                                    onClick={() => setScreen('home')}
                                    className="flex w-full items-center justify-center rounded-full bg-pastel-yellow/70 dark:bg-pastel-yellow/70 h-14 text-deep-navy text-lg font-bold leading-tight tracking-tight transition-opacity hover:opacity-90"
                                >
                                    Back to Home
                                </button>
                            </div>
                        </footer>
                    </div>
                   </div>
                ) : (
                <div className="app-container">
                    <div className="container">
                        {screen === 'briefing' && (
                            <>
                                <h1>Interview Briefing</h1>
                                <div className="briefing-text">
                                    {briefingText || "Generating briefing..."}
                                </div>
                                {error && <div style={{ color: 'var(--error-color)', marginBottom: '15px' }}>{error}</div>}
                                <button className="button" onClick={() => setShowPermissionModal(true)} disabled={isLoading}>
                                    Ready to Begin
                                </button>
                            </>
                        )}

                        {screen === 'interview' && (
                            <div style={{ textAlign: 'center', position: 'relative' }}>
                                <div className="video-preview-container">
                                    <video ref={videoRef} autoPlay muted playsInline className="user-video-feed" />
                                    <div className="video-controls">
                                        <button onClick={toggleMute} className={`control-btn ${isMuted ? 'off' : ''}`} title="Toggle Microphone">
                                            {isMuted ? '🔇' : '🎙️'}
                                        </button>
                                        <button onClick={toggleCamera} className={`control-btn ${isCameraOff ? 'off' : ''}`} title="Toggle Camera">
                                            {isCameraOff ? '🚫' : '📹'}
                                        </button>
                                    </div>
                                </div>

                                <div style={{ marginBottom: '30px' }}>
                                    <div style={{ 
                                        width: '120px', 
                                        height: '120px', 
                                        borderRadius: '50%', 
                                        background: 'var(--primary-color)', 
                                        margin: '0 auto', 
                                        display: 'flex', 
                                        alignItems: 'center', 
                                        justifyContent: 'center',
                                        boxShadow: '0 0 30px rgba(108, 99, 255, 0.4)',
                                        animation: 'pulse 2s infinite'
                                    }}>
                                        <span style={{ fontSize: '3rem' }}>🎙️</span>
                                    </div>
                                    <style>{`
                                        @keyframes pulse {
                                            0% { transform: scale(1); box-shadow: 0 0 0 0 rgba(108, 99, 255, 0.7); }
                                            70% { transform: scale(1.1); box-shadow: 0 0 0 20px rgba(108, 99, 255, 0); }
                                            100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(108, 99, 255, 0); }
                                        }
                                    `}</style>
                                </div>
                                
                                <h2>Interview in Progress</h2>
                                <p>Listening to your answers...</p>

                                {settings.mode === 'timed' && timeLeft !== null && (
                                    <div style={{ fontSize: '2rem', fontWeight: 'bold', color: timeLeft < 30 ? 'var(--error-color)' : 'var(--primary-color)', margin: '20px 0' }}>
                                        {timeLeft}s
                                    </div>
                                )}

                                <div style={{ height: '150px', overflowY: 'auto', border: '1px solid #eee', padding: '10px', borderRadius: '8px', textAlign: 'left', marginBottom: '20px', fontSize: '0.9rem', color: '#666' }}>
                                    {transcript.slice(-3).map((t, i) => (
                                        <div key={i} style={{ marginBottom: '8px' }}>
                                            <strong>{t.speaker === 'user' ? 'You' : 'Interviewer'}:</strong> {t.text}
                                        </div>
                                    ))}
                                    {transcript.length === 0 && <i>Conversation will appear here...</i>}
                                </div>

                                <button className="button" style={{ backgroundColor: 'var(--error-color)' }} onClick={stopInterview}>
                                    End Interview
                                </button>
                            </div>
                        )}

                        {screen === 'feedback' && feedback && (
                            <div>
                                <h1>Performance Analysis</h1>
                                
                                <div style={{ textAlign: 'center', marginBottom: '30px' }}>
                                    <div className="score-circle">
                                        <span>{feedback.overall}</span>
                                        <div style={{ fontSize: '0.9rem', marginTop: '5px' }}>Overall Score</div>
                                    </div>
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
                                    <div className="score-item">
                                        <h4>Tech Accuracy</h4>
                                        <p>{feedback.technicalAccuracy}/10</p>
                                    </div>
                                </div>

                                <div className="feedback-summary">
                                    <h3>Executive Summary</h3>
                                    <p>{feedback.summary}</p>
                                </div>
                                
                                {/* Session Playback Section */}
                                {recordedVideoUrl && (
                                    <div className="feedback-section">
                                        <h3 style={{ borderBottom: '1px solid #eee', paddingBottom: '10px' }}>Session Playback</h3>
                                        <video src={recordedVideoUrl} controls style={{ width: '100%', borderRadius: '8px', marginTop: '10px' }} />
                                        <a href={recordedVideoUrl} download="interview-session.webm" style={{ display: 'inline-block', marginTop: '10px', color: 'var(--primary-color)', textDecoration: 'none', fontWeight: '500' }}>
                                            Download Recording ⬇
                                        </a>
                                    </div>
                                )}

                                <div className="feedback-section">
                                    <h3 style={{ color: 'var(--success-color)' }}>Key Strengths</h3>
                                    {feedback.strengths.map((item, i) => (
                                        <div key={i} className="feedback-card strength">
                                            <div className="feedback-header">{item.strength}</div>
                                            <div className="feedback-quote">"{item.example}"</div>
                                        </div>
                                    ))}
                                </div>

                                <div className="feedback-section">
                                    <h3 style={{ color: 'var(--error-color)' }}>Areas for Improvement</h3>
                                    {feedback.improvements.map((item, i) => (
                                        <div key={i} className="feedback-card improvement">
                                            <div className="feedback-header">{item.area}</div>
                                            <div className="feedback-quote">Issue: "{item.example}"</div>
                                            <div className="feedback-suggestion">
                                                <strong>Try saying:</strong> "{item.suggestion}"
                                            </div>
                                        </div>
                                    ))}
                                </div>
                                
                                 <div className="feedback-section">
                                    <h3>Actionable Tips</h3>
                                    <ul className="feedback-list">
                                        {feedback.tips.map((tip, i) => (
                                            <li key={i}>{tip}</li>
                                        ))}
                                    </ul>
                                </div>

                                <div style={{ marginTop: '20px' }}>
                                    <button 
                                        onClick={() => setShowFullTranscript(!showFullTranscript)}
                                        style={{ background: 'none', border: 'none', color: 'var(--primary-color)', cursor: 'pointer', textDecoration: 'underline', padding: '0', fontSize: '1rem', marginBottom: '15px' }}
                                    >
                                        {showFullTranscript ? 'Hide Transcript' : 'View Full Transcript Analysis'}
                                    </button>
                                    
                                    {showFullTranscript && (
                                        <div className="transcript-view">
                                            {transcript.map((t, i) => (
                                                <div key={i} style={{ marginBottom: '10px' }}>
                                                    <strong style={{ color: t.speaker === 'user' ? 'var(--primary-color)' : '#555' }}>
                                                        {t.speaker === 'user' ? 'You' : 'Interviewer'}:
                                                    </strong> {t.text}
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>

                                <button className="button secondary" onClick={() => setScreen('home')}>
                                    Back to Home
                                </button>
                            </div>
                        )}
                    </div>
                </div>
                )
            )}
            
            {showPermissionModal && (
                <div className="modal-overlay">
                    <div className="modal-content">
                        <span className="modal-icon">{permissionDenied ? '🚫' : '🎙️'}</span>
                        <h2>{permissionDenied ? 'Access Denied' : 'Microphone & Camera Access'}</h2>
                        
                        {permissionDenied ? (
                            <div style={{ textAlign: 'left', marginTop: '15px', fontSize: '0.9rem', color: '#555' }}>
                                <p>To proceed, you must enable permissions in your browser:</p>
                                <ol style={{ paddingLeft: '20px', lineHeight: '1.6' }}>
                                    <li>Click the <strong>Lock icon 🔒</strong> in the address bar.</li>
                                    <li>Find <strong>Microphone</strong> and <strong>Camera</strong>.</li>
                                    <li>Switch them to <strong>Allow</strong>.</li>
                                    <li>Refresh this page.</li>
                                </ol>
                            </div>
                        ) : (
                            <p style={{ color: '#666', marginBottom: '20px' }}>
                                To simulate a real interview, we need access to your microphone and camera. 
                                Video is recorded for your personal review only.
                            </p>
                        )}

                        <div className="modal-btn-group">
                            {!permissionDenied ? (
                                <>
                                    <button className="button modal-btn-secondary" onClick={() => setShowPermissionModal(false)}>Cancel</button>
                                    <button className="button" onClick={confirmPermission}>Enable Access</button>
                                </>
                            ) : (
                                <button className="button" onClick={() => window.location.reload()}>Refresh Page</button>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </>
    );
};

const root = createRoot(document.getElementById('root')!);
root.render(<App />);