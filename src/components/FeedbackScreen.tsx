import React from 'react';
import { FeedbackData } from '../types';

interface FeedbackScreenProps {
    feedback: FeedbackData;
    recordedVideoUrl: string | null;
    setActiveScoreModal: (metric: string) => void;
    getScoreTitle: (metric: string) => string;
    setScreen: (screen: string) => void;
}

export const FeedbackScreen = ({
    feedback,
    recordedVideoUrl,
    setActiveScoreModal,
    getScoreTitle,
    setScreen
}: FeedbackScreenProps) => {
    return (
        <div className="flex min-h-screen flex-col items-center justify-center p-4 relative z-10 w-full">
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
    );
};
