import React, { useState, useRef, useCallback, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { GoogleGenAI, LiveServerMessage, Modality, Blob } from "@google/genai";
import { Remarkable } from 'remarkable';

interface LiveSession {
    sendRealtimeInput(request: { media: Blob }): void;
    close(): void;
}

interface TranscriptItem {
    speaker: string;
    text: string;
}

interface InterviewRecord {
    id: string;
    date: string;
    role: string;
    topics: string;
    transcript: TranscriptItem[];
    feedback: string;
}

const App = () => {
    const [appState, setAppState] = useState('setup'); // 'setup', 'interviewing', 'generating_feedback', 'feedback', 'history', 'viewing_history_item'
    const [role, setRole] = useState('');
    const [topics, setTopics] = useState('');
    const [voice, setVoice] = useState('Zephyr');
    const [transcript, setTranscript] = useState<TranscriptItem[]>([]);
    const [feedback, setFeedback] = useState('');
    const [error, setError] = useState('');
    const [isInterviewerSpeaking, setIsInterviewerSpeaking] = useState(false);
    const [isUserSpeaking, setIsUserSpeaking] = useState(false);
    const [isMuted, setIsMuted] = useState(false);
    const [history, setHistory] = useState<InterviewRecord[]>([]);
    const [viewedItem, setViewedItem] = useState<InterviewRecord | null>(null);

    const md = new Remarkable();
    const transcriptEndRef = useRef<HTMLDivElement>(null);

    const sessionPromiseRef = useRef<Promise<LiveSession> | null>(null);
    const inputAudioContextRef = useRef<AudioContext | null>(null);
    const outputAudioContextRef = useRef<AudioContext | null>(null);
    const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
    const mediaStreamSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
    const mediaStreamRef = useRef<MediaStream | null>(null);
    const nextStartTimeRef = useRef(0);
    const audioSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
    const speakingTimerRef = useRef<number | null>(null);

    useEffect(() => {
        try {
            const storedHistory = localStorage.getItem('interviewHistory');
            if (storedHistory) {
                setHistory(JSON.parse(storedHistory));
            }
        } catch (e) {
            console.error("Failed to parse interview history:", e);
            localStorage.removeItem('interviewHistory');
        }
    }, []);

    useEffect(() => {
        if (error) {
            const timer = setTimeout(() => setError(''), 5000);
            return () => clearTimeout(timer);
        }
    }, [error]);

    useEffect(() => {
        transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [transcript]);


    const decode = (base64: string): Uint8Array => {
        const binaryString = atob(base64);
        const len = binaryString.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        return bytes;
    };

    const encode = (bytes: Uint8Array): string => {
        let binary = '';
        const len = bytes.byteLength;
        for (let i = 0; i < len; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    };

    const decodeAudioData = async (data: Uint8Array, ctx: AudioContext, sampleRate: number, numChannels: number): Promise<AudioBuffer> => {
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
    };
    
    const createBlob = (data: Float32Array): Blob => {
        const l = data.length;
        const int16 = new Int16Array(l);
        for (let i = 0; i < l; i++) {
            int16[i] = data[i] * 32768;
        }
        return {
            data: encode(new Uint8Array(int16.buffer)),
            mimeType: 'audio/pcm;rate=16000',
        };
    };

    const toggleMute = () => {
        if (!mediaStreamRef.current) return;
    
        const newMutedState = !isMuted;
        setIsMuted(newMutedState);
    
        mediaStreamRef.current.getAudioTracks().forEach(track => {
            track.enabled = !newMutedState;
        });
    };

    const startInterview = async () => {
        setError('');
        setTranscript([]);
        if (!role || !topics) {
            setError("Please fill in both the job role and topics.");
            return;
        }

        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            mediaStreamRef.current = stream;
            setAppState('interviewing');

            inputAudioContextRef.current = new ((window as any).AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
            outputAudioContextRef.current = new ((window as any).AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });

            const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

            const commonQuestions = `
1. Tell me about yourself.
2. What are your biggest strengths?
3. What are your biggest weaknesses?
4. Why do you want to work here?
5. Where do you see yourself in 5 years?
6. Can you describe a difficult work situation and how you handled it?`;

            const systemInstruction = `You are a hiring manager for the role of '${role}'. The candidate is expected to know about '${topics}'. Your task is to conduct a professional job interview.
First, introduce yourself briefly.
Then, ask the candidate a few of the following common questions to warm up:
${commonQuestions}
After they have answered a few of those, transition smoothly to asking more specific behavioral and technical questions related to the '${role}' position and the topics of '${topics}'.
Keep your questions concise and professional. Wait for the candidate's response after each question.`;

            sessionPromiseRef.current = ai.live.connect({
                model: 'gemini-2.5-flash-native-audio-preview-09-2025',
                config: {
                    systemInstruction: systemInstruction,
                    responseModalities: [Modality.AUDIO],
                    inputAudioTranscription: {},
                    outputAudioTranscription: {},
                    speechConfig: {
                        voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } },
                    },
                },
                callbacks: {
                    onopen: () => {
                        if (!inputAudioContextRef.current || !mediaStreamRef.current) return;
                        mediaStreamSourceRef.current = inputAudioContextRef.current.createMediaStreamSource(mediaStreamRef.current);
                        scriptProcessorRef.current = inputAudioContextRef.current.createScriptProcessor(4096, 1, 1);
                        
                        scriptProcessorRef.current.onaudioprocess = (audioProcessingEvent: AudioProcessingEvent) => {
                            const inputData = audioProcessingEvent.inputBuffer.getChannelData(0);
                            
                            // User speech detection
                            let sum = 0;
                            for (let i = 0; i < inputData.length; i++) {
                                sum += inputData[i] * inputData[i];
                            }
                            const rms = Math.sqrt(sum / inputData.length);
                            const speakingThreshold = 0.02;

                            if (rms > speakingThreshold) {
                                setIsUserSpeaking(true);
                                if (speakingTimerRef.current) {
                                    clearTimeout(speakingTimerRef.current);
                                }
                                speakingTimerRef.current = window.setTimeout(() => {
                                    setIsUserSpeaking(false);
                                }, 1500); // Keep visualizer active for 1.5s after sound stops
                            }

                            // Send audio to GenAI
                            const pcmBlob = createBlob(inputData);
                            if (sessionPromiseRef.current) {
                                sessionPromiseRef.current.then((session) => {
                                    session.sendRealtimeInput({ media: pcmBlob });
                                });
                            }
                        };
                        
                        mediaStreamSourceRef.current.connect(scriptProcessorRef.current);
                        scriptProcessorRef.current.connect(inputAudioContextRef.current.destination);
                    },
                    onmessage: async (message: LiveServerMessage) => {
                        const base64Audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
                        if (base64Audio) {
                            setIsInterviewerSpeaking(true);
                            if (outputAudioContextRef.current) {
                                const outputAudioContext = outputAudioContextRef.current;
                                nextStartTimeRef.current = Math.max(nextStartTimeRef.current, outputAudioContext.currentTime);
                                const audioBuffer = await decodeAudioData(decode(base64Audio), outputAudioContext, 24000, 1);
                                const source = outputAudioContext.createBufferSource();
                                source.buffer = audioBuffer;
                                source.connect(outputAudioContext.destination);
                                source.addEventListener('ended', () => audioSourcesRef.current.delete(source));
                                source.start(nextStartTimeRef.current);
                                nextStartTimeRef.current += audioBuffer.duration;
                                audioSourcesRef.current.add(source);
                            }
                        }

                        if (message.serverContent?.inputTranscription) {
                            const partial = message.serverContent.inputTranscription.text.trim();
                            if (partial) {
                                setTranscript(prev => {
                                    const last = prev[prev.length - 1];
                                    if (last && last.speaker === "You") {
                                        const updated = [...prev];
                                        updated[updated.length - 1] = { ...last, text: partial };
                                        return updated;
                                    } else {
                                        return [...prev, { speaker: "You", text: partial }];
                                    }
                                });
                            }
                        }

                        if (message.serverContent?.outputTranscription) {
                            const partial = message.serverContent.outputTranscription.text.trim();
                            if (partial) {
                                setTranscript(prev => {
                                    const last = prev[prev.length - 1];
                                    if (last && last.speaker === "Interviewer") {
                                        const updated = [...prev];
                                        updated[updated.length - 1] = { ...last, text: partial };
                                        return updated;
                                    } else {
                                        return [...prev, { speaker: "Interviewer", text: partial }];
                                    }
                                });
                            }
                        }

                        if (message.serverContent?.turnComplete) {
                            setIsInterviewerSpeaking(false);
                        }
                    },
                    onerror: (e: ErrorEvent) => {
                        setError('An error occurred during the interview. Please try again.');
                        console.error(e);
                        stopInterview(false);
                    },
                    onclose: (e: CloseEvent) => {
                        stream.getTracks().forEach(track => track.stop());
                    },
                },
            });

        } catch (err) {
            setError('Could not start the interview. Please ensure you have given microphone permissions.');
            console.error(err);
            setAppState('setup');
        }
    };

    const stopInterview = async (shouldGenerateFeedback: boolean = true) => {
        setIsInterviewerSpeaking(false);
        setIsUserSpeaking(false);
        if (speakingTimerRef.current) {
            clearTimeout(speakingTimerRef.current);
            speakingTimerRef.current = null;
        }

        if (mediaStreamRef.current) {
            mediaStreamRef.current.getTracks().forEach(track => track.stop());
            mediaStreamRef.current = null;
        }
        if (sessionPromiseRef.current) {
            const session = await sessionPromiseRef.current;
            session.close();
            sessionPromiseRef.current = null;
        }

        if (scriptProcessorRef.current) {
            scriptProcessorRef.current.disconnect();
            scriptProcessorRef.current = null;
        }
        if (mediaStreamSourceRef.current) {
            mediaStreamSourceRef.current.disconnect();
            mediaStreamSourceRef.current = null;
        }
        if (inputAudioContextRef.current && inputAudioContextRef.current.state !== 'closed') {
           await inputAudioContextRef.current.close();
        }
        if (outputAudioContextRef.current && outputAudioContextRef.current.state !== 'closed') {
           await outputAudioContextRef.current.close();
        }

        audioSourcesRef.current.forEach(source => source.stop());
        audioSourcesRef.current.clear();
        
        if (shouldGenerateFeedback) {
            generateFeedback();
        } else {
            setAppState('setup');
        }
    };

    const generateFeedback = async () => {
        setAppState('generating_feedback');
        
        const fullTranscript = transcript.map(t => `${t.speaker}: ${t.text}`).join('\n');
        if (fullTranscript.length < 50) { 
            setFeedback("The interview was too short to generate feedback. Please try again and have a longer conversation.");
            setAppState('feedback');
            return;
        }

        try {
            const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
            const prompt = `You are an expert career coach analyzing this **exact transcript** of a live AI interview. Do NOT invent or assume any answers — base all feedback ONLY on what the candidate said below.

Your task is to provide specific, actionable feedback to the candidate based on their actual answers from the transcript.

Your feedback must be corrective and educational, helping the candidate understand their mistakes and learn how to give better answers. Analyze each question and answer pair from the transcript.

Follow the format and style of the examples below EXACTLY. For each of the candidate's answers, provide a "Correction / Feedback" section.

---
**LEARNING EXAMPLES**

**Example 1: For a candidate with some knowledge**

Interviewer: What are your strengths and weaknesses?
You: “My strength is my ability to learn quickly and stay consistent with my work. I’m good at debugging and documenting code. My weakness is that I sometimes take on too much work at once, but I’ve learned to prioritize and manage tasks using tools like Trello.”

➡️ **Correction / Feedback:**
✅ **Excellent answer.** Your strength is relevant, and you present your weakness in a positive light by showing how you are actively working to improve it. This demonstrates self-awareness and a proactive attitude.
💡 **Tip:** When discussing a weakness, always frame it with a solution. This is a classic and effective strategy.

---

**Example 2: For a nervous or underprepared candidate**

Interviewer: Can you tell me about yourself?
You: Uh… I’m… I’m from computer science department. I like coding but… not that much expert. Umm… I did some projects… but not completed.

➡️ **Correction / Feedback:**
💬 **You said:** "I like coding but… not that much expert. Umm… I did some projects… but not completed."
❌ **Problem:** Quoting your own words shows the issue here: you immediately downplayed your skills and highlighted incomplete work. This sounds hesitant and lacks confidence.
✅ **Better answer:** “I’m a Computer Science student who enjoys learning programming and solving problems. I’ve worked on several projects using Python and C++, and I’m eager to apply my skills and grow in a professional environment like this one.”
💡 **Tip:** Prepare a 60-second "elevator pitch" about yourself. Structure it: 1. Who you are (e.g., "Computer Science student") → 2. What you're passionate about/skilled in → 3. What you want to achieve in this role. Practice it until it sounds natural.

Interviewer: What do you know about our company?
You: Uh… sorry sir, I didn’t check much. I only know it’s an IT company.

➡️ **Correction / Feedback:**
💬 **You said:** "sorry sir, I didn’t check much."
❌ **Problem:** This directly states a lack of preparation and can signal a low level of interest in the role.
✅ **Better answer:** “I know that your company is a leader in cloud-based solutions for the healthcare industry. I was particularly interested to read about your recent launch of the 'HealthVista' platform, and I'm excited by the prospect of working on technologies that have a real-world impact.”
💡 **Tip:** Always research the company before the interview. Spending just 10 minutes on their website's "About Us" or "Products" page makes a huge difference.

---

**Example 3: For a candidate with basic knowledge**

Interviewer: Can you explain what a database is?
You: Umm… it’s like… where data is stored… maybe like Excel sheet?

➡️ **Correction / Feedback:**
💬 **You said:** "maybe like Excel sheet?"
✅ **You’re on the right track!** Relating it to an Excel sheet is a good starting point for an analogy. Let's build on that to make it more technical.
✅ **Better Answer:** “A database is a structured system for storing and managing data so it can be easily accessed and updated. While it shares the concept of storing data with an Excel sheet, it's much more powerful, using systems like MySQL or PostgreSQL to handle large amounts of data with features for querying, security, and integrity.”
💡 **Tip:** When you're unsure, it's good to use a simple analogy, but try to follow it up with at least one technical keyword (like 'table', 'SQL', 'query') to show you have some foundational knowledge.

---
**PERSONALIZED PRACTICE PLAN EXAMPLE**

After providing the summary, add this section.

**Personalized Practice Plan**

Based on your interview, here are a few exercises to help you improve:

1.  **Exercise: The "Elevator Pitch" Rework.**
    *   **Goal:** To answer "Tell me about yourself" confidently and concisely.
    *   **Task:** Write a 3-4 sentence answer that covers your background, 2-3 key skills relevant to the job, and your career goal. Record yourself saying it on your phone until it sounds smooth and natural (aim for under 90 seconds).

2.  **Exercise: Company Knowledge Deep Dive.**
    *   **Goal:** To demonstrate genuine interest and preparation.
    *   **Task:** Before your next interview, spend 15 minutes on the company's website. Find the answers to these three questions: 1) What is their main product/service? 2) Who are their customers? 3) What is a recent company news or achievement? Write down one sentence for each.

---

**NOW, YOUR TASK:**

Analyze the following interview transcript. Provide feedback for EACH of the candidate's answers using the **EXACT SAME FORMAT** as the examples above. Be encouraging but direct.

For each answer, you must:
1.  Start with a "Correction / Feedback" section.
2.  **Quote the specific part of the candidate's answer you are analyzing using 💬.**
3.  Identify the problem (if any) using ❌ or praise good points using ✅.
4.  Suggest a "Better answer".
5.  Provide an actionable "Tip" 💡.

After analyzing all answers, provide a final summary of overall strengths and areas for improvement.

Finally, create a "Personalized Practice Plan" section with 2-3 specific, actionable exercises tailored to the candidate's main weaknesses identified from the transcript.

**INTERVIEW TRANSCRIPT TO ANALYZE:**
${fullTranscript}`;
            
            const response = await ai.models.generateContent({
                model: 'gemini-2.5-pro',
                contents: prompt,
            });
            const feedbackText = response.text;
            setFeedback(feedbackText);

            // Save to history
            const newRecord: InterviewRecord = {
                id: new Date().toISOString(),
                date: new Date().toLocaleString(),
                role,
                topics,
                transcript,
                feedback: feedbackText,
            };
            const updatedHistory = [...history, newRecord];
            setHistory(updatedHistory);
            localStorage.setItem('interviewHistory', JSON.stringify(updatedHistory));

        } catch (err) {
            console.error("Feedback generation error:", err);
            setError("Sorry, there was an error generating your feedback.");
            setFeedback('');
        }
        setAppState('feedback');
    };
    
    const startNewInterview = () => {
        setRole('');
        setTopics('');
        setTranscript([]);
        setFeedback('');
        setError('');
        setVoice('Zephyr');
        setIsMuted(false);
        setAppState('setup');
    }
    
    const viewHistoryItem = (item: InterviewRecord) => {
        setViewedItem(item);
        setAppState('viewing_history_item');
    }

    const renderContent = () => {
        switch (appState) {
            case 'setup':
                return (
                    <section key="setup" className="app-screen">
                        <h2>Interview Setup</h2>
                        <p className="subtitle">Tell us about the role you're applying for.</p>
                        <div className="form-group">
                            <input id="role" type="text" value={role} onChange={e => setRole(e.target.value)} required />
                            <label htmlFor="role">Job Role</label>
                        </div>
                        <div className="form-group">
                             <textarea id="topics" value={topics} onChange={e => setTopics(e.target.value)} required rows={4}></textarea>
                             <label htmlFor="topics">Key Skills / Topics</label>
                        </div>
                         <div className="form-group">
                            <select id="voice" value={voice} onChange={e => setVoice(e.target.value)} required>
                                <option value="Zephyr">Zephyr (Male)</option>
                                <option value="Puck">Puck (Male)</option>
                                <option value="Charon">Charon (Male)</option>
                                <option value="Kore">Kore (Female)</option>
                                <option value="Fenrir">Fenrir (Female)</option>
                            </select>
                             <label htmlFor="voice" className="select-label">Interviewer Voice</label>
                        </div>
                        <button onClick={startInterview} disabled={!role || !topics}>Start Interview</button>
                        {history.length > 0 && (
                            <button onClick={() => setAppState('history')} className="secondary-button">View Interview History</button>
                        )}
                    </section>
                );
            case 'interviewing':
                return (
                     <section key="interviewing" className="app-screen">
                        <h2>Interview in Progress...</h2>
                        <div className="visualizer-container">
                            {isInterviewerSpeaking ? (
                                <div className="interviewer-visualizer" />
                            ) : isUserSpeaking && !isMuted ? (
                                <div className="user-visualizer">
                                    <div className="bar"></div>
                                    <div className="bar"></div>
                                    <div className="bar"></div>
                                    <div className="bar"></div>
                                    <div className="bar"></div>
                                </div>
                            ) : (
                                <div className={`mic-icon ${isMuted ? 'muted' : ''}`}>
                                    {isMuted ? (
                                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.34 3 3 3 .23 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z"></path></svg>
                                    ) : (
                                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.49 6-3.31 6-6.72h-1.7z"></path></svg>
                                    )}
                                </div>
                            )}
                        </div>
                        <div className="transcript-container">
                            {transcript.map((t, i) => (
                                <div key={i} className={`message-bubble ${t.speaker === 'You' ? 'user-message' : 'ai-message'}`}>
                                    <strong>{t.speaker}:</strong> {t.text}
                                </div>
                            ))}
                             <div ref={transcriptEndRef} />
                        </div>
                        <div className="interview-controls">
                            <button onClick={toggleMute} className="control-button" aria-label={isMuted ? 'Unmute microphone' : 'Mute microphone'}>
                                {isMuted ? (
                                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.34 3 3 3 .23 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z"></path></svg>
                                ) : (
                                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.49 6-3.31 6-6.72h-1.7z"></path></svg>
                                )}
                            </button>
                            <button onClick={() => stopInterview(true)} className="danger-button end-interview-button">End Interview & Get Feedback</button>
                        </div>
                    </section>
                );
             case 'generating_feedback':
                return (
                    <section key="generating" className="app-screen">
                        <h2>Generating Your Feedback</h2>
                        <p className="subtitle">Our AI coach is analyzing your performance...</p>
                        <div className="skeleton-loader">
                            <div className="skeleton-line title"></div>
                            <div className="skeleton-line"></div>
                            <div className="skeleton-line short"></div>
                            <div className="skeleton-line title"></div>
                            <div className="skeleton-line"></div>
                            <div className="skeleton-line short"></div>
                             <div className="skeleton-line title"></div>
                            <div className="skeleton-line"></div>
                            <div className="skeleton-line short"></div>
                        </div>
                    </section>
                );
            case 'feedback':
                 return (
                    <section key="feedback" className="app-screen">
                        <h2>Interview Feedback</h2>
                        <div className="feedback-content" dangerouslySetInnerHTML={{ __html: md.render(feedback) }}></div>
                        <button onClick={startNewInterview} style={{marginTop: '2rem'}}>Start New Interview</button>
                    </section>
                );
            case 'history':
                return (
                     <section key="history" className="app-screen">
                        <h2>Interview History</h2>
                         <div className="history-list">
                            {history.slice().reverse().map(item => (
                                <div key={item.id} className="history-item" onClick={() => viewHistoryItem(item)}>
                                    <div className="history-item-role">{item.role}</div>
                                    <div className="history-item-date">{item.date}</div>
                                </div>
                            ))}
                         </div>
                        <button onClick={() => setAppState('setup')} className="secondary-button">Back to Setup</button>
                    </section>
                );
            case 'viewing_history_item':
                if (!viewedItem) return null;
                return (
                    <section key="view-item" className="app-screen">
                        <h2>Review: {viewedItem.role}</h2>
                        <p className="subtitle">{viewedItem.date}</p>
                        <div className="history-details">
                            <div className="details-column">
                                <h3>Transcript</h3>
                                 <div className="transcript-container historic">
                                    {viewedItem.transcript.map((t, i) => (
                                        <div key={i} className={`message-bubble ${t.speaker === 'You' ? 'user-message' : 'ai-message'}`}>
                                            <strong>{t.speaker}:</strong> {t.text}
                                        </div>
                                    ))}
                                </div>
                            </div>
                            <div className="details-column">
                                <h3>Feedback</h3>
                                <div className="feedback-content" dangerouslySetInnerHTML={{ __html: md.render(viewedItem.feedback) }}></div>
                            </div>
                        </div>
                         <button onClick={() => setAppState('history')} className="secondary-button">Back to History</button>
                    </section>
                )
            default:
                return null;
        }
    };

    return (
        <div className="app-wrapper">
        <style>{`
            /* CSS Variables and Base Styles */
            :root {
                --font-family: 'Poppins', sans-serif;
                --gradient-start: #4f46e5;
                --gradient-end: #a855f7;
                --bg-glass: rgba(255, 255, 255, 0.05);
                --border-glass: rgba(255, 255, 255, 0.2);
                --text-primary: #f0f0f0;
                --text-secondary: #a7a7a7;
                --accent-primary: #3b82f6;
                --accent-secondary: #8b5cf6;
                --success: #22c55e;
                --error: #ef4444;
                --shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.37);
                --image-visualizer: url('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAA+gAAAPoAQMAAAB+l3i9AAAABlBMVEX////AAD0IfV0AAAACXBIWXMAAA7EAAAOxAGVKw4bAAADgElEQVR4nO3bS47jMBAF0DCI/ldyKk0QZseeU3CKgEajo1Zl2eF/yCChxmM4xG8eAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPiV3wH8P34AP4fP4ScQf/x/gI/h0/gC/hw+wz/jM7x8fgYfwz/j8/gK/g/8+QE+hv+YvMAf4fP8M3yGz+Fr/Bn+Cl/AL/Bn+Ax/gI/hM/wb/gB/hu/gP+H//98Z/gB/ht/gYPgMfwYfwb/h+Pxx+Ax/gE/gD/A/+AD+DH+An8G/4Y/gT/An8G/4Y/gT+AP8M/wR/Am+BP8Af4T/gT/DP8GfwL/gT/An+DP8Cfwb/gT+DP8GfwL/gD/Dn8C/4U/g3/An8G/4E/wb/gT+DP8EfwL/gD/Dn+BP8Cfwb/gT+DP8GfwL/gD/Bn+BP8C/4U/g3/DP8E/wb/gT+BP8CfwL/gT+DP8Cfwb/gT+DP8Gfwb/hj+BP8EfwJ/gT+AP8M/wJ/hH+AP8M/wJ/hH+AP8M/wZ/gv+BP8C/4E/wb/gn+BP8G/4I/wZ/gv+BP8Efwb/gn+BP8E/wb/gT/A3+CP8C/4E/wJ/hH+DP8EfwL/gT/Bv+BP8Df4Y/gT/An+CP8Gf4I/wZ/gn+BP8Gfwb/gD/Bv+CP8Gf4E/wb/gT/An+BP8E/wb/gv+BP8GfwJ/gT/An+DP8C/4I/wb/gv+DP8G/4I/wb/gn+BP8GfwL/gT/An+DP8G/4I/wb/gT/A3+DP8E/wb/gj/Bv+CP8G/4I/wb/gn+BP8Gfwb/gD/DP8Gf4I/wb/gj/Bv+CP8EfwJ/gD/Bv+DP8Cfwb/gT/Bv+DP8C/4I/wb/gT/A3+CP8EfwJ/gT/Bv+DP8CfwJ/gv+DP8GfwL/gn+DP8GfwL/gT/Bv+DP8GfwL/gT/Bv+DP8E/wJ/gT/An+BP8G/4I/gT/An+CP8EfwJ/gD/Bv+CP8G/4I/wZ/gT/A3+CP8Efwb/gT/An+DP8E/wZ/gv+CP8Gfwb/gD/Bv+CP8E/wZ/gv+BP8CfwL/gT/An+BP8C/4E/wL/gT/An+DP8E/wZ/gv+CP8G/4I/wZ/gn+BP8E/wb/gj/Bv+CP8E/wb/gj/Bn+BP8G/4E/wZ/gT/B3+AP8M/wZ/gj/B3+AP8M/wJ/hH+AP8M/wZ/gT/Bn+DP8E/wL/gT/An+DP8E/wb/gT/An+DP8EfwL/gD/Bn+BP8C/4E/g3/DP8E/wZ/gT/An+BP8CfwJ/gT/An+DP8E/wZ/gn+DP8EfwL/gT/Bv+CP8E/wL/gT/An+BP8C/4I/wb/gT/A3+CP8EfwJ/gn+DP8Gf4M/wZ/gT/An+BP8Cf4I/wZ/gn+CP8G/4I/wZ/gT/A3+BP8Gfwb/gT/An+CP8Gf4M/wJ/gT/An+BP8EfwL/gD/An+BP8Gf4I/wZ/gT/An+BP8G/4I/wZ/gT/A3+CP8Gf4M/wJ/gT/An+BP8E/wZ/gT/Bv+AP8CfwJ/gT/Bv+CP8Gf4M/wJ/gT/An+CP8GfwL/gT/An+BP8Gf4M/wJ/gT/A3+BP8Cf4I/wZ/gT/A3+DP8EfwZ/gT/Bv+BP8CfwZ/gT/An+CP8Gf4M/wJ/gv+CP8Gf4I/wZ/gn+DP8Gf4M/wZ/gv+BP8Gf4M/wZ/gD/An+DP8Gf4I/wb/gj/Bn+BP8G/4I/wZ/gv+BP8Gf4E/wb/gj/Bv+CP8GfwL/gD/Bn+BP8Gf4I/wZ/gj/Bv+BP8GfwJ/gv+BP8Gf4I/wZ/gv+CP8Gf4M/wb/gv+BP8Gf4M/wZ/gT/An+BP8Gf4M/wb/gn+BP8Gf4I/wZ/gn+BP8Gf4I/wZ/gT/An+BP8Gf4E/wb/gT/An+DP8E/wb/gj/Bn+CP8G/4I/wb/gn+BP8E/wL/gD/Bv+BP8EfwJ/gT/A3+BP8E/wJ/gn+BP8Gfwb/gD/Bv+CP8GfwL/gT/An+BP8G/4M/wZ/gT/Bv+BP8E/wZ/gn+BP8G/4M/wZ/gn+BP8G/4I/wZ/gT/An+BP8Gf4E/wb/gT/An+BP8GfwJ/gn+BP8GfwL/gT/Bv+DP8EfwZ/gT/A3+BP8EfwJ/gn+DP8EfwZ/gT/An+BP8G/4I/wZ/gj/Bv+CP8Gf4M/wb/gT/An+BP8Gf4M/wZ/gT/A3+DP8EfwZ/gT/An+BP8EfwJ/gD/Bv+BP8Cfwb/gj/Bv+CP8GfwJ/gT/A3+CP8E/wJ/gT/Bv+BP8CfwJ/gn+BP8EfwZ/gn+CP8Gfwb/gT/Bv+CP8Gf4M/wZ/gn+DP8E/wJ/gv+CP8G/4M/wb/gn+DP8G/4M/wZ/gT/Bv+BP8C/4I/wZ/gv+BP8G/4I/wb/gn+BP8E/wb/gj/Bv+CP8GfwJ/gT/A3+CP8Gfwb/gj/Bv+CP8GfwJ/gT/An+DP8E/wJ/gn+DP8GfwL/gT/Bv+DP8EfwZ/gT/An+BP8GfwL/gv+DP8G/4M/wZ/gT/Bv+CP8E/wb/gT/Bv+BP8E/wb/gT/B3+AP8M/wZ/gj/B3+AP8M/wb/gT/Bv+CP8G/4I/wZ/gT/An+CP8Gfwb/gT/A3+CP8G/4I/wZ/gT/A3+CP8Gf4I/wZ/gT/A3+AP8Of4E/wb/gn+DP8Gf4I/wb/gT/An+CP8Gfwb/gT/B3+BP8Efwb/gT/B3+AP8M/wZ/gT/Bn+DP8Gf4M/wZ/gv+CP8E/wZ/gT/An+DP8EfwJ/gv+DP8Gf4I/wZ/gT/Bv+BP8Gf4I/wZ/gv+CP8Gf4I/wb/gT/B3+CP8Gf4M/wb/gT/B3+DP8EfwJ/gT/An+CP8EfwJ/gv+BP8GfwL/gD/An+CP8EfwJ/gn+BP8EfwJ/gv+CP8G/4I/wZ/gv+BP8E/wZ/gv+BP8E/wb/gj/Bv+CP8E/wb/gT/Bv+BP8G/4E/wZ/gT/An+DP8GfwL/gD/Bv+CP8EfwL/gT/An+CP8E/wb/gT/Bv+CP8E/wZ/gT/A3+DP8E/wZ/gT/A3+BP8EfwZ/gT/An+BP8Gf4I/wZ/gv+BP8G/4I/wb/gn+DP8E/wJ/gv+BP8EfwZ/gT/Bv+BP8G/4I/wZ/gT/Bv+BP8E/wZ/gv+BP8Gf4I/wb/gT/Bv+AP8C/4I/wZ/gj/Bv+AP8EfwJ/gv+DP8G/4I/wZ/gT/Bv+BP8Gf4I/wZ/gn+BP8E/wb/gT/Bv+BP8Gf4E/wb/gT/Bv+CP8Gf4E/wJ/gn+BP8Gf4I/wb/gn+BP8Gf4I/wZ/gT/A3+BP8E/wZ/gT/A3+BP8EfwZ/gj/Bv+BP8Efwb/gT/B3+DP8E/wZ/gT/A3+BP8EfwZ/gn+BP8G/4I/wZ/gn+DP8G/4M/wZ/gT/B3+BP8Gf4M/wb/gn+DP8GfwL/gn+DP8E/wZ/gT/B3+DP8Gf4M/wZ/gT/Bv+BP8EfwZ/gT/A3+BP8E/wJ/gn+BP8G/4I/wZ/gv+BP8E/wZ/gT/An+DP8E/wb/gj/Bv+BP8Gf4E/wZ/gT/A3+CP8Efwb/gT/An+DP8E/wZ/gv+BP8E/wZ/gj/Bn+BP8G/4I/wZ/gn+DP8Gfwb/gT/An+DP8E/wb/gT/An+DP8EfwL/gT/Bv+BP8EfwL/gD/Bv+BP8G/4I/wb/gj/Bv+AP8E/wb/gj/Bv+CP8Gf4I/wb/gn+DP8GfwJ/gv+CP8GfwL/gT/Bv+BP8G/4I/wZ/gv+CP8E/wb/gT/A3+CP8E/wZ/gT/A3+BP8EfwZ/gj/Bn+BP8Gfwb/gT/An+BP8E/wZ/gn+BP8EfwZ/gT/An+BP8GfwJ/gn+BP8E/wZ/gD/Bn+BP8Cf4E/wb/gT/An+BP8G/4I/wZ/gT/A3+BP8EfwZ/gT/An+BP8EfwL/gn+CP8Gfwb/gT/An+BP8E/wb/gj/Bn+BP8GfwJ/gT/An+DP8Cf4I/wZ/gj/Bv+AP8Efwb/gj/Bn+CP8Gf4E/wZ/gT/A3+DP8E/wZ/gn+BP8E/wZ/gj/Bv+BP8E/wZ/gn+BP8EfwL/gT/Bv+BP8EfwZ/gn+BP8E/wZ/gj/Bn+BP8Cf4I/wb/gT/A3+CP8Efwb/gT/A3+CP8EfwZ/gn+BP8EfwZ/gT/A3+BP8Gf4E/wb/gD/An+BP8G/4I/wb/gT/A3+CP8Gf4I/wZ/gT/A3+BP8E/wZ/gT/An+BP8Gf4I/wZ/gT/A3+CP8Gf4M/wZ/gn+BP8Cf4E/wZ/gT/An+DP8EfwJ/gn+BP8Cf4E/wZ/gj/Bv+AP8M/wJ/hH+AP8M/wZ/gn+BP8CfwL/gT/An+DP8EfwZ/gT/An+BP8Efwb/gT/B3+AP8M/wJ/hH+AP8Of4I/wb/gD/Bn+BP8Cf4E/wJ/gT/An+BP8E/wL/gT/An+BP8Gf4I/wZ/gT/Bv+CP8Gf4I/wZ/gT/Bv+AP8Of4E/wJ/gT/A3+BP8E/wb/gT/An+BP8Gf4E/wZ/gn+BP8Cfwb/gT/An+CP8Gf4E/wJ/gn+CP8Gf4M/wZ/gT/B3+AP8G/4E/wL/gT/An+BP8Gf4I/wZ/gn+DP8Cf4E/wZ/gn+BP8Gf4I/wZ/gv+DP8Gf4M/wZ/gn+DP8CfwJ/gn+BP8E/wb/gT/An+BP8Cf4I/wZ/gj/Bv+BP8GfwL/gT/An+CP8Gf4I/wZ/gn+DP8G/4E/wZ/gv+DP8GfwJ/gv+DP8GfwZ/gT/An+CP8Gfwb/gT/A3+BP8Gfwb/gT/A3+CP8E/wL/gT/An+DP8E/wZ/gv+BP8CfwJ/gv+BP8Gf4I/wZ/gv+BP8Cf4M/wZ/gn+BP8E/wZ/gT/Bv+CP8Gf4I/wZ/gv+BP8Cf4M/wJ/gT/An+CP8E/wZ/gT/A3+AP8EfwJ/gv+CP8G/4M/wZ/gn+BP8EfwZ/gT/Bv+AP8EfwJ/gv+BP8Gf4I/wb/gj/Bv+BP8Cf4I/wZ/gn+BP8EfwZ/gT/An+CP8G/4M/wb/gn+BP8GfwL/gv+CP8EfwZ/gT/Bv+CP8G/4I/wZ/gT/B3+DP8E/wZ/gT/B3+CP8Gf4I/wb/gn+DP8Gf4E/wZ/gT/Bv+BP8EfwL/gT/A3+BP8EfwZ/gn+CP8GfwL/gT/An+DP8E/wZ/gv+BP8E/wZ/gn+BP8Cf4I/wZ/gv+BP8EfwL/gD/Bn+CP8G/4I/wZ/gT/An+CP8G/4E/wZ/gn+BP8Cf4M/wZ/gv+BP8EfwJ/gv+CP8GfwJ/gv+AP8M/wZ/gn+BP8Gfwb/gj/Bv+CP8GfwL/gD/Bn+BP8EfwZ/gT/An+DP8Gf4M/wb/gT/A3+DP8Efwb/gn+BP8Cf4M/wZ/gn+BP8EfwJ/gn+CP8Gfwb/gn+BP8Cf4I/wZ/gv+BP8GfwJ/gn+AP8Of4E/wZ/gT/A3+DP8GfwZ/gT/A3+DP8E/wZ/gT/An+DP8Gfwb/gT/An+BP8G/4M/wJ/gT/An+DP8EfwJ/gn+BP8EfwL/gT/An+BP8Gf4E/wZ/gj/Bv+BP8Gfwb/gT/A3+CP8EfwZ/gj/Bv+BP8Gf4E/wb/gT/A3+CP8Gf4M/wb/gj/Bv+BP8EfwZ/gT/A3+AP8M/wZ/gj/Bn+BP8G/4M/wZ/gn+BP8Cf4E/wZ/gn+BP8Gf4I/wb/gT/Bv+BP8Gf4M/wJ/gv+CP8Gf4I/wb/gn+BP8Cf4I/wb/gT/A3+CP8E/wZ/gn+CP8G/4I/wb/gv+BP8Gf4M/wJ/gn+BP8Gf4E/wb/gD/An+BP8G/4I/wZ/gT/A3+BP8EfwZ/gn+BP8EfwZ/gT/An+DP8E/wZ/gn+BP8G/4I/wb/gv+DP8E/wZ/gT/An+BP8E/wL/gv+CP8E/wb/gT/Bv+BP8GfwJ/gT/An+CP8Efwb/gj/Bv+BP8G/4E/wZ/gv+BP8GfwJ/gn+BP8E/wZ/gv+BP8Gf4M/wZ/gn+DP8Gf4I/wZ/gn+DP8Cf4I/wZ/gj/Bv+BP8E/wZ/gn+BP8Cf4M/wZ/gv+BP8E/wZ/gD/Bn+BP8Cf4M/wZ/gT/An+CP8Efwb/gj/Bv+AP8CfwJ/gn+BP8GfwJ/gv+DP8E/wZ/gj/Bv+BP8CfwJ/gn+CP8G/4I/wb/gT/A3+AP8E/wb/gT/An+CP8E/wb/gD/An+CP8GfwL/gT/An+CP8E/wb/gT/Bv+BP8Gf4I/wZ/gn+BP8EfwZ/gT/A3+BP8Cf4E/wZ/gT/A3+CP8EfwZ/gT/An+CP8EfwL/gT/An+BP8E/wb/gT/An+BP8E/wZ/gj/Bv+BP8GfwL/gT/An+DP8EfwZ/gj/Bv+AP8M/wJ/hH+AP8M/wZ/gn+CP8E/wL/gT/Bv+CP8GfwL/gD/Bv+CP8Gfwb/gT/An+BP8EfwJ/gv+BP8Efwb/gT/An+DP8EfwL/gT/Bv+BP8Cf4E/wL/gT/A3+AP8M/wZ/gj/Bn+DP8Gf4M/wZ/gv+CP8E/wZ/gT/A3+CP8Gfwb/gT/A3+BP8Efwb/gT/Bv+BP8Gf4M/wZ/gn+BP8G/4I/wZ/gv+BP8Gf4I/wZ/gn+DP8Cfwb/gj/Bv+BP8GfwJ/gv+BP8GfwJ/gv+BP8E/wZ/gT/A3+CP8E/wZ/gv+BP8G/4E/wL/gT/An+CP8GfwJ/gv+BP8G/4I/wZ/gT/An+CP8E/wZ/gv+BP8C/4I/wZ/gT/A3+DP8E/wZ/gT/Bv+CP8EfwJ/gT/A3+BP8Cf4E/wZ/gT/A3+BP8E/wZ/gn+BP8Cfwb/gn+BP8E/wZ/gn+BP8Efwb/gn+DP8GfwJ/gn+BP8Efwb/gT/B3+AP8G/4I/wb/gT/B3+CP8G/4I/wZ/gT/A3+AP8M/wZ/gj/Bv+CP8G/4M/wZ/gn+BP8Efwb/gD/Bn+BP8Cf4M/wZ/gT/Bv+BP8E/wZ/gn+BP8E/wZ/gn+DP8G/4I/wZ/gj/Bn+BP8G/4E/wL/gT/A3+CP8EfwZ/gT/A3+CP8G/4I/wZ/gv+BP8Cf4I/wZ/gv+BP8GfwL/gn+CP8EfwZ/gT/An+CP8E/wL/gv+CP8E/wZ/gv+BP8GfwJ/gT/Bv+DP8G/4I/wZ/gn+BP8E/wZ/gv+CP8E/wZ/gT/An+DP8E/wb/gT/Bv+DP8EfwJ/gv+BP8G/4M/wZ/gn+BP8Cf4E/wZ/gv+CP8E/wZ/gT/B3+CP8Gf4M/wZ/gT/A3+CP8Gf4I/wZ/gv+DP8Gf4E/wZ/gT/Bv+BP8GfwL/gv+CP8E/wZ/gv+CP8E/wZ/gT/A3+DP8E/wZ/gT/A3+DP8E/wZ/gv+BP8E/wZ/gn+BP8Gfwb/gj/Bn+BP8Gf4M/wZ/gT/Bv+CP8E/wZ/gj/Bv+BP8GfwL/gT/A3+CP8GfwL/gv+CP8E/wZ/gj/Bn+CP8E/wL/gT/A3+CP8E/wZ/gT/An+CP8E/wZ/gT/Bv+AP8E/wZ/gv+BP8Gf4I/wZ/gv+CP8E/wZ/gD/Bn+BP8Cf4M/wZ/gT/A3+CP8EfwZ/gv+BP8GfwZ/gT/An+BP8EfwZ/gv+BP8Cf4I/wZ/gv+BP8E/wb/gT/A3+CP8E/wZ/gT/An+CP8EfwL/gv+BP8E/wL/gv+DP8EfwZ/gT/An+DP8Gfwb/gT/Bv+CP8Gfwb/gT/A3+CP8E/wZ/gD/Bv+CP8GfwL/gT/An+DP8Efwb/gT/A3+CP8EfwZ/gv+BP8E/wb/gT/An+CP8E/wZ/gT/An+CP8EfwZ/gT/Bv+CP8Efwb/gT/An+DP8E/wZ/gv+BP8E/wb/gT/An+CP8Gfwb/gj/Bv+CP8Gfwb/gn+BP8E/wb/gT/An+DP8E/wZ/gj/Bv+AP8CfwJ/gv+CP8EfwZ/gv+BP8Efwb/gn+BP8Efwb/gT/Bv+CP8E/wb/gT/An+DP8E/wZ/gT/Bv+CP8Efwb/gT/A3+CP8E/wb/gn+BP8Cf4I/wZ/gj/Bv+AP8CfwJ/gn+BP8EfwZ/gv+BP8E/wZ/gn+BP8E/wb/gn+BP8E/wb/gT/A3+BP8Efwb/gn+BP8E/wb/gn+BP8Efwb/gn+BP8Efwb/gj/Bv+BP8E/wZ/gn+BP8Cf4I/wZ/gj/Bv+CP8Gf4E/wZ/gv+BP8EfwZ/gD/Bn+CP8E/wZ/gT/A3+DP8E/wb/gn+BP8E/wb/gj/Bn+CP8E/wZ/gn+BP8E/wZ/gv+BP8E/wb/gT/An+CP8E/wb/gT/Bv+CP8Efwb/gn+BP8Efwb/gT/An+DP8Efwb/gD/An+BP8EfwJ/gn+DP8E/wb/gn+BP8E/wZ/gn+BP8GfwL/gT/An+DP8E/wZ/gT/A3+CP8E/wb/gT/An+DP8E/wZ/gn+BP8Cf4I/wZ/gv+CP8EfwL/gv+BP8E/wZ/gn+DP8E/wZ/gD/Bn+BP8Efwb/gT/An+CP8E/wb/gT/A3+CP8E/wZ/gv+BP8Cf4M/wb/gT/An+CP8EfwL/gv+BP8Cf4M/wZ/gT/An+BP8E/wb/gT/An+DP8Efwb/gT/An+DP8EfwJ/gv+CP8E/wZ/gD/An+BP8E/wZ/gT/A3+CP8E/wZ/gn+BP8Efwb/gj/Bv+AP8E/wb/gT/A3+CP8E/wZ/gv+BP8E/wZ/gn+BP8EfwL/gv+BP8G/4M/wZ/gn+BP8E/wL/gv+BP8Cf4I/wZ/gv+BP8E/wb/gT/A3+CP8E/wb/gj/Bv+AP8C/4M/wZ/gn+BP8EfwZ/gn+BP8E/wZ/gn+BP8E/wb/gn+BP8E/wZ/gn+BP8EfwZ/gv+BP8G/4E/wZ/gv+BP8Cf4M/wZ/gv+BP8E/wb/gn+BP8E/wb/gj/Bv+CP8E/wZ/gn+BP8Cf4I/wb/gv+BP8E/wb/gj/Bv+CP8E/wb/gT/Bv+CP8E/wZ/gT/An+CP8E/wZ/gT/An+CP8E/wZ/gT/Bv+CP8E/wZ/gT/A3+CP8E/wZ/gT/An+DP8EfwZ/gT/An+CP8E/wZ/gv+DP8Cf4I/wZ/gv+CP8E/wZ/gv+BP8E/wb/gT/An+DP8E/wb/gT/Bv+CP8E/wZ/gv+BP8E/wb/gT/Bv+CP8E/wZ/gT/A3+CP8E/wZ/gn+CP8E/wb/gT/A3+DP8E/wb/gT/An+DP8E/wZ/gn+BP8E/wb/gT/A3+DP8E/wb/gj/Bv+CP8E/wZ/gn+BP8Efwb/gD/Bv+BP8EfwJ/gv+DP8E/wb/gT/An+CP8EfwL/gv+BP8E/wb/gT/A3+CP8E/wZ/gn+CP8E/wZ/gT/A3+DP8E/wb/gT/An+CP8Efwb/gT/A3+BP8Efwb/gT/A3+CP8E/wZ/gv+DP8Cf4E/wb/gn+CP8G/4M/wJ/gv+BP8G/4I/wb/gT/A3+DP8E/wZ/gT/An+DP8Efwb/gT/A3+CP8E/wZ/gv+CP8E/wZ/gT/A3+CP8E/wL/gT/An+DP8EfwZ/gD/Bv+BP8E/wZ/gT/A3+DP8Cf4M/wb/gT/An+DP8EfwJ/gv+DP8E/wb/gn+BP8E/wZ/gn+BP8G/4M/wb/gj/Bv+CP8G/4E/wL/gT/A3+CP8E/wZ/gT/An+DP8E/wL/gT/An+DP8E/wZ/gn+CP8E/wZ/gT/An+BP8E/wZ/gj/Bv+AP8M/wZ/gn+BP8Gf4M/wZ/gn+BP8EfwJ/gv+BP8Gf4M/wZ/gj/Bv+BP8EfwZ/gj/Bv+BP8E/wZ/gn+BP8E/wb/gn+BP8E/wZ/gn+BP8Cf4M/wZ/gv+BP8GfwL/gv+DP8E/wZ/gn+BP8Cf4I/wb/gT/A3+DP8E/wZ/gv+CP8E/wL/gT/A3+DP8EfwL/gv+BP8Gf4I/wZ/gD/Bv+CP8E/wZ/gT/An+DP8Cf4I/wZ/gT/A3+DP8E/wZ/gn+CP8E/wZ/gD/Bv+BP8E/wZ/gn+BP8Cf4I/wZ/gT/Bv+CP8EfwL/gv+BP8E/wZ/gn+BP8E/wZ/gT/A3+DP8E/wZ/gn+DP8Cf4I/wZ/gn+BP8EfwJ/gv+DP8E/wb/gT/An+DP8E/wZ/gT/An+DP8E/wZ/gT/A3+DP8E/wZ/gn+BP8Cf4I/wZ/gj/Bv+AP8C/4E/wb/gn+BP8Gfwb/gj/Bv+BP8E/wZ/gn+BP8E/wb/gn+BP8E/wb/gj/Bn+BP8E/wb/gn+BP8E/wZ/gv+BP8Cf4I/wZ/gj/Bv+CP8Gf4I/wb/gn+BP8E/wb/gT/A3+DP8E/wZ/gT/An+DP8E/wZ/gn+BP8E/wb/gj/Bn+BP8E/wZ/gv+BP8E/wb/gn+BP8EfwZ/gj/Bn+BP8E/wZ/gn+BP8Cf4I/wZ/gv+BP8E/wZ/gv+CP8E/wZ/gv+BP8E/wZ/gv+DP8Gf4E/wZ/gT/An+DP8EfwZ/gj/Bv+BP8Gf4I/wZ/gn+BP8Cf4E/wZ/gj/Bv+BP8EfwJ/gv+CP8EfwZ/gT/A3+DP8E/wZ/gn+BP8E/wZ/gv+DP8E/wb/gn+CP8EfwZ/gT/Bv+BP8E/wZ/gn+BP8E/wZ/gT/A3+DP8E/wZ/gn+DP8Efwb/gT/Bv+CP8EfwL/gT/An+DP8Efwb/gj/Bv+AP8M/wZ/gv+BP8G/4M/wZ/gv+BP8E/wZ/gv+BP8Cf4M/wZ/gj/Bv+AP8E/wZ/gv+BP8G/4I/wZ/gT/A3+CP8E/wZ/gT/An+CP8EfwZ/gv+BP8G/4I/wb/gv+BP8Gf4I/wZ/gT/An+CP8E/wb/gT/An+DP8E/wL/gT/An+BP8EfwZ/gn+BP8Cf4I/wZ/gj/Bv+CP8E/wZ/gv+BP8Cf4I/wZ/gT/An+DP8EfwZ/gT/A3+BP8Cf4I/wZ/gv+BP8E/wZ/gv+BP8G/4I/wb/gT/A3+CP8E/wZ/gn+BP8E/wL/gT/An+DP8E/wZ/gn+BP8E/wb/gT/An+BP8EfwJ/gv+CP8EfwZ/gD/Bn+BP8Cf4M/wb/gn+BP8Cf4M/wZ/gv+BP8Gfwb/gn+CP8EfwZ/gT/An+BP8G/4M/wb/gj/Bv+BP8EfwZ/gn+BP8Cf4I/wZ/gv+BP8G/4I/wZ/gn+CP8EfwZ/gn+BP8EfwJ/gv+BP8GfwL/gv+CP8E/wZ/gj/Bv+CP8E/wZ/gn+BP8EfwJ/gv+CP8E/wZ/gn+BP8Cf4I/wZ/gn+BP8EfwZ/gT/An+BP8EfwL/gT/A3+DP8E/wZ/gD/Bv+CP8E/wZ/gn+BP8Cf4M/wZ/gn+BP8Efwb/gT/A3+DP8E/wZ/gv+BP8G/4M/wZ/gn+BP8E/wZ/gT/A3+DP8E/wZ/gv+BP8G/4I/wb/gT/A3+DP8E/wZ/gn+BP8Cf4I/wb/gT/An+DP8EfwZ/gT/A3+DP8E/wZ/gv+BP8E/wZ/gv+DP8EfwL/gT/Bv+DP8G/4I/wZ/gv+BP8G/4I/wZ/gv+BP8GfwL/gT/An+BP8G/4I/wZ/gT/An+CP8E/wL/gT/A3+CP8E/wZ/gv+BP8GfwJ/gv+BP8Cf4I/wZ/gT/A3+CP8E/wL/gT/An+DP8E/wL/gT/An+CP8E/wb/gT/An+BP8EfwZ/gn+BP8E/wZ/gn+BP8Cf4M/wZ/gn+BP8G/4I/wZ/gj/Bv+BP8Gfwb/gn+BP8Cf4I/wZ/gv+BP8E/wL/gT/An+CP8EfwJ/gv+DP8Cf4E/wZ/gj/Bv+BP8EfwL/gT/An+CP8G/4E/wZ/gD/Bn+BP8E/wZ/gT/An+BP8Cf4M/wZ/gT/An+DP8E/wb/gT/An+DP8E/wb/gT/An+BP8EfwZ/gT/An+CP8Efwb/gT/A3+CP8E/wb/gT/An+CP8Cf4E/wb/gT/A3+CP8Efwb/gT/A3+CP8E/wZ/gv+BP8Cf4E/wL/gT/A3+DP8E/wb/gD/Bv+CP8Efwb/gj/Bv+CP8E/wZ/gT/Bv+BP8E/wb/gT/A3+CP8EfwZ/gT/An+BP8Efwb/gT/An+DP8Efwb/gT/Bv+CP8EfwJ/gv+BP8E/wb/gT/An+CP8E/wL/gT/An+DP8E/wb/gT/Bv+CP8Efwb/gT/Bv+CP8E/wZ/gT/An+BP8E/wZ/gT/A3+BP8E/wZ/gT/An+DP8E/wZ/gT/A3+AP8M/wZ/gj/Bn+CP8EfwZ/gv+BP8E/wL/gT/Bv+BP8E/wL/gT/A3+CP8E/wZ/gv+BP8Gfwb/gT/A3+CP8EfwJ/gv+BP8E/wZ/gv+BP8Cf4I/wb/gv+BP8E/wZ/gT/An+BP8G/4E/wb/gv+BP8GfwJ/gv+BP8E/wZ/gv+CP8E/wb/gv+BP8GfwJ/gv+BP8E/wZ/gv+BP8Gfwb/gT/Bv+AP8M/wJ/hH+AP8M/wJ/gv+BP8Gfwb/gT/A3+DP8E/wZ/gv+BP8Gfwb/gT/A3+BP8E/wb/gT/Bv+CP8E/wL/gT/An+DP8E/wb/gT/Bv+CP8E/wZ/gT/A3+CP8E/wZ/gn+BP8E/wb/gj/Bv+CP8G/4I/wZ/gv+CP8E/wZ/gv+BP8E/wb/gT/Bv+CP8E/wZ/gT/An+BP8E/wZ/gT/A3+DP8E/wZ/gn+BP8Gfwb/gT/A3+CP8E/wZ/gT/An+DP8E/wb/gj/Bv+CP8E/wL/gT/A3+DP8E/wZ/gn+BP8Gf4M/wZ/gn+DP8Cf4I/wZ/gv+BP8E/wZ/gn+BP8Gf4E/wZ/gT/An+DP8E/wZ/gv+BP8GfwL/gT/An+DP8E/wZ/gn+BP8Efwb/gj/Bn+BP8G/4M/wZ/gT/An+CP8G/4E/wZ/gv+BP8Efwb/gT/A3+DP8E/wZ/gT/An+DP8E/wb/gn+BP8Efwb/gT/An+BP8G/4I/wZ/gv+BP8E/wZ/gn+BP8G/4I/wZ/gj/Bv+CP8E/wZ/gn+BP8Cf4M/wZ/gn+BP8E/wb/gn+BP8E/wb/gj/Bv+BP8E/wZ/gv+BP8E/wZ/gn+BP8Cf4M/wZ/gn+DP8Efwb/gT/An+BP8Cf4I/wZ/gn+BP8E/wb/gT/An+BP8Cf4M/wb/gT/An+DP8E/wL/gv+BP8EfwJ/gv+BP8E/wZ/gv+BP8G/4I/wZ/gT/An+BP8E/wZ/gv+CP8E/wL/gT/An+DP8E/wb/gT/Bv+BP8EfwJ/gv+BP8E/wb/gj/Bv+AP8CfwJ/gv+CP8EfwZ/gv+BP8E/wZ/gv+BP8E/wb/gj/Bv+AP8E/wb/gn+BP8Gfwb/gn+BP8E/wZ/gn+BP8E/wb/gT/A3+BP8E/wZ/gT/An+CP8E/wZ/gn+BP8Cf4I/wZ/gv+BP8E/wZ/gn+BP8Gf4E/wZ/gv+BP8E/wL/gv+CP8E/wZ/gn+BP8Gf4I/wZ/gD/Bv+CP8E/wZ/gT/A3+BP8EfwZ/gT/An+DP8E/wZ/gT/A3+BP8EfwZ/gv+BP8Cf4M/wb/gT/A3+BP8E/wZ/gn+BP8Gfwb/gD/Bn+BP8E/wZ/gn+BP8Cf4I/wZ/gj/Bv+BP8E/wb/gj/Bv+AP8E/wZ/gv+BP8E/wZ/gv+BP8Cf4I/wZ/gv+BP8Cf4I/wZ/gT/A3+BP8E/wL/gT/An+DP8E/wZ/gT/An+CP8EfwJ/gn+BP8Gfwb/gn+BP8Cf4I/wZ/gj/Bv+BP8EfwJ/gv+DP8E/wb/gn+BP8GfwL/gT/An+DP8EfwZ/gT/Bv+DP8E/wZ/gj/Bv+DP8EfwZ/gD/Bv+CP8E/wZ/gT/An+DP8E/wb/gj/Bn+BP8Cf4M/wb/gT/Bv+DP8E/wL/gT/A3+DP8E/wZ/gT/A3+CP8E/wZ/gD/An+BP8E/wZ/gn+BP8Cf4M/wZ/gn+BP8Cf4I/wZ/gn+BP8E/wZ/gv+BP8EfwL/gv+BP8GfwZ/gT/An+DP8E/wZ/gj/Bv+CP8EfwZ/gT/An+DP8E/wZ/gT/A3+DP8E/wb/gj/Bv+CP8GfwZ/gT/A3+DP8E/wb/gj/Bv+CP8GfwZ/gv+BP8G/4M/wZ/gv+CP8G/4I/wZ/gT/A3+DP8E/wb/gT/Bv+CP8E/wZ/gT/An+DP8E/wZ/gn+CP8EfwZ/gv+DP8Gf4M/wJ/gv+CP8EfwZ/gT/A3+DP8E/wZ/gv+BP8Gf4I/wZ/gn+BP8GfwZ/gv+DP8Cf4E/wb/gj/Bv+BP8EfwJ/gv+BP8Gf4I/wb/gn+CP8G/4M/wZ/gv+BP8EfwJ/gv+BP8Gf4I/wb/gD/Bn+BP8E/wZ/gj/Bv+CP8Efwb/gT/Bv+CP8E/wL/gT/Bv+CP8E/wZ/gT/An+CP8E/wJ/gv+CP8EfwL/gD/An+BP8E/wL/gT/A3+DP8E/wb/gT/A3+CP8EfwZ/gT/An+DP8E/wZ/gT/An+BP8E/wZ/gn+BP8E/wZ/gv+BP8EfwL/gT/An+CP8EfwL/gT/A3+BP8Efwb/gT/A3+CP8E/wZ/gv+BP8G/4M/wZ/gn+BP8E/wZ/gT/An+CP8Efwb/gj/Bv+CP8E/wb/gT/A3+CP8E/wZ/gn+BP8EfwZ/gv+BP8E/wb/gT/A3+CP8E/wZ/gT/An+CP8E/wZ/gT/A3+DP8E/wZ/gn+BP8EfwZ/gv+BP8Efwb/gT/A3+DP8E/wL/gT/An+CP8E/wL/gT/An+DP8E/wb/gT/An+DP8E/wZ/gT/A3+DP8E/wb/gT/Bv+BP8E/wb/gT/Bv+AP8M/wZ/gv+BP8Gf4I/wZ/gv+BP8E/wZ/gv+CP8EfwZ/gT/Bv+CP8E/wZ/gn+BP8EfwZ/gv+BP8E/wZ/gn+DP8E/wZ/gn+CP8EfwZ/gT/A3+DP8E/wZ/gn+CP8E/wZ/gT/An+CP8E/wb/gT/A3+DP8E/wb/gT/Bv+AP8E/wZ/gv+BP8E/wZ/gT/An+CP8E/wb/gT/An+DP8E/wL/gv+BP8E/wL/gT/An+DP8EfwZ/gD/Bv+BP8E/wb/gj/Bv+CP8E/wb/gT/A3+BP8EfwZ/gn+BP8EfwL/gv+CP8EfwZ/gv+BP8Cf4I/wZ/gv+BP8Cf4I/wZ/gv+DP8GfwZ/gD/An+BP8E/wL/gT/An+DP8EfwZ/gT/Bv+CP8E/wb/gT/A3+BP8E/wZ/gT/An+CP8EfwL/gv+BP8G/4E/wZ/gn+BP8Cf4I/wb/gT/A3+CP8E/wb/gT/An+DP8EfwL/gv+BP8Gfwb/gn+BP8E/wZ/gv+CP8EfwZ/gv+BP8GfwL/gv+BP8Gfwb/gn+BP8E/wL/gv+BP8GfwZ/gD/An+CP8E/wL/gv+DP8Cf4E/wZ/gD/An+BP8Cf4M/wb/gn+BP8E/wZ/gj/Bv+CP8Efwb/gT/An+DP8E/wZ/gT/Bv+CP8E/wb/gT/An+CP8EfwJ/gv+DP8Cf4E/wZ/gj/Bv+CP8EfwJ/gv+DP8EfwL/gv+BP8EfwZ/gn+CP8EfwZ/gT/An+DP8E/wZ/gn+CP8EfwZ/gT/An+DP8Efwb/gn+BP8GfwJ/gv+BP8Cf4M/wZ/gT/An+DP8Efwb/gn+BP8Cf4M/wZ/gj/Bv+AP8Of4E/wZ/gT/Bv+CP8E/wZ/gn+BP8E/wZ/gT/An+CP8EfwJ/gv+DP8Cf4E/wZ/gv+BP8Cf4E/wZ/gj/Bv+AP8M/wJ/hH+AP8M/wZ/gv+BP8E/wZ/gn+CP8EfwZ/gT/An+DP8E/wb/gT/Bv+CP8E/wZ/gT/An+DP8Efwb/gT/An+DP8Efwb/gT/An+DP8Efwb/gn+BP8EfwZ/gv+BP8GfwZ/gn+BP8G/4E/wL/gT/An+DP8E/wZ/gn+CP8Efwb/gT/Bv+CP8E/wZ/gT/An+CP8E/wZ/gv+BP8Cf4E/wZ/gn+BP8EfwL/gT/An+CP8E/wZ/gT/An+DP8EfwJ/gv+BP8G/4E/wZ/gn+BP8Cf4E/wZ/gj/Bn+AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPCZ/wD4W/L0Tf+nLAAAAABJRU5ErkJggg==');
                --bg-pattern: radial-gradient(circle, rgba(255,255,255,0.05) 1px, transparent 1px);
                background-size: 2rem 2rem;
            }

            *, *::before, *::after {
                box-sizing: border-box;
                margin: 0;
                padding: 0;
            }

            html {
                font-size: 16px;
            }

            body {
                font-family: var(--font-family);
                color: var(--text-primary);
                background-color: #111827;
                background-image: linear-gradient(135deg, var(--gradient-start) 0%, var(--gradient-end) 100%);
                background-attachment: fixed;
                display: flex;
                justify-content: center;
                align-items: center;
                min-height: 100vh;
                overflow-x: hidden;
            }

            #root {
                width: 100%;
                height: 100%;
                display: flex;
                justify-content: center;
                align-items: center;
            }

            .app-wrapper {
                width: 100%;
                max-width: 900px;
                min-height: 90vh;
                margin: 2rem;
                background: var(--bg-glass);
                backdrop-filter: blur(20px);
                border-radius: 20px;
                border: 1px solid var(--border-glass);
                box-shadow: var(--shadow);
                display: flex;
                flex-direction: column;
                overflow: hidden;
                position: relative;
            }
            
            .app-wrapper::before {
                content: '';
                position: absolute;
                top: 0; left: 0;
                width: 100%;
                height: 100%;
                background-image: var(--bg-pattern);
                opacity: 0.5;
                z-index: -1;
            }

            .app-screen {
                padding: 2.5rem;
                flex-grow: 1;
                display: flex;
                flex-direction: column;
                animation: fadeIn 0.5s ease-in-out;
            }
            
             @keyframes fadeIn {
                from { opacity: 0; transform: translateY(10px); }
                to { opacity: 1; transform: translateY(0); }
            }

            h2 {
                font-size: 2.5rem;
                font-weight: 700;
                text-align: center;
                margin-bottom: 0.5rem;
                background: linear-gradient(90deg, #fff, #a7a7a7);
                -webkit-background-clip: text;
                -webkit-text-fill-color: transparent;
            }
            
            .subtitle {
                text-align: center;
                color: var(--text-secondary);
                margin-bottom: 2.5rem;
                font-size: 1.1rem;
            }

            /* Form Elements */
            .form-group {
                position: relative;
                margin-bottom: 2rem;
            }

            .form-group input,
            .form-group textarea,
            .form-group select {
                width: 100%;
                padding: 1rem;
                background: rgba(0,0,0,0.2);
                border: 1px solid var(--border-glass);
                border-radius: 8px;
                color: var(--text-primary);
                font-size: 1rem;
                transition: all 0.2s ease;
                appearance: none; /* For select */
            }

            .form-group textarea {
                resize: vertical;
                min-height: 80px;
            }
            
            .form-group select {
                cursor: pointer;
            }

            .form-group label {
                position: absolute;
                top: 1rem;
                left: 1rem;
                color: var(--text-secondary);
                pointer-events: none;
                transition: all 0.2s ease;
            }
            
            .form-group input:focus,
            .form-group textarea:focus,
            .form-group select:focus,
            .form-group input:valid,
            .form-group textarea:valid,
            .form-group select:valid {
                outline: none;
                border-color: var(--accent-secondary);
                background: rgba(0,0,0,0.3);
            }

            .form-group input:focus + label,
            .form-group input:valid + label,
            .form-group textarea:focus + label,
            .form-group textarea:valid + label,
            .form-group .select-label {
                top: -0.75rem;
                left: 0.75rem;
                font-size: 0.8rem;
                color: var(--accent-secondary);
                background: #2a2a3e; /* Match approximate glassmorphism bg */
                padding: 0 0.25rem;
            }

            /* Buttons */
            button {
                padding: 1rem 2rem;
                border: none;
                border-radius: 8px;
                background-image: linear-gradient(90deg, var(--accent-primary), var(--accent-secondary));
                color: white;
                font-size: 1rem;
                font-weight: 600;
                cursor: pointer;
                transition: all 0.3s ease;
                display: block;
                width: 100%;
                margin-top: 1rem;
            }
            
            button:hover:not(:disabled) {
                box-shadow: 0 0 20px rgba(139, 92, 246, 0.5);
                transform: translateY(-2px);
            }

            button:disabled {
                opacity: 0.5;
                cursor: not-allowed;
            }
            
            .secondary-button {
                background: transparent;
                border: 1px solid var(--accent-secondary);
                color: var(--accent-secondary);
            }
            
            .danger-button {
                background: var(--error);
                background-image: none;
            }

            /* Interview Screen */
            .visualizer-container {
                height: 200px;
                display: flex;
                justify-content: center;
                align-items: center;
                margin-bottom: 1.5rem;
            }
            
            .interviewer-visualizer {
                width: 150px;
                height: 150px;
                background-image: var(--image-visualizer);
                background-size: contain;
                background-repeat: no-repeat;
                background-position: center;
                border-radius: 50%;
                border: 4px solid var(--accent-secondary);
                animation: pulse 2s infinite ease-in-out;
            }
            
            @keyframes pulse {
                0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(168, 85, 247, 0.7); }
                70% { transform: scale(1); box-shadow: 0 0 0 20px rgba(168, 85, 247, 0); }
                100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(168, 85, 247, 0); }
            }

            .user-visualizer {
                display: flex;
                justify-content: center;
                align-items: center;
                height: 80px;
                gap: 8px;
            }

            .user-visualizer .bar {
                display: block;
                width: 10px;
                border-radius: 5px;
                background: var(--success);
                animation: user-speaking-animation 1.2s infinite ease-in-out alternate;
            }

            .user-visualizer .bar:nth-child(1) { height: 30px; animation-delay: -0.4s; }
            .user-visualizer .bar:nth-child(2) { height: 50px; animation-delay: -0.2s; }
            .user-visualizer .bar:nth-child(3) { height: 70px; animation-delay: 0s; }
            .user-visualizer .bar:nth-child(4) { height: 50px; animation-delay: 0.2s; }
            .user-visualizer .bar:nth-child(5) { height: 30px; animation-delay: 0.4s; }

            @keyframes user-speaking-animation {
                0% { transform: scaleY(0.3); }
                100% { transform: scaleY(1); }
            }

            .mic-icon svg {
                width: 80px;
                height: 80px;
                color: var(--text-secondary);
                animation: mic-pulse 2s infinite ease-in-out;
            }
            
            .mic-icon.muted svg {
                color: var(--error);
                animation: none;
            }

            @keyframes mic-pulse {
                0%, 100% { opacity: 0.7; }
                50% { opacity: 1; }
            }

            .transcript-container {
                flex-grow: 1;
                overflow-y: auto;
                padding: 1rem;
                background: rgba(0,0,0,0.2);
                border-radius: 12px;
                display: flex;
                flex-direction: column;
                gap: 1rem;
            }
            
            .transcript-container.historic {
                max-height: 50vh;
            }
            
            .message-bubble {
                padding: 0.75rem 1.25rem;
                border-radius: 18px;
                max-width: 80%;
                word-wrap: break-word;
            }

            .ai-message {
                background: #2c2c4d;
                align-self: flex-start;
                border-bottom-left-radius: 4px;
            }
            
            .user-message {
                background: var(--accent-primary);
                align-self: flex-end;
                border-bottom-right-radius: 4px;
            }
            
            .message-bubble strong {
                display: block;
                margin-bottom: 0.25rem;
                font-weight: 600;
                color: var(--text-secondary);
            }
            
            .user-message strong {
                color: rgba(255,255,255,0.7);
            }

            .interview-controls {
                display: flex;
                gap: 1rem;
                margin-top: 1rem;
                align-items: center;
            }

            .control-button {
                flex-shrink: 0;
                width: 56px;
                height: 56px;
                padding: 0;
                margin: 0;
                border-radius: 50%;
                background-image: none;
                background-color: rgba(255, 255, 255, 0.1);
                border: 1px solid var(--border-glass);
                display: flex;
                justify-content: center;
                align-items: center;
            }

            .control-button svg {
                width: 24px;
                height: 24px;
            }

            .end-interview-button {
                flex-grow: 1;
                margin-top: 0;
                width: auto;
            }

            /* Feedback & History Screens */
            .feedback-content, .history-details {
                flex-grow: 1;
                overflow-y: auto;
                background: rgba(0,0,0,0.2);
                border-radius: 12px;
                padding: 1.5rem;
                color: var(--text-primary);
            }
            
            .feedback-content h1, .feedback-content h2, .feedback-content h3 {
                margin-top: 1.5rem;
                margin-bottom: 0.75rem;
                color: var(--accent-secondary);
            }

            .feedback-content p {
                line-height: 1.7;
                margin-bottom: 1rem;
            }
            
            .feedback-content strong {
                color: #fff;
            }
            
            .feedback-content code {
                background: rgba(0,0,0,0.5);
                padding: 0.2rem 0.4rem;
                border-radius: 4px;
            }
            
            .feedback-content blockquote {
                border-left: 3px solid var(--accent-primary);
                padding-left: 1rem;
                margin: 1rem 0;
                color: var(--text-secondary);
            }

            .history-list {
                display: flex;
                flex-direction: column;
                gap: 1rem;
                flex-grow: 1;
            }

            .history-item {
                padding: 1.5rem;
                background: rgba(0,0,0,0.2);
                border: 1px solid var(--border-glass);
                border-radius: 12px;
                cursor: pointer;
                transition: all 0.2s ease;
            }

            .history-item:hover {
                background: rgba(0,0,0,0.4);
                border-color: var(--accent-secondary);
                transform: translateY(-2px);
            }
            
            .history-item-role {
                font-size: 1.2rem;
                font-weight: 600;
                margin-bottom: 0.5rem;
            }
            
            .history-item-date {
                color: var(--text-secondary);
                font-size: 0.9rem;
            }
            
            .history-details {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 2rem;
                align-items: start;
            }
            
            .details-column h3 {
                text-align: center;
                margin-bottom: 1rem;
                font-size: 1.5rem;
                color: var(--text-secondary);
            }

            /* Skeleton Loader */
            @keyframes skeleton-loading {
              0% { background-color: rgba(255,255,255,0.1); }
              100% { background-color: rgba(255,255,255,0.2); }
            }
            
            .skeleton-loader {
                padding: 1.5rem;
            }

            .skeleton-line {
              height: 1rem;
              margin-bottom: 0.75rem;
              border-radius: 0.25rem;
              animation: skeleton-loading 1s linear infinite alternate;
            }
            .skeleton-line.title {
                height: 2rem;
                width: 50%;
                margin-bottom: 1.5rem;
            }
            .skeleton-line.short {
                width: 70%;
            }


            /* Responsive Design */
            @media (max-width: 768px) {
                .app-wrapper {
                    min-height: 100vh;
                    margin: 0;
                    border-radius: 0;
                }
                .app-screen {
                    padding: 1.5rem;
                }
                h2 {
                    font-size: 2rem;
                }
                .history-details {
                    grid-template-columns: 1fr;
                }
            }
        `}</style>
        {renderContent()}
        </div>
    );
};

const container = document.getElementById("root");
const root = createRoot(container!);
root.render(<App />);