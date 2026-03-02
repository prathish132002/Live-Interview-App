import React from 'react';
import { TranscriptEntry } from '../types';

interface InterviewScreenProps {
    settings: { mode: string; };
    timeLeft: number | null;
    videoRef: React.RefObject<HTMLVideoElement | null>;
    isCameraOff: boolean;
    isMuted: boolean;
    toggleMute: () => void;
    toggleCamera: () => void;
    speakingDuration: number;
    transcript: TranscriptEntry[];
    transcriptEndRef: React.RefObject<HTMLDivElement | null>;
    stopInterview: () => void;
    loadingAction: string | null;
    isInIntro?: boolean;
    isAiThinking?: boolean;
}

export const InterviewScreen = ({
    settings,
    videoRef,
    isCameraOff,
    isMuted,
    toggleMute,
    toggleCamera,
    speakingDuration,
    transcript,
    transcriptEndRef,
    stopInterview,
    loadingAction,
    isInIntro,
    isAiThinking,
    timeLeft
}: InterviewScreenProps) => {
    return (
        <div className="flex h-screen flex-col items-center justify-center p-4 relative z-10 w-full">
            <div className="w-full max-w-2xl flex flex-col h-full max-h-[900px]">
                {/* Interview Header */}
                <div className="glass-card rounded-2xl p-4 mb-4 flex justify-between items-center shadow-md">
                    <div className="flex items-center gap-3">
                        <div className={`w-2 h-2 rounded-full ${isInIntro ? 'bg-blue-500' : 'bg-red-500'} animate-pulse`}></div>
                        <span className="font-bold text-brand-text">{isInIntro ? 'Preparation Phase' : 'Live Session'}</span>
                    </div>
                    {settings.mode === 'timed' && timeLeft !== null && (
                        <span className={`font-mono font-bold text-xl ${timeLeft < 30 ? 'text-red-500' : 'text-brand-text'}`}>
                            {timeLeft}s
                        </span>
                    )}
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
                        {isAiThinking ? (
                            <div className="flex flex-col items-center">
                                <p className="text-brand-primary font-bold animate-pulse text-lg mb-2">Analyzing response...</p>
                                <div className="flex gap-1">
                                    <div className="w-2 h-2 bg-brand-primary rounded-full animate-bounce" style={{animationDelay: '0s'}}></div>
                                    <div className="w-2 h-2 bg-brand-primary rounded-full animate-bounce" style={{animationDelay: '0.2s'}}></div>
                                    <div className="w-2 h-2 bg-brand-primary rounded-full animate-bounce" style={{animationDelay: '0.4s'}}></div>
                                </div>
                            </div>
                        ) : (
                            <>
                                <p className="text-brand-text-light font-medium">{speakingDuration > 0 ? 'You are speaking...' : 'Listening...'}</p>
                                {speakingDuration > 0 && (
                                    <div className="mt-2 h-1 w-24 bg-gray-200 rounded-full overflow-hidden mx-auto">
                                        <div className="h-full bg-green-500 transition-all duration-100" style={{width: `${Math.min(speakingDuration * 5, 100)}%`}}></div>
                                    </div>
                                )}
                            </>
                        )}
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
        </div>
    );
};
