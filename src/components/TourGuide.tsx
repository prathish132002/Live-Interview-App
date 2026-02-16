import React, { useState, useEffect } from 'react';
import { TourStep } from '../types';

interface TourGuideProps {
    steps: TourStep[];
    isOpen: boolean;
    onClose: () => void;
    stepIndex: number;
    onNext: () => void;
}

export const TourGuide = ({ steps, isOpen, onClose, stepIndex, onNext }: TourGuideProps) => {
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
