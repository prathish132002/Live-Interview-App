import React, { useState, useRef, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { onAuthStateChanged, User, signInWithPopup, signOut } from "firebase/auth";

// Components
import { TourGuide } from './src/components/TourGuide';
import { ChatWidget } from './src/components/ChatWidget';
import { HomeScreen } from './src/components/HomeScreen';
import { SetupScreen } from './src/components/SetupScreen';
import { InterviewScreen } from './src/components/InterviewScreen';
import { FeedbackScreen } from './src/components/FeedbackScreen';

// Hooks & Utils
import { useLiveInterview } from './src/hooks/useLiveInterview';
import { auth, googleProvider } from './src/lib/firebase';
import { analyzeResume, generateFeedback } from './src/utils/ai';
import { FeedbackData, TourStep } from './src/types';

const App = () => {
    // Auth State
    const [user, setUser] = useState<User | null>(null);
    const [authLoading, setAuthLoading] = useState(true);

    const [screen, setScreen] = useState('home'); // setup, interview, feedback, home
    const [sessionType, setSessionType] = useState<'interview' | 'presentation' | 'seminar'>('interview');
    const [settings, setSettings] = useState({
        role: 'Software Engineer', 
        topics: 'React, TypeScript, and System Design',
        voice: 'Aoede',
        language: 'English',
        mode: 'standard',
        level: 'Medium' 
    });
    
    const [resumeFile, setResumeFile] = useState<File | null>(null);
    const [resumeAnalysis, setResumeAnalysis] = useState<string>('');
    const [feedback, setFeedback] = useState<FeedbackData | null>(null);
    const [showPermissionModal, setShowPermissionModal] = useState(false);
    const [permissionDenied, setPermissionDenied] = useState(false);
    const [activeScoreModal, setActiveScoreModal] = useState<string | null>(null);
    const [tourOpen, setTourOpen] = useState(false);
    const [tourStep, setTourStep] = useState(0);

    const videoRef = useRef<HTMLVideoElement | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const transcriptEndRef = useRef<HTMLDivElement>(null);

    const {
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
    } = useLiveInterview(settings, resumeAnalysis, sessionType);

    const tourSteps: TourStep[] = [
        { targetId: 'welcome-header', title: 'Welcome to SpeakEasy AI', content: 'Prepare for high-stakes conversations with your personal AI coach.' },
        { targetId: 'card-interview', title: 'Ace Your Interview', content: 'Practice behavioral and technical questions tailored to your target role.' },
        { targetId: 'card-presentation', title: 'Refine Your Presentation', content: 'Rehearse your slides and get feedback on clarity, pacing, and fact accuracy.' },
        { targetId: 'card-seminar', title: 'Defend Your Thesis', content: 'Simulate a seminar environment for academic or research defenses.' },
    ];

    // Auth & Tour Init
    useEffect(() => {
        const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
            setUser(currentUser);
            setAuthLoading(false);
        });

        const tourSeen = localStorage.getItem('onboardingTourSeen');
        if (!tourSeen) {
            setTimeout(() => setTourOpen(true), 1000);
        }

        return () => unsubscribe();
    }, []);

    const handleTourNext = () => {
        if (tourStep < tourSteps.length - 1) {
            setTourStep(prev => prev + 1);
        } else {
            setTourOpen(false);
            localStorage.setItem('onboardingTourSeen', 'true');
        }
    };
    
    const restartTour = () => {
        setTourStep(0);
        setTourOpen(true);
    };

    const handleLogin = async () => {
        try {
            await signInWithPopup(auth, googleProvider);
        } catch (error: any) {
            console.error("Login failed", error);
            if (error.code === 'auth/unauthorized-domain') {
                 setUser({ uid: 'guest-demo', displayName: 'Guest User', email: 'guest@demo.com' } as any);
                 alert("Notice: Logged in as Guest User (Domain Unauthorized).");
            } else {
                setError(`Login failed: ${error.message}`);
            }
        }
    };

    const handleLogout = async () => {
        await signOut(auth);
        setUser(null);
        setScreen('home');
    };

    const handleStartInterview = async () => {
        setLoadingAction(resumeFile ? 'analyzing_file' : 'preparing_session');
        setError(null);
        setRecordedVideoUrl(null);
        
        await cleanupAudioResources();
        let analysis = '';

        try {
            if (resumeFile) {
                analysis = await analyzeResume(resumeFile, sessionType, (window as any).process?.env?.API_KEY || "");
                setResumeAnalysis(analysis);
            } else {
                setResumeAnalysis('');
            }
            
            setShowPermissionModal(true);
            setLoadingAction(null);
        } catch (err: any) {
            setError(`Failed to prepare session: ${err.message}`);
            setLoadingAction(null);
        }
    };

    const confirmPermission = async () => {
        setPermissionDenied(false);
        setShowPermissionModal(false);
        setScreen('interview');
        try {
            await startLiveSession(videoRef.current);
        } catch (err: any) {
            if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
                setPermissionDenied(true);
                setShowPermissionModal(true);
                setScreen('setup');
            }
        }
    };

    const stopInterview = async () => {
        const finalInput = transcriptionBuffer.current.input.trim();
        const finalOutput = transcriptionBuffer.current.output.trim();
        const finalTranscript = [...transcript];
        if (finalInput) finalTranscript.push({ speaker: 'user', text: finalInput });
        if (finalOutput) finalTranscript.push({ speaker: 'interviewer', text: finalOutput });
        
        setLoadingAction('generating_feedback');
        const videoUrl = await stopRecording();
        setRecordedVideoUrl(videoUrl);

        await cleanupAudioResources();
        setScreen('feedback');
        
        try {
            const feedbackData = await generateFeedback(
                finalTranscript, 
                sessionType, 
                settings.role, 
                (window as any).process?.env?.API_KEY || ""
            );
            setFeedback(feedbackData);
            setTranscript(finalTranscript);
        } catch (err: any) {
            setError(`Failed to generate feedback: ${err.message}`);
        } finally {
            setLoadingAction(null);
        }
    };

    const handleSettingsChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
      const { name, value } = e.target;
      setSettings(prev => ({ ...prev, [name]: value }));
    };

    const handleStartSessionSetup = (type: 'interview' | 'presentation' | 'seminar') => {
        setSessionType(type);
        setScreen('setup');
        setResumeAnalysis('');
        setResumeFile(null);
        setSettings(prev => ({
            ...prev,
            role: type === 'interview' ? 'Software Engineer' : (type === 'seminar' ? 'Research Topic' : 'Quarterly Business Review'),
            topics: type === 'interview' ? 'React, TypeScript' : 'Audience',
        }));
    };
    
    const getScoreTitle = (metric: string) => {
        const titles: Record<string, string> = { relevance: 'Relevance', clarity: 'Clarity', conciseness: 'Conciseness', technicalAccuracy: 'Accuracy' };
        return titles[metric] || metric;
    };

    if (authLoading) return <div className="h-screen w-full flex items-center justify-center bg-brand-gradient text-white font-bold">Loading...</div>;

    return (
        <div className="min-h-screen w-full bg-brand-gradient text-brand-text font-display transition-colors duration-500 relative overflow-hidden">
            <style>{`
                .glass-card { background: rgba(255, 255, 255, 0.4); backdrop-filter: blur(16px); border: 1px solid rgba(255, 255, 255, 0.4); box-shadow: 0 4px 30px rgba(0, 0, 0, 0.1); }
                .glass-input { background: rgba(255, 255, 255, 0.5); border: none; backdrop-filter: blur(4px); transition: all 0.3s ease; }
                .glass-input:focus { background: rgba(255, 255, 255, 0.8); box-shadow: 0 0 0 4px rgba(29, 78, 216, 0.1); outline: none; }
                .btn-primary { background-color: var(--brand-primary); color: white; transition: all 0.2s; box-shadow: 0 4px 14px 0 rgba(29, 78, 216, 0.3); }
                .btn-primary:hover { background-color: var(--brand-primary-hover); transform: translateY(-1px); box-shadow: 0 6px 20px rgba(29, 78, 216, 0.23); }
                .custom-scrollbar::-webkit-scrollbar { width: 6px; }
                .custom-scrollbar::-webkit-scrollbar-track { background: rgba(0,0,0,0.05); }
                .custom-scrollbar::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.2); border-radius: 10px; }
            `}</style>
            
            <div className="relative z-10">
                <TourGuide steps={tourSteps} isOpen={tourOpen} onClose={() => setTourOpen(false)} stepIndex={tourStep} onNext={handleTourNext} />
                <ChatWidget />

                {screen === 'home' && (
                    <HomeScreen 
                        user={user} 
                        handleLogin={handleLogin} 
                        handleLogout={handleLogout} 
                        restartTour={restartTour} 
                        handleStartSessionSetup={handleStartSessionSetup} 
                    />
                )}

                {screen === 'setup' && (
                    <SetupScreen 
                        sessionType={sessionType}
                        settings={settings}
                        handleSettingsChange={handleSettingsChange}
                        handleStartInterview={handleStartInterview}
                        setScreen={setScreen}
                        resumeFile={resumeFile}
                        setResumeFile={setResumeFile}
                        fileInputRef={fileInputRef}
                        isLoading={loadingAction !== null}
                        loadingAction={loadingAction}
                        error={error}
                    />
                )}
                
                {screen === 'interview' && (
                    <InterviewScreen 
                        settings={settings}
                        timeLeft={timeLeft}
                        videoRef={videoRef}
                        isCameraOff={isCameraOff}
                        isMuted={isMuted}
                        toggleMute={toggleMute}
                        toggleCamera={toggleCamera}
                        speakingDuration={speakingDuration}
                        transcript={transcript}
                        transcriptEndRef={transcriptEndRef}
                        stopInterview={stopInterview}
                        loadingAction={loadingAction}
                        isInIntro={isInIntro}
                    />
                )}

                {screen === 'feedback' && feedback && (
                    <FeedbackScreen 
                        feedback={feedback}
                        recordedVideoUrl={recordedVideoUrl}
                        setActiveScoreModal={setActiveScoreModal}
                        getScoreTitle={getScoreTitle}
                        setScreen={setScreen}
                    />
                )}
            </div>
            
            {showPermissionModal && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
                    <div className="bg-white rounded-3xl p-8 max-w-md text-center shadow-2xl">
                        <div className="w-20 h-20 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-6 text-4xl">{permissionDenied ? '🚫' : '🎙️'}</div>
                        <h2 className="text-2xl font-bold text-gray-900 mb-2">{permissionDenied ? 'Access Denied' : 'Microphone Access'}</h2>
                        <p className="text-gray-600 mb-8">{permissionDenied ? 'Please enable permissions in your browser settings to continue.' : 'We need microphone and camera access to simulate a real interview.'}</p>
                        <div className="flex gap-4 justify-center">
                            {!permissionDenied ? (
                                <>
                                    <button onClick={() => setShowPermissionModal(false)} className="px-6 py-3 rounded-xl font-bold text-gray-500 hover:bg-gray-100">Cancel</button>
                                    <button onClick={confirmPermission} className="px-6 py-3 rounded-xl font-bold bg-brand-primary text-white shadow-lg shadow-blue-500/30 hover:bg-blue-800">Allow Access</button>
                                </>
                            ) : (
                                <button onClick={() => window.location.reload()} className="px-6 py-3 rounded-xl font-bold bg-gray-900 text-white">Refresh Page</button>
                            )}
                        </div>
                    </div>
                </div>
            )}
            
            {activeScoreModal && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4" onClick={() => setActiveScoreModal(null)}>
                    <div className="bg-white rounded-3xl p-6 max-w-sm w-full shadow-2xl animate-[fadeIn_0.2s_ease-out]" onClick={(e) => e.stopPropagation()}>
                        <div className="flex justify-between items-center mb-4">
                            <h3 className="text-xl font-bold text-gray-900">{getScoreTitle(activeScoreModal)}</h3>
                            <button onClick={() => setActiveScoreModal(null)} className="p-1 rounded-full hover:bg-gray-100"><span className="material-symbols-outlined text-gray-500">close</span></button>
                        </div>
                        <p className="text-gray-600 leading-relaxed mb-6">{
                            sessionType === 'interview' ? 
                            (activeScoreModal === 'relevance' ? "Did you answer the specific question asked?" : activeScoreModal === 'clarity' ? "Was your structure logical and easy to follow?" : activeScoreModal === 'conciseness' ? "Did you avoid rambling?" : "Was your technical content accurate?") :
                            (activeScoreModal === 'relevance' ? "Did you stick to the facts in your slides?" : activeScoreModal === 'clarity' ? "Was your delivery articulate?" : activeScoreModal === 'conciseness' ? "Was your pacing appropriate?" : "Were your statements factually correct?")
                        }</p>
                        <button onClick={() => setActiveScoreModal(null)} className="w-full py-3 bg-brand-primary text-white rounded-xl font-bold">Got it</button>
                    </div>
                </div>
            )}
        </div>
    );
};

const root = createRoot(document.getElementById('root')!);
root.render(<App />);