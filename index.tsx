import { GoogleGenAI, LiveSession, LiveServerMessage, Modality, Type } from "@google/genai";
import React, { useState, useRef, useEffect } from 'react';
import { createRoot } from 'react-dom/client';

// --- AUDIO HELPER FUNCTIONS ---
// FIX: Added types for function parameters and return values.
function decode(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

// FIX: Added types for function parameters and return values.
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

// FIX: Added types for function parameters and return values.
function encode(bytes: Uint8Array): string {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// FIX: Added types for function parameters and return values.
function createBlob(data: Float32Array): { data: string; mimeType: string } {
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

// --- REACT COMPONENTS ---

const App = () => {
    const [screen, setScreen] = useState('setup'); // setup, briefing, interview, feedback
    const [settings, setSettings] = useState({
        role: 'Software Engineer',
        topics: 'React, TypeScript, and System Design',
        voice: 'Zephyr',
        language: 'English',
        mode: 'standard', // standard, timed
    });
    const [transcript, setTranscript] = useState<{ speaker: string; text: string }[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [timeLeft, setTimeLeft] = useState<number | null>(null);
    const [briefingText, setBriefingText] = useState('');
    const [feedback, setFeedback] = useState<{ summary: string; overall: number; relevance: number; clarity: number; conciseness: number } | null>(null);


    const sessionRef = useRef<LiveSession | null>(null);
    const timerRef = useRef<NodeJS.Timeout | null>(null);
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
            if (timeLeft === 0) {
              // Optionally handle time's up logic here
            }
            return;
        }

        timerRef.current = setInterval(() => {
            setTimeLeft(prevTime => (prevTime ? prevTime - 1 : 0));
        }, 1000);

        return () => {
          if (timerRef.current) clearInterval(timerRef.current);
        };
    }, [timeLeft]);

    const handleStartInterview = async () => {
        setIsLoading(true);
        setScreen('briefing');
        setError(null);
        setBriefingText('');

        try {
            const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

            const textPrompt = `Generate a short, friendly, and professional welcome message for a job interview. The role is '${settings.role}' and the topics are '${settings.topics}'. Welcome the candidate, state the role and topics, and wish them luck. The message must be entirely in ${settings.language}.`;
            
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
        setIsLoading(true);
        setError(null);
        setTranscript([]);
        setTimeLeft(null);
        setFeedback(null);

        try {
            const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

            audioRefs.current.inputAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
            if (!audioRefs.current.outputAudioContext || audioRefs.current.outputAudioContext.state === 'closed') {
                audioRefs.current.outputAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
            }

            audioRefs.current.stream = await navigator.mediaDevices.getUserMedia({ audio: true });

            let currentInputTranscription = '';
            let currentOutputTranscription = '';
            let nextStartTime = 0;
            const sources = new Set<AudioBufferSourceNode>();
            
            let systemInstruction = `You are an expert interviewer. Conduct an interview for the role of '${settings.role}' focusing on '${settings.topics}'. IMPORTANT: You must conduct this entire interview, including all questions and responses, exclusively in ${settings.language}. Do not switch languages under any circumstances. Keep your first question concise.`;
            if (settings.mode === 'timed') {
                systemInstruction += ` This is a timed interview. The user has 90 seconds to respond to each question.`
            }


            const sessionPromise = ai.live.connect({
                // FIX: Corrected a typo in the model name from '...-205' to '...-2025'.
                model: 'gemini-2.5-flash-native-audio-preview-09-2025',
                callbacks: {
                    onopen: () => {
                        setIsLoading(false);
                        setScreen('interview');
                        if (!audioRefs.current.inputAudioContext || !audioRefs.current.stream) return;
                        const source = audioRefs.current.inputAudioContext.createMediaStreamSource(audioRefs.current.stream);
                        audioRefs.current.source = source;
                        const scriptProcessor = audioRefs.current.inputAudioContext.createScriptProcessor(4096, 1, 1);
                        audioRefs.current.scriptProcessor = scriptProcessor;

                        scriptProcessor.onaudioprocess = (audioProcessingEvent) => {
                            const inputData = audioProcessingEvent.inputBuffer.getChannelData(0);
                            const pcmBlob = createBlob(inputData);
                            sessionPromise.then((session) => {
                                session.sendRealtimeInput({ media: pcmBlob });
                            });
                        };
                        source.connect(scriptProcessor);
                        scriptProcessor.connect(audioRefs.current.inputAudioContext.destination);
                    },
                    onmessage: async (message: LiveServerMessage) => {
                       if (message.serverContent?.inputTranscription) {
                            const text = message.serverContent.inputTranscription.text;
                            currentInputTranscription += text;
                        } else if (message.serverContent?.outputTranscription) {
                            const text = message.serverContent.outputTranscription.text;
                            currentOutputTranscription += text;
                        }

                        if (message.serverContent?.turnComplete) {
                           if (currentInputTranscription.trim()) {
                                setTranscript(prev => [...prev, { speaker: 'user', text: currentInputTranscription.trim() }]);
                                if(timerRef.current) clearInterval(timerRef.current);
                                setTimeLeft(null);
                           }
                           if (currentOutputTranscription.trim()) {
                                setTranscript(prev => [...prev, { speaker: 'interviewer', text: currentOutputTranscription.trim() }]);
                                if (settings.mode === 'timed') {
                                    setTimeLeft(90);
                                }
                           }
                            currentInputTranscription = '';
                            currentOutputTranscription = '';
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
                    // FIX: Added type for the error event object.
                    onerror: (e: ErrorEvent) => {
                        console.error('Session error:', e);
                        setError('An error occurred during the session. Please try again.');
                        stopInterview();
                    },
                    // FIX: Added type for the close event object.
                    onclose: (e: CloseEvent) => {
                        console.log('Session closed.');
                    },
                },
                config: {
                    responseModalities: [Modality.AUDIO],
                    speechConfig: {
                        voiceConfig: { prebuiltVoiceConfig: { voiceName: settings.voice } },
                    },
                    systemInstruction,
                    inputAudioTranscription: {},
                    outputAudioTranscription: {},
                },
            });
            sessionRef.current = await sessionPromise;

        } catch (err: any) {
            console.error("Failed to start interview:", err);
            setError(`Failed to start interview: ${err.message}. Please check microphone permissions.`);
            setIsLoading(false);
        }
    };
    
    const generateFeedback = async () => {
        if (transcript.length === 0) {
            setFeedback({ summary: "No interview to analyze. Practice a few questions to get feedback.", overall: 0, relevance: 0, clarity: 0, conciseness: 0 });
            return;
        }
        setIsLoading(true);
        setError(null);

        try {
            const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
            const fullTranscript = transcript.map(entry => `${entry.speaker === 'user' ? 'Candidate' : 'Interviewer'}: ${entry.text}`).join('\n\n');
            
            const prompt = `As an expert hiring manager, analyze the following interview transcript for the role of '${settings.role}'. The candidate's (user's) responses should be evaluated. Provide a concise summary of constructive feedback and score the candidate on a scale of 1 to 10 for the following criteria: Relevance, Clarity, and Conciseness. Also, provide an overall score from 1 to 10 based on their performance.
            
            Transcript:
            ${fullTranscript}`;

            const responseSchema = {
                type: Type.OBJECT,
                properties: {
                    summary: { type: Type.STRING, description: "Constructive feedback summary for the candidate." },
                    relevance: { type: Type.INTEGER, description: "Score from 1-10 for relevance of answers." },
                    clarity: { type: Type.INTEGER, description: "Score from 1-10 for clarity of answers." },
                    conciseness: { type: Type.INTEGER, description: "Score from 1-10 for conciseness of answers." },
                    overall: { type: Type.INTEGER, description: "Overall score from 1-10." },
                },
                required: ["summary", "relevance", "clarity", "conciseness", "overall"],
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

        } catch (err: any) {
            console.error("Failed to generate feedback:", err);
            setError(`Failed to generate feedback: ${err.message}.`);
        } finally {
            setIsLoading(false);
        }
    };

    const stopInterview = () => {
        if(timerRef.current) clearInterval(timerRef.current);
        setTimeLeft(null);
        if (sessionRef.current) {
            sessionRef.current.close();
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
        if (audioRefs.current.inputAudioContext && audioRefs.current.inputAudioContext.state !== 'closed') {
            audioRefs.current.inputAudioContext.close();
        }
        if (audioRefs.current.outputAudioContext && audioRefs.current.outputAudioContext.state !== 'closed') {
            audioRefs.current.outputAudioContext.close();
        }
        setScreen('feedback');
        generateFeedback();
    };

    // FIX: Added type for event object.
    const handleSettingsChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      const { name, value } = e.target;
      setSettings(prev => ({ ...prev, [name]: value }));
    };

    return (
        <>
            <style>{`
                :root {
                    --primary-color: #4A90E2;
                    --secondary-color: #F5A623;
                    --text-color: #4A4A4A;
                    --bg-color: #F7F9FC;
                    --card-bg: #FFFFFF;
                    --border-color: #DDE4EE;
                    --error-color: #D32F2F;
                    --success-color: #2E7D32;
                }
                body {
                    font-family: 'Poppins', sans-serif;
                    background-color: var(--bg-color);
                    color: var(--text-color);
                    margin: 0;
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    min-height: 100vh;
                }
                .container {
                    width: 100%;
                    max-width: 800px;
                    margin: 20px;
                    padding: 40px;
                    background-color: var(--card-bg);
                    border-radius: 20px;
                    box-shadow: 0 10px 30px rgba(0,0,0,0.08);
                    box-sizing: border-box;
                }
                h1, h2 {
                    color: var(--primary-color);
                    text-align: center;
                    margin-bottom: 30px;
                }
                .form-group {
                    margin-bottom: 25px;
                }
                label {
                    display: block;
                    font-weight: 500;
                    margin-bottom: 8px;
                }
                input, select {
                    width: 100%;
                    padding: 12px;
                    border: 1px solid var(--border-color);
                    border-radius: 8px;
                    box-sizing: border-box;
                    font-family: 'Poppins', sans-serif;
                    font-size: 1rem;
                }
                .button {
                    width: 100%;
                    padding: 15px;
                    font-size: 1.1rem;
                    font-weight: 600;
                    color: white;
                    background-color: var(--primary-color);
                    border: none;
                    border-radius: 8px;
                    cursor: pointer;
                    transition: background-color 0.3s, transform 0.1s;
                    margin-top: 10px;
                }
                .button:hover:not(:disabled) {
                    background-color: #357ABD;
                }
                .button:disabled {
                    background-color: #A9CBEF;
                    cursor: not-allowed;
                }
                .button.secondary {
                  background-color: #888;
                }
                .button.secondary:hover:not(:disabled) {
                  background-color: #666;
                }
                .transcript-container {
                  height: 400px;
                  overflow-y: auto;
                  border: 1px solid var(--border-color);
                  border-radius: 8px;
                  padding: 20px;
                  margin-bottom: 20px;
                }
                .transcript-bubble {
                  padding: 10px 15px;
                  border-radius: 15px;
                  margin-bottom: 10px;
                  max-width: 80%;
                }
                .transcript-bubble.user {
                  background-color: #EBF2FC;
                  margin-left: auto;
                  border-bottom-right-radius: 3px;
                }
                .transcript-bubble.interviewer {
                  background-color: #F1F1F1;
                  margin-right: auto;
                  border-bottom-left-radius: 3px;
                }
                .error {
                    color: var(--error-color);
                    text-align: center;
                    margin-top: 20px;
                }
                .timer {
                    text-align: center;
                    font-size: 1.8rem;
                    font-weight: 700;
                    margin-bottom: 15px;
                    color: var(--primary-color);
                    transition: color 0.5s ease;
                }
                .timer.warning {
                    color: var(--error-color);
                }
                .briefing-text {
                    background-color: #f0f4f8;
                    border-left: 4px solid var(--primary-color);
                    padding: 20px;
                    margin: 20px 0;
                    border-radius: 4px;
                    font-style: italic;
                    color: #555;
                }
                .feedback-container {
                    text-align: center;
                }
                .score-overall-container {
                    margin: 20px 0 30px;
                }
                .score-circle {
                    width: 120px;
                    height: 120px;
                    border-radius: 50%;
                    background-color: var(--bg-color);
                    border: 8px solid var(--primary-color);
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    flex-direction: column;
                    margin: 0 auto;
                    font-size: 1.2rem;
                    color: var(--primary-color);
                }
                .score-circle span {
                    font-size: 3rem;
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
                    margin: 0 0 5px 0;
                    font-weight: 500;
                    color: #777;
                }
                .score-item p {
                    margin: 0;
                    font-size: 1.5rem;
                    font-weight: 600;
                    color: var(--text-color);
                }
                .feedback-summary {
                    text-align: left;
                    background-color: #f0f4f8;
                    padding: 20px;
                    border-radius: 8px;
                    margin-bottom: 30px;
                }
                .feedback-summary h3 {
                    margin-top: 0;
                    color: var(--primary-color);
                    text-align: left;
                }
                .spinner {
                  border: 4px solid rgba(0,0,0,0.1);
                  width: 36px;
                  height: 36px;
                  border-radius: 50%;
                  border-left-color: var(--primary-color);
                  animation: spin 1s ease infinite;
                  margin: 20px auto;
                }
                @keyframes spin {
                  0% { transform: rotate(0deg); }
                  100% { transform: rotate(360deg); }
                }

            `}</style>
            <div className="container">
                {screen === 'setup' && (
                    <div>
                        <h1>AI Interview Coach</h1>
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
                            <label htmlFor="mode">Practice Mode</label>
                            <select id="mode" name="mode" value={settings.mode} onChange={handleSettingsChange}>
                                <option value="standard">Standard Interview</option>
                                <option value="timed">Timed Response (90s)</option>
                            </select>
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
                                    <h3>Feedback Summary</h3>
                                    <p>{feedback.summary}</p>
                                </div>

                                <button className="button" onClick={() => {
                                    setScreen('setup');
                                    setTranscript([]);
                                    setFeedback(null);
                                }}>
                                    Start New Interview
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
