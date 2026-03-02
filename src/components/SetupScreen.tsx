import React from 'react';

interface SetupScreenProps {
    sessionType: 'interview' | 'presentation' | 'seminar';
    settings: {
        role: string;
        topics: string;
        voice: string;
        language: string;
        mode: string;
        level: string;
        maxQuestions?: string;
    };
    handleSettingsChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => void;
    handleStartInterview: () => void;
    setScreen: (screen: string) => void;
    resumeFile: File | null;
    setResumeFile: (file: File | null) => void;
    fileInputRef: React.RefObject<HTMLInputElement>;
    isLoading: boolean;
    loadingAction: string | null;
    error: string | null;
}

export const SetupScreen = ({
    sessionType,
    settings,
    handleSettingsChange,
    handleStartInterview,
    setScreen,
    resumeFile,
    setResumeFile,
    fileInputRef,
    isLoading,
    loadingAction,
    error
}: SetupScreenProps) => {
    return (
        <div className="flex min-h-screen items-center justify-center p-4 relative z-10">
            <div className="w-full max-w-lg glass-card rounded-3xl p-8 shadow-2xl animate-[fadeIn_0.5s_ease-out]">
                <button onClick={() => setScreen('home')} className="mb-6 flex items-center text-sm font-bold text-brand-text-light hover:text-brand-primary transition-colors">
                    <span className="material-symbols-outlined text-lg mr-1">arrow_back</span> Back
                </button>
                <h2 className="text-3xl font-bold text-brand-text mb-2 text-center">
                    {sessionType === 'interview' ? 'Interview Setup' : (sessionType === 'seminar' ? 'Seminar Setup' : 'Presentation Setup')}
                </h2>
                <p className="text-center text-brand-text-light mb-8 text-sm">Configure your AI coach preferences</p>
                
                <div className="space-y-5">
                    <div>
                        <label className="block text-xs font-bold uppercase tracking-wider text-brand-text-light mb-2 ml-1">
                            {sessionType === 'interview' ? 'Target Role' : 'Presentation Title'}
                        </label>
                        <input 
                            name="role" 
                            value={settings.role} 
                            onChange={handleSettingsChange} 
                            className="w-full h-14 px-5 rounded-2xl glass-input text-brand-text font-medium placeholder-gray-400"
                            placeholder={sessionType === 'interview' ? "e.g. Product Manager" : "e.g. Q3 Business Review"} 
                        />
                    </div>
                    <div>
                        <label className="block text-xs font-bold uppercase tracking-wider text-brand-text-light mb-2 ml-1">
                            {sessionType === 'interview' ? 'Focus Topics' : 'Target Audience'}
                        </label>
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

                    <div className="grid grid-cols-[1fr_1fr_1fr] gap-4">
                        <div className="relative">
                            <label className="block text-xs font-bold uppercase tracking-wider text-brand-text-light mb-2 ml-1">Difficulty</label>
                            <select name="level" value={settings.level} onChange={handleSettingsChange} className="w-full h-12 px-4 rounded-xl glass-input text-brand-text text-sm appearance-none cursor-pointer">
                                {['Easy', 'Medium', 'Hard'].map(l => <option key={l} value={l}>{l}</option>)}
                            </select>
                            <span className="material-symbols-outlined absolute right-3 bottom-3 pointer-events-none text-gray-500 text-sm">expand_more</span>
                        </div>
                        <div className="relative">
                            <label className="block text-xs font-bold uppercase tracking-wider text-brand-text-light mb-2 ml-1">Session Mode</label>
                            <select name="mode" value={settings.mode} onChange={handleSettingsChange} className="w-full h-12 px-4 rounded-xl glass-input text-brand-text text-sm appearance-none cursor-pointer">
                                <option value="standard">Standard</option>
                                <option value="timed">Timed Response (90s)</option>
                            </select>
                            <span className="material-symbols-outlined absolute right-3 bottom-3 pointer-events-none text-gray-500 text-sm">expand_more</span>
                        </div>
                        <div className="relative">
                            <label className="block text-xs font-bold uppercase tracking-wider text-brand-text-light mb-2 ml-1">Q Limit</label>
                            <select name="maxQuestions" value={settings.maxQuestions || 'Unlimited'} onChange={handleSettingsChange} className="w-full h-12 px-4 rounded-xl glass-input text-brand-text text-sm appearance-none cursor-pointer">
                                {['3', '5', '10', 'Unlimited'].map(l => <option key={l} value={l}>{l}</option>)}
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
    );
};
