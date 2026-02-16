import React, { useState, useEffect } from 'react';
import { User } from 'firebase/auth';
import { reviews } from '../data/reviews';

interface HomeScreenProps {
    user: User | null;
    handleLogin: () => void;
    handleLogout: () => void;
    restartTour: () => void;
    handleStartSessionSetup: (type: 'interview' | 'presentation' | 'seminar') => void;
}

export const HomeScreen = ({ user, handleLogin, handleLogout, restartTour, handleStartSessionSetup }: HomeScreenProps) => {
    const [currentReviewIndex, setCurrentReviewIndex] = useState(0);
    const [isAutoPlay, setIsAutoPlay] = useState(true);

    // Review Carousel Effect
    useEffect(() => {
        if (!isAutoPlay) return;
        const interval = setInterval(() => {
            setCurrentReviewIndex((prev) => (prev + 1) % reviews.length);
        }, 5000);
        return () => clearInterval(interval);
    }, [isAutoPlay]);

    const nextReview = () => {
        setCurrentReviewIndex((prev) => (prev + 1) % reviews.length);
    };

    const prevReview = () => {
        setCurrentReviewIndex((prev) => (prev - 1 + reviews.length) % reviews.length);
    };

    return (
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
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-16">
                    {[
                        { id: 'card-interview', icon: 'work', title: 'Job Interview', desc: 'Behavioral & technical prep', color: 'text-blue-600', bg: 'bg-blue-50', type: 'interview' as const },
                        { id: 'card-presentation', icon: 'present_to_all', title: 'Presentation', desc: 'Slide & delivery coaching', color: 'text-purple-600', bg: 'bg-purple-50', type: 'presentation' as const },
                        { id: 'card-seminar', icon: 'school', title: 'Seminar Defense', desc: 'Academic rigor check', color: 'text-orange-600', bg: 'bg-orange-50', type: 'seminar' as const }
                    ].map((card) => (
                        <div 
                            key={card.id}
                            id={card.id}
                            onClick={() => handleStartSessionSetup(card.type)}
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

                {/* Reviews Carousel */}
                <div className="relative max-w-2xl mx-auto">
                    <div className="overflow-hidden rounded-2xl bg-white/30 backdrop-blur-sm p-6 border border-white/40">
                        <div className="transition-all duration-500 ease-in-out flex flex-col items-center">
                            <div className="w-12 h-12 bg-brand-primary rounded-full flex items-center justify-center text-white font-bold text-xl mb-4 shadow-lg">
                                {reviews[currentReviewIndex].avatar}
                            </div>
                            <p className="text-center text-brand-text font-medium italic mb-4 leading-relaxed">
                                "{reviews[currentReviewIndex].content}"
                            </p>
                            <div className="text-center">
                                <div className="font-bold text-brand-text">{reviews[currentReviewIndex].name}</div>
                                <div className="text-xs text-brand-text-light">{reviews[currentReviewIndex].role}</div>
                            </div>
                        </div>
                    </div>
                    
                    <button onClick={prevReview} className="absolute top-1/2 -left-4 -translate-y-1/2 w-10 h-10 rounded-full bg-white shadow-lg flex items-center justify-center text-brand-text-light hover:text-brand-primary transition-all">
                        <span className="material-symbols-outlined">chevron_left</span>
                    </button>
                    <button onClick={nextReview} className="absolute top-1/2 -right-4 -translate-y-1/2 w-10 h-10 rounded-full bg-white shadow-lg flex items-center justify-center text-brand-text-light hover:text-brand-primary transition-all">
                        <span className="material-symbols-outlined">chevron_right</span>
                    </button>

                    <div className="flex justify-center gap-2 mt-4">
                        {reviews.map((_, i) => (
                            <button 
                                key={i} 
                                onClick={() => { setCurrentReviewIndex(i); setIsAutoPlay(false); }}
                                className={`w-2 h-2 rounded-full transition-all ${i === currentReviewIndex ? 'bg-brand-primary w-4' : 'bg-brand-text-light/30'}`}
                            />
                        ))}
                    </div>
                </div>
            </div>
        </div>
    );
};

