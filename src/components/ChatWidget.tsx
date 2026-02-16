import React, { useState, useRef, useEffect } from 'react';
import { GoogleGenAI, Chat, GenerateContentResponse } from "@google/genai";

export const ChatWidget = () => {
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
             // Use public client-side approach for simplicity here, 
             // though normally you'd use an environment variable or backend proxy
            const ai = new GoogleGenAI({ apiKey: (window as any).process?.env?.API_KEY || "" });
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
