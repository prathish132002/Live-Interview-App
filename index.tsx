import { GoogleGenAI, LiveServerMessage, Modality, Type, Chat, GenerateContentResponse } from "@google/genai";
import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged, User } from "firebase/auth";
import { getAnalytics } from "firebase/analytics";
import React, { useState, useRef, useEffect } from 'react';
import { createRoot } from 'react-dom/client';

// FIX: The 'LiveSession' type is not exported from the '@google/genai' module.
// We can infer it from the 'ai.live.connect' method's return type for type safety.
type LiveSession = Awaited<ReturnType<InstanceType<typeof GoogleGenAI>["live"]["connect"]>>;

// --- FIREBASE CONFIGURATION ---
const firebaseConfig = {
  apiKey: "AIzaSyC3LXVOH2rrnCHw0ONQYaJn3cl0Om-FU_k",
  authDomain: "live-simulation-interview.firebaseapp.com",
  projectId: "live-simulation-interview",
  storageBucket: "live-simulation-interview.firebasestorage.app",
  messagingSenderId: "615341063115",
  appId: "1:615341063115:web:2a4963b14776c82f5ad44e",
  measurementId: "G-N52ZXCMBT6"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const analytics = getAnalytics(app);

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

// --- TOUR GUIDE COMPONENT ---
interface TourStep {
    targetId: string;
    title: string;
    content: string;
}

const TourGuide = ({ steps, isOpen, onClose, stepIndex, onNext }: { steps: TourStep[], isOpen: boolean, onClose: () => void, stepIndex: number, onNext: () => void }) => {
    const [targetRect, setTargetRect] = useState<DOMRect | null>(null);

    useEffect(() => {
        if (!isOpen) return;
        const updateRect = () => {
            const el = document.getElementById(steps[stepIndex].targetId);
            if (el) {
                setTargetRect(el.getBoundingClientRect());
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        };
        updateRect();
        window.addEventListener('resize', updateRect);
        const timer = setTimeout(updateRect, 100);
        return () => {
            window.removeEventListener('resize', updateRect);
            clearTimeout(timer);
        };
    }, [stepIndex, isOpen, steps]);

    if (!isOpen || !targetRect) return null;

    return (
        <div className="fixed inset-0 z-[100] overflow-hidden">
            <div 
                className="absolute transition-all duration-500 ease-in-out pointer-events-none"
                style={{
                    top: targetRect.top,
                    left: targetRect.left,
                    width: targetRect.width,
                    height: targetRect.height,
                    boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.75)',
                    borderRadius: '16px' 
                }}
            />
            <div 
                className="absolute transition-all duration-500 ease-in-out flex flex-col items-center"
                style={{
                    top: targetRect.bottom + 20,
                    left: targetRect.left + (targetRect.width / 2),
                    transform: 'translateX(-50%)',
                    width: '300px'
                }}
            >
                <div className="bg-white p-6 rounded-2xl shadow-2xl border border-white/40 relative animate-[fadeIn_0.3s_ease-out]">
                    <div className="absolute -top-2 left-1/2 -translate-x-1/2 w-4 h-4 bg-white rotate-45 border-t border-l border-white/20"></div>
                    <div className="flex justify-between items-center mb-2">
                        <span className="text-xs font-bold text-brand-primary uppercase tracking-wider">Step {stepIndex + 1} of {steps.length}</span>
                        <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
                            <span className="material-symbols-outlined text-sm">close</span>
                        </button>
                    </div>
                    <h3 className="text-lg font-bold text-gray-900 mb-2">{steps[stepIndex].title}</h3>
                    <p className="text-sm text-gray-600 mb-4">{steps[stepIndex].content}</p>
                    <div className="flex justify-between">
                         <button onClick={onClose} className="text-sm text-gray-500 hover:text-gray-700 underline">Skip Tour</button>
                        <button 
                            onClick={onNext}
                            className="bg-brand-primary text-white px-4 py-2 rounded-xl text-sm font-semibold hover:bg-brand-primary-hover transition-colors shadow-lg shadow-blue-500/30"
                        >
                            {stepIndex === steps.length - 1 ? 'Finish' : 'Next'}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

// --- CHATBOT COMPONENT ---
const ChatWidget = () => {
    const [isOpen, setIsOpen] = useState(false);
    const [messages, setMessages] = useState<{role: 'user' | 'model', text: string}[]>([
        { role: 'model', text: 'Hi! I can help you understand SpeakEasy AI features. What would you like to know?' }
    ]);
    const [inputValue, setInputValue] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [chatSession, setChatSession] = useState<Chat | null>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const initChat = async () => {
            const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
            const chat = ai.chats.create({
                model: 'gemini-3-flash-preview',
                config: {
                    systemInstruction: `You are the friendly and helpful AI Support Assistant for 'SpeakEasy AI'.
                    Your goal is to help users understand, navigate, and use the application effectively.
                    
                    APP FEATURES TO EXPLAIN:
                    1. **Interview Practice:** Users simulate real-time job interviews. They can upload a PDF resume. The AI acts as an interviewer (Recruiter or Technical) based on the "Target Role" and "Topics".
                    2. **Presentation Coach:** Users practice speeches or presentations. They can upload slides (PDF). The AI listens, monitors pacing, and fact-checks against the slides.
                    3. **Seminar Defense:** A rigorous mode for academic thesis defense or research Q&A.
                    4. **Live Mode:** The core experience. Uses microphone and camera (optional) for real-time audio interaction.
                    5. **Feedback Report:** After every session, users get a detailed score (0-10) on Relevance, Clarity, Conciseness, and Technical Accuracy, plus specific Strengths and Improvements.
                    6. **Settings:** Users can change the AI Voice (Zephyr, Puck, etc.), Language, and Difficulty Level.
                    
                    BEHAVIOR:
                    - Be concise, professional, yet warm.
                    - Use emojis occasionally to be friendly.
                    - If asked about technical issues (mic not working), suggest checking browser permissions.
                    - If asked "How do I start?", explain the "Setup" screen process.
                    `
                }
            });
            setChatSession(chat);
        };
        initChat();
    }, []);

    useEffect(() => {
        if (isOpen && messagesEndRef.current) {
            messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
        }
    }, [messages, isOpen]);

    const handleSend = async () => {
        if (!inputValue.trim() || !chatSession) return;
        
        const userMsg = inputValue.trim();
        setMessages(prev => [...prev, { role: 'user', text: userMsg }]);
        setInputValue('');
        setIsLoading(true);

        try {
            const result = await chatSession.sendMessageStream({ message: userMsg });
            
            let fullText = '';
            setMessages(prev => [...prev, { role: 'model', text: '' }]); // Placeholder

            for await (const chunk of result) {
                const text = (chunk as GenerateContentResponse).text;
                fullText += text;
                setMessages(prev => {
                    const newMsgs = [...prev];
                    newMsgs[newMsgs.length - 1].text = fullText;
                    return newMsgs;
                });
            }
        } catch (error) {
            console.error("Chat error:", error);
            setMessages(prev => [...prev, { role: 'model', text: "Sorry, I'm having trouble connecting right now. Please try again." }]);
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <>
            {/* Chat Window */}
            {isOpen && (
                <div className="fixed bottom-24 right-6 w-80 h-96 z-50 glass-card rounded-2xl flex flex-col overflow-hidden shadow-2xl animate-[fadeIn_0.2s_ease-out] border border-white/60">
                    {/* Header */}
                    <div className="bg-brand-primary/90 backdrop-blur-md p-4 flex justify-between items-center text-white">
                        <div className="flex items-center gap-2">
                            <span className="material-symbols-outlined text-xl">support_agent</span>
                            <span className="font-bold text-sm">SpeakEasy Support</span>
                        </div>
                        <button onClick={() => setIsOpen(false)} className="hover:bg-white/20 rounded-full p-1 transition-colors">
                            <span className="material-symbols-outlined text-sm">close</span>
                        </button>
                    </div>

                    {/* Messages */}
                    <div className="flex-1 overflow-y-auto p-4 space-y-3 custom-scrollbar bg-white/40">
                        {messages.map((msg, idx) => (
                            <div key={idx} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                                <div className={`max-w-[85%] rounded-2xl px-3 py-2 text-xs leading-relaxed shadow-sm ${
                                    msg.role === 'user' 
                                    ? 'bg-brand-primary text-white rounded-br-none' 
                                    : 'bg-white text-gray-800 border border-gray-100 rounded-bl-none'
                                }`}>
                                    {msg.text}
                                </div>
                            </div>
                        ))}
                        {isLoading && (
                            <div className="flex justify-start">
                                <div className="bg-white px-3 py-2 rounded-2xl rounded-bl-none shadow-sm flex gap-1 items-center">
                                    <div className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce"></div>
                                    <div className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce delay-75"></div>
                                    <div className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce delay-150"></div>
                                </div>
                            </div>
                        )}
                        <div ref={messagesEndRef} />
                    </div>

                    {/* Input */}
                    <div className="p-3 bg-white/60 backdrop-blur-md border-t border-white/50">
                        <div className="relative">
                            <input
                                type="text"
                                value={inputValue}
                                onChange={(e) => setInputValue(e.target.value)}
                                onKeyDown={(e) => e.key === 'Enter' && handleSend()}
                                placeholder="Ask about features..."
                                className="w-full pl-4 pr-10 py-2 rounded-full text-xs border border-gray-200 focus:border-brand-primary focus:ring-1 focus:ring-brand-primary outline-none bg-white/80"
                            />
                            <button 
                                onClick={handleSend}
                                disabled={isLoading || !inputValue.trim()}
                                className="absolute right-1 top-1/2 -translate-y-1/2 p-1.5 bg-brand-primary text-white rounded-full hover:bg-brand-primary-hover disabled:opacity-50 transition-all flex items-center justify-center"
                            >
                                <span className="material-symbols-outlined text-sm">send</span>
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Toggle Button */}
            <button 
                onClick={() => setIsOpen(!isOpen)}
                className="fixed bottom-6 right-6 w-14 h-14 z-50 rounded-full bg-brand-primary hover:bg-brand-primary-hover text-white shadow-lg shadow-brand-primary/40 transition-all hover:scale-110 flex items-center justify-center group"
            >
                {isOpen ? (
                    <span className="material-symbols-outlined text-2xl">expand_more</span>
                ) : (
                    <span className="material-symbols-outlined text-2xl animate-pulse-slow">chat_bubble</span>
                )}
                <div className="absolute right-full mr-3 bg-gray-900 text-white text-xs px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none">
                    Ask AI Support
                </div>
            </button>
        </>
    );
};

// --- WAVE BACKGROUND COMPONENT ---
const WaveBackground = () => (
  <>
    <style>{`
      @keyframes move-forever {
        0% { transform: translate3d(-90px,0,0); }
        100% { transform: translate3d(85px,0,0); }
      }
      .parallax > use {
        animation: move-forever 25s cubic-bezier(.55,.5,.45,.5) infinite;
      }
      .parallax > use:nth-child(1) { animation-delay: -2s; animation-duration: 7s; }
      .parallax > use:nth-child(2) { animation-delay: -3s; animation-duration: 10s; }
      .parallax > use:nth-child(3) { animation-delay: -4s; animation-duration: 13s; }
      .parallax > use:nth-child(4) { animation-delay: -5s; animation-duration: 20s; }
    `}</style>
    <div className="fixed bottom-0 left-0 w-full z-0 pointer-events-none" style={{ height: '35vh', minHeight: '300px' }}>
      <svg className="w-full h-full" viewBox="0 24 150 28" preserveAspectRatio="none" shapeRendering="auto">
        <defs>
          <path id="gentle-wave" d="M-160 44c30 0 58-18 88-18s 58 18 88 18 58-18 88-18 58 18 88 18 v44h-352z" />
        </defs>
        <g className="parallax">
          <use href="#gentle-wave" x="48" y="0" fill="rgba(255,255,255,0.4)" />
          <use href="#gentle-wave" x="48" y="3" fill="rgba(255,255,255,0.3)" />
          <use href="#gentle-wave" x="48" y="5" fill="rgba(255,255,255,0.2)" />
          <use href="#gentle-wave" x="48" y="7" fill="rgba(255,255,255,0.1)" />
        </g>
      </svg>
    </div>
  </>
);

// --- REACT COMPONENTS ---

const App = () => {
    // Auth State
    const [user, setUser] = useState<User | null>(null);
    const [authLoading, setAuthLoading] = useState(true);

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
    
    // Granular loading state
    const [loadingAction, setLoadingAction] = useState<string | null>(null); 

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
    const [speakingDuration, setSpeakingDuration] = useState(0);
    const [currentReviewIndex, setCurrentReviewIndex] = useState(0);
    const [isAutoPlay, setIsAutoPlay] = useState(true);
    
    const [activeScoreModal, setActiveScoreModal] = useState<string | null>(null);
    const [tourOpen, setTourOpen] = useState(false);
    const [tourStep, setTourStep] = useState(0);

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
          noiseGateOpen: boolean;
          hpfState: { lastInput: number, lastOutput: number };
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
      audioProcessingState: { 
          smoothedVolume: 0, 
          currentGain: 1.0,
          noiseGateOpen: false,
          hpfState: { lastInput: 0, lastOutput: 0 }
      },
    });

    const tourSteps: TourStep[] = [
        { targetId: 'welcome-header', title: 'Welcome to SpeakEasy AI', content: 'Prepare for high-stakes conversations with your personal AI coach.' },
        { targetId: 'card-interview', title: 'Ace Your Interview', content: 'Practice behavioral and technical questions tailored to your target role.' },
        { targetId: 'card-presentation', title: 'Refine Your Presentation', content: 'Rehearse your slides and get feedback on clarity, pacing, and fact accuracy.' },
        { targetId: 'card-seminar', title: 'Defend Your Thesis', content: 'Simulate a seminar environment for academic or research defenses.' },
    ];

    // Auth & Tour Init
    useEffect(() => {
        const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
            setUser(currentUser);
            setAuthLoading(false);
        });

        const tourSeen = localStorage.getItem('onboardingTourSeen');
        if (!tourSeen) {
            setTimeout(() => setTourOpen(true), 1000);
        }

        return () => unsubscribe();
    }, []);

    const handleTourNext = () => {
        if (tourStep < tourSteps.length - 1) {
            setTourStep(prev => prev + 1);
        } else {
            setTourOpen(false);
            localStorage.setItem('onboardingTourSeen', 'true');
        }
    };
    
    const restartTour = () => {
        setTourStep(0);
        setTourOpen(true);
    };

    const handleLogin = async () => {
        const provider = new GoogleAuthProvider();
        try {
            await signInWithPopup(auth, provider);
        } catch (error: any) {
            console.error("Login failed", error);
            // Fallback for preview environments
            if (error.code === 'auth/unauthorized-domain' || error.code === 'auth/operation-not-allowed') {
                 const demoUser = { uid: 'guest-demo', displayName: 'Guest User', photoURL: null, email: 'guest@demo.com' } as unknown as User;
                 setUser(demoUser);
                 setError(null);
                 alert("Notice: Logged in as Guest User for testing (Firebase Domain Unauthorized).");
            } else {
                setError(`Login failed: ${error.message}. Please try again.`);
            }
        }
    };

    const handleLogout = async () => {
        try {
            await signOut(auth);
            setUser(null);
            setScreen('home');
        } catch (error) {
            console.error("Logout failed", error);
        }
    };
    
    // Review Carousel Effect
    useEffect(() => {
        if (screen !== 'home' || !isAutoPlay) return;
        const interval = setInterval(() => {
            setCurrentReviewIndex((prev) => (prev + 1) % reviews.length);
        }, 5000);
        return () => clearInterval(interval);
    }, [screen, isAutoPlay]);

    const nextReview = () => {
        setCurrentReviewIndex((prev) => (prev + 1) % reviews.length);
    };

    const prevReview = () => {
        setCurrentReviewIndex((prev) => (prev - 1 + reviews.length) % reviews.length);
    };

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

    // Auto-scroll transcript
    useEffect(() => {
        if (transcriptEndRef.current) {
            transcriptEndRef.current.scrollIntoView({ behavior: 'smooth' });
        }
    }, [transcript]);

    const cleanupAudioResources = async () => {
        isSessionActive.current = false;
        if (timerRef.current) clearInterval(timerRef.current);
        if (speechTimerIntervalRef.current) clearInterval(speechTimerIntervalRef.current);
        
        if (sessionRef.current) sessionRef.current = null;
        if (audioRefs.current.mediaRecorder && audioRefs.current.mediaRecorder.state !== 'inactive') {
            try { audioRefs.current.mediaRecorder.stop(); } catch (e) {}
        }
        if (audioRefs.current.stream) {
            audioRefs.current.stream.getTracks().forEach(track => track.stop());
            audioRefs.current.stream = null;
        }
        if (videoRef.current) videoRef.current.srcObject = null;
        if (audioRefs.current.scriptProcessor) {
            try { audioRefs.current.scriptProcessor.disconnect(); } catch(e) {}
            audioRefs.current.scriptProcessor = null;
        }
        if(audioRefs.current.source) {
            try { audioRefs.current.source.disconnect(); } catch(e) {}
            audioRefs.current.source = null;
        }
        if (audioRefs.current.inputAudioContext && audioRefs.current.inputAudioContext.state !== 'closed') {
            try { await audioRefs.current.inputAudioContext.close(); } catch (e) {}
        }
        audioRefs.current.inputAudioContext = null;
        if (audioRefs.current.outputAudioContext && audioRefs.current.outputAudioContext.state !== 'closed') {
             try { await audioRefs.current.outputAudioContext.close(); } catch (e) {}
        }
        audioRefs.current.outputAudioContext = null;
        audioRefs.current.mediaRecorder = null;
        await new Promise(resolve => setTimeout(resolve, 100));
    };

    const handleStartInterview = async () => {
        setLoadingAction(resumeFile ? 'analyzing_file' : 'generating_briefing');
        setScreen('briefing');
        setError(null);
        setBriefingText('');
        setRecordedVideoUrl(null);
        
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
            
            setLoadingAction('generating_briefing');

            let textPrompt = "";
            if (sessionType === 'interview') {
                textPrompt = `Generate a short, friendly, and professional welcome message for a job interview. The role is '${settings.role}' and the topics are '${settings.topics}'. Welcome the candidate, state the role and topics, and wish them luck. The message must be entirely in ${settings.language}.`;
                if (currentResumeAnalysis) {
                    textPrompt += `\n\nContext: The candidate has uploaded a resume. Here is the summary: ${currentResumeAnalysis}. Acknowledge that you have reviewed their resume and mention that you will be asking questions about their projects.`;
                }
            } else {
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
                    setLoadingAction(null);
                };
            } else {
                setLoadingAction(null);
            }
        } catch (err: any) {
            console.error("Failed to prepare briefing:", err);
            setError(`Failed to prepare briefing: ${err.message}. Please try again.`);
            setScreen('setup');
            setLoadingAction(null);
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
        if (!MediaRecorder.isTypeSupported(mimeType)) {
             mimeType = 'video/mp4';
             if(!MediaRecorder.isTypeSupported(mimeType)) mimeType = ''; 
        }
        
        const options = mimeType ? { mimeType } : undefined;
        try {
            const recorder = new MediaRecorder(stream, options);
            recorder.ondataavailable = (e) => {
                if (e.data.size > 0) audioRefs.current.recordedChunks.push(e.data);
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
                if (recorder.mimeType) blobType = recorder.mimeType;
                else if (audioRefs.current.recordedChunks.length > 0) blobType = audioRefs.current.recordedChunks[0].type || 'video/webm';
                
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
        await cleanupAudioResources();
        
        audioRefs.current.audioProcessingState = { 
            smoothedVolume: 0, 
            currentGain: 1.0,
            noiseGateOpen: false,
            hpfState: { lastInput: 0, lastOutput: 0 }
        };
        
        isUserSpeakingRef.current = false;
        speechStartTimeRef.current = null;
        lastSpeechDetectedTimeRef.current = 0;
        setSpeakingDuration(0);

        setIsMuted(false);
        setIsCameraOff(false);

        setLoadingAction('connecting_session');
        setError(null);
        setTranscript([]);
        transcriptionBuffer.current = { input: '', output: '' };
        setTimeLeft(null);
        setFeedback(null);
        isSessionActive.current = true;

        try {
            const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
            audioRefs.current.inputAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
            await audioRefs.current.inputAudioContext.resume();

            audioRefs.current.outputAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });

            audioRefs.current.stream = await navigator.mediaDevices.getUserMedia({ 
                audio: {
                    channelCount: 1,
                    sampleRate: 16000,
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: false,
                },
                video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" }
            });

            startRecording(audioRefs.current.stream);

            let nextStartTime = 0;
            const sources = new Set<AudioBufferSourceNode>();
            
            let systemInstructionText = sessionType === 'interview' ? 
                `You are a Senior HR + Technical Interviewer. Role: '${settings.role}'. Focus: '${settings.topics}'. Level: '${settings.level}'. Language: ${settings.language}.
                RULES: Ask ONE question at a time. Provide feedback after every answer. Do not reuse questions.
                STAGES: Warm-up, Resume, Technical, Behavioral, Evaluation.
                Include Riddles based on difficulty.` :
                `You are a Presentation Coach/Audience. Topic: '${settings.role}'. Audience: '${settings.topics}'. Language: ${settings.language}.
                GOAL: Help user deliver accurate, clear presentation.
                ROLE: Listen predominantly. FACT CHECK real-time against context. Monitor Clarity & Pacing.`;

            if (resumeAnalysis) systemInstructionText += `\n\nCONTEXT:\n${resumeAnalysis}`;
            if (settings.mode === 'timed') systemInstructionText += `\nNOTE: Timed session (90s).`;

            const sessionPromise = ai.live.connect({
                model: 'gemini-2.5-flash-native-audio-preview-09-2025',
                callbacks: {
                    onopen: () => {
                        if (!isSessionActive.current) return;
                        setLoadingAction(null);
                        setScreen('interview');
                        
                        if (!audioRefs.current.inputAudioContext || !audioRefs.current.stream) return;
                        
                        if (videoRef.current) {
                            videoRef.current.srcObject = audioRefs.current.stream;
                        }

                        const source = audioRefs.current.inputAudioContext.createMediaStreamSource(audioRefs.current.stream);
                        audioRefs.current.source = source;
                        
                        const scriptProcessor = audioRefs.current.inputAudioContext.createScriptProcessor(2048, 1, 1);
                        audioRefs.current.scriptProcessor = scriptProcessor;

                        scriptProcessor.onaudioprocess = (audioProcessingEvent) => {
                            if (!isSessionActive.current) return;
                            const inputData = audioProcessingEvent.inputBuffer.getChannelData(0);

                            // Audio Processing (HPF, RMS, Gate, Compression)
                            const HPF_ALPHA = 0.90;
                            const GATE_OPEN_THRESHOLD = 0.015;
                            const GATE_CLOSE_THRESHOLD = 0.008;
                            const TARGET_RMS = 0.2; 
                            const MAX_GAIN = 12.0;   
                            const ATTACK_COEFF = 0.8; 
                            const RELEASE_COEFF = 0.99;
                            const GAIN_SMOOTHING = 0.92;

                            if (!audioRefs.current.audioProcessingState.hpfState) {
                                audioRefs.current.audioProcessingState.hpfState = { lastInput: 0, lastOutput: 0 };
                                audioRefs.current.audioProcessingState.noiseGateOpen = false;
                            }

                            const { hpfState } = audioRefs.current.audioProcessingState;

                            for (let i = 0; i < inputData.length; i++) {
                                const raw = inputData[i];
                                const filtered = raw - hpfState.lastInput + HPF_ALPHA * hpfState.lastOutput;
                                inputData[i] = filtered;
                                hpfState.lastInput = raw;
                                hpfState.lastOutput = filtered;
                            }

                            let sum = 0;
                            for (let i = 0; i < inputData.length; i++) sum += inputData[i] * inputData[i];
                            const rms = Math.sqrt(sum / inputData.length);

                            let { smoothedVolume, currentGain, noiseGateOpen } = audioRefs.current.audioProcessingState;
                            
                            smoothedVolume = rms > smoothedVolume ? 
                                ATTACK_COEFF * smoothedVolume + (1 - ATTACK_COEFF) * rms : 
                                RELEASE_COEFF * smoothedVolume + (1 - RELEASE_COEFF) * rms;

                            if (noiseGateOpen) {
                                if (smoothedVolume < GATE_CLOSE_THRESHOLD) noiseGateOpen = false;
                            } else {
                                if (smoothedVolume > GATE_OPEN_THRESHOLD) noiseGateOpen = true;
                            }

                            const SILENCE_TIMEOUT = 2000;
                            if (noiseGateOpen) {
                                lastSpeechDetectedTimeRef.current = Date.now();
                                if (!isUserSpeakingRef.current) {
                                    isUserSpeakingRef.current = true;
                                    speechStartTimeRef.current = Date.now();
                                }
                            } else {
                                if (isUserSpeakingRef.current && (Date.now() - lastSpeechDetectedTimeRef.current > SILENCE_TIMEOUT)) {
                                    isUserSpeakingRef.current = false;
                                    speechStartTimeRef.current = null;
                                }
                            }

                            let targetGain = !noiseGateOpen ? 0.0 : Math.max(1.0, Math.min(TARGET_RMS / (smoothedVolume + 0.00001), MAX_GAIN));
                            currentGain = GAIN_SMOOTHING * currentGain + (1 - GAIN_SMOOTHING) * targetGain;

                            for (let i = 0; i < inputData.length; i++) {
                                inputData[i] *= currentGain;
                                if (inputData[i] > 0.99) inputData[i] = 0.99;
                                if (inputData[i] < -0.99) inputData[i] = -0.99;
                            }
                            
                            audioRefs.current.audioProcessingState = { smoothedVolume, currentGain, noiseGateOpen, hpfState };

                            const pcmBlob = createBlob(inputData);
                            sessionPromise.then((session) => {
                                if (isSessionActive.current) {
                                    try { session.sendRealtimeInput({ media: pcmBlob }); } catch (err) {}
                                }
                            });
                        };
                        source.connect(scriptProcessor);
                        scriptProcessor.connect(audioRefs.current.inputAudioContext.destination);
                    },
                    onmessage: async (message: LiveServerMessage) => {
                       if (!isSessionActive.current) return;
                       
                       if (message.serverContent?.inputTranscription) transcriptionBuffer.current.input += message.serverContent.inputTranscription.text;
                       if (message.serverContent?.outputTranscription) transcriptionBuffer.current.output += message.serverContent.outputTranscription.text;
                        
                        if (message.serverContent?.modelTurn || message.serverContent?.turnComplete) {
                            isUserSpeakingRef.current = false;
                            speechStartTimeRef.current = null;
                            setSpeakingDuration(0);
                        }

                        if (message.serverContent?.turnComplete) {
                           const input = transcriptionBuffer.current.input.trim();
                           const output = transcriptionBuffer.current.output.trim();

                           if (input) {
                                setTranscript(prev => [...prev, { speaker: 'user', text: input }]);
                                if(timerRef.current) clearInterval(timerRef.current);
                                setTimeLeft(null);
                           }
                           if (output) {
                                setTranscript(prev => [...prev, { speaker: 'interviewer', text: output }]);
                                if (settings.mode === 'timed') setTimeLeft(90);
                           }
                           
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
                        if (isSessionActive.current) setError('Connection Interrupted.');
                        isSessionActive.current = false;
                        setLoadingAction(null);
                    },
                    onclose: (e: CloseEvent) => isSessionActive.current = false,
                },
                config: {
                    responseModalities: [Modality.AUDIO],
                    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: settings.voice } } },
                    systemInstruction: systemInstructionText,
                    inputAudioTranscription: {},
                    outputAudioTranscription: {},
                },
            });
            sessionRef.current = await sessionPromise;

        } catch (err: any) {
            console.error("Failed to start session:", err);
            if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError' || err.message.includes('permission') || err.message.includes('denied')) {
                setPermissionDenied(true);
                setShowPermissionModal(true);
                setError(null);
            } else {
                setError(`Failed to start session: ${err.message}.`);
                setShowPermissionModal(false);
            }
            setLoadingAction(null);
            cleanupAudioResources();
        }
    };
    
    const generateFeedback = async (finalTranscript: TranscriptEntry[]) => {
        if (finalTranscript.length === 0) {
            setFeedback({ 
                summary: "No session data to analyze.", strengths: [], improvements: [], tips: [],
                overall: 0, relevance: 0, clarity: 0, conciseness: 0, technicalAccuracy: 0
            });
            return;
        }
        setLoadingAction('generating_feedback');
        setError(null);

        try {
            const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
            const fullTranscriptText = finalTranscript.map(entry => `${entry.speaker === 'user' ? 'Candidate' : 'Interviewer'}: ${entry.text}`).join('\n\n');
            
            const prompt = `Analyze this ${sessionType} transcript. Role: ${settings.role}.
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

            const feedbackData = JSON.parse(response.text);
            setFeedback(feedbackData);
            setTranscript(finalTranscript);

        } catch (err: any) {
            setError(`Failed to generate feedback: ${err.message}.`);
        } finally {
            setLoadingAction(null);
        }
    };

    const stopInterview = async () => {
        const finalInput = transcriptionBuffer.current.input.trim();
        const finalOutput = transcriptionBuffer.current.output.trim();
        const finalTranscript = [...transcript];
        if (finalInput) finalTranscript.push({ speaker: 'user', text: finalInput });
        if (finalOutput) finalTranscript.push({ speaker: 'interviewer', text: finalOutput });
        
        setLoadingAction('generating_feedback');
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
        setResumeAnalysis('');
        setResumeFile(null);
        setSettings(prev => ({
            ...prev,
            role: type === 'interview' ? 'Software Engineer' : (type === 'seminar' ? 'Research Topic' : 'Quarterly Business Review'),
            topics: type === 'interview' ? 'React, TypeScript' : 'Audience',
        }));
    };
    
    // UI Helpers
    const getScoreTitle = (metric: string) => {
        const titles: Record<string, string> = { relevance: 'Relevance', clarity: 'Clarity', conciseness: 'Conciseness', technicalAccuracy: 'Accuracy' };
        return titles[metric] || metric;
    };
    const getTimerColor = (seconds: number) => seconds < 45 ? '#34C759' : (seconds < 90 ? '#FFD700' : '#FF3B30');

    const isLoading = loadingAction !== null;

    // --- RENDER ---
    return (
        <div className="min-h-screen w-full bg-brand-gradient text-brand-text font-display transition-colors duration-500 relative overflow-hidden">
            <style>{`
                .glass-card { background: rgba(255, 255, 255, 0.4); backdrop-filter: blur(16px); border: 1px solid rgba(255, 255, 255, 0.4); box-shadow: 0 4px 30px rgba(0, 0, 0, 0.1); }
                .glass-input { background: rgba(255, 255, 255, 0.5); border: none; backdrop-filter: blur(4px); transition: all 0.3s ease; }
                .glass-input:focus { background: rgba(255, 255, 255, 0.8); box-shadow: 0 0 0 4px rgba(29, 78, 216, 0.1); outline: none; }
                .btn-primary { background-color: var(--brand-primary); color: white; transition: all 0.2s; box-shadow: 0 4px 14px 0 rgba(29, 78, 216, 0.3); }
                .btn-primary:hover { background-color: var(--brand-primary-hover); transform: translateY(-1px); box-shadow: 0 6px 20px rgba(29, 78, 216, 0.23); }
                .custom-scrollbar::-webkit-scrollbar { width: 6px; }
                .custom-scrollbar::-webkit-scrollbar-track { background: rgba(0,0,0,0.05); }
                .custom-scrollbar::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.2); border-radius: 10px; }
            `}</style>
            
            <WaveBackground />
            
            <div className="relative z-10">
                <TourGuide steps={tourSteps} isOpen={tourOpen} onClose={() => setTourOpen(false)} stepIndex={tourStep} onNext={handleTourNext} />
                <ChatWidget />

                {screen === 'home' && (
                   <div className="relative flex min-h-screen flex-col items-center justify-center p-4">
                        <div className="w-full max-w-5xl glass-card rounded-3xl p-8 md:p-12 shadow-2xl relative overflow-hidden">
                             {/* Header */}
                            <div className="flex justify-between items-center mb-12">
                                <div className="flex items-center gap-3">
                                    <div className="bg-brand-primary/10 p-2 rounded-xl text-brand-primary">
                                        <span className="material-symbols-outlined text-3xl">psychology</span>
                                    </div>
                                    <h1 className="text-2xl font-bold tracking-tight text-brand-text m-0">SpeakEasy AI</h1>
                                </div>
                                <div className="flex items-center gap-4">
                                    {user ? (
                                        <div className="flex items-center gap-3 bg-white/50 px-4 py-2 rounded-full border border-white/40">
                                            <img src={user.photoURL || `https://ui-avatars.com/api/?name=${user.displayName}`} className="w-8 h-8 rounded-full border border-white" />
                                            <button onClick={handleLogout} className="text-sm font-semibold text-brand-text-light hover:text-red-500 transition-colors">Sign Out</button>
                                        </div>
                                    ) : (
                                        <button onClick={handleLogin} className="text-sm font-bold bg-white text-brand-primary px-6 py-2.5 rounded-full shadow-lg hover:shadow-xl transition-all">Sign In</button>
                                    )}
                                    <button onClick={restartTour} className="w-10 h-10 rounded-full bg-white/40 hover:bg-white/70 flex items-center justify-center text-brand-text transition-all"><span className="material-symbols-outlined">help</span></button>
                                </div>
                            </div>

                            {/* Hero */}
                            <div className="text-center mb-16">
                                <h2 className="text-5xl md:text-6xl font-black text-brand-text mb-6 tracking-tight leading-tight">Master Your<br/><span className="text-brand-primary">Next Conversation</span></h2>
                                <p className="text-lg text-brand-text-light max-w-xl mx-auto leading-relaxed">AI-powered simulation for interviews, presentations, and academic defenses. Real-time feedback, zero judgement.</p>
                            </div>

                            {/* Cards */}
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                                {[
                                    { id: 'card-interview', icon: 'work', title: 'Job Interview', desc: 'Behavioral & technical prep', color: 'text-blue-600', bg: 'bg-blue-50' },
                                    { id: 'card-presentation', icon: 'present_to_all', title: 'Presentation', desc: 'Slide & delivery coaching', color: 'text-purple-600', bg: 'bg-purple-50' },
                                    { id: 'card-seminar', icon: 'school', title: 'Seminar Defense', desc: 'Academic rigor check', color: 'text-orange-600', bg: 'bg-orange-50' }
                                ].map((card, idx) => (
                                    <div 
                                        key={card.id}
                                        id={card.id}
                                        onClick={() => handleStartSessionSetup(idx === 0 ? 'interview' : idx === 1 ? 'presentation' : 'seminar')}
                                        className="group relative cursor-pointer bg-white/60 hover:bg-white/90 backdrop-blur-md rounded-2xl p-8 transition-all duration-300 hover:-translate-y-2 hover:shadow-xl border border-white/50"
                                    >
                                        <div className={`w-14 h-14 ${card.bg} rounded-2xl flex items-center justify-center mb-6 group-hover:scale-110 transition-transform`}>
                                            <span className={`material-symbols-outlined text-3xl ${card.color}`}>{card.icon}</span>
                                        </div>
                                        <h3 className="text-xl font-bold text-gray-800 mb-2">{card.title}</h3>
                                        <p className="text-sm text-gray-500 font-medium">{card.desc}</p>
                                        <div className="absolute bottom-6 right-6 opacity-0 group-hover:opacity-100 transition-opacity transform translate-x-2 group-hover:translate-x-0">
                                            <span className="material-symbols-outlined text-gray-400">arrow_forward</span>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                   </div>
                )}

                {screen === 'setup' && (
                    <div className="flex min-h-screen items-center justify-center p-4 relative z-10">
                        <div className="w-full max-w-lg glass-card rounded-3xl p-8 shadow-2xl animate-[fadeIn_0.5s_ease-out]">
                            <button onClick={() => setScreen('home')} className="mb-6 flex items-center text-sm font-bold text-brand-text-light hover:text-brand-primary transition-colors"><span className="material-symbols-outlined text-lg mr-1">arrow_back</span> Back</button>
                            <h2 className="text-3xl font-bold text-brand-text mb-2 text-center">{sessionType === 'interview' ? 'Interview Setup' : (sessionType === 'seminar' ? 'Seminar Setup' : 'Presentation Setup')}</h2>
                            <p className="text-center text-brand-text-light mb-8 text-sm">Configure your AI coach preferences</p>
                            
                            <div className="space-y-5">
                                <div>
                                    <label className="block text-xs font-bold uppercase tracking-wider text-brand-text-light mb-2 ml-1">{sessionType === 'interview' ? 'Target Role' : 'Presentation Title'}</label>
                                    <input 
                                        name="role" 
                                        value={settings.role} 
                                        onChange={handleSettingsChange} 
                                        className="w-full h-14 px-5 rounded-2xl glass-input text-brand-text font-medium placeholder-gray-400"
                                        placeholder={sessionType === 'interview' ? "e.g. Product Manager" : "e.g. Q3 Business Review"} 
                                    />
                                </div>
                                <div>
                                    <label className="block text-xs font-bold uppercase tracking-wider text-brand-text-light mb-2 ml-1">{sessionType === 'interview' ? 'Focus Topics' : 'Target Audience'}</label>
                                    <textarea 
                                        name="topics" 
                                        value={settings.topics} 
                                        onChange={handleSettingsChange} 
                                        className="w-full h-32 px-5 py-4 rounded-2xl glass-input text-brand-text font-medium placeholder-gray-400 resize-none"
                                        placeholder={sessionType === 'interview' ? "e.g. System Design, Leadership" : "e.g. Investors, Students"} 
                                    />
                                </div>
                                
                                <div className="grid grid-cols-2 gap-4">
                                    <div className="relative">
                                        <label className="block text-xs font-bold uppercase tracking-wider text-brand-text-light mb-2 ml-1">AI Voice</label>
                                        <select name="voice" value={settings.voice} onChange={handleSettingsChange} className="w-full h-12 px-4 rounded-xl glass-input text-brand-text text-sm appearance-none cursor-pointer">
                                            {['Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir'].map(v => <option key={v} value={v}>{v}</option>)}
                                        </select>
                                        <span className="material-symbols-outlined absolute right-3 bottom-3 pointer-events-none text-gray-500 text-sm">expand_more</span>
                                    </div>
                                    <div className="relative">
                                        <label className="block text-xs font-bold uppercase tracking-wider text-brand-text-light mb-2 ml-1">Language</label>
                                        <select name="language" value={settings.language} onChange={handleSettingsChange} className="w-full h-12 px-4 rounded-xl glass-input text-brand-text text-sm appearance-none cursor-pointer">
                                            {['English', 'Spanish', 'French', 'German', 'Hindi'].map(l => <option key={l} value={l}>{l}</option>)}
                                        </select>
                                        <span className="material-symbols-outlined absolute right-3 bottom-3 pointer-events-none text-gray-500 text-sm">expand_more</span>
                                    </div>
                                </div>

                                <button onClick={() => fileInputRef.current?.click()} className="w-full py-4 border-2 border-dashed border-white/60 rounded-2xl bg-white/20 hover:bg-white/40 transition-all flex items-center justify-center gap-3 group cursor-pointer text-brand-text-light font-medium">
                                    <span className={`material-symbols-outlined ${resumeFile ? 'text-green-500' : 'text-brand-primary'}`}>{resumeFile ? 'check_circle' : 'upload_file'}</span>
                                    <span className="group-hover:text-brand-primary transition-colors">{resumeFile ? resumeFile.name : (sessionType === 'interview' ? "Upload Resume (PDF)" : "Upload Slides (PDF)")}</span>
                                    <input type="file" accept=".pdf" ref={fileInputRef} onChange={(e) => setResumeFile(e.target.files ? e.target.files[0] : null)} className="hidden" />
                                </button>

                                {error && <div className="bg-red-100 text-red-600 text-sm p-3 rounded-xl text-center font-medium">{error}</div>}

                                <button 
                                    onClick={handleStartInterview} 
                                    disabled={isLoading}
                                    className="w-full h-14 rounded-full bg-brand-primary hover:bg-brand-primary-hover text-white font-bold text-lg shadow-xl shadow-brand-primary/30 transition-all transform hover:scale-[1.02] active:scale-[0.98] disabled:opacity-70 disabled:cursor-not-allowed mt-4"
                                >
                                    {loadingAction === 'analyzing_file' ? 'Analyzing...' : loadingAction === 'generating_briefing' ? 'Preparing Session...' : 'Start Session'}
                                </button>
                            </div>
                        </div>
                    </div>
                )}
                
                {(screen === 'briefing' || screen === 'interview') && (
                    <div className="flex h-screen flex-col items-center justify-center p-4 relative z-10">
                         {screen === 'briefing' ? (
                            <div className="w-full max-w-lg glass-card rounded-3xl p-8 text-center animate-[fadeIn_0.5s_ease-out]">
                                <h2 className="text-2xl font-bold text-brand-text mb-6">Briefing</h2>
                                <div className="bg-white/60 rounded-2xl p-6 mb-8 text-left max-h-60 overflow-y-auto custom-scrollbar text-brand-text leading-relaxed shadow-inner">
                                    {briefingText || "Generating your briefing..."}
                                </div>
                                <button onClick={() => setShowPermissionModal(true)} disabled={isLoading} className="w-full h-14 rounded-full bg-brand-primary hover:bg-brand-primary-hover text-white font-bold text-lg shadow-xl shadow-brand-primary/30 transition-all">
                                    {loadingAction === 'connecting_session' ? 'Connecting...' : 'I\'m Ready'}
                                </button>
                            </div>
                         ) : (
                            <div className="w-full max-w-2xl flex flex-col h-full max-h-[900px]">
                                {/* Interview Header */}
                                <div className="glass-card rounded-2xl p-4 mb-4 flex justify-between items-center shadow-md">
                                    <div className="flex items-center gap-3">
                                        <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse"></div>
                                        <span className="font-bold text-brand-text">Live Session</span>
                                    </div>
                                    {settings.mode === 'timed' && timeLeft !== null && <span className={`font-mono font-bold text-xl ${timeLeft < 30 ? 'text-red-500' : 'text-brand-text'}`}>{timeLeft}s</span>}
                                </div>

                                {/* Visualizer / Avatar */}
                                <div className="flex-1 glass-card rounded-3xl p-6 mb-4 flex flex-col items-center justify-center relative overflow-hidden shadow-lg">
                                    <div className="absolute inset-0 bg-gradient-to-b from-transparent to-brand-primary/5"></div>
                                    
                                    {/* AI Avatar Pulse */}
                                    <div className="relative mb-8">
                                        <div className="w-32 h-32 rounded-full bg-gradient-to-tr from-brand-primary to-purple-500 flex items-center justify-center shadow-2xl z-10 relative">
                                            <span className="material-symbols-outlined text-5xl text-white">graphic_eq</span>
                                        </div>
                                        {/* Rings */}
                                        <div className="absolute inset-0 rounded-full border-2 border-brand-primary/30 animate-pulse-slow scale-150"></div>
                                        <div className="absolute inset-0 rounded-full border border-brand-primary/20 animate-pulse-slow scale-[2]" style={{animationDelay: '1s'}}></div>
                                    </div>

                                    {/* User Camera (PiP) */}
                                    <div className="absolute bottom-4 right-4 w-32 h-40 bg-black rounded-xl overflow-hidden shadow-2xl border-2 border-white/20 group">
                                        <video ref={videoRef} autoPlay muted playsInline className={`w-full h-full object-cover transform scale-x-[-1] ${isCameraOff ? 'hidden' : ''}`}/>
                                        {isCameraOff && <div className="w-full h-full flex items-center justify-center text-white/50"><span className="material-symbols-outlined">videocam_off</span></div>}
                                        <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2">
                                            <button onClick={toggleMute} className="p-2 rounded-full bg-white/20 hover:bg-white/40 text-white"><span className="material-symbols-outlined text-sm">{isMuted ? 'mic_off' : 'mic'}</span></button>
                                            <button onClick={toggleCamera} className="p-2 rounded-full bg-white/20 hover:bg-white/40 text-white"><span className="material-symbols-outlined text-sm">{isCameraOff ? 'videocam_off' : 'videocam'}</span></button>
                                        </div>
                                    </div>
                                    
                                    <div className="text-center z-10">
                                        <p className="text-brand-text-light font-medium">{speakingDuration > 0 ? 'You are speaking...' : 'Listening...'}</p>
                                        {speakingDuration > 0 && <div className="mt-2 h-1 w-24 bg-gray-200 rounded-full overflow-hidden mx-auto"><div className="h-full bg-green-500 transition-all duration-100" style={{width: `${Math.min(speakingDuration * 5, 100)}%`}}></div></div>}
                                    </div>
                                </div>

                                {/* Transcript */}
                                <div className="glass-card rounded-2xl p-4 flex-1 mb-4 overflow-hidden flex flex-col shadow-inner bg-white/30">
                                    <div className="overflow-y-auto custom-scrollbar flex-1 space-y-3 pr-2">
                                         {transcript.length === 0 && <p className="text-center text-brand-text-light text-sm italic mt-10">Conversation starting...</p>}
                                         {transcript.map((t, i) => (
                                             <div key={i} className={`flex flex-col ${t.speaker === 'user' ? 'items-end' : 'items-start'}`}>
                                                 <div className={`px-4 py-2.5 rounded-2xl max-w-[85%] text-sm leading-relaxed shadow-sm ${t.speaker === 'user' ? 'bg-brand-primary text-white rounded-br-none' : 'bg-white/80 text-brand-text rounded-bl-none'}`}>
                                                     {t.text}
                                                 </div>
                                             </div>
                                         ))}
                                         <div ref={transcriptEndRef} />
                                    </div>
                                </div>

                                <button onClick={stopInterview} disabled={loadingAction === 'generating_feedback'} className="w-full h-14 rounded-full bg-red-500 hover:bg-red-600 text-white font-bold text-lg shadow-lg shadow-red-500/30 transition-all hover:scale-[1.01]">
                                    {loadingAction === 'generating_feedback' ? 'Analyzing Session...' : 'End Session'}
                                </button>
                            </div>
                         )}
                    </div>
                )}

                {screen === 'feedback' && feedback && (
                    <div className="flex min-h-screen flex-col items-center justify-center p-4 relative z-10">
                        <div className="w-full max-w-3xl glass-card rounded-3xl p-8 md:p-10 shadow-2xl">
                            <h1 className="text-3xl font-bold text-brand-text text-center mb-8">Performance Report</h1>
                            
                            <div className="flex flex-col md:flex-row gap-8 mb-10 items-center justify-center">
                                {/* Overall Score */}
                                <div className="relative w-40 h-40 flex items-center justify-center">
                                    <svg className="w-full h-full transform -rotate-90">
                                        <circle cx="80" cy="80" r="70" stroke="white" strokeWidth="12" fill="none" className="opacity-30" />
                                        <circle cx="80" cy="80" r="70" stroke="#1D4ED8" strokeWidth="12" fill="none" strokeDasharray="440" strokeDashoffset={440 - (440 * feedback.overall) / 10} className="transition-all duration-1000 ease-out" />
                                    </svg>
                                    <div className="absolute inset-0 flex flex-col items-center justify-center">
                                        <span className="text-5xl font-black text-brand-text">{feedback.overall}</span>
                                        <span className="text-xs uppercase font-bold text-brand-text-light mt-1">Overall</span>
                                    </div>
                                </div>
                                
                                {/* Detailed Metrics */}
                                <div className="grid grid-cols-2 gap-4 flex-1 w-full">
                                    {['relevance', 'clarity', 'conciseness', 'technicalAccuracy'].map((metric) => (
                                        <div key={metric} onClick={() => setActiveScoreModal(metric)} className="bg-white/50 p-4 rounded-2xl cursor-pointer hover:bg-white/80 transition-colors border border-white/50">
                                            <div className="flex justify-between items-start mb-2">
                                                <span className="text-xs font-bold text-brand-text-light uppercase tracking-wider">{getScoreTitle(metric)}</span>
                                                <span className="material-symbols-outlined text-brand-text-light text-sm">info</span>
                                            </div>
                                            <div className="text-2xl font-bold text-brand-text">{(feedback as any)[metric]}/10</div>
                                        </div>
                                    ))}
                                </div>
                            </div>

                            <div className="bg-brand-primary/5 border-l-4 border-brand-primary p-6 rounded-r-xl mb-8">
                                <h3 className="font-bold text-brand-primary mb-2 uppercase text-xs tracking-wider">Executive Summary</h3>
                                <p className="text-brand-text text-sm leading-relaxed">{feedback.summary}</p>
                            </div>

                            {recordedVideoUrl && (
                                 <div className="mb-8">
                                    <h3 className="font-bold text-brand-text mb-3">Session Recording</h3>
                                    <video src={recordedVideoUrl} controls className="w-full rounded-2xl shadow-lg border border-white/20" />
                                    <a href={recordedVideoUrl} download="session.webm" className="inline-block mt-3 text-sm font-bold text-brand-primary hover:underline">Download Video</a>
                                </div>
                            )}

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
                                <div>
                                    <h3 className="flex items-center gap-2 font-bold text-green-600 mb-4"><span className="material-symbols-outlined">thumb_up</span> Strengths</h3>
                                    <div className="space-y-3">
                                        {feedback.strengths.map((item, i) => (
                                            <div key={i} className="bg-green-50/80 p-4 rounded-xl border border-green-100 text-sm">
                                                <div className="font-bold text-green-800 mb-1">{item.strength}</div>
                                                <div className="text-green-700 italic">"{item.example}"</div>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                                <div>
                                    <h3 className="flex items-center gap-2 font-bold text-red-500 mb-4"><span className="material-symbols-outlined">thumb_down</span> Improvements</h3>
                                    <div className="space-y-3">
                                        {feedback.improvements.map((item, i) => (
                                            <div key={i} className="bg-red-50/80 p-4 rounded-xl border border-red-100 text-sm">
                                                <div className="font-bold text-red-800 mb-1">{item.area}</div>
                                                <div className="text-red-700 italic mb-2">"{item.example}"</div>
                                                <div className="bg-white/60 p-2 rounded text-red-900 text-xs"><span className="font-bold">Try:</span> "{item.suggestion}"</div>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            </div>

                            <button className="w-full h-14 rounded-full bg-brand-primary hover:bg-brand-primary-hover text-white font-bold text-lg shadow-xl shadow-brand-primary/30 transition-all" onClick={() => setScreen('home')}>Back to Home</button>
                        </div>
                    </div>
                )}
            </div>
            
            {showPermissionModal && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
                    <div className="bg-white rounded-3xl p-8 max-w-md text-center shadow-2xl">
                        <div className="w-20 h-20 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-6 text-4xl">{permissionDenied ? '🚫' : '🎙️'}</div>
                        <h2 className="text-2xl font-bold text-gray-900 mb-2">{permissionDenied ? 'Access Denied' : 'Microphone Access'}</h2>
                        <p className="text-gray-600 mb-8">{permissionDenied ? 'Please enable permissions in your browser settings to continue.' : 'We need microphone and camera access to simulate a real interview.'}</p>
                        <div className="flex gap-4 justify-center">
                            {!permissionDenied ? (
                                <>
                                    <button onClick={() => setShowPermissionModal(false)} className="px-6 py-3 rounded-xl font-bold text-gray-500 hover:bg-gray-100">Cancel</button>
                                    <button onClick={confirmPermission} className="px-6 py-3 rounded-xl font-bold bg-brand-primary text-white shadow-lg shadow-blue-500/30 hover:bg-blue-800">Allow Access</button>
                                </>
                            ) : (
                                <button onClick={() => window.location.reload()} className="px-6 py-3 rounded-xl font-bold bg-gray-900 text-white">Refresh Page</button>
                            )}
                        </div>
                    </div>
                </div>
            )}
            
            {activeScoreModal && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4" onClick={() => setActiveScoreModal(null)}>
                    <div className="bg-white rounded-3xl p-6 max-w-sm w-full shadow-2xl animate-[fadeIn_0.2s_ease-out]" onClick={(e) => e.stopPropagation()}>
                        <div className="flex justify-between items-center mb-4">
                            <h3 className="text-xl font-bold text-gray-900">{getScoreTitle(activeScoreModal)}</h3>
                            <button onClick={() => setActiveScoreModal(null)} className="p-1 rounded-full hover:bg-gray-100"><span className="material-symbols-outlined text-gray-500">close</span></button>
                        </div>
                        <p className="text-gray-600 leading-relaxed mb-6">{
                            sessionType === 'interview' ? 
                            (activeScoreModal === 'relevance' ? "Did you answer the specific question asked?" : activeScoreModal === 'clarity' ? "Was your structure logical and easy to follow?" : activeScoreModal === 'conciseness' ? "Did you avoid rambling?" : "Was your technical content accurate?") :
                            (activeScoreModal === 'relevance' ? "Did you stick to the facts in your slides?" : activeScoreModal === 'clarity' ? "Was your delivery articulate?" : activeScoreModal === 'conciseness' ? "Was your pacing appropriate?" : "Were your statements factually correct?")
                        }</p>
                        <button onClick={() => setActiveScoreModal(null)} className="w-full py-3 bg-brand-primary text-white rounded-xl font-bold">Got it</button>
                    </div>
                </div>
            )}
        </div>
    );
};

const root = createRoot(document.getElementById('root')!);
root.render(<App />);