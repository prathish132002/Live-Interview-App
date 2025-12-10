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

// --- REVIEWS DATA ---
const reviews = [
    {
        name: "Sarah Jenkins",
        role: "Software Engineer @ TechGiant",
        content: "This app helped me ace my Google interview! The technical feedback was incredibly precise and the riddles actually prepared me for the curveballs.",
        avatar: "S"
    },
    {
        name: "Dr. Michael Chen",
        role: "Research Fellow",
        content: "The seminar mode is a game changer. It caught factual discrepancies in my thesis defense practice that I hadn't noticed myself.",
        avatar: "M"
    },
    {
        name: "Emily Rivera",
        role: "Product Manager",
        content: "I love the real-time corrections. It feels like having a compassionate but strict coach right in front of you. Highly recommended!",
        avatar: "E"
    },
    {
        name: "David Kim",
        role: "Marketing Director",
        content: "Used the presentation mode for a Q3 business review. The pacing score helped me trim down my speech to fit the time limit perfectly.",
        avatar: "D"
    }
];

// --- REACT COMPONENTS ---

const App = () => {
    const [screen, setScreen] = useState('home'); // setup, briefing, interview, feedback, home
    const [sessionType, setSessionType] = useState<'interview' | 'presentation' | 'seminar'>('interview');
    const [settings, setSettings] = useState({
        role: 'Software Engineer', // acts as "Title" in presentation/seminar mode
        topics: 'React, TypeScript, and System Design', // acts as "Audience" in presentation/seminar mode
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
    const [speakingDuration, setSpeakingDuration] = useState(0);
    const [currentReviewIndex, setCurrentReviewIndex] = useState(0);

    const sessionRef = useRef<LiveSession | null>(null);
    const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const isSessionActive = useRef(false);
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const transcriptEndRef = useRef<HTMLDivElement>(null);
    
    // Speaking timer refs
    const isUserSpeakingRef = useRef(false);
    const speechStartTimeRef = useRef<number | null>(null);
    const lastSpeechDetectedTimeRef = useRef<number>(0);
    const speechTimerIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
    
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
      audioProcessingState: {
          smoothedVolume: number;
          currentGain: number;
      };
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
      audioProcessingState: { smoothedVolume: 0, currentGain: 1.0 },
    });
    
    // Review Carousel Effect
    useEffect(() => {
        if (screen !== 'home') return;
        const interval = setInterval(() => {
            setCurrentReviewIndex((prev) => (prev + 1) % reviews.length);
        }, 5000);
        return () => clearInterval(interval);
    }, [screen]);

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

    // Timer for speaking duration UI update
    useEffect(() => {
        if (screen !== 'interview') {
            if (speechTimerIntervalRef.current) clearInterval(speechTimerIntervalRef.current);
            return;
        }

        speechTimerIntervalRef.current = setInterval(() => {
            if (isUserSpeakingRef.current && speechStartTimeRef.current) {
                const duration = (Date.now() - speechStartTimeRef.current) / 1000;
                setSpeakingDuration(duration);
            } else if (!isUserSpeakingRef.current && speakingDuration !== 0) {
                 setSpeakingDuration(0);
            }
        }, 100);

        return () => {
            if (speechTimerIntervalRef.current) clearInterval(speechTimerIntervalRef.current);
        };
    }, [screen, speakingDuration]);

    useEffect(() => {
        const html = document.documentElement;
        if (darkMode) {
            html.classList.add('dark');
        } else {
            html.classList.remove('dark');
        }
    }, [darkMode]);

    // Auto-scroll transcript
    useEffect(() => {
        if (transcriptEndRef.current) {
            transcriptEndRef.current.scrollIntoView({ behavior: 'smooth' });
        }
    }, [transcript]);

    // Cleanup audio resources properly to avoid "Network Error" due to max AudioContexts or conflicts
    const cleanupAudioResources = async () => {
        isSessionActive.current = false;
        if (timerRef.current) clearInterval(timerRef.current);
        if (speechTimerIntervalRef.current) clearInterval(speechTimerIntervalRef.current);
        
        if (sessionRef.current) {
            try {
                // Use close() but catch errors if session is already bad
                // Note: live.close() isn't always exposed or async in all versions, but good practice
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
                    let resumePrompt = "";
                    
                    if (sessionType === 'interview') {
                         resumePrompt = "You are an expert technical interviewer. Analyze this candidate's resume. Extract the candidate's name (if available), key technical skills, detailed work history, and specifically the details of any projects mentioned. Provide a structured summary that an interviewer can use to ask specific, deep-dive questions about their actual experience. Focus on what they built, technologies used, and their specific role.";
                    } else {
                         // Presentation or Seminar
                         resumePrompt = "You are an expert presentation coach and fact-checker. Analyze these slides/document. Extract a structured list of KEY FACTS, DATA POINTS, DEFINITIONS, and MAIN ARGUMENTS. I need to use this to fact-check the presenter in real-time if they say something wrong. Also summarize the intended narrative flow.";
                    }

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
                    console.error("File analysis failed", resumeErr);
                }
            } else {
                setResumeAnalysis('');
            }

            let textPrompt = "";
            if (sessionType === 'interview') {
                textPrompt = `Generate a short, friendly, and professional welcome message for a job interview. The role is '${settings.role}' and the topics are '${settings.topics}'. Welcome the candidate, state the role and topics, and wish them luck. The message must be entirely in ${settings.language}.`;
                if (currentResumeAnalysis) {
                    textPrompt += `\n\nContext: The candidate has uploaded a resume. Here is the summary: ${currentResumeAnalysis}. Acknowledge that you have reviewed their resume and mention that you will be asking questions about their projects.`;
                }
            } else {
                // Presentation or Seminar
                textPrompt = `Generate a short, encouraging welcome message for a ${sessionType === 'seminar' ? 'seminar' : 'presentation'} practice session. The user is presenting on '${settings.role}' to an audience of '${settings.topics}'. Welcome them, acknowledge you have reviewed their materials (if any), and ask them to begin their presentation whenever they are ready. State that you will listen actively and interrupt ONLY if you hear a factual error based on their slides. The message must be entirely in ${settings.language}.`;
                if (currentResumeAnalysis) {
                    textPrompt += `\n\nContext: The user has uploaded slides. Summary: ${currentResumeAnalysis}.`;
                }
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
        
        // Reset processing state
        audioRefs.current.audioProcessingState = { smoothedVolume: 0, currentGain: 1.0 };
        
        // Reset Speech Timer logic
        isUserSpeakingRef.current = false;
        speechStartTimeRef.current = null;
        lastSpeechDetectedTimeRef.current = 0;
        setSpeakingDuration(0);

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
                    autoGainControl: false, // We will handle gain manually
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
            
            let systemInstructionText = "";

            if (sessionType === 'interview') {
                systemInstructionText = `
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
    
    (Include logic for Levels 1, 2, 3 as standard interview flow...)
    `;
                // Add level logic (abbreviated for brevity as it's the same logic)
                systemInstructionText += `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RIDDLE & CRITICAL-THINKING SYSTEM
Riddles are included at all levels. Difficulty scales by interview level.
Each riddle must:
• Match the level (Easy → Medium → Hard).
• Test reasoning, pattern recognition, or structured problem solving.
• Never exceed 2–3 minutes thinking time unless at Advanced level.
• Provide hints only when explicitly requested by the user.

Riddle Difficulty Guide:
• EASY: Simple logic, water jug puzzles, pattern recognition.
• MEDIUM: Multi-step logic puzzles, constraint-based reasoning.
• HARD: Paradox puzzles, incomplete-information logic, multi-variable reasoning.

Scoring:
• Correct/strong attempt: +10% to reasoning score.
• Partial logic: +5%.
• Incorrect with good approach: +2%.
• No attempt: 0%.

Riddle Behavior Rules:
• Do not reuse the same riddle twice in the same session.
• Do not use the rope-burning riddle.
• The riddle must feel natural, short, and fit the conversation flow.
• Reveal the answer only after the candidate completes or asks for it.


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LEVEL 1 — BASIC INTERVIEW
A beginner-friendly interview with foundational checks and one EASY riddle.

STAGE 1:
• Ask: "Tell me about yourself."
• Ask: "Why this role?"

STAGE 2:
• Ask 1–2 resume basics.

STAGE 3:
• Ask 2 light technical questions.

STAGE 4:
• Ask 1 behavioral question.
• Include 1 **EASY riddle** (simple logic puzzle, pattern, basic scenario).

STAGE 5:
• Give a brief final evaluation on fundamentals, clarity, and basic reasoning.


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LEVEL 2 — INTERMEDIATE INTERVIEW
A deeper evaluation with more probing questions and a MEDIUM riddle.

STAGE 1:
• Ask 3 warm-up questions.

STAGE 2:
• Ask 4–5 resume deep-dive questions.

STAGE 3:
• Ask 3–4 technical questions (algorithms, debugging, applied engineering).

STAGE 4:
• Ask 2 behavioral questions.
• Include 1 **MEDIUM riddle** (multi-step logic, constraint puzzle, reasoning chain).

STAGE 5:
• Give evaluation on depth, problem-solving, and communication.


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LEVEL 3 — ADVANCED INTERVIEW
A senior-level track with architectural thinking and a HARD riddle.

STAGE 1:
• Ask 3 complex warm-up questions.

STAGE 2:
• Ask 5–6 resume/system design probes.

STAGE 3:
• Ask 4–5 deep tech/architecture questions.

STAGE 4:
• Ask 2 senior behavioral questions.
• Include 1 **HARD riddle** (paradox, multi-variable reasoning, incomplete-information logic).

STAGE 5:
• Give final evaluation on leadership strength, system-level clarity, tradeoff reasoning, and strategic thinking.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;

                
                if (resumeAnalysis) {
                    systemInstructionText += `\n\n=== CANDIDATE RESUME CONTEXT ===\n${resumeAnalysis}\n================================`;
                } else {
                    systemInstructionText += `\n\n(No resume provided. Skip Stage 2 specific references and ask general experience questions instead).`;
                }
            } else {
                // PRESENTATION / SEMINAR MODE INSTRUCTION
                systemInstructionText = `
                You are a supportive but attentive Presentation Coach and Audience.
                The user is delivering a seminar/presentation.
                
                Topic/Title: '${settings.role}'
                Target Audience: '${settings.topics}'
                Language: ${settings.language} (STRICTLY).
                
                YOUR GOAL: Help the user deliver an accurate, clear, and engaging presentation.
                
                YOUR ROLE:
                1. LISTEN predominantly. Let the user speak for long periods if they are presenting a slide.
                2. REAL-TIME FACT CHECKING (CRITICAL):
                   - Actively compare the user's spoken words against the [SLIDE CONTENT SUMMARY] provided below.
                   - If the user contradicts the slides (e.g., wrong data, conflicting dates, misstated facts), INTERRUPT POLITELY to correct them.
                     Example: "Excuse me, I noticed a discrepancy. Your slides mention [Fact from slides], but you said [Error]. Could you clarify?"
                   - If the user misses a crucial argument from the summary, gently nudge them.
                3. CLARITY & PACING:
                   - If the user is silent for more than 5 seconds, prompt them: "Please continue," or "Are you ready for the next point?".
                   - If the user uses jargon inappropriate for the Target Audience ('${settings.topics}'), interrupt to ask for a simpler explanation.
                4. POSITIVE REINFORCEMENT:
                   - If the user explains a complex concept well, acknowledge it briefly ("That's a clear explanation, please go on").
                5. Do NOT ask job interview questions. You are simulating the audience for a seminar.
                `;

                if (resumeAnalysis) {
                    systemInstructionText += `\n\n=== SLIDE CONTENT SUMMARY (FACT SHEET) ===\n${resumeAnalysis}\nUse this to verify their facts strictly.\n================================`;
                }
            }
            
            if (settings.mode === 'timed') {
                systemInstructionText += `\nNOTE: This is a timed session. The user has 90 seconds for each segment.`
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

                            // --- ADVANCED AUDIO PROCESSING STAGE ---
                            // Tuned for human speech extraction
                            const NOISE_THRESHOLD = 0.01;
                            const TARGET_RMS = 0.2; 
                            const MAX_GAIN = 8.0;   
                            const ATTACK_COEFF = 0.8; // Fast attack
                            const RELEASE_COEFF = 0.98; // Slow release
                            const GAIN_SMOOTHING = 0.9;

                            // 1. Calculate RMS (Volume)
                            let sum = 0;
                            for (let i = 0; i < inputData.length; i++) {
                                sum += inputData[i] * inputData[i];
                            }
                            const rms = Math.sqrt(sum / inputData.length);

                            // 2. Retrieve state
                            let { smoothedVolume, currentGain } = audioRefs.current.audioProcessingState;

                            // 3. Envelope Tracking (Attack/Release)
                            if (rms > smoothedVolume) {
                                smoothedVolume = ATTACK_COEFF * smoothedVolume + (1 - ATTACK_COEFF) * rms;
                            } else {
                                smoothedVolume = RELEASE_COEFF * smoothedVolume + (1 - RELEASE_COEFF) * rms;
                            }

                            // --- SPEAKING TIMER LOGIC ---
                            // Detect speech presence using a threshold slightly above noise floor
                            const SPEECH_DETECT_THRESHOLD = 0.02; 
                            const SILENCE_TIMEOUT = 2000; // 2 seconds

                            if (smoothedVolume > SPEECH_DETECT_THRESHOLD) {
                                lastSpeechDetectedTimeRef.current = Date.now();
                                if (!isUserSpeakingRef.current) {
                                    isUserSpeakingRef.current = true;
                                    speechStartTimeRef.current = Date.now();
                                }
                            } else {
                                // If silence persists longer than timeout, reset the speaking state
                                if (isUserSpeakingRef.current && (Date.now() - lastSpeechDetectedTimeRef.current > SILENCE_TIMEOUT)) {
                                    isUserSpeakingRef.current = false;
                                    speechStartTimeRef.current = null;
                                }
                            }
                            // --- END SPEAKING TIMER LOGIC ---

                            // 4. Calculate Target Gain based on Dynamic Compression / Expansion
                            let targetGain = 1.0;
                            if (smoothedVolume < NOISE_THRESHOLD) {
                                targetGain = 0; // Gate Closed
                            } else {
                                targetGain = TARGET_RMS / (smoothedVolume + 0.0001);
                                targetGain = Math.min(targetGain, MAX_GAIN);
                                targetGain = Math.max(targetGain, 1.0); // Only boost, don't attenuate loud speech too much
                            }

                            // 5. Smooth the Gain Application
                            currentGain = GAIN_SMOOTHING * currentGain + (1 - GAIN_SMOOTHING) * targetGain;

                            // 6. Apply Gain & Soft Limiting
                            for (let i = 0; i < inputData.length; i++) {
                                inputData[i] *= currentGain;
                                // Soft Clipper to prevent digital distortion
                                if (inputData[i] > 0.99) inputData[i] = 0.99;
                                if (inputData[i] < -0.99) inputData[i] = -0.99;
                            }
                            
                            // Save state
                            audioRefs.current.audioProcessingState = { smoothedVolume, currentGain };
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
                        
                        // If model speaks or turn completes, reset the user speaking timer
                        if (message.serverContent?.modelTurn || message.serverContent?.turnComplete) {
                            isUserSpeakingRef.current = false;
                            speechStartTimeRef.current = null;
                            setSpeakingDuration(0);
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
            console.error("Failed to start session:", err);
            // Enhanced error handling for permissions
            if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError' || err.message.includes('permission') || err.message.includes('denied')) {
                setPermissionDenied(true);
                setShowPermissionModal(true); // Re-open or keep open the modal to show the error
                setError(null);
            } else {
                setError(`Failed to start session: ${err.message}. Please check microphone permissions and try again.`);
                setShowPermissionModal(false);
            }
            setIsLoading(false);
            cleanupAudioResources();
        }
    };
    
    const generateFeedback = async (finalTranscript: TranscriptEntry[]) => {
        if (finalTranscript.length === 0) {
            setFeedback({ 
                summary: "No session data to analyze. The session was too short.", 
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
            
            let prompt = "";
            if (sessionType === 'interview') {
                 prompt = `As an expert hiring manager, analyze the following interview transcript for the role of '${settings.role}'. 
                
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
            } else {
                // Presentation or Seminar Feedback
                prompt = `As an expert Presentation and Public Speaking Coach, analyze the following ${sessionType} transcript.
                Title: ${settings.role}
                Audience: ${settings.topics}
                
                TRANSCRIPT:
                ${fullTranscriptText}
                
                TASKS:
                1. Evaluate the presentation based on:
                   - Content Fidelity (Did they stick to the correct facts?) -> Score as Relevance
                   - Clarity (Was the message easy to understand and well articulated?) -> Score as Clarity
                   - Pacing & Delivery (Did they ramble or keep a good pace?) -> Score as Conciseness
                   - Fact Accuracy (Were their facts correct based on the context?) -> Score as Technical Accuracy
                2. Provide a detailed summary of the performance.
                3. Identify 3 specific strengths in their delivery or content. QUOTE THE TRANSCRIPT.
                4. Identify 3 specific areas for improvement (e.g. incorrect facts, filler words, confusing explanations). QUOTE THE TRANSCRIPT and provide a fix.
                5. Provide 3 actionable tips for their next seminar/presentation.

                Output strictly in JSON matching the schema structure provided.
                `;
            }

            const responseSchema = {
                type: Type.OBJECT,
                properties: {
                    summary: { type: Type.STRING, description: "Executive summary of the performance." },
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

    const handleStartSessionSetup = (type: 'interview' | 'presentation' | 'seminar') => {
        setSessionType(type);
        setScreen('setup');
        // Reset analysis when switching modes
        setResumeAnalysis('');
        setResumeFile(null);
        setSettings(prev => ({
            ...prev,
            role: type === 'interview' ? 'Software Engineer' : (type === 'seminar' ? 'Research Topic' : 'Quarterly Business Review'),
            topics: type === 'interview' ? 'React, TypeScript' : 'Audience',
        }));
    };
    
    // Helper to get score tooltip text
    const getScoreExplanation = (metric: string) => {
        if (sessionType === 'interview') {
            switch (metric) {
                case 'relevance': return "How well your answer addressed the specific question asked.";
                case 'clarity': return "How structured, logical, and easy to follow your response was.";
                case 'conciseness': return "Whether you avoided rambling and got to the point efficiently.";
                case 'technicalAccuracy': return "The correctness and depth of your technical knowledge.";
                default: return "";
            }
        } else {
            switch (metric) {
                case 'relevance': return "Content Fidelity: Did you stick to the facts in your slides?";
                case 'clarity': return "Speech Clarity: Was your delivery articulate and easy to understand?";
                case 'conciseness': return "Pacing: Did you maintain a good flow without rushing or dragging?";
                case 'technicalAccuracy': return "Fact Accuracy: Were your statements factually correct?";
                default: return "";
            }
        }
    };

    // Helper for speaking time color
    const getTimerColor = (seconds: number) => {
        if (seconds < 45) return '#34C759';
        if (seconds < 90) return '#FFD700'; // Gold/Yellow
        return '#FF3B30';
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
                
                @keyframes fadeIn {
                    from { opacity: 0; transform: translateY(10px); }
                    to { opacity: 1; transform: translateY(0); }
                }

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
                    color: var(--text-color); 
                    position: relative;
                    z-index: 10;
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
                    margin-left: 8px;
                    cursor: help;
                    vertical-align: middle;
                }
                .info-icon {
                    background: #eee;
                    color: #666;
                    width: 18px;
                    height: 18px;
                    border-radius: 50%;
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 11px;
                    font-weight: bold;
                    font-family: sans-serif;
                }
                .tooltip-content {
                    visibility: hidden;
                    width: 220px;
                    background-color: #333;
                    color: #fff;
                    text-align: center;
                    border-radius: 6px;
                    padding: 8px 10px;
                    position: absolute;
                    z-index: 20;
                    bottom: 125%;
                    left: 50%;
                    transform: translateX(-50%);
                    opacity: 0;
                    transition: opacity 0.3s;
                    font-size: 0.8rem;
                    line-height: 1.4;
                    font-weight: normal;
                    box-shadow: 0 4px 10px rgba(0,0,0,0.2);
                    text-transform: none;
                }
                .tooltip-content::after {
                    content: "";
                    position: absolute;
                    top: 100%;
                    left: 50%;
                    margin-left: -5px;
                    border-width: 5px;
                    border-style: solid;
                    border-color: #333 transparent transparent transparent;
                }
                .tooltip-container:hover .tooltip-content {
                    visibility: visible;
                    opacity: 1;
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
                .score-item h4 { 
                    margin: 0 0 8px 0; 
                    font-weight: 600; 
                    color: #555; 
                    font-size: 0.75rem; 
                    text-transform: uppercase; 
                    display: flex;
                    align-items: center;
                    justify-content: center;
                }
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

                @media (max-width: 600px) {
                    .scores-detailed {
                        grid-template-columns: repeat(2, 1fr);
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

                /* Animation for Interview Pulse */
                .animated-pulse-ring {
                  box-shadow: 0 0 0 0 rgba(242, 140, 140, 0.7); /* Matching interview-primary color */
                  animation: pulse-ring 2s infinite;
                }
                @keyframes pulse-ring {
                  0% {
                    transform: scale(0.95);
                    box-shadow: 0 0 0 0 rgba(242, 140, 140, 0.7);
                  }
                  70% {
                    transform: scale(1);
                    box-shadow: 0 0 0 25px rgba(242, 140, 140, 0);
                  }
                  100% {
                    transform: scale(0.95);
                    box-shadow: 0 0 0 0 rgba(242, 140, 140, 0);
                  }
                }

            `}</style>
            
            {screen === 'home' ? (
               <div className="relative flex min-h-screen w-full flex-col group/design-root overflow-hidden bg-background-light dark:bg-background-dark">
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
                        <h2 className="text-zinc-900 dark:text-white text-lg font-bold leading-tight tracking-[-0.015em] flex-1 ml-2">SpeakEasy AI</h2>
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
                            <h1 className="text-zinc-900 dark:text-white text-[40px] font-black leading-tight tracking-tighter text-center pt-8 pb-3">Speak with Confidence</h1>
                            <p className="text-zinc-700 dark:text-zinc-300 text-base font-normal leading-normal pb-8 pt-1 px-4 text-center max-w-sm">Practice for high-stakes interviews or perfect your seminar presentations with real-time AI feedback.</p>
                            
                            <div className="w-full max-w-4xl grid grid-cols-1 md:grid-cols-3 gap-6 px-4">
                                {/* Interview Card with Animated Border */}
                                <div className="relative group cursor-pointer w-full h-full" onClick={() => handleStartSessionSetup('interview')}>
                                    {/* Rotating Gradient Border */}
                                    <div className="absolute -inset-[2px] rounded-2xl bg-gradient-to-r from-blue-400 via-purple-500 to-blue-400 opacity-60 group-hover:opacity-100 blur-[2px] animate-spin-slow transition-opacity duration-500"></div>
                                    {/* Inner Content */}
                                    <div className="relative flex flex-col items-center justify-center p-6 rounded-2xl bg-white/80 dark:bg-zinc-900/90 backdrop-blur-md h-full transition-transform duration-200 group-hover:scale-[0.98]">
                                        <div className="bg-blue-100 dark:bg-blue-900/40 p-3 rounded-full mb-3 shadow-inner">
                                            <span className="material-symbols-outlined text-3xl text-blue-600 dark:text-blue-300">work</span>
                                        </div>
                                        <h3 className="text-xl font-bold text-zinc-900 dark:text-white mb-1">Job Interview</h3>
                                        <p className="text-sm text-zinc-600 dark:text-zinc-400 text-center">Practice behavioral & technical questions</p>
                                    </div>
                                </div>
                                
                                {/* Presentation Card with Animated Border */}
                                <div className="relative group cursor-pointer w-full h-full" onClick={() => handleStartSessionSetup('presentation')}>
                                    {/* Rotating Gradient Border */}
                                    <div className="absolute -inset-[2px] rounded-2xl bg-gradient-to-r from-pink-400 via-purple-500 to-pink-400 opacity-60 group-hover:opacity-100 blur-[2px] animate-spin-slow transition-opacity duration-500"></div>
                                    {/* Inner Content */}
                                    <div className="relative flex flex-col items-center justify-center p-6 rounded-2xl bg-white/80 dark:bg-zinc-900/90 backdrop-blur-md h-full transition-transform duration-200 group-hover:scale-[0.98]">
                                        <div className="bg-purple-100 dark:bg-purple-900/40 p-3 rounded-full mb-3 shadow-inner">
                                            <span className="material-symbols-outlined text-3xl text-purple-600 dark:text-purple-300">present_to_all</span>
                                        </div>
                                        <h3 className="text-xl font-bold text-zinc-900 dark:text-white mb-1">Presentation</h3>
                                        <p className="text-sm text-zinc-600 dark:text-zinc-400 text-center">Rehearse slides & delivery</p>
                                    </div>
                                </div>

                                {/* Seminar Card with Animated Border */}
                                <div className="relative group cursor-pointer w-full h-full" onClick={() => handleStartSessionSetup('seminar')}>
                                    {/* Rotating Gradient Border */}
                                    <div className="absolute -inset-[2px] rounded-2xl bg-gradient-to-r from-orange-400 via-yellow-500 to-orange-400 opacity-60 group-hover:opacity-100 blur-[2px] animate-spin-slow transition-opacity duration-500"></div>
                                    {/* Inner Content */}
                                    <div className="relative flex flex-col items-center justify-center p-6 rounded-2xl bg-white/80 dark:bg-zinc-900/90 backdrop-blur-md h-full transition-transform duration-200 group-hover:scale-[0.98]">
                                        <div className="bg-orange-100 dark:bg-orange-900/40 p-3 rounded-full mb-3 shadow-inner">
                                            <span className="material-symbols-outlined text-3xl text-orange-600 dark:text-orange-300">school</span>
                                        </div>
                                        <h3 className="text-xl font-bold text-zinc-900 dark:text-white mb-1">Seminar</h3>
                                        <p className="text-sm text-zinc-600 dark:text-zinc-400 text-center">Academic & research talk prep</p>
                                    </div>
                                </div>
                            </div>

                        </div>
                        <div className="mt-16 w-full max-w-md mx-auto px-4">
                            <h3 className="text-2xl font-bold text-zinc-900 dark:text-white text-center">How it works</h3>
                            <div className="mt-6 space-y-4">
                                <div className="flex items-start gap-4">
                                    <div className="flex-shrink-0 mt-1 flex h-6 w-6 items-center justify-center rounded-full bg-blue-100 dark:bg-blue-900/50">
                                        <span className="material-symbols-outlined text-sm text-blue-600 dark:text-blue-300">upload_file</span>
                                    </div>
                                    <div>
                                        <h4 className="font-bold text-zinc-800 dark:text-zinc-100">Upload Your Materials</h4>
                                        <p className="text-zinc-600 dark:text-zinc-400 text-sm mt-1">Upload your resume for interviews, or your slides for presentations.</p>
                                    </div>
                                </div>
                                <div className="flex items-start gap-4">
                                    <div className="flex-shrink-0 mt-1 flex h-6 w-6 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/50">
                                        <span className="material-symbols-outlined text-sm text-green-600 dark:text-green-300">mic</span>
                                    </div>
                                    <div>
                                        <h4 className="font-bold text-zinc-800 dark:text-zinc-100">Live Interaction</h4>
                                        <p className="text-zinc-600 dark:text-zinc-400 text-sm mt-1">Answer questions or present your topic. The AI listens and reacts in real-time.</p>
                                    </div>
                                </div>
                                <div className="flex items-start gap-4">
                                    <div className="flex-shrink-0 mt-1 flex h-6 w-6 items-center justify-center rounded-full bg-purple-100 dark:bg-purple-900/50">
                                        <span className="material-symbols-outlined text-sm text-purple-600 dark:text-purple-300">analytics</span>
                                    </div>
                                    <div>
                                        <h4 className="font-bold text-zinc-800 dark:text-zinc-100">Get Expert Feedback</h4>
                                        <p className="text-zinc-600 dark:text-zinc-400 text-sm mt-1">Receive a detailed breakdown of your performance, accuracy, and delivery.</p>
                                    </div>
                                </div>
                            </div>
                        </div>
                        
                        {/* REVIEWS SECTION */}
                         <div className="mt-20 w-full max-w-4xl mx-auto px-4 pb-20">
                            <h3 className="text-2xl font-bold text-zinc-900 dark:text-white text-center mb-8">Trusted by Professionals</h3>
                            
                            <div className="relative overflow-hidden min-h-[200px] flex justify-center">
                                 <div key={currentReviewIndex} className="w-full max-w-2xl bg-white/60 dark:bg-zinc-900/60 backdrop-blur-md p-8 rounded-2xl border border-white/20 dark:border-white/5 shadow-xl text-center animate-[fadeIn_0.5s_ease-in-out]">
                                    <div className="flex justify-center mb-4">
                                        <div className="w-12 h-12 rounded-full bg-gradient-to-br from-blue-400 to-purple-500 flex items-center justify-center text-white font-bold text-xl shadow-lg">
                                            {reviews[currentReviewIndex].avatar}
                                        </div>
                                    </div>
                                    <p className="text-lg text-zinc-700 dark:text-zinc-300 italic mb-6 leading-relaxed">"{reviews[currentReviewIndex].content}"</p>
                                    <h4 className="font-bold text-zinc-900 dark:text-white text-lg">{reviews[currentReviewIndex].name}</h4>
                                    <p className="text-sm text-zinc-500 dark:text-zinc-400 font-medium">{reviews[currentReviewIndex].role}</p>
                                 </div>
                            </div>
                            
                            <div className="flex justify-center mt-6 gap-2">
                                {reviews.map((_, idx) => (
                                    <button
                                        key={idx}
                                        onClick={() => setCurrentReviewIndex(idx)}
                                        className={`w-3 h-3 rounded-full transition-all duration-300 ${idx === currentReviewIndex ? 'bg-primary w-6' : 'bg-zinc-300 dark:bg-zinc-700 hover:bg-zinc-400'}`}
                                        aria-label={`Go to review ${idx + 1}`}
                                    />
                                ))}
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
                            <h2 className="text-deep-navy dark:text-white text-lg font-bold leading-tight tracking-tight flex-1 text-center">
                                {sessionType === 'interview' ? 'Interview Setup' : (sessionType === 'seminar' ? 'Seminar Setup' : 'Presentation Setup')}
                            </h2>
                            <div className="size-10 shrink-0"></div>
                        </div>
                        <main className="relative flex-1 px-4 pt-4 pb-8 z-10 flex flex-col items-center">
                            <div className="flex flex-col gap-6 w-full max-w-[480px]">
                                <div className="flex flex-wrap items-end gap-4 w-full">
                                    <label className="flex flex-col min-w-40 flex-1">
                                        <p className="text-deep-navy dark:text-white text-base font-medium leading-normal pb-2">
                                            {sessionType === 'interview' ? 'Target Role' : 'Presentation Title'}
                                        </p>
                                        <input 
                                            name="role"
                                            value={settings.role}
                                            onChange={handleSettingsChange}
                                            className="form-input flex w-full min-w-0 flex-1 resize-none overflow-hidden rounded-xl text-deep-navy dark:text-deep-navy focus:outline-0 focus:ring-2 focus:ring-mango-orange/50 border border-pastel-pink/50 dark:border-pastel-pink/50 bg-airy-cream dark:bg-airy-cream backdrop-blur-sm focus:border-mango-orange h-14 placeholder:text-deep-navy/60 dark:placeholder:text-deep-navy/60 p-[15px] text-base font-normal leading-normal" 
                                            placeholder={sessionType === 'interview' ? "e.g. Product Manager" : "e.g. Q3 Business Review"} 
                                        />
                                    </label>
                                </div>
                                <div className="flex flex-wrap items-end gap-4 w-full">
                                    <label className="flex flex-col min-w-40 flex-1">
                                        <p className="text-deep-navy dark:text-white text-base font-medium leading-normal pb-2">
                                            {sessionType === 'interview' ? 'Key Topics / Skills' : 'Target Audience'}
                                        </p>
                                        <textarea 
                                            name="topics"
                                            value={settings.topics}
                                            onChange={handleSettingsChange}
                                            className="form-input flex w-full min-w-0 flex-1 resize-none overflow-hidden rounded-xl text-deep-navy dark:text-deep-navy focus:outline-0 focus:ring-2 focus:ring-mango-orange/50 border border-pastel-pink/50 dark:border-pastel-pink/50 bg-airy-cream dark:bg-airy-cream backdrop-blur-sm focus:border-mango-orange min-h-36 placeholder:text-deep-navy/60 dark:placeholder:text-deep-navy/60 p-[15px] text-base font-normal leading-normal" 
                                            placeholder={sessionType === 'interview' ? "e.g. A/B testing, user research" : "e.g. Executive Team, Investors, Students"}
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
                                            {resumeFile 
                                                ? resumeFile.name 
                                                : (sessionType === 'interview' ? "Upload Resume (PDF - Optional)" : "Upload Slides (PDF - Recommended)")
                                            }
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
                                            <p className="text-deep-navy dark:text-deep-navy text-base font-normal leading-normal flex-1 truncate">AI Voice</p>
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

                                    {sessionType === 'interview' && (
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
                                    )}

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
                                    {isLoading ? 'Preparing Session...' : (sessionType === 'interview' ? 'Start Interview' : (sessionType === 'seminar' ? 'Start Seminar' : 'Start Presentation'))}
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
                    <div className="container" style={screen === 'interview' ? {maxWidth: '100%', height: '100vh', margin: 0, padding: 0, borderRadius: 0, border: 'none', background: 'transparent', display: 'flex', flexDirection: 'column'} : {}}>
                        {screen === 'briefing' && (
                            <>
                                <h1>{sessionType === 'interview' ? 'Interview Briefing' : 'Session Briefing'}</h1>
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
                            <div className="flex flex-col h-screen p-6 w-full max-w-[600px] mx-auto">
                                <main className="flex flex-col flex-1 h-full">
                                    <div className="flex-grow flex flex-col items-center pt-8">
                                        <div className="flex flex-col items-center">
                                            {/* Pulse Ring and Microphone */}
                                            <div className="relative w-32 h-32 flex items-center justify-center">
                                                <div className="absolute inset-0 bg-gradient-to-br from-gradient-start to-gradient-end rounded-full animated-pulse-ring"></div>
                                                <div className="relative w-28 h-28 bg-white/50 dark:bg-black/20 backdrop-blur-sm rounded-full flex items-center justify-center shadow-xl">
                                                    <span className="material-icons text-white text-5xl">mic</span>
                                                </div>
                                            </div>
                                            
                                            {/* Video Feed */}
                                            <div className="w-32 h-44 mt-6 bg-surface-dark rounded-3xl shadow-lg border-2 border-white/10 overflow-hidden relative group">
                                                <video 
                                                    ref={videoRef} 
                                                    autoPlay 
                                                    muted 
                                                    playsInline 
                                                    className={`absolute inset-0 w-full h-full object-cover transform scale-x-[-1] ${isCameraOff ? 'hidden' : ''}`}
                                                />
                                                {isCameraOff && (
                                                     <div className="absolute inset-0 flex items-center justify-center bg-gray-800 text-white">
                                                        <span className="material-icons text-3xl">videocam_off</span>
                                                     </div>
                                                )}
                                                
                                                {/* Controls Overlay with Tooltips */}
                                                <div className="absolute bottom-2 left-1/2 -translate-x-1/2 w-auto bg-black/40 backdrop-blur-sm rounded-full p-2 flex items-center justify-center space-x-2 opacity-0 group-hover:opacity-100 transition-opacity duration-300">
                                                    <button onClick={toggleMute} className="group/btn relative text-white hover:text-red-400 transition-colors p-2">
                                                        <span className="material-icons text-lg">{isMuted ? 'mic_off' : 'mic'}</span>
                                                        <span className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 bg-black/80 text-white text-xs px-2 py-1 rounded opacity-0 group-hover/btn:opacity-100 transition-opacity whitespace-nowrap pointer-events-none">
                                                            {isMuted ? 'Unmute Microphone' : 'Mute Microphone'}
                                                        </span>
                                                    </button>
                                                    <button onClick={toggleCamera} className="group/btn relative text-white hover:text-red-400 transition-colors p-2">
                                                        <span className="material-icons text-lg">{isCameraOff ? 'videocam_off' : 'videocam'}</span>
                                                        <span className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 bg-black/80 text-white text-xs px-2 py-1 rounded opacity-0 group-hover/btn:opacity-100 transition-opacity whitespace-nowrap pointer-events-none">
                                                            {isCameraOff ? 'Turn Camera On' : 'Turn Camera Off'}
                                                        </span>
                                                    </button>
                                                </div>
                                            </div>
                                        </div>

                                        <h1 className="text-2xl font-bold text-heading-light dark:text-heading-dark mt-8 text-center">
                                            {sessionType === 'interview' ? 'Interview in Progress' : (sessionType === 'seminar' ? 'Seminar Mode' : 'Presentation Mode')}
                                        </h1>
                                        <p className="text-sm text-text-light dark:text-text-dark mt-1 text-center">
                                            {sessionType === 'interview' ? 'Listening to your answers...' : 'Listening to your presentation...'}
                                        </p>

                                        {/* Speaking Timer Indicator */}
                                        {speakingDuration > 0 && (
                                            <div className="mt-3 px-3 py-1 bg-surface-light dark:bg-surface-dark rounded-full shadow-sm border border-gray-200 dark:border-gray-700 flex items-center gap-2">
                                                 <div className="w-2 h-2 rounded-full animate-pulse" style={{backgroundColor: getTimerColor(speakingDuration)}}></div>
                                                 <span className="text-xs font-semibold text-text-light dark:text-text-dark">{speakingDuration.toFixed(1)}s</span>
                                            </div>
                                        )}
                                         {settings.mode === 'timed' && timeLeft !== null && (
                                            <div className="mt-2 text-xl font-bold" style={{ color: timeLeft < 30 ? 'var(--error-color)' : 'var(--primary-color)' }}>
                                                {timeLeft}s
                                            </div>
                                        )}

                                        {/* Transcript Area */}
                                        <div className="w-full bg-surface-light dark:bg-surface-dark rounded-2xl mt-8 p-4 flex-grow overflow-hidden shadow-inner flex flex-col border border-gray-100 dark:border-gray-800" style={{maxHeight: '30vh'}}>
                                            <div className="overflow-y-auto flex-grow space-y-3 custom-scrollbar pr-2">
                                                {transcript.length === 0 ? (
                                                    <p className="text-text-light/50 dark:text-text-dark/50 text-sm text-center italic mt-10">Conversation will appear here...</p>
                                                ) : (
                                                    transcript.map((t, i) => (
                                                        <div key={i} className={`flex flex-col ${t.speaker === 'user' ? 'items-end' : 'items-start'}`}>
                                                            <span className="text-[10px] text-gray-400 mb-1 uppercase tracking-wider">{t.speaker === 'user' ? 'You' : 'AI Coach'}</span>
                                                            <div className={`p-3 rounded-2xl max-w-[90%] text-sm ${t.speaker === 'user' ? 'bg-indigo-500 text-white rounded-br-none' : 'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200 rounded-bl-none'}`}>
                                                                {t.text}
                                                            </div>
                                                        </div>
                                                    ))
                                                )}
                                                <div ref={transcriptEndRef} />
                                            </div>
                                        </div>
                                    </div>

                                    <div className="mt-6 mb-4">
                                        <button 
                                            onClick={stopInterview}
                                            className="w-full bg-interview-primary text-white font-semibold py-4 rounded-full shadow-lg shadow-red-400/30 hover:shadow-red-400/50 hover:opacity-95 transition-all transform hover:scale-[1.01]"
                                        >
                                            End Session
                                        </button>
                                    </div>
                                </main>
                            </div>
                        )}

                        {screen === 'feedback' && feedback && (
                            <div className="w-full max-w-[800px] mx-auto">
                                <h1>Performance Analysis</h1>
                                
                                <div style={{ textAlign: 'center', marginBottom: '30px' }}>
                                    <div className="score-circle">
                                        <span>{feedback.overall}</span>
                                        <div style={{ fontSize: '0.9rem', marginTop: '5px' }}>Overall Score</div>
                                    </div>
                                </div>

                                <div className="scores-detailed">
                                    <div className="score-item">
                                        <h4>
                                            {sessionType === 'interview' ? 'Relevance' : 'Content Fidelity'}
                                            <div className="tooltip-container">
                                                <span className="info-icon">i</span>
                                                <div className="tooltip-content">{getScoreExplanation('relevance')}</div>
                                            </div>
                                        </h4>
                                        <p>{feedback.relevance}/10</p>
                                    </div>
                                    <div className="score-item">
                                        <h4>
                                            {sessionType === 'interview' ? 'Clarity' : 'Speech Clarity'}
                                            <div className="tooltip-container">
                                                <span className="info-icon">i</span>
                                                <div className="tooltip-content">{getScoreExplanation('clarity')}</div>
                                            </div>
                                        </h4>
                                        <p>{feedback.clarity}/10</p>
                                    </div>
                                    <div className="score-item">
                                        <h4>
                                            {sessionType === 'interview' ? 'Conciseness' : 'Pacing'}
                                            <div className="tooltip-container">
                                                <span className="info-icon">i</span>
                                                <div className="tooltip-content">{getScoreExplanation('conciseness')}</div>
                                            </div>
                                        </h4>
                                        <p>{feedback.conciseness}/10</p>
                                    </div>
                                    <div className="score-item">
                                        <h4>
                                            {sessionType === 'interview' ? 'Tech Accuracy' : 'Fact Accuracy'}
                                            <div className="tooltip-container">
                                                <span className="info-icon">i</span>
                                                <div className="tooltip-content">{getScoreExplanation('technicalAccuracy')}</div>
                                            </div>
                                        </h4>
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
                                                        {t.speaker === 'user' ? 'You' : 'AI Coach'}:
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
                                To simulate a real session, we need access to your microphone and camera. 
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