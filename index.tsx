import React, { useState, useRef, useEffect } from 'react';
import { createRoot } from "react-dom/client";
import { GoogleGenAI, LiveServerMessage, Modality } from "@google/genai";

type SessionType = 'interview' | 'seminar' | 'presentation';

interface Settings {
    role: string;
    topics: string;
    language: string;
    voice: string;
    difficulty: 'Easy' | 'Medium' | 'Hard';
    mode: string;
    qLimit: string;
}

// --- Helper Functions ---

const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = () => {
            const result = reader.result as string;
            const base64 = result.split(',')[1];
            resolve(base64);
        };
        reader.onerror = (error) => reject(error);
    });
};

function decode(base64: string) {
    const binaryString = atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
}

function encode(bytes: Uint8Array) {
    let binary = '';
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

async function decodeAudioData(
    data: Uint8Array,
    ctx: AudioContext,
    sampleRate: number,
    numChannels: number,
): Promise<AudioBuffer> {
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

function createBlob(data: Float32Array) {
    const l = data.length;
    const int16 = new Int16Array(l);
    for (let i = 0; i < l; i++) {
        int16[i] = data[i] * 32768;
    }
    return {
        data: encode(new Uint8Array(int16.buffer)),
        mimeType: 'audio/pcm;rate=16000',
    };
}

// --- Main Component ---

function App() {
    const [screen, setScreen] = useState<string>('home'); // home, setup, briefing, interview
    const [loadingAction, setLoadingAction] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    
    // Setup State
    const [sessionType, setSessionType] = useState<SessionType>('interview');
    const [settings, setSettings] = useState<Settings>({
        role: 'Software Engineer',
        topics: 'React, TypeScript',
        language: 'English',
        voice: 'Zephyr',
        difficulty: 'Medium',
        mode: 'Standard',
        qLimit: 'Unlimited',
    });
    const [resumeFile, setResumeFile] = useState<File | null>(null);
    const [resumeAnalysis, setResumeAnalysis] = useState<string>('');
    
    // Briefing State
    const [briefingText, setBriefingText] = useState<string>('');

    // Session State
    const [transcript, setTranscript] = useState<Array<{speaker: 'user' | 'ai', text: string}>>([]);
    const [isMuted, setIsMuted] = useState(false);
    const [isAiSpeaking, setIsAiSpeaking] = useState(false);

    // Refs for Audio & Logic
    const sessionRef = useRef<any>(null);
    const isSessionActive = useRef(false);
    const isAiSpeakingRef = useRef(false);
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const transcriptEndRef = useRef<HTMLDivElement>(null);
    
    // Audio Scheduling Refs
    const nextAudioStartTimeRef = useRef(0);
    const activeSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
    
    const transcriptionBuffer = useRef({ input: '', output: '' });

    const audioRefs = useRef<{
        inputAudioContext: AudioContext | null;
        outputAudioContext: AudioContext | null;
        outputCompressor: DynamicsCompressorNode | null;
        stream: MediaStream | null;
        scriptProcessor: ScriptProcessorNode | null;
        source: MediaStreamAudioSourceNode | null;
    }>({
        inputAudioContext: null,
        outputAudioContext: null,
        outputCompressor: null,
        stream: null,
        scriptProcessor: null,
        source: null,
    });

    // --- Effects ---

    useEffect(() => {
        // Auto-scroll transcript
        if (transcriptEndRef.current) {
            transcriptEndRef.current.scrollIntoView({ behavior: 'smooth' });
        }
    }, [transcript]);

    // --- Cleanup ---

    const cleanupAudioResources = async () => {
        isSessionActive.current = false;
        isAiSpeakingRef.current = false;
        setIsAiSpeaking(false);
        nextAudioStartTimeRef.current = 0;

        // Stop all playing sources
        activeSourcesRef.current.forEach(source => {
            try { source.stop(); } catch(e) {}
        });
        activeSourcesRef.current.clear();

        if (sessionRef.current) {
             sessionRef.current = null;
        }

        if (audioRefs.current.scriptProcessor) {
            try { audioRefs.current.scriptProcessor.disconnect(); } catch(e) {}
            audioRefs.current.scriptProcessor = null;
        }
        if (audioRefs.current.source) {
            try { audioRefs.current.source.disconnect(); } catch(e) {}
            audioRefs.current.source = null;
        }
        if (audioRefs.current.stream) {
            audioRefs.current.stream.getTracks().forEach(track => track.stop());
            audioRefs.current.stream = null;
        }
        if (audioRefs.current.inputAudioContext) {
            try { await audioRefs.current.inputAudioContext.close(); } catch(e) {}
            audioRefs.current.inputAudioContext = null;
        }
        if (audioRefs.current.outputAudioContext) {
            try { await audioRefs.current.outputAudioContext.close(); } catch(e) {}
            audioRefs.current.outputAudioContext = null;
            audioRefs.current.outputCompressor = null;
        }
    };

    // --- Handlers ---

    const handleGenerateBriefing = async () => {
        setLoadingAction(resumeFile ? 'analyzing_file' : 'generating_briefing');
        setError(null);
        setBriefingText('');
        
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
                         resumePrompt = "You are an expert presentation coach and fact-checker. Analyze these slides/document. Extract a structured list of KEY FACTS, DATA POINTS, DEFINITIONS, and MAIN ARGUMENTS. I need to use this to fact-check the presenter in real-time if they say something wrong. Also summarize the intended narrative flow.";
                    }

                    const resumeResponse = await ai.models.generateContent({
                        model: 'gemini-3-flash-preview',
                        contents: {
                            parts: [
                                { inlineData: { mimeType: 'application/pdf', data: base64Data } },
                                { text: resumePrompt }
                            ]
                        }
                    });
                    currentResumeAnalysis = resumeResponse.text || '';
                    setResumeAnalysis(currentResumeAnalysis);
                } catch (resumeErr: any) {
                    console.error("File analysis failed", resumeErr);
                }
            }
            
            setLoadingAction('generating_briefing');
            let textPrompt = "";
            if (sessionType === 'interview') {
                textPrompt = `Generate a short, friendly, and professional welcome message for a job interview. The role is '${settings.role}', the topics are '${settings.topics}', and the difficulty level is '${settings.difficulty}'. Welcome the candidate, state the role and topics, and wish them luck. The message must be entirely in ${settings.language}.`;
                if (currentResumeAnalysis) {
                    textPrompt += `\n\nContext: The candidate has uploaded a resume. Here is the summary: ${currentResumeAnalysis}. Acknowledge that you have reviewed their resume and mention that you will be asking questions about their projects.`;
                }
            } else {
                textPrompt = `Generate a short, encouraging welcome message for a ${sessionType === 'seminar' ? 'seminar' : 'presentation'} practice session. The user is presenting on '${settings.role}' to an audience of '${settings.topics}'. The difficulty level is '${settings.difficulty}'. Welcome them, acknowledge you have reviewed their materials (if any), and ask them to begin their presentation whenever they are ready. State that you will listen actively and interrupt ONLY if you hear a factual error based on their slides. The message must be entirely in ${settings.language}.`;
                if (currentResumeAnalysis) {
                    textPrompt += `\n\nContext: The user has uploaded slides. Summary: ${currentResumeAnalysis}.`;
                }
            }
            
            const textResponse = await ai.models.generateContent({
                model: 'gemini-3-flash-preview',
                contents: textPrompt,
            });
            setBriefingText(textResponse.text || '');
            setLoadingAction(null);
            setScreen('briefing');

        } catch (err: any) {
            console.error("Error:", err);
            setError(err.message);
            setLoadingAction(null);
        }
    };

    const handleStartLiveSession = async () => {
        setScreen('interview');
        setLoadingAction('connecting');
        setError(null);
        setTranscript([]);
        
        await cleanupAudioResources();
        
        isSessionActive.current = true;
        isAiSpeakingRef.current = false;
        transcriptionBuffer.current = { input: '', output: '' };
        nextAudioStartTimeRef.current = 0;

        try {
            const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
            
            // Audio Contexts
            // NOTE: Use system default sample rate for output to avoid resampling artifacts/stuttering
            const outputCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
            const inputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
            
            audioRefs.current.outputAudioContext = outputCtx;
            audioRefs.current.inputAudioContext = inputCtx;

            // Add Dynamics Compressor to Output Chain for "Radio Voice" quality
            const compressor = outputCtx.createDynamicsCompressor();
            compressor.threshold.value = -20;
            compressor.knee.value = 30;
            compressor.ratio.value = 12;
            compressor.attack.value = 0.003;
            compressor.release.value = 0.25;
            compressor.connect(outputCtx.destination);
            audioRefs.current.outputCompressor = compressor;
            
            // Stream Setup
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
            audioRefs.current.stream = stream;
            
            if (videoRef.current) {
                videoRef.current.srcObject = stream;
            }

            // System Instructions
            let systemInstructionText = sessionType === 'interview' ? 
                `You are a Senior HR + Technical Interviewer. Role: '${settings.role}'. Focus: '${settings.topics}'. Language: ${settings.language}. Difficulty: ${settings.difficulty}.
                RULES: 
                1. Ask ONE question at a time. Wait for the user to answer.
                2. Tailor question complexity to the difficulty level: ${settings.difficulty}. 
                   - Easy: Fundamental concepts, gentle guidance.
                   - Medium: Practical applications, standard industry questions.
                   - Hard: Deep technical dives, edge cases, architectural trade-offs.
                3. Provide feedback and coaching based on the difficulty level.
                4. Wait for the user to answer before moving to the next question.
                STAGES: Introduction, Experience Check, Technical Questions, Behavioral Questions.` :
                `You are a Presentation Coach. Topic: '${settings.role}'. Audience: '${settings.topics}'. Language: ${settings.language}. Difficulty: ${settings.difficulty}.
                GOAL: Listen to the user's presentation. Only interrupt if there is a factual error or if clarity is lost. 
                Tailor your feedback and interruptions to the difficulty level: ${settings.difficulty}.
                Otherwise, provide a summary at the end.`;

            if (resumeAnalysis) systemInstructionText += `\n\nCONTEXT FROM RESUME/DOCS:\n${resumeAnalysis}`;

            const sessionPromise = ai.live.connect({
                model: 'gemini-2.5-flash-native-audio-preview-12-2025',
                callbacks: {
                    onopen: () => {
                        if (!isSessionActive.current) return;
                        setLoadingAction(null);
                        
                        // Input Processing
                        const ctx = audioRefs.current.inputAudioContext;
                        if (!ctx) return;
                        
                        const source = ctx.createMediaStreamSource(stream);
                        const scriptProcessor = ctx.createScriptProcessor(4096, 1, 1);
                        
                        scriptProcessor.onaudioprocess = (e) => {
                            if (!isSessionActive.current) return;
                            
                            // Mute input if AI is speaking to prevent echo
                            if (isAiSpeakingRef.current) {
                                return;
                            }

                            const inputData = e.inputBuffer.getChannelData(0);
                            const pcmBlob = createBlob(inputData);
                            
                            sessionPromise.then(session => {
                                session.sendRealtimeInput({ media: pcmBlob });
                            });
                        };

                        source.connect(scriptProcessor);
                        scriptProcessor.connect(ctx.destination);
                        
                        audioRefs.current.source = source;
                        audioRefs.current.scriptProcessor = scriptProcessor;
                    },
                    onmessage: async (msg: LiveServerMessage) => {
                        if (!isSessionActive.current) return;

                        // Transcription
                        if (msg.serverContent?.inputTranscription) {
                            transcriptionBuffer.current.input += msg.serverContent.inputTranscription.text;
                        }
                        if (msg.serverContent?.outputTranscription) {
                            transcriptionBuffer.current.output += msg.serverContent.outputTranscription.text;
                        }

                        if (msg.serverContent?.turnComplete) {
                            const inText = transcriptionBuffer.current.input.trim();
                            const outText = transcriptionBuffer.current.output.trim();
                            
                            if (inText) setTranscript(prev => [...prev, { speaker: 'user', text: inText }]);
                            if (outText) setTranscript(prev => [...prev, { speaker: 'ai', text: outText }]);
                            
                            transcriptionBuffer.current = { input: '', output: '' };
                        }
                        
                        // Handle Interruption
                        if (msg.serverContent?.interrupted) {
                            // Stop all currently playing audio immediately
                            activeSourcesRef.current.forEach(source => {
                                try { source.stop(); } catch(e) {}
                            });
                            activeSourcesRef.current.clear();
                            nextAudioStartTimeRef.current = 0;
                            setIsAiSpeaking(false);
                            isAiSpeakingRef.current = false;
                            return; // Stop processing this message
                        }

                        // Audio Output
                        const base64Audio = msg.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
                        if (base64Audio && audioRefs.current.outputAudioContext) {
                            const ctx = audioRefs.current.outputAudioContext;
                            // NOTE: 24000Hz is the raw rate from Gemini. 
                            // Creating the buffer with 24000Hz lets the browser's native AudioContext (e.g. 48000Hz)
                            // handle the resampling efficiently.
                            const audioBuffer = await decodeAudioData(decode(base64Audio), ctx, 24000, 1);
                            
                            const source = ctx.createBufferSource();
                            source.buffer = audioBuffer;
                            
                            // Connect to compressor for better quality
                            if (audioRefs.current.outputCompressor) {
                                source.connect(audioRefs.current.outputCompressor);
                            } else {
                                source.connect(ctx.destination);
                            }
                            
                            // Advanced Scheduling with Jitter Buffer
                            // If we have fallen behind (current time > next start time), add a small buffer (latency)
                            // to ensure continuous playback for the incoming stream.
                            const currentTime = ctx.currentTime;
                            if (nextAudioStartTimeRef.current < currentTime) {
                                nextAudioStartTimeRef.current = currentTime + 0.05; // 50ms jitter buffer
                            }
                            
                            source.start(nextAudioStartTimeRef.current);
                            nextAudioStartTimeRef.current += audioBuffer.duration;
                            
                            // Track active source
                            activeSourcesRef.current.add(source);
                            
                            source.onended = () => {
                                activeSourcesRef.current.delete(source);
                                if (activeSourcesRef.current.size === 0) {
                                    setIsAiSpeaking(false);
                                    isAiSpeakingRef.current = false;
                                }
                            };

                            setIsAiSpeaking(true);
                            isAiSpeakingRef.current = true;
                        }
                    },
                    onclose: () => {
                        console.log("Session closed");
                    },
                    onerror: (err) => {
                        console.error("Session error", err);
                        setError("Connection error");
                    }
                },
                config: {
                    responseModalities: [Modality.AUDIO],
                    inputAudioTranscription: {},
                    outputAudioTranscription: {},
                    speechConfig: {
                        voiceConfig: {
                            prebuiltVoiceConfig: { voiceName: settings.voice || 'Zephyr' },
                        },
                    },
                    systemInstruction: systemInstructionText,
                }
            });
            
            sessionRef.current = await sessionPromise;

        } catch (e: any) {
            console.error(e);
            setError(e.message);
            setLoadingAction(null);
        }
    };

    const handleEndSession = async () => {
        await cleanupAudioResources();
        setScreen('setup');
    };

    // --- Render ---

    return (
        <div className="min-h-screen bg-brand-gradient flex items-center justify-center p-4 md:p-8 font-display selection:bg-blue-100">
            {/* Main Container */}
            <div className="w-full max-w-6xl min-h-[85vh] bg-white/40 backdrop-blur-2xl rounded-[2.5rem] shadow-2xl border border-white/30 overflow-hidden flex flex-col relative">
                
                {/* Header (Only on Home or Setup) */}
                {(screen === 'home' || screen === 'setup') && (
                    <header className="px-8 py-6 flex items-center justify-between z-10">
                        <div className="flex items-center gap-3 cursor-pointer" onClick={() => setScreen('home')}>
                            <div className="w-10 h-10 bg-indigo-100 rounded-xl flex items-center justify-center shadow-inner">
                                <span className="material-symbols-outlined text-indigo-600 text-2xl">psychology</span>
                            </div>
                            <h1 className="text-2xl font-extrabold tracking-tight text-slate-800">SpeakEasy AI</h1>
                        </div>
                        <div className="flex items-center gap-4">
                            <button className="px-6 py-2 bg-white text-indigo-600 rounded-full text-sm font-bold shadow-sm hover:shadow-md transition-all">Sign In</button>
                            <span className="material-symbols-outlined text-slate-500 cursor-pointer hover:text-slate-800 transition-colors">help</span>
                        </div>
                    </header>
                )}

                {/* Content Area */}
                <div className="flex-1 flex flex-col overflow-y-auto custom-scrollbar">
                    {error && (
                        <div className="mx-8 mt-4 bg-red-500/10 border border-red-500/20 text-red-700 px-6 py-3 rounded-2xl flex items-center gap-3 animate-pulse">
                            <span className="material-symbols-outlined">error</span>
                            <span className="font-medium">{error}</span>
                        </div>
                    )}

                    {screen === 'home' && (
                        <div className="flex-1 flex flex-col items-center justify-center px-8 py-12 text-center">
                            <h2 className="text-5xl md:text-7xl font-black text-slate-900 mb-6 leading-[1.1]">
                                Master Your <br />
                                <span className="text-indigo-600">Next Conversation</span>
                            </h2>
                            <p className="text-slate-600 text-lg md:text-xl max-w-2xl mb-12 font-medium leading-relaxed">
                                AI-powered simulation for interviews, presentations, and academic defenses. 
                                Real-time feedback, zero judgement.
                            </p>

                            {/* Feature Cards */}
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 w-full max-w-5xl mb-16">
                                {[
                                    { id: 'interview', title: 'Job Interview', desc: 'Behavioral & technical prep', icon: 'work', color: 'blue' },
                                    { id: 'presentation', title: 'Presentation', desc: 'Slide & delivery coaching', icon: 'present_to_all', color: 'purple' },
                                    { id: 'seminar', title: 'Seminar Defense', desc: 'Academic rigor check', icon: 'school', color: 'orange' }
                                ].map(card => (
                                    <div 
                                        key={card.id}
                                        onClick={() => { setSessionType(card.id as SessionType); setScreen('setup'); }}
                                        className="bg-white/60 hover:bg-white/80 p-8 rounded-[2rem] border border-white/50 shadow-sm hover:shadow-xl transition-all cursor-pointer group text-left"
                                    >
                                        <div className={`w-12 h-12 rounded-2xl flex items-center justify-center mb-6 transition-transform group-hover:scale-110 ${
                                            card.color === 'blue' ? 'bg-blue-50 text-blue-600' : 
                                            card.color === 'purple' ? 'bg-purple-50 text-purple-600' : 'bg-orange-50 text-orange-600'
                                        }`}>
                                            <span className="material-symbols-outlined text-2xl">{card.icon}</span>
                                        </div>
                                        <h3 className="text-xl font-bold text-slate-800 mb-2">{card.title}</h3>
                                        <p className="text-slate-500 text-sm font-medium">{card.desc}</p>
                                    </div>
                                ))}
                            </div>

                            {/* Testimonial Carousel (Simplified) */}
                            <div className="w-full max-w-3xl bg-white/50 p-8 rounded-[2.5rem] border border-white/40 relative">
                                <div className="flex flex-col items-center">
                                    <div className="w-12 h-12 bg-blue-600 rounded-full flex items-center justify-center text-white font-bold text-xl mb-6 shadow-lg">D</div>
                                    <p className="text-slate-700 italic text-lg mb-6 leading-relaxed font-medium">
                                        "Used the presentation mode for a Q3 business review. The pacing score helped me trim down my speech to fit the time limit perfectly."
                                    </p>
                                    <div className="text-center">
                                        <p className="font-bold text-slate-800">David Kim</p>
                                        <p className="text-slate-500 text-sm font-semibold">Marketing Director</p>
                                    </div>
                                </div>
                                <div className="absolute top-1/2 -translate-y-1/2 left-4 w-10 h-10 bg-white rounded-full flex items-center justify-center shadow-md cursor-pointer hover:bg-slate-50">
                                    <span className="material-symbols-outlined text-slate-400">chevron_left</span>
                                </div>
                                <div className="absolute top-1/2 -translate-y-1/2 right-4 w-10 h-10 bg-white rounded-full flex items-center justify-center shadow-md cursor-pointer hover:bg-slate-50">
                                    <span className="material-symbols-outlined text-slate-400">chevron_right</span>
                                </div>
                                <div className="flex justify-center gap-2 mt-8">
                                    {[0, 1, 2, 3].map(i => <div key={i} className={`w-2 h-2 rounded-full ${i === 2 ? 'bg-blue-600 w-4' : 'bg-slate-300'}`}></div>)}
                                </div>
                            </div>
                        </div>
                    )}

                    {screen === 'setup' && (
                        <div className="flex-1 flex flex-col items-center justify-center px-8 py-12">
                            <div className="w-full max-w-lg">
                                <button 
                                    onClick={() => setScreen('home')}
                                    className="flex items-center gap-2 text-slate-500 hover:text-slate-800 font-bold mb-8 transition-colors"
                                >
                                    <span className="material-symbols-outlined text-sm">arrow_back</span>
                                    Back
                                </button>

                                <div className="text-center mb-10">
                                    <h2 className="text-4xl font-black text-slate-900 mb-2 capitalize">{sessionType} Setup</h2>
                                    <p className="text-slate-500 font-semibold">Configure your AI coach preferences</p>
                                </div>

                                <div className="space-y-6">
                                    <div>
                                        <label className="block text-[11px] font-black text-slate-400 uppercase tracking-widest mb-2 ml-1">
                                            {sessionType === 'interview' ? 'Target Role' : 'Presentation Title'}
                                        </label>
                                        <input 
                                            type="text" 
                                            className="w-full bg-white/60 border-none rounded-2xl px-6 py-4 text-slate-800 font-bold placeholder:text-slate-400 focus:ring-4 focus:ring-indigo-500/20 transition-all shadow-sm"
                                            value={settings.role}
                                            onChange={(e) => setSettings({...settings, role: e.target.value})}
                                            placeholder={sessionType === 'interview' ? "Software Engineer" : "Quarterly Business Review"}
                                        />
                                    </div>

                                    <div>
                                        <label className="block text-[11px] font-black text-slate-400 uppercase tracking-widest mb-2 ml-1">
                                            {sessionType === 'interview' ? 'Focus Topics' : 'Target Audience'}
                                        </label>
                                        <textarea 
                                            className="w-full bg-white/60 border-none rounded-2xl px-6 py-4 text-slate-800 font-bold placeholder:text-slate-400 focus:ring-4 focus:ring-indigo-500/20 transition-all shadow-sm min-h-[100px] resize-none"
                                            value={settings.topics}
                                            onChange={(e) => setSettings({...settings, topics: e.target.value})}
                                            placeholder={sessionType === 'interview' ? "React, TypeScript" : "Audience"}
                                        />
                                    </div>

                                    <div className="grid grid-cols-2 gap-4">
                                        <div>
                                            <label className="block text-[11px] font-black text-slate-400 uppercase tracking-widest mb-2 ml-1">AI Voice</label>
                                            <select 
                                                className="w-full bg-white/60 border-none rounded-2xl px-6 py-4 text-slate-800 font-bold focus:ring-4 focus:ring-indigo-500/20 transition-all shadow-sm appearance-none cursor-pointer"
                                                value={settings.voice}
                                                onChange={(e) => setSettings({...settings, voice: e.target.value})}
                                            >
                                                {['Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir'].map(v => <option key={v} value={v}>{v}</option>)}
                                            </select>
                                        </div>
                                        <div>
                                            <label className="block text-[11px] font-black text-slate-400 uppercase tracking-widest mb-2 ml-1">Language</label>
                                            <select 
                                                className="w-full bg-white/60 border-none rounded-2xl px-6 py-4 text-slate-800 font-bold focus:ring-4 focus:ring-indigo-500/20 transition-all shadow-sm appearance-none cursor-pointer"
                                                value={settings.language}
                                                onChange={(e) => setSettings({...settings, language: e.target.value})}
                                            >
                                                {['English', 'Spanish', 'French', 'German', 'Hindi'].map(l => <option key={l} value={l}>{l}</option>)}
                                            </select>
                                        </div>
                                    </div>

                                    <div className="grid grid-cols-3 gap-4">
                                        <div>
                                            <label className="block text-[11px] font-black text-slate-400 uppercase tracking-widest mb-2 ml-1">Difficulty</label>
                                            <select 
                                                className="w-full bg-white/60 border-none rounded-2xl px-4 py-4 text-slate-800 font-bold focus:ring-4 focus:ring-indigo-500/20 transition-all shadow-sm appearance-none cursor-pointer text-sm"
                                                value={settings.difficulty}
                                                onChange={(e) => setSettings({...settings, difficulty: e.target.value as any})}
                                            >
                                                {['Easy', 'Medium', 'Hard'].map(d => <option key={d} value={d}>{d}</option>)}
                                            </select>
                                        </div>
                                        <div>
                                            <label className="block text-[11px] font-black text-slate-400 uppercase tracking-widest mb-2 ml-1">Session Mode</label>
                                            <select 
                                                className="w-full bg-white/60 border-none rounded-2xl px-4 py-4 text-slate-800 font-bold focus:ring-4 focus:ring-indigo-500/20 transition-all shadow-sm appearance-none cursor-pointer text-sm"
                                                value={settings.mode}
                                                onChange={(e) => setSettings({...settings, mode: e.target.value})}
                                            >
                                                {['Standard', 'Speed', 'Deep Dive'].map(m => <option key={m} value={m}>{m}</option>)}
                                            </select>
                                        </div>
                                        <div>
                                            <label className="block text-[11px] font-black text-slate-400 uppercase tracking-widest mb-2 ml-1">Q Limit</label>
                                            <select 
                                                className="w-full bg-white/60 border-none rounded-2xl px-4 py-4 text-slate-800 font-bold focus:ring-4 focus:ring-indigo-500/20 transition-all shadow-sm appearance-none cursor-pointer text-sm"
                                                value={settings.qLimit}
                                                onChange={(e) => setSettings({...settings, qLimit: e.target.value})}
                                            >
                                                {['Unlimited', '5 Questions', '10 Questions'].map(q => <option key={q} value={q}>{q}</option>)}
                                            </select>
                                        </div>
                                    </div>

                                    <div className="pt-4">
                                        <button 
                                            onClick={() => document.getElementById('file-upload')?.click()}
                                            className="w-full py-4 bg-indigo-50 border-2 border-dashed border-indigo-200 text-indigo-600 rounded-2xl font-bold hover:bg-indigo-100 transition-all flex items-center justify-center gap-3"
                                        >
                                            <span className="material-symbols-outlined">upload_file</span>
                                            {resumeFile ? resumeFile.name : `Upload ${sessionType === 'interview' ? 'Resume' : 'Slides'} (PDF)`}
                                        </button>
                                        <input 
                                            id="file-upload"
                                            type="file" 
                                            accept="application/pdf"
                                            onChange={(e) => setResumeFile(e.target.files ? e.target.files[0] : null)}
                                            className="hidden"
                                        />
                                    </div>

                                    <button 
                                        onClick={handleGenerateBriefing}
                                        disabled={!!loadingAction}
                                        className="w-full py-5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-[1.5rem] font-black text-lg shadow-xl hover:shadow-indigo-500/40 transition-all flex justify-center items-center gap-3 mt-6 disabled:opacity-50"
                                    >
                                        {loadingAction ? (
                                            <>
                                                <span className="material-symbols-outlined animate-spin">progress_activity</span>
                                                Processing...
                                            </>
                                        ) : (
                                            <>Start Session</>
                                        )}
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}

                    {screen === 'briefing' && (
                        <div className="flex-1 flex flex-col items-center justify-center px-8 py-12">
                            <div className="w-full max-w-2xl bg-white/60 p-10 rounded-[2.5rem] border border-white/50 shadow-xl">
                                <div className="flex items-center gap-4 mb-8">
                                    <div className="w-14 h-14 bg-indigo-100 rounded-2xl flex items-center justify-center">
                                        <span className="material-symbols-outlined text-indigo-600 text-3xl">assignment</span>
                                    </div>
                                    <div>
                                        <h2 className="text-3xl font-black text-slate-900">Session Briefing</h2>
                                        <p className="text-slate-500 font-bold">Review your preparation guide</p>
                                    </div>
                                </div>
                                
                                <div className="prose prose-slate max-w-none text-slate-700 leading-relaxed whitespace-pre-wrap font-medium text-lg bg-white/40 p-6 rounded-2xl mb-10 border border-white/30">
                                    {briefingText}
                                </div>
                                
                                <div className="flex gap-4">
                                    <button 
                                        onClick={() => setScreen('setup')}
                                        className="flex-1 py-4 px-6 bg-white border-2 border-slate-100 text-slate-600 rounded-2xl font-black hover:bg-slate-50 transition-all"
                                    >
                                        Back
                                    </button>
                                    <button 
                                        onClick={handleStartLiveSession}
                                        className="flex-1 py-4 px-6 bg-indigo-600 text-white rounded-2xl font-black shadow-lg hover:bg-indigo-700 transition-all flex items-center justify-center gap-3"
                                    >
                                        <span className="material-symbols-outlined">mic</span>
                                        Start Live Session
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}

                    {screen === 'interview' && (
                        <div className="flex-1 grid grid-cols-1 lg:grid-cols-3 gap-8 p-8 h-full">
                            {/* Left Column: Video & Status */}
                            <div className="lg:col-span-2 flex flex-col gap-6">
                                <div className="relative bg-slate-900 rounded-[2.5rem] overflow-hidden shadow-2xl aspect-video flex items-center justify-center group border-4 border-white/20">
                                    <video 
                                        ref={videoRef} 
                                        autoPlay 
                                        playsInline 
                                        muted 
                                        className={`w-full h-full object-cover transform scale-x-[-1] transition-opacity ${isMuted ? 'opacity-90' : 'opacity-100'}`}
                                    />
                                    
                                    <div className="absolute top-6 left-6 flex gap-3">
                                        <div className={`px-4 py-2 rounded-full text-xs font-black uppercase tracking-widest flex items-center gap-2 backdrop-blur-xl border border-white/20 ${isAiSpeaking ? 'bg-emerald-500/90 text-white' : 'bg-slate-800/60 text-slate-300'}`}>
                                            <span className={`w-2 h-2 rounded-full ${isAiSpeaking ? 'bg-white animate-pulse' : 'bg-slate-400'}`}></span>
                                            {isAiSpeaking ? 'AI Speaking' : 'Listening...'}
                                        </div>
                                        <div className="px-4 py-2 rounded-full text-xs font-black uppercase tracking-widest bg-indigo-600/90 text-white backdrop-blur-xl border border-white/20">
                                            {settings.difficulty} Mode
                                        </div>
                                    </div>

                                    <div className="absolute bottom-6 left-6 right-6 flex justify-between items-center">
                                        <div className="flex gap-3">
                                            <button 
                                                onClick={() => setIsMuted(!isMuted)}
                                                className={`w-14 h-14 rounded-2xl flex items-center justify-center backdrop-blur-xl transition-all border border-white/20 ${isMuted ? 'bg-rose-500/90 text-white' : 'bg-white/20 text-white hover:bg-white/30'}`}
                                            >
                                                <span className="material-symbols-outlined text-2xl">{isMuted ? 'mic_off' : 'mic'}</span>
                                            </button>
                                            <button className="w-14 h-14 rounded-2xl flex items-center justify-center bg-white/20 text-white backdrop-blur-xl border border-white/20 hover:bg-white/30 transition-all">
                                                <span className="material-symbols-outlined text-2xl">videocam</span>
                                            </button>
                                        </div>
                                        
                                        <button 
                                            onClick={handleEndSession}
                                            className="px-8 py-4 bg-rose-500 text-white rounded-2xl font-black text-sm shadow-lg hover:bg-rose-600 transition-all flex items-center gap-2"
                                        >
                                            <span className="material-symbols-outlined text-sm">close</span>
                                            End Session
                                        </button>
                                    </div>
                                </div>
                                
                                {loadingAction === 'connecting' && (
                                    <div className="flex items-center justify-center p-12 bg-white/60 rounded-[2rem] border border-white/50 backdrop-blur-xl">
                                        <div className="text-center">
                                            <span className="material-symbols-outlined text-5xl text-indigo-600 animate-spin mb-6">progress_activity</span>
                                            <p className="text-slate-800 font-black text-xl">Connecting to AI Coach...</p>
                                            <p className="text-slate-500 font-bold mt-2">Setting up your personalized session</p>
                                        </div>
                                    </div>
                                )}
                            </div>

                            {/* Right Column: Transcript */}
                            <div className="bg-white/60 rounded-[2.5rem] shadow-xl border border-white/50 backdrop-blur-xl flex flex-col h-full overflow-hidden">
                                <div className="p-6 border-b border-white/50 bg-white/40 flex items-center justify-between">
                                    <h3 className="font-black text-slate-800 flex items-center gap-3 uppercase tracking-widest text-xs">
                                        <span className="material-symbols-outlined text-indigo-600">forum</span>
                                        Live Transcript
                                    </h3>
                                    <div className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse"></div>
                                </div>
                                <div className="flex-1 overflow-y-auto p-6 space-y-6 custom-scrollbar">
                                    {transcript.length === 0 && (
                                        <div className="flex flex-col items-center justify-center h-full text-center opacity-40">
                                            <span className="material-symbols-outlined text-5xl mb-4">chat_bubble</span>
                                            <p className="text-slate-500 font-bold italic">Conversation will appear here...</p>
                                        </div>
                                    )}
                                    {transcript.map((msg, i) => (
                                        <div key={i} className={`flex flex-col ${msg.speaker === 'user' ? 'items-end' : 'items-start'}`}>
                                            <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 ml-1">
                                                {msg.speaker === 'user' ? 'You' : 'AI Coach'}
                                            </span>
                                            <div className={`max-w-[90%] rounded-2xl px-5 py-3.5 text-sm leading-relaxed font-semibold shadow-sm ${
                                                msg.speaker === 'user' 
                                                ? 'bg-indigo-600 text-white rounded-tr-none' 
                                                : 'bg-white text-slate-800 rounded-tl-none border border-slate-100'
                                            }`}>
                                                {msg.text}
                                            </div>
                                        </div>
                                    ))}
                                    <div ref={transcriptEndRef} />
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* Global Styles for Custom Scrollbar */}
            <style>{`
                .custom-scrollbar::-webkit-scrollbar {
                    width: 6px;
                }
                .custom-scrollbar::-webkit-scrollbar-track {
                    background: transparent;
                }
                .custom-scrollbar::-webkit-scrollbar-thumb {
                    background: rgba(0, 0, 0, 0.1);
                    border-radius: 10px;
                }
                .custom-scrollbar::-webkit-scrollbar-thumb:hover {
                    background: rgba(0, 0, 0, 0.2);
                }
            `}</style>
        </div>
    );
}

const root = createRoot(document.getElementById('root')!);
root.render(<App />);