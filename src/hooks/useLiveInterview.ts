import { useRef, useState, useEffect } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from "@google/genai";
import { TranscriptEntry } from '../types';
import { decode, decodeAudioData, createBlob } from '../utils/audio';

// FIX: The 'LiveSession' type is not exported from the '@google/genai' module.
type LiveSession = Awaited<ReturnType<InstanceType<typeof GoogleGenAI>["live"]["connect"]>>;

const PREMADE_QUESTIONS = [
    "To start, could you please introduce yourself and give a brief overview of your background?",
    "What interested you in this specific role and our company?",
    "Can you describe a challenging professional situation you've faced and how you handled it?"
];

export const useLiveInterview = (settings: any, resumeAnalysis: string, sessionType: string) => {
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

    const sessionRef = useRef<LiveSession | null>(null);
    const isSessionActive = useRef(false);
    const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const speechTimerIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
    
    // Speaking timer refs
    const isUserSpeakingRef = useRef(false);
    const speechStartTimeRef = useRef<number | null>(null);
    const lastSpeechDetectedTimeRef = useRef<number>(0);
    
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
            const utterance = new SpeechSynthesisUtterance(text);
            
            // Try to find a high-quality voice if possible
            const voices = window.speechSynthesis.getVoices();
            const preferredVoice = voices.find(v => v.name.includes('Google') || v.name.includes('Premium')) || voices[0];
            if (preferredVoice) utterance.voice = preferredVoice;
            
            utterance.rate = 1.0;
            utterance.pitch = 1.0;
            utterance.onend = () => resolve();
            utterance.onerror = () => resolve();

            window.speechSynthesis.speak(utterance);
        });
    };

    const cleanupAudioResources = async () => {
        isSessionActive.current = false;
        window.speechSynthesis.cancel();
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
        transcriptionBuffer.current = { input: '', output: '' };
        setTimeLeft(null);
        isSessionActive.current = true;
        
        setIsInIntro(true);
        setPremadeQuestionIdx(-1);

        try {
            const ai = new GoogleGenAI({ apiKey: (window as any).process?.env?.API_KEY || "" });
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

            const sources = new Set<AudioBufferSourceNode>();

            const difficultyContext = {
                'Easy': "Questions should be fundamental and straightforward. Be encouraging, patient, and helpful. Focus on core concepts.",
                'Medium': "Questions should be of moderate difficulty, covering standard scenarios. Provide balanced feedback.",
                'Hard': "Questions should be complex, challenging edge cases and deep technical details. Be strict, critical, and simulate a high-pressure environment."
            };

            let systemInstructionText = sessionType === 'interview' ? 
                `You are a Senior HR + Technical Interviewer. Role: '${settings.role}'. Focus: '${settings.topics}'. 
                DIFFICULTY LEVEL: ${settings.level}.
                INSTRUCTIONS FOR DIFFICULTY: ${difficultyContext[settings.level as keyof typeof difficultyContext] || difficultyContext['Medium']}
                Language: ${settings.language}.
                RULES: Ask ONE question at a time. Provide feedback after completion of whole interview session. Do not reuse questions.
                STAGES: Technical, Behavioral, Evaluation.
                NOTE: The user has already finished warm-up questions. Jump straight into the core interview.` :
                `You are a Presentation Coach/Audience. Topic: '${settings.role}'. Audience: '${settings.topics}'. Language: ${settings.language}.
                GOAL: Help user deliver accurate, clear presentation.
                ROLE: Listen predominantly. FACT CHECK real-time against context. Monitor Clarity & Pacing.`;

            if (resumeAnalysis) systemInstructionText += `\n\nCONTEXT:\n${resumeAnalysis}`;
            if (settings.mode === 'timed') systemInstructionText += `\nNOTE: Timed session (90s).`;

            const sessionPromise = ai.live.connect({
                model: 'gemini-2.5-flash-native-audio-preview-09-2025',
                callbacks: {
                    onopen: async () => {
                        if (!isSessionActive.current) return;
                        setLoadingAction(null);
                        
                        if (!audioRefs.current.inputAudioContext || !audioRefs.current.stream) return;
                        
                        if (videoElement) {
                            videoElement.srcObject = audioRefs.current.stream;
                        }

                        const source = audioRefs.current.inputAudioContext.createMediaStreamSource(audioRefs.current.stream);
                        audioRefs.current.source = source;
                        
                        const scriptProcessor = audioRefs.current.inputAudioContext.createScriptProcessor(2048, 1, 1);
                        audioRefs.current.scriptProcessor = scriptProcessor;

                        scriptProcessor.onaudioprocess = (audioProcessingEvent) => {
                            if (!isSessionActive.current) return;
                            
                            // Only send audio to AI if we are NOT in intro phase
                            // Actually, we want the AI to "listen" but we handle the responses for now.
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

                            if (noiseGateOpen && !isUserSpeakingRef.current) {
                                // Interruption: clear current model audio
                                sources.forEach(s => { try { s.stop(); } catch(e) {} });
                                sources.clear();
                                audioRefs.current.nextStartTime = 0;
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
                                // Even in intro, we send input so AI has transcription history
                                if (isSessionActive.current) {
                                    try { session.sendRealtimeInput({ media: pcmBlob }); } catch (err) {}
                                }
                            });
                        };
                        source.connect(scriptProcessor);
                        scriptProcessor.connect(audioRefs.current.inputAudioContext.destination);

                        // START GREETING & WALKTHROUGH
                        const greetingText = `Hello! I'm your AI Interview Coach. Welcome to your practice session for the ${settings.role} position.`;
                        const walkthroughText = `Before we begin, here's how this session will work. First, we'll start with a few warm-up questions. Then, we'll dive into your technical background and behavioral experiences. Finally, I'll provide a detailed performance report. I'll be listening carefully, so feel free to speak naturally. Let's start with your introduction.`;
                        
                        setTranscript(prev => [...prev, { speaker: 'AI Coach', text: greetingText }]);
                        await speakLocal(greetingText);
                        
                        setTranscript(prev => [...prev, { speaker: 'AI Coach', text: walkthroughText }]);
                        await speakLocal(walkthroughText);

                        const firstQuestion = PREMADE_QUESTIONS[0];
                        setTranscript(prev => [...prev, { speaker: 'AI Coach', text: firstQuestion }]);
                        await speakLocal(firstQuestion);
                        
                        setIsInIntro(false);
                        setPremadeQuestionIdx(0);
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

                                // Logic for Premade Questions
                                sessionPromise.then(async (session) => {
                                    if (premadeQuestionIdx >= 0 && premadeQuestionIdx < PREMADE_QUESTIONS.length - 1) {
                                        const nextIdx = premadeQuestionIdx + 1;
                                        setPremadeQuestionIdx(nextIdx);
                                        const nextQ = PREMADE_QUESTIONS[nextIdx];
                                        
                                        // Wait a bit before asking next question
                                        await new Promise(r => setTimeout(r, 1000));
                                        
                                        setTranscript(prev => [...prev, { speaker: 'AI Coach', text: nextQ }]);
                                        await speakLocal(nextQ);
                                    } else if (premadeQuestionIdx === PREMADE_QUESTIONS.length - 1) {
                                        // Transition to real AI
                                        setPremadeQuestionIdx(-2); // -2 means transition to AI
                                        const transitionText = "Great! Now let's move into more specific questions based on your background and the role.";
                                        setTranscript(prev => [...prev, { speaker: 'AI Coach', text: transitionText }]);
                                        await speakLocal(transitionText);
                                    }
                                });
                           }
                           
                           // If AI is actually talking (premadeIdx === -2 or AI started talking on its own)
                           if (output && premadeQuestionIdx < 0) {
                                setTranscript(prev => [...prev, { speaker: 'AI Coach', text: output }]);
                                if (settings.mode === 'timed') setTimeLeft(90);
                           }
                           
                           transcriptionBuffer.current.input = '';
                           transcriptionBuffer.current.output = '';
                        }

                        // Only process AI audio if we are in AI mode
                        const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
                        if (base64Audio && audioRefs.current.outputAudioContext && premadeQuestionIdx < 0) {
                            const outputAudioContext = audioRefs.current.outputAudioContext;
                            const audioBuffer = await decodeAudioData(decode(base64Audio), outputAudioContext, 24000, 1);
                            
                            const now = outputAudioContext.currentTime;
                            if (audioRefs.current.nextStartTime <= now) {
                                audioRefs.current.nextStartTime = now + 0.1; // 100ms jitter buffer
                            }

                            const source = outputAudioContext.createBufferSource();
                            source.buffer = audioBuffer;
                            source.connect(outputAudioContext.destination);
                            source.addEventListener('ended', () => sources.delete(source));
                            source.start(audioRefs.current.nextStartTime);
                            audioRefs.current.nextStartTime += audioBuffer.duration;
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
        isInIntro
    };
};

