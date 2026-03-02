import { useRef, useState, useEffect } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from "@google/genai";
import { TranscriptEntry } from '../types';
import { decode, decodeAudioData, createBlob } from '../utils/audio';
import { generateNextQuestion } from '../utils/ai';

// Fix: Web Speech API types
const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

// FIX: The 'LiveSession' type is not exported from the '@google/genai' module.
type LiveSession = Awaited<ReturnType<InstanceType<typeof GoogleGenAI>["live"]["connect"]>>;

const PREMADE_QUESTIONS = [
    "To start, could you please introduce yourself and give a brief overview of your background?",
    "What interested you in this specific role and our company?",
    "Can you describe a challenging professional situation you've faced and how you handled it?"
];

export const useLiveInterview = (settings: any, resumeAnalysis: string, sessionType: string, onComplete?: () => void) => {
    const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
    const [speakingDuration, setSpeakingDuration] = useState(0);
    const [timeLeft, setTimeLeft] = useState<number | null>(null);
    const [recordedVideoUrl, setRecordedVideoUrl] = useState<string | null>(null);
    const [isMuted, setIsMuted] = useState(false);
    const [isCameraOff, setIsCameraOff] = useState(false);
    const [loadingAction, setLoadingAction] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    
    // Intro & Premade Logic
    const [isInIntro, setIsInIntro] = useState(false);
    const [premadeQuestionIdx, setPremadeQuestionIdx] = useState(-1); // -1 means intro/greeting
    const [questionsAsked, setQuestionsAsked] = useState(0);

    const onCompleteRef = useRef<(() => void) | null>(null);
    onCompleteRef.current = onComplete || null;

    const recognitionRef = useRef<any>(null);
    const [isAiThinking, setIsAiThinking] = useState(false);

    const sessionRef = useRef<LiveSession | null>(null);
    const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
    const isSessionActive = useRef(false);
    const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const speechTimerIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
    
    // Speaking timer refs
    const isUserSpeakingRef = useRef(false);
    const speechStartTimeRef = useRef<number | null>(null);
    const lastSpeechDetectedTimeRef = useRef<number>(0);
    
    const transcriptionBuffer = useRef({ input: '', output: '' });
    const transcriptRef = useRef<TranscriptEntry[]>([]);

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
      nextStartTime: number;
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
      nextStartTime: 0,
    });

    const speakLocal = (text: string): Promise<void> => {
        return new Promise((resolve) => {
            if (!text) return resolve();
            
            window.speechSynthesis.cancel();
            const utterance = new SpeechSynthesisUtterance(text);
            utteranceRef.current = utterance;
            
            const voices = window.speechSynthesis.getVoices();
            const preferredVoice = voices.find(v => v.name.includes('Google') || v.name.includes('Premium')) || voices[0];
            if (preferredVoice) utterance.voice = preferredVoice;
            
            utterance.rate = 1.0;
            utterance.pitch = 1.0;
            utterance.onend = () => {
                utteranceRef.current = null;
                resolve();
            };
            utterance.onerror = (e) => {
                console.error("TTS Error", e);
                utteranceRef.current = null;
                resolve();
            };

            window.speechSynthesis.speak(utterance);
        });
    };

    const cleanupAudioResources = async () => {
        isSessionActive.current = false;
        window.speechSynthesis.cancel();
        
        if (recognitionRef.current) {
            try { recognitionRef.current.stop(); } catch (e) {}
            recognitionRef.current = null;
        }

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

    const handleAiTurn = async (currentTranscript: TranscriptEntry[]) => {
        console.log("AI Coach turn started. Context size:", currentTranscript.length);
        if (!isSessionActive.current) return;
        
        // Check if limit reached
        const maxQ = parseInt(settings.maxQuestions);
        if (!isNaN(maxQ) && questionsAsked >= maxQ) {
            setTimeout(() => {
                if (onCompleteRef.current) onCompleteRef.current();
            }, 1500);
            return;
        }

        setIsAiThinking(true);
        try {
            const nextQ = await generateNextQuestion(
                currentTranscript,
                sessionType,
                settings.role,
                settings.topics,
                settings.level,
                resumeAnalysis,
                (window as any).process?.env?.API_KEY || ""
            );
            console.log("AI Question generated:", nextQ);
            
            if (!isSessionActive.current) return;
            
            setTranscript(prev => {
                const updated = [...prev, { speaker: 'AI Coach', text: nextQ }];
                transcriptRef.current = updated;
                return updated;
            });
            setQuestionsAsked(prev => prev + 1);
            setIsAiThinking(false);
            
            await speakLocal(nextQ);
            
            if (isSessionActive.current) {
                console.log("AI finished speaking, starting recognition for user response...");
                startRecognition();
            }
        } catch (err) {
            console.error("AI Turn failed", err);
            setIsAiThinking(false);
            setError("Failed to generate next question.");
        }
    };

    const startRecognition = () => {
        if (!isSessionActive.current || !SpeechRecognition) return;

        if (recognitionRef.current) {
            try { recognitionRef.current.stop(); } catch (e) {}
        }

        const recognition = new SpeechRecognition();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.lang = settings.language === 'Hindi' ? 'hi-IN' : 
                          settings.language === 'Spanish' ? 'es-ES' : 
                          settings.language === 'French' ? 'fr-FR' : 
                          settings.language === 'German' ? 'de-DE' : 'en-US';

        let finalTranscript = '';
        let silenceTimer: any;

        recognition.onresult = (event: any) => {
            let interimTranscript = '';
            for (let i = event.resultIndex; i < event.results.length; ++i) {
                if (event.results[i].isFinal) {
                    finalTranscript += event.results[i][0].transcript;
                } else {
                    interimTranscript += event.results[i][0].transcript;
                }
            }
            transcriptionBuffer.current.input = finalTranscript + interimTranscript;

            // Silence detection: If user stops speaking for 3 seconds, stop recognition to trigger onend
            if (silenceTimer) clearTimeout(silenceTimer);
            silenceTimer = setTimeout(() => {
                if (recognitionRef.current) {
                    console.log("Silence detected (3s pause), ending recognition turn...");
                    try { recognitionRef.current.stop(); } catch(e) { console.error("Recognition stop error", e); }
                }
            }, 3000); 
        };

        recognition.onend = () => {
            console.log("Speech recognition onend triggered.");
            if (!isSessionActive.current) return;
            if (silenceTimer) clearTimeout(silenceTimer);
            
            const userText = transcriptionBuffer.current.input.trim();
            console.log("Captured user text:", userText);
            
            if (userText) {
                const updatedTranscript = [...transcriptRef.current, { speaker: 'user', text: userText }];
                transcriptRef.current = updatedTranscript;
                setTranscript(updatedTranscript);
                transcriptionBuffer.current.input = '';
                handleAiTurn(updatedTranscript);
            } else {
                console.log("No user text captured, restarting recognition...");
                // If nothing heard, restart recognition after a small pause
                setTimeout(() => {
                    if (isSessionActive.current) startRecognition();
                }, 1000);
            }
        };

        recognition.onerror = (event: any) => {
            console.error("Recognition error", event.error);
            if (event.error === 'no-speech') {
                // Ignore no-speech error, it will trigger onend
            } else {
                setError(`Speech recognition error: ${event.error}`);
            }
        };

        recognitionRef.current = recognition;
        recognition.start();
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

    const startLiveSession = async (videoElement: HTMLVideoElement | null) => {
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
        audioRefs.current.nextStartTime = 0;

        setIsMuted(false);
        setIsCameraOff(false);

        setLoadingAction('connecting_session');
        setError(null);
        setTranscript([]);
        transcriptRef.current = [];
        transcriptionBuffer.current = { input: '', output: '' };
        setTimeLeft(null);
        isSessionActive.current = true;
        
        setIsInIntro(true);
        setPremadeQuestionIdx(-1);
        setQuestionsAsked(0);

        try {
            // Setup Audio Context for visualization ONLY (not for sending to AI)
            audioRefs.current.inputAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
            await audioRefs.current.inputAudioContext.resume();

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

            if (videoElement) {
                videoElement.srcObject = audioRefs.current.stream;
            }

            // Local Visualizer Logic
            const source = audioRefs.current.inputAudioContext.createMediaStreamSource(audioRefs.current.stream);
            audioRefs.current.source = source;
            const scriptProcessor = audioRefs.current.inputAudioContext.createScriptProcessor(2048, 1, 1);
            audioRefs.current.scriptProcessor = scriptProcessor;

            scriptProcessor.onaudioprocess = (audioProcessingEvent) => {
                if (!isSessionActive.current) return;
                const inputData = audioProcessingEvent.inputBuffer.getChannelData(0);

                // Basic RMS calculation for the visualizer
                let sum = 0;
                for (let i = 0; i < inputData.length; i++) sum += inputData[i] * inputData[i];
                const rms = Math.sqrt(sum / inputData.length);

                let { smoothedVolume } = audioRefs.current.audioProcessingState;
                smoothedVolume = 0.8 * smoothedVolume + 0.2 * rms;

                const GATE_THRESHOLD = 0.015;
                if (smoothedVolume > GATE_THRESHOLD) {
                    if (!isUserSpeakingRef.current) {
                        isUserSpeakingRef.current = true;
                        speechStartTimeRef.current = Date.now();
                    }
                } else {
                    if (isUserSpeakingRef.current) {
                        isUserSpeakingRef.current = false;
                        speechStartTimeRef.current = null;
                    }
                }
                
                audioRefs.current.audioProcessingState.smoothedVolume = smoothedVolume;
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(audioRefs.current.inputAudioContext.destination);

            setLoadingAction(null);

            // GREETING & INTRO FLOW
            const greetingText = `Hello! I'm your AI Interview Coach. Welcome to your practice session for the ${settings.role} position.`;
            const walkthroughText = `Before we begin, here's how this session will work. First, we'll start with a few warm-up questions. Then, we'll dive into your technical background and behavioral experiences. I'll be listening after each question, so feel free to speak naturally. Let's start with your introduction.`;
            
            setTranscript(prev => {
                const updated = [...prev, { speaker: 'AI Coach', text: greetingText }];
                transcriptRef.current = updated;
                return updated;
            });
            await speakLocal(greetingText);
            
            setTranscript(prev => {
                const updated = [...prev, { speaker: 'AI Coach', text: walkthroughText }];
                transcriptRef.current = updated;
                return updated;
            });
            await speakLocal(walkthroughText);

            const firstQuestion = PREMADE_QUESTIONS[0];
            setTranscript(prev => {
                const updated = [...prev, { speaker: 'AI Coach', text: firstQuestion }];
                transcriptRef.current = updated;
                return updated;
            });
            setIsInIntro(false);
            setQuestionsAsked(1);
            
            await speakLocal(firstQuestion);
            
            if (isSessionActive.current) {
                startRecognition();
            }

        } catch (err: any) {
            console.error("Failed to start session:", err);
            setError(`Failed to start session: ${err.message}.`);
            setLoadingAction(null);
            cleanupAudioResources();
            throw err;
        }
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

    // Speaking timer effect
    useEffect(() => {
        speechTimerIntervalRef.current = setInterval(() => {
            if (isUserSpeakingRef.current && speechStartTimeRef.current) {
                const duration = (Date.now() - speechStartTimeRef.current) / 1000;
                setSpeakingDuration(duration);
            } else if (!isUserSpeakingRef.current) {
                 setSpeakingDuration(0);
            }
        }, 100);

        return () => {
            if (speechTimerIntervalRef.current) clearInterval(speechTimerIntervalRef.current);
        };
    }, []);

    // Timed mode effect
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

    return {
        transcript,
        speakingDuration,
        timeLeft,
        recordedVideoUrl,
        setRecordedVideoUrl,
        isMuted,
        isCameraOff,
        loadingAction,
        setLoadingAction,
        error,
        setError,
        startLiveSession,
        stopRecording,
        cleanupAudioResources,
        toggleMute,
        toggleCamera,
        transcriptionBuffer,
        setTranscript,
        isInIntro,
        isAiThinking
    };
};

