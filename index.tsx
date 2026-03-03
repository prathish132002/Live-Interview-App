import React, { useState, useRef, useEffect } from 'react';
import { createRoot } from "react-dom/client";
import { GoogleGenAI, LiveServerMessage, Modality } from "@google/genai";
import { motion, AnimatePresence } from "motion/react";
import { 
  LineChart, 
  Line, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  ResponsiveContainer,
  AreaChart,
  Area,
  BarChart,
  Bar
} from 'recharts';
import { 
  auth, 
  db, 
  googleProvider, 
  signInWithPopup, 
  signOut, 
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  updateProfile,
  sendEmailVerification,
  sendPasswordResetEmail,
  verifyBeforeUpdateEmail,
  collection,
  addDoc,
  query,
  where,
  getDocs,
  orderBy,
  limit,
  Timestamp,
  User
} from "./firebase";

type SessionType = 'interview' | 'seminar' | 'presentation';

interface Settings {
    role: string;
    company: string;
    jobDescription: string;
    topics: string;
    topicCategory: 'Technical' | 'Behavioral' | 'Situational' | 'Mixed';
    language: string;
    voice: string;
    difficulty: 'Easy' | 'Medium' | 'Hard';
    mode: string;
    qLimit: string;
}

// --- Helper Functions ---

const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = () => {
            const result = reader.result as string;
            const base64 = result.split(',')[1];
            resolve(base64);
        };
        reader.onerror = (error) => reject(error);
    });
};

function decode(base64: string) {
    const binaryString = atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
}

function encode(bytes: Uint8Array) {
    let binary = '';
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

async function decodeAudioData(
    data: Uint8Array,
    ctx: AudioContext,
    sampleRate: number,
    numChannels: number,
): Promise<AudioBuffer> {
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

function createBlob(data: Float32Array) {
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

// --- Auth Screen Component ---

function AuthScreen({ onAuthSuccess }: { onAuthSuccess: () => void }) {
    const [mode, setMode] = useState<'signin' | 'signup' | 'forgot-password'>('signin');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [name, setName] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [message, setMessage] = useState<string | null>(null);

    const handleGoogleSignIn = async () => {
        setLoading(true);
        setError(null);
        setMessage(null);
        try {
            await signInWithPopup(auth, googleProvider);
            onAuthSuccess();
        } catch (err: any) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    const handlePasswordReset = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        setMessage(null);
        try {
            await sendPasswordResetEmail(auth, email);
            setMessage("Password reset email sent! Please check your inbox (and spam folder).");
            setMode('signin');
        } catch (err: any) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    const handleEmailAuth = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        setMessage(null);
        try {
            if (mode === 'signup') {
                const userCredential = await createUserWithEmailAndPassword(auth, email, password);
                await updateProfile(userCredential.user, { displayName: name });
                await sendEmailVerification(userCredential.user);
                setMessage("A verification email has been sent to your inbox. Please check your email before signing in.");
                setMode('signin');
            } else {
                const userCredential = await signInWithEmailAndPassword(auth, email, password);
                if (!userCredential.user.emailVerified) {
                    setError("Please verify your email address. A verification link was sent to your inbox.");
                }
                onAuthSuccess();
            }
        } catch (err: any) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen w-full flex items-center justify-center bg-brand-gradient p-6">
            <motion.div 
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                className="w-full max-w-md bg-white/40 backdrop-blur-2xl rounded-[2.5rem] p-10 border border-white/50 shadow-2xl"
            >
                <div className="text-center mb-8">
                    <div className="w-16 h-16 bg-indigo-100 rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-inner">
                        <span className="material-symbols-outlined text-indigo-600 text-4xl">psychology</span>
                    </div>
                    <h1 className="text-3xl font-black text-slate-900 mb-2">SpeakEasy AI</h1>
                    <p className="text-slate-500 font-semibold">
                        {mode === 'signin' ? 'Welcome back! Please sign in.' : 
                         mode === 'signup' ? 'Create an account to get started.' : 
                         'Reset your password.'}
                    </p>
                </div>

                {error && (
                    <div className="mb-6 bg-red-500/10 border border-red-500/20 text-red-700 px-4 py-3 rounded-xl text-sm font-medium animate-pulse">
                        {error}
                    </div>
                )}

                {message && (
                    <div className="mb-6 bg-emerald-500/10 border border-emerald-500/20 text-emerald-700 px-4 py-3 rounded-xl text-sm font-medium">
                        {message}
                    </div>
                )}

                <form onSubmit={mode === 'forgot-password' ? handlePasswordReset : handleEmailAuth} className="space-y-4">
                    {mode === 'signup' && (
                        <div>
                            <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5 ml-1">Full Name</label>
                            <input 
                                type="text" 
                                required
                                className="w-full bg-white/60 border-none rounded-xl px-4 py-3 text-slate-800 font-bold placeholder:text-slate-400 focus:ring-4 focus:ring-indigo-500/20 transition-all shadow-sm"
                                placeholder="John Doe"
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                            />
                        </div>
                    )}
                    <div>
                        <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5 ml-1">Email Address</label>
                        <input 
                            type="email" 
                            required
                            className="w-full bg-white/60 border-none rounded-xl px-4 py-3 text-slate-800 font-bold placeholder:text-slate-400 focus:ring-4 focus:ring-indigo-500/20 transition-all shadow-sm"
                            placeholder="john@example.com"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                        />
                    </div>
                    {mode !== 'forgot-password' && (
                        <div>
                            <div className="flex justify-between items-center mb-1.5 ml-1">
                                <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest">Password</label>
                                {mode === 'signin' && (
                                    <button 
                                        type="button"
                                        onClick={() => setMode('forgot-password')}
                                        className="text-[10px] font-black text-indigo-600 hover:text-indigo-700 uppercase tracking-widest"
                                    >
                                        Forgot Password ?
                                    </button>
                                )}
                            </div>
                            <input 
                                type="password" 
                                required
                                className="w-full bg-white/60 border-none rounded-xl px-4 py-3 text-slate-800 font-bold placeholder:text-slate-400 focus:ring-4 focus:ring-indigo-500/20 transition-all shadow-sm"
                                placeholder="••••••••"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                            />
                        </div>
                    )}

                    <button 
                        type="submit"
                        disabled={loading}
                        className="w-full py-4 bg-indigo-600 hover:bg-indigo-700 text-white rounded-2xl font-black shadow-lg shadow-indigo-500/30 transition-all flex justify-center items-center gap-2 disabled:opacity-50"
                    >
                        {loading ? (
                            <span className="material-symbols-outlined animate-spin">progress_activity</span>
                        ) : (
                            mode === 'signin' ? 'Sign In' : 
                            mode === 'signup' ? 'Create Account' : 
                            'Send Reset Link'
                        )}
                    </button>
                </form>

                {mode !== 'forgot-password' && (
                    <>
                        <div className="relative my-8">
                            <div className="absolute inset-0 flex items-center">
                                <div className="w-full border-t border-slate-200"></div>
                            </div>
                            <div className="relative flex justify-center text-xs uppercase">
                                <span className="bg-transparent px-2 text-slate-400 font-black tracking-widest">Or continue with</span>
                            </div>
                        </div>

                        <button 
                            onClick={handleGoogleSignIn}
                            disabled={loading}
                            className="w-full py-4 bg-white hover:bg-slate-50 text-slate-700 rounded-2xl font-bold border border-slate-200 shadow-sm transition-all flex justify-center items-center gap-3 disabled:opacity-50"
                        >
                            <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" alt="Google" className="w-5 h-5" />
                            Google
                        </button>
                    </>
                )}

                <p className="mt-8 text-center text-sm font-bold text-slate-500">
                    {mode === 'signin' ? "Don't have an account?" : 
                     mode === 'signup' ? "Already have an account?" : 
                     "Remember your password?"}
                    <button 
                        onClick={() => {
                            setError(null);
                            setMessage(null);
                            setMode(mode === 'signin' ? 'signup' : 'signin');
                        }}
                        className="ml-2 text-indigo-600 hover:underline"
                    >
                        {mode === 'signin' ? 'Sign Up' : 'Sign In'}
                    </button>
                </p>
            </motion.div>
        </div>
    );
}

// --- Main Component ---

function VerifyEmailScreen({ user, onSignOut }: { user: User, onSignOut: () => void }) {
    const [loading, setLoading] = useState(false);
    const [message, setMessage] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const handleResend = async () => {
        setLoading(true);
        setMessage(null);
        setError(null);
        try {
            await sendEmailVerification(user);
            setMessage("Verification email resent! Please check your inbox.");
        } catch (err: any) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    const handleRefresh = async () => {
        setLoading(true);
        try {
            await user.reload();
            if (user.emailVerified) {
                window.location.reload();
            } else {
                setError("Email still not verified. Please check your inbox and click the link.");
            }
        } catch (err: any) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen w-full flex items-center justify-center bg-brand-gradient p-6">
            <motion.div 
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                className="w-full max-w-md bg-white/40 backdrop-blur-2xl rounded-[2.5rem] p-10 border border-white/50 shadow-2xl text-center"
            >
                <div className="w-20 h-20 bg-amber-100 rounded-3xl flex items-center justify-center mx-auto mb-6 shadow-inner">
                    <span className="material-symbols-outlined text-amber-600 text-5xl">mark_email_unread</span>
                </div>
                <h2 className="text-3xl font-black text-slate-900 mb-4">Verify Your Email</h2>
                <p className="text-slate-600 font-medium mb-8 leading-relaxed">
                    We've sent a verification link to <span className="font-bold text-slate-900">{user.email}</span>. 
                    Please verify your email to access all features.
                </p>

                {message && (
                    <div className="mb-6 bg-emerald-500/10 border border-emerald-500/20 text-emerald-700 px-4 py-3 rounded-xl text-sm font-medium">
                        {message}
                    </div>
                )}

                {error && (
                    <div className="mb-6 bg-red-500/10 border border-red-500/20 text-red-700 px-4 py-3 rounded-xl text-sm font-medium">
                        {error}
                    </div>
                )}

                <div className="space-y-4">
                    <button 
                        onClick={handleRefresh}
                        className="w-full py-4 bg-indigo-600 hover:bg-indigo-700 text-white rounded-2xl font-black shadow-lg shadow-indigo-500/30 transition-all flex justify-center items-center gap-2"
                    >
                        <span className="material-symbols-outlined">refresh</span>
                        I've Verified My Email
                    </button>
                    
                    <button 
                        onClick={handleResend}
                        disabled={loading}
                        className="w-full py-4 bg-white/60 hover:bg-white/80 text-slate-700 rounded-2xl font-bold border border-white/50 shadow-sm transition-all flex justify-center items-center gap-2 disabled:opacity-50"
                    >
                        {loading ? (
                            <span className="material-symbols-outlined animate-spin">progress_activity</span>
                        ) : (
                            <>
                                <span className="material-symbols-outlined">send</span>
                                Resend Verification Email
                            </>
                        )}
                    </button>

                    <button 
                        onClick={onSignOut}
                        className="w-full py-3 text-slate-500 hover:text-red-500 font-bold transition-colors"
                    >
                        Sign Out & Try Another Account
                    </button>
                </div>

                <p className="mt-8 text-xs text-slate-400 font-medium italic">
                    Don't see the email? Check your spam or junk folder.
                </p>
            </motion.div>
        </div>
    );
}

function ProfileScreen({ user, onBack }: { user: User, onBack: () => void }) {
    const [newEmail, setNewEmail] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [message, setMessage] = useState<string | null>(null);

    const handleUpdateEmail = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        setMessage(null);
        try {
            await verifyBeforeUpdateEmail(user, newEmail);
            setMessage("Verification email sent to your new address. Please verify it to complete the update.");
        } catch (err: any) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="flex-1 flex flex-col items-center justify-center px-8 py-12">
            <motion.div 
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                className="w-full max-w-md bg-white/60 backdrop-blur-xl rounded-[2.5rem] p-10 border border-white/50 shadow-2xl"
            >
                <div className="text-center mb-8">
                    <div className="w-16 h-16 bg-indigo-100 rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-inner">
                        <span className="material-symbols-outlined text-indigo-600 text-4xl">manage_accounts</span>
                    </div>
                    <h2 className="text-3xl font-black text-slate-900 mb-2">Account Settings</h2>
                    <p className="text-slate-500 font-semibold">Update your profile information</p>
                </div>

                {error && (
                    <div className="mb-6 bg-red-500/10 border border-red-500/20 text-red-700 px-4 py-3 rounded-xl text-sm font-medium">
                        {error}
                    </div>
                )}

                {message && (
                    <div className="mb-6 bg-emerald-500/10 border border-emerald-500/20 text-emerald-700 px-4 py-3 rounded-xl text-sm font-medium">
                        {message}
                    </div>
                )}

                <div className="space-y-6">
                    <div>
                        <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5 ml-1">Current Email</label>
                        <div className="w-full bg-slate-100/50 rounded-xl px-4 py-3 text-slate-500 font-bold border border-slate-200">
                            {user.email}
                        </div>
                    </div>

                    <form onSubmit={handleUpdateEmail} className="space-y-4">
                        <div>
                            <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5 ml-1">New Email Address</label>
                            <input 
                                type="email" 
                                required
                                className="w-full bg-white border-none rounded-xl px-4 py-3 text-slate-800 font-bold placeholder:text-slate-400 focus:ring-4 focus:ring-indigo-500/20 transition-all shadow-sm"
                                placeholder="new-email@example.com"
                                value={newEmail}
                                onChange={(e) => setNewEmail(e.target.value)}
                            />
                        </div>

                        <button 
                            type="submit"
                            disabled={loading}
                            className="w-full py-4 bg-indigo-600 hover:bg-indigo-700 text-white rounded-2xl font-black shadow-lg shadow-indigo-500/30 transition-all flex justify-center items-center gap-2 disabled:opacity-50"
                        >
                            {loading ? (
                                <span className="material-symbols-outlined animate-spin">progress_activity</span>
                            ) : (
                                'Update Email'
                            )}
                        </button>
                    </form>

                    <button 
                        onClick={onBack}
                        className="w-full py-4 bg-white hover:bg-slate-50 text-slate-700 rounded-2xl font-bold border border-slate-200 shadow-sm transition-all"
                    >
                        Back to Home
                    </button>
                </div>
            </motion.div>
        </div>
    );
}

function DashboardScreen({ 
    user, 
    sessions, 
    onBack,
    onViewSession
}: { 
    user: User, 
    sessions: any[], 
    onBack: () => void,
    onViewSession: (session: any) => void
}) {
    // Process sessions for the chart
    const chartData = [...sessions].reverse().map(s => ({
        date: new Date(s.timestamp?.seconds * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        score: s.feedback?.overallScore || 0,
        type: s.sessionType
    }));

    const averageScore = sessions.length > 0 
        ? Math.round(sessions.reduce((acc, s) => acc + (s.feedback?.overallScore || 0), 0) / sessions.length)
        : 0;

    const totalSessions = sessions.length;

    return (
        <div className="flex-1 flex flex-col px-8 py-12 max-w-6xl mx-auto w-full">
            <div className="flex items-center justify-between mb-12">
                <div>
                    <h2 className="text-4xl font-black text-slate-900 mb-2">Performance Dashboard</h2>
                    <p className="text-slate-500 font-semibold">Track your progress over time</p>
                </div>
                <button 
                    onClick={onBack}
                    className="flex items-center gap-2 px-6 py-3 bg-white text-slate-600 rounded-2xl font-bold shadow-sm hover:shadow-md transition-all border border-slate-100"
                >
                    <span className="material-symbols-outlined text-sm">arrow_back</span>
                    Back to Home
                </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-12">
                <div className="bg-white/60 backdrop-blur-xl p-8 rounded-[2rem] border border-white/50 shadow-sm">
                    <p className="text-[11px] font-black text-slate-400 uppercase tracking-widest mb-2">Average Score</p>
                    <div className="flex items-end gap-2">
                        <span className="text-5xl font-black text-indigo-600">{averageScore}</span>
                        <span className="text-slate-400 font-bold mb-1">/ 100</span>
                    </div>
                </div>
                <div className="bg-white/60 backdrop-blur-xl p-8 rounded-[2rem] border border-white/50 shadow-sm">
                    <p className="text-[11px] font-black text-slate-400 uppercase tracking-widest mb-2">Total Sessions</p>
                    <div className="flex items-end gap-2">
                        <span className="text-5xl font-black text-emerald-600">{totalSessions}</span>
                        <span className="text-slate-400 font-bold mb-1">completed</span>
                    </div>
                </div>
                <div className="bg-white/60 backdrop-blur-xl p-8 rounded-[2rem] border border-white/50 shadow-sm">
                    <p className="text-[11px] font-black text-slate-400 uppercase tracking-widest mb-2">Latest Session</p>
                    <div className="flex items-end gap-2">
                        <span className="text-5xl font-black text-orange-600">
                            {sessions[0]?.feedback?.overallScore || '-'}
                        </span>
                        <span className="text-slate-400 font-bold mb-1">score</span>
                    </div>
                </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-12">
                <div className="bg-white/60 backdrop-blur-xl p-8 rounded-[2.5rem] border border-white/50 shadow-xl h-[400px]">
                    <h3 className="text-xl font-black text-slate-800 mb-8">Score Trend</h3>
                    <ResponsiveContainer width="100%" height="80%">
                        <AreaChart data={chartData}>
                            <defs>
                                <linearGradient id="colorScore" x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="5%" stopColor="#4f46e5" stopOpacity={0.3}/>
                                    <stop offset="95%" stopColor="#4f46e5" stopOpacity={0}/>
                                </linearGradient>
                            </defs>
                            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                            <XAxis dataKey="date" axisLine={false} tickLine={false} tick={{fill: '#94a3b8', fontSize: 12, fontWeight: 600}} dy={10} />
                            <YAxis domain={[0, 100]} axisLine={false} tickLine={false} tick={{fill: '#94a3b8', fontSize: 12, fontWeight: 600}} dx={-10} />
                            <Tooltip 
                                contentStyle={{ backgroundColor: '#fff', borderRadius: '16px', border: 'none', boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.1)' }}
                                itemStyle={{ fontWeight: 'bold', color: '#4f46e5' }}
                            />
                            <Area type="monotone" dataKey="score" stroke="#4f46e5" strokeWidth={4} fillOpacity={1} fill="url(#colorScore)" />
                        </AreaChart>
                    </ResponsiveContainer>
                </div>

                <div className="bg-white/60 backdrop-blur-xl p-8 rounded-[2.5rem] border border-white/50 shadow-xl overflow-y-auto custom-scrollbar">
                    <h3 className="text-xl font-black text-slate-800 mb-8">Recent Sessions</h3>
                    <div className="space-y-4">
                        {sessions.length > 0 ? sessions.map((s, i) => (
                            <div 
                                key={i} 
                                onClick={() => onViewSession(s)}
                                className="flex items-center justify-between p-4 bg-white/40 rounded-2xl border border-white/50 hover:bg-white/60 transition-all cursor-pointer group"
                            >
                                <div className="flex items-center gap-4">
                                    <div className={`w-10 h-10 rounded-xl flex items-center justify-center transition-transform group-hover:scale-110 ${
                                        s.sessionType === 'interview' ? 'bg-blue-50 text-blue-600' : 
                                        s.sessionType === 'presentation' ? 'bg-purple-50 text-purple-600' : 'bg-orange-50 text-orange-600'
                                    }`}>
                                        <span className="material-symbols-outlined text-xl">
                                            {s.sessionType === 'interview' ? 'work' : s.sessionType === 'presentation' ? 'present_to_all' : 'school'}
                                        </span>
                                    </div>
                                    <div>
                                        <p className="font-bold text-slate-800 capitalize">
                                            {s.sessionType} {s.settings?.company ? `at ${s.settings.company}` : ''}
                                        </p>
                                        <p className="text-xs text-slate-500 font-semibold">{new Date(s.timestamp?.seconds * 1000).toLocaleDateString()}</p>
                                    </div>
                                </div>
                                <div className="flex items-center gap-4">
                                    <div className="text-right">
                                        <p className="text-lg font-black text-indigo-600">{s.feedback?.overallScore}</p>
                                        <p className="text-[10px] text-slate-400 font-black uppercase tracking-tighter">Score</p>
                                    </div>
                                    <span className="material-symbols-outlined text-slate-300 group-hover:text-indigo-500 transition-colors">chevron_right</span>
                                </div>
                            </div>
                        )) : (
                            <div className="text-center py-12">
                                <p className="text-slate-400 font-bold italic">No sessions recorded yet.</p>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}

const testimonials = [
    {
        name: "David Kim",
        role: "Marketing Director",
        text: "Used the presentation mode for a Q3 business review. The pacing score helped me trim down my speech to fit the time limit perfectly.",
        initial: "D",
        color: "bg-blue-600"
    },
    {
        name: "Sarah Chen",
        role: "Software Engineer",
        text: "The technical interview simulation was spot on. It asked exactly the kind of React questions I faced in my actual interview at Google.",
        initial: "S",
        color: "bg-purple-600"
    },
    {
        name: "James Wilson",
        role: "MBA Student",
        text: "The seminar defense mode is a game changer. It challenged my assumptions and prepared me for the toughest questions from the panel.",
        initial: "J",
        color: "bg-orange-600"
    },
    {
        name: "Elena Rodriguez",
        role: "Product Manager",
        text: "The AI's ability to follow up on my answers made the practice feel incredibly real. I felt so much more confident in my real interviews.",
        initial: "E",
        color: "bg-emerald-600"
    }
];

function App() {
    const [user, setUser] = useState<User | null>(null);
    const [screen, setScreen] = useState<string>('home'); // home, setup, briefing, interview, feedback, profile, dashboard
    const [loadingAction, setLoadingAction] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [dashboardSessions, setDashboardSessions] = useState<any[]>([]);
    
    // Setup State
    const [sessionType, setSessionType] = useState<SessionType>('interview');
    const [settings, setSettings] = useState<Settings>({
        role: 'Software Engineer',
        company: '',
        jobDescription: '',
        topics: 'React, TypeScript',
        topicCategory: 'Mixed',
        language: 'English',
        voice: 'Zephyr',
        difficulty: 'Medium',
        mode: 'Standard',
        qLimit: 'Unlimited',
    });
    const [resumeFile, setResumeFile] = useState<File | null>(null);
    const [resumeAnalysis, setResumeAnalysis] = useState<string>('');
    
    // Briefing State
    const [briefingText, setBriefingText] = useState<string>('');

    // Feedback State
    const [feedback, setFeedback] = useState<{
        overallScore: number;
        metrics: { name: string; score: number; explanation: string }[];
        summary: string;
        strengths: string[];
        improvements: string[];
        studyPlan?: {
            day: number;
            focus: string;
            tasks: string[];
            resources: { title: string; url: string }[];
        }[];
        modelAnswers?: {
            question: string;
            userAnswer: string;
            modelAnswer: string;
            whyBetter: string;
        }[];
        vocalAnalysis?: {
            primaryEmotion: string;
            confidenceLevel: string;
            pacing: string;
            toneObservations: string;
            coachingTip: string;
        };
    } | null>(null);
    const [activeModal, setActiveModal] = useState<string | null>(null);

    // Session State
    const [transcript, setTranscript] = useState<Array<{speaker: 'user' | 'ai', text: string}>>([]);
    const [isMuted, setIsMuted] = useState(false);
    const [isAiSpeaking, setIsAiSpeaking] = useState(false);
    const [currentTestimonialIndex, setCurrentTestimonialIndex] = useState(0);

    // Refs for Audio & Logic
    const sessionRef = useRef<any>(null);
    const isSessionActive = useRef(false);
    const isAiSpeakingRef = useRef(false);
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const transcriptEndRef = useRef<HTMLDivElement>(null);
    
    // Audio Scheduling Refs
    const nextAudioStartTimeRef = useRef(0);
    const activeSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
    
    const transcriptionBuffer = useRef({ input: '', output: '' });

    const audioRefs = useRef<{
        inputAudioContext: AudioContext | null;
        outputAudioContext: AudioContext | null;
        outputCompressor: DynamicsCompressorNode | null;
        stream: MediaStream | null;
        scriptProcessor: ScriptProcessorNode | null;
        source: MediaStreamAudioSourceNode | null;
    }>({
        inputAudioContext: null,
        outputAudioContext: null,
        outputCompressor: null,
        stream: null,
        scriptProcessor: null,
        source: null,
    });

    // --- Effects ---

    // Reset settings when session type changes to show correct placeholders
    useEffect(() => {
        if (sessionType === 'interview') {
            setSettings(prev => ({ 
                ...prev, 
                role: 'Software Engineer', 
                topics: 'React, TypeScript',
                topicCategory: 'Mixed'
            }));
        } else {
            // Clear values for seminar and presentation so placeholders are visible
            setSettings(prev => ({ 
                ...prev, 
                role: '', 
                topics: '',
                topicCategory: 'Mixed'
            }));
        }
    }, [sessionType]);

    const fetchDashboardSessions = async () => {
        if (!user) return;
        try {
            const q = query(
                collection(db, "sessions"),
                where("userId", "==", user.uid),
                orderBy("timestamp", "desc"),
                limit(20)
            );
            const querySnapshot = await getDocs(q);
            const sessionsData = querySnapshot.docs.map(doc => doc.data());
            setDashboardSessions(sessionsData);
        } catch (err) {
            console.error("Error fetching sessions:", err);
        }
    };

    useEffect(() => {
        if (user) {
            fetchDashboardSessions();
        }
    }, [user]);

    useEffect(() => {
        if (screen === 'dashboard') {
            fetchDashboardSessions();
        }
    }, [screen]);

    useEffect(() => {
        const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
            setUser(currentUser);
        });
        return () => unsubscribe();
    }, []);

    useEffect(() => {
        // Auto-scroll transcript
        if (transcriptEndRef.current) {
            transcriptEndRef.current.scrollIntoView({ behavior: 'smooth' });
        }
    }, [transcript]);

    // --- Cleanup ---

    const cleanupAudioResources = async () => {
        isSessionActive.current = false;
        isAiSpeakingRef.current = false;
        setIsAiSpeaking(false);
        nextAudioStartTimeRef.current = 0;

        // Stop all playing sources
        activeSourcesRef.current.forEach(source => {
            try { source.stop(); } catch(e) {}
        });
        activeSourcesRef.current.clear();

        if (sessionRef.current) {
             sessionRef.current = null;
        }

        if (audioRefs.current.scriptProcessor) {
            try { audioRefs.current.scriptProcessor.disconnect(); } catch(e) {}
            audioRefs.current.scriptProcessor = null;
        }
        if (audioRefs.current.source) {
            try { audioRefs.current.source.disconnect(); } catch(e) {}
            audioRefs.current.source = null;
        }
        if (audioRefs.current.stream) {
            audioRefs.current.stream.getTracks().forEach(track => track.stop());
            audioRefs.current.stream = null;
        }
        if (audioRefs.current.inputAudioContext) {
            try { await audioRefs.current.inputAudioContext.close(); } catch(e) {}
            audioRefs.current.inputAudioContext = null;
        }
        if (audioRefs.current.outputAudioContext) {
            try { await audioRefs.current.outputAudioContext.close(); } catch(e) {}
            audioRefs.current.outputAudioContext = null;
            audioRefs.current.outputCompressor = null;
        }
    };

    // --- Handlers ---

    const handleSignIn = async () => {
        try {
            await signInWithPopup(auth, googleProvider);
        } catch (err: any) {
            console.error("Sign in failed", err);
            setError("Sign in failed. Please try again.");
        }
    };

    const handleSignOut = async () => {
        try {
            await signOut(auth);
            setScreen('home');
        } catch (err: any) {
            console.error("Sign out failed", err);
        }
    };

    const handleGenerateBriefing = async () => {
        setLoadingAction(resumeFile ? 'analyzing_file' : 'generating_briefing');
        setError(null);
        setBriefingText('');
        
        let currentResumeAnalysis = '';
        let companyGrounding = '';

        try {
            const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
            
            if (resumeFile) {
                try {
                    const base64Data = await fileToBase64(resumeFile);
                    let resumePrompt = "";
                    if (sessionType === 'interview') {
                         resumePrompt = "You are an expert technical interviewer. Analyze this candidate's resume. Extract the candidate's name (if available), key technical skills, detailed work history, and specifically the details of any projects mentioned. Provide a structured summary that an interviewer can use to ask specific, deep-dive questions about their actual experience. Focus on what they built, technologies used, and their specific role.";
                    } else {
                         resumePrompt = "You are an expert presentation coach and fact-checker. Analyze these slides/document. Extract a structured list of KEY FACTS, DATA POINTS, DEFINITIONS, and MAIN ARGUMENTS. I need to use this to fact-check the presenter in real-time if they say something wrong. Also summarize the intended narrative flow.";
                    }

                    const resumeResponse = await ai.models.generateContent({
                        model: 'gemini-3-flash-preview',
                        contents: {
                            parts: [
                                { inlineData: { mimeType: 'application/pdf', data: base64Data } },
                                { text: resumePrompt }
                            ]
                        }
                    });
                    currentResumeAnalysis = resumeResponse.text || '';
                    setResumeAnalysis(currentResumeAnalysis);
                } catch (resumeErr: any) {
                    console.error("File analysis failed", resumeErr);
                }
            }

            // Company Grounding
            if (sessionType === 'interview' && (settings.company || settings.jobDescription)) {
                setLoadingAction('grounding_company');
                const groundingPrompt = `I am preparing for an interview at '${settings.company}' for the role of '${settings.role}'. 
                ${settings.jobDescription ? `Here is the job description/link: ${settings.jobDescription}` : ''}
                Please use Google Search to find:
                1. Recent interview questions for this role at this company.
                2. The company's core values and culture.
                3. Any recent news or major projects the company is working on that would be relevant to an interviewee.
                Provide a concise summary that can be used to tailor a mock interview.`;

                try {
                    const groundingResponse = await ai.models.generateContent({
                        model: 'gemini-3-flash-preview',
                        contents: groundingPrompt,
                        config: {
                            tools: [{ googleSearch: {} }]
                        }
                    });
                    companyGrounding = groundingResponse.text || '';
                } catch (groundErr: any) {
                    console.error("Company grounding failed", groundErr);
                }
            }
            
            setLoadingAction('generating_briefing');
            let textPrompt = "";
            if (sessionType === 'interview') {
                textPrompt = `Generate a short, friendly, and professional welcome message for a job interview. The role is '${settings.role}', the focus category is '${settings.topicCategory}', the specific topics are '${settings.topics}', and the difficulty level is '${settings.difficulty}'. Welcome the candidate, state the role and topics, and wish them luck. The message must be entirely in ${settings.language}.`;
                if (settings.company) {
                    textPrompt += `\n\nTarget Company: ${settings.company}. Mention that this interview is specifically tailored for ${settings.company}.`;
                }
                if (currentResumeAnalysis) {
                    textPrompt += `\n\nContext: The candidate has uploaded a resume. Here is the summary: ${currentResumeAnalysis}. Acknowledge that you have reviewed their resume and mention that you will be asking questions about their projects.`;
                }
                if (companyGrounding) {
                    textPrompt += `\n\nCompany Insights (use this to make the welcome more specific): ${companyGrounding}`;
                }
            } else {
                textPrompt = `Generate a short, encouraging welcome message for a ${sessionType === 'seminar' ? 'seminar' : 'presentation'} practice session. The user is presenting on '${settings.role}' to an audience of '${settings.topics}'. The focus category is '${settings.topicCategory}' and the difficulty level is '${settings.difficulty}'. Welcome them, acknowledge you have reviewed their materials (if any), and ask them to begin their presentation whenever they are ready. State that you will listen actively and interrupt ONLY if you hear a factual error based on their slides. The message must be entirely in ${settings.language}.`;
                if (currentResumeAnalysis) {
                    textPrompt += `\n\nContext: The user has uploaded slides. Summary: ${currentResumeAnalysis}.`;
                }
            }
            
            const textResponse = await ai.models.generateContent({
                model: 'gemini-3-flash-preview',
                contents: textPrompt,
            });
            setBriefingText(textResponse.text || '');
            
            // Store grounding in resumeAnalysis if it's an interview so it gets passed to the live session
            if (companyGrounding) {
                setResumeAnalysis(prev => prev + "\n\nCOMPANY GROUNDING:\n" + companyGrounding);
            }

            setLoadingAction(null);
            setScreen('briefing');

        } catch (err: any) {
            console.error("Error:", err);
            setError(err.message);
            setLoadingAction(null);
        }
    };

    const handleStartLiveSession = async () => {
        setScreen('interview');
        setLoadingAction('connecting');
        setError(null);
        setTranscript([]);
        
        await cleanupAudioResources();
        
        isSessionActive.current = true;
        isAiSpeakingRef.current = false;
        transcriptionBuffer.current = { input: '', output: '' };
        nextAudioStartTimeRef.current = 0;

        try {
            const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
            
            // Audio Contexts
            // NOTE: Use system default sample rate for output to avoid resampling artifacts/stuttering
            const outputCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
            const inputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
            
            audioRefs.current.outputAudioContext = outputCtx;
            audioRefs.current.inputAudioContext = inputCtx;

            // Add Dynamics Compressor to Output Chain for "Radio Voice" quality
            const compressor = outputCtx.createDynamicsCompressor();
            compressor.threshold.value = -20;
            compressor.knee.value = 30;
            compressor.ratio.value = 12;
            compressor.attack.value = 0.003;
            compressor.release.value = 0.25;
            compressor.connect(outputCtx.destination);
            audioRefs.current.outputCompressor = compressor;
            
            // Stream Setup
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
            audioRefs.current.stream = stream;
            
            if (videoRef.current) {
                videoRef.current.srcObject = stream;
            }

            // System Instructions
            let systemInstructionText = sessionType === 'interview' ? 
                `You are a Senior HR + Technical Interviewer. Role: '${settings.role}'. ${settings.company ? `Target Company: '${settings.company}'.` : ''} Focus Category: '${settings.topicCategory}'. Specific Topics: '${settings.topics}'. Language: ${settings.language}. Difficulty: ${settings.difficulty}.
                RULES: 
                1. Ask ONE question at a time. Wait for the user to answer.
                2. Focus questions primarily on the category: ${settings.topicCategory}.
                3. Tailor question complexity to the difficulty level: ${settings.difficulty}. 
                4. Provide feedback and coaching based on the difficulty level.
                5. Wait for the user to answer before moving to the next question.
                6. VOICE EMOTION ANALYSIS: Pay close attention to the user's vocal tone, pace, and volume. Note if they sound nervous, confident, hesitant, or enthusiastic. You will use these observations to provide vocal coaching in the final feedback.
                STAGES: Introduction, Experience Check, Technical Questions, Behavioral Questions.` :
                `You are a Presentation Coach. Topic: '${settings.role}'. Audience: '${settings.topics}'. Focus Category: '${settings.topicCategory}'. Language: ${settings.language}. Difficulty: ${settings.difficulty}.
                GOAL: Listen to the user's presentation. Only interrupt if there is a factual error or if clarity is lost. 
                VOICE EMOTION ANALYSIS: Pay close attention to the user's vocal tone, pace, and volume. Note if they sound nervous, confident, hesitant, or enthusiastic. You will use these observations to provide vocal coaching in the final feedback.
                Tailor your feedback and interruptions to the difficulty level: ${settings.difficulty}.
                Otherwise, provide a summary at the end.`;

            if (resumeAnalysis) systemInstructionText += `\n\nCONTEXT FROM RESUME/DOCS/GROUNDING:\n${resumeAnalysis}`;

            const sessionPromise = ai.live.connect({
                model: 'gemini-2.5-flash-native-audio-preview-12-2025',
                callbacks: {
                    onopen: () => {
                        if (!isSessionActive.current) return;
                        setLoadingAction(null);
                        
                        // Input Processing
                        const ctx = audioRefs.current.inputAudioContext;
                        if (!ctx) return;
                        
                        const source = ctx.createMediaStreamSource(stream);
                        const scriptProcessor = ctx.createScriptProcessor(4096, 1, 1);
                        
                        scriptProcessor.onaudioprocess = (e) => {
                            if (!isSessionActive.current) return;
                            
                            // Mute input if AI is speaking to prevent echo
                            if (isAiSpeakingRef.current) {
                                return;
                            }

                            const inputData = e.inputBuffer.getChannelData(0);
                            const pcmBlob = createBlob(inputData);
                            
                            sessionPromise.then(session => {
                                session.sendRealtimeInput({ media: pcmBlob });
                            });
                        };

                        source.connect(scriptProcessor);
                        scriptProcessor.connect(ctx.destination);
                        
                        audioRefs.current.source = source;
                        audioRefs.current.scriptProcessor = scriptProcessor;
                    },
                    onmessage: async (msg: LiveServerMessage) => {
                        if (!isSessionActive.current) return;

                        // Transcription
                        if (msg.serverContent?.inputTranscription) {
                            transcriptionBuffer.current.input += msg.serverContent.inputTranscription.text;
                        }
                        if (msg.serverContent?.outputTranscription) {
                            transcriptionBuffer.current.output += msg.serverContent.outputTranscription.text;
                        }

                        if (msg.serverContent?.turnComplete) {
                            const inText = transcriptionBuffer.current.input.trim();
                            const outText = transcriptionBuffer.current.output.trim();
                            
                            if (inText) setTranscript(prev => [...prev, { speaker: 'user', text: inText }]);
                            if (outText) setTranscript(prev => [...prev, { speaker: 'ai', text: outText }]);
                            
                            transcriptionBuffer.current = { input: '', output: '' };
                        }
                        
                        // Handle Interruption
                        if (msg.serverContent?.interrupted) {
                            // Stop all currently playing audio immediately
                            activeSourcesRef.current.forEach(source => {
                                try { source.stop(); } catch(e) {}
                            });
                            activeSourcesRef.current.clear();
                            nextAudioStartTimeRef.current = 0;
                            setIsAiSpeaking(false);
                            isAiSpeakingRef.current = false;
                            return; // Stop processing this message
                        }

                        // Audio Output
                        const base64Audio = msg.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
                        if (base64Audio && audioRefs.current.outputAudioContext) {
                            const ctx = audioRefs.current.outputAudioContext;
                            // NOTE: 24000Hz is the raw rate from Gemini. 
                            // Creating the buffer with 24000Hz lets the browser's native AudioContext (e.g. 48000Hz)
                            // handle the resampling efficiently.
                            const audioBuffer = await decodeAudioData(decode(base64Audio), ctx, 24000, 1);
                            
                            const source = ctx.createBufferSource();
                            source.buffer = audioBuffer;
                            
                            // Connect to compressor for better quality
                            if (audioRefs.current.outputCompressor) {
                                source.connect(audioRefs.current.outputCompressor);
                            } else {
                                source.connect(ctx.destination);
                            }
                            
                            // Advanced Scheduling with Jitter Buffer
                            // If we have fallen behind (current time > next start time), add a small buffer (latency)
                            // to ensure continuous playback for the incoming stream.
                            const currentTime = ctx.currentTime;
                            if (nextAudioStartTimeRef.current < currentTime) {
                                nextAudioStartTimeRef.current = currentTime + 0.05; // 50ms jitter buffer
                            }
                            
                            source.start(nextAudioStartTimeRef.current);
                            nextAudioStartTimeRef.current += audioBuffer.duration;
                            
                            // Track active source
                            activeSourcesRef.current.add(source);
                            
                            source.onended = () => {
                                activeSourcesRef.current.delete(source);
                                if (activeSourcesRef.current.size === 0) {
                                    setIsAiSpeaking(false);
                                    isAiSpeakingRef.current = false;
                                }
                            };

                            setIsAiSpeaking(true);
                            isAiSpeakingRef.current = true;
                        }
                    },
                    onclose: () => {
                        console.log("Session closed");
                    },
                    onerror: (err) => {
                        console.error("Session error", err);
                        setError("Connection error");
                    }
                },
                config: {
                    responseModalities: [Modality.AUDIO],
                    inputAudioTranscription: {},
                    outputAudioTranscription: {},
                    speechConfig: {
                        voiceConfig: {
                            prebuiltVoiceConfig: { voiceName: settings.voice || 'Zephyr' },
                        },
                    },
                    systemInstruction: systemInstructionText,
                    tools: [{ googleSearch: {} }]
                }
            });
            
            sessionRef.current = await sessionPromise;

        } catch (e: any) {
            console.error(e);
            setError(e.message);
            setLoadingAction(null);
        }
    };

    const handleEndSession = async () => {
        setLoadingAction('generating_feedback');
        const sessionTranscript = [...transcript];
        await cleanupAudioResources();
        
        if (sessionTranscript.length < 2) {
            setScreen('setup');
            setLoadingAction(null);
            return;
        }

        try {
            const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
            const prompt = `Analyze the following interview/presentation transcript and provide detailed feedback.
            Role: ${settings.role}
            ${settings.company ? `Target Company: ${settings.company}` : ''}
            Topics: ${settings.topics}
            Difficulty: ${settings.difficulty}
            
            Transcript:
            ${sessionTranscript.map(m => `${m.speaker.toUpperCase()}: ${m.text}`).join('\n')}
            
            Return the analysis in JSON format with the following structure:
            {
                "overallScore": number (0-100),
                "metrics": [
                    { "name": "Relevance", "score": number (0-100), "explanation": "string" },
                    { "name": "Clarity", "score": number (0-100), "explanation": "string" },
                    { "name": "Confidence", "score": number (0-100), "explanation": "string" },
                    { "name": "Technical Depth", "score": number (0-100), "explanation": "string" }
                ],
                "vocalAnalysis": {
                    "primaryEmotion": "string",
                    "confidenceLevel": "string",
                    "pacing": "string",
                    "toneObservations": "string",
                    "coachingTip": "string"
                },
                "summary": "string",
                "strengths": ["string"],
                "improvements": ["string"],
                "studyPlan": [
                    { 
                        "day": number, 
                        "focus": "string", 
                        "tasks": ["string"], 
                        "resources": [{ "title": "string", "url": "string" }] 
                    }
                ],
                "modelAnswers": [
                    { 
                        "question": "string", 
                        "userAnswer": "string", 
                        "modelAnswer": "string", 
                        "whyBetter": "string" 
                    }
                ]
            }
            
            For 'studyPlan', generate a 3-day roadmap based on the weaknesses. Include real, relevant links to articles or documentation (e.g., MDN, official docs, or reputable tech blogs).
            For 'modelAnswers', identify 2-3 questions where the user's answer was weak and provide a 'Perfect Answer' tailored to their background (based on resume if provided).`;

            const response = await ai.models.generateContent({
                model: 'gemini-3-flash-preview',
                contents: prompt,
                config: { responseMimeType: 'application/json' }
            });

            const result = JSON.parse(response.text || '{}');
            setFeedback(result);
            setScreen('feedback');

            // Save to Firebase if user is logged in
            if (user) {
                try {
                    await addDoc(collection(db, "sessions"), {
                        userId: user.uid,
                        userEmail: user.email,
                        sessionType,
                        settings,
                        feedback: result,
                        timestamp: Timestamp.now(),
                        transcript: sessionTranscript
                    });
                } catch (dbErr) {
                    console.error("Error saving session to DB:", dbErr);
                }
            }
        } catch (err: any) {
            console.error("Feedback generation failed", err);
            setError("Failed to generate feedback. Returning to setup.");
            setTimeout(() => setScreen('setup'), 3000);
        } finally {
            setLoadingAction(null);
        }
    };

    // --- Render ---

    if (!user) {
        return <AuthScreen onAuthSuccess={() => setScreen('home')} />;
    }

    if (!user.emailVerified && user.providerData[0]?.providerId === 'password') {
        return <VerifyEmailScreen user={user} onSignOut={handleSignOut} />;
    }

    return (
        <div className="min-h-screen bg-brand-gradient flex items-center justify-center p-4 md:p-8 font-display selection:bg-blue-100">
            {/* Main Container */}
            <div className="w-full max-w-6xl min-h-[85vh] bg-white/40 backdrop-blur-2xl rounded-[2.5rem] shadow-2xl border border-white/30 overflow-hidden flex flex-col relative">
                
                {/* Header (Only on Home, Setup, or Profile) */}
                {(screen === 'home' || screen === 'setup' || screen === 'profile') && (
                    <header className="px-8 py-6 flex items-center justify-between z-10">
                        <div className="flex items-center gap-3 cursor-pointer" onClick={() => setScreen('home')}>
                            <div className="w-10 h-10 bg-indigo-100 rounded-xl flex items-center justify-center shadow-inner">
                                <span className="material-symbols-outlined text-indigo-600 text-2xl">psychology</span>
                            </div>
                            <h1 className="text-2xl font-extrabold tracking-tight text-slate-800">SpeakEasy AI</h1>
                        </div>
                        <div className="flex items-center gap-4">
                            {user ? (
                                <div className="flex items-center gap-3">
                                    <div className="text-right hidden sm:block">
                                        <p className="text-xs font-black text-slate-900 leading-none">{user.displayName}</p>
                                        <div className="flex gap-2 justify-end mt-1">
                                            <button 
                                                onClick={() => setScreen('dashboard')}
                                                className="text-[10px] font-bold text-emerald-600 hover:text-emerald-700 transition-colors"
                                            >
                                                Dashboard
                                            </button>
                                            <span className="text-[10px] text-slate-300">|</span>
                                            <button 
                                                onClick={() => setScreen('profile')}
                                                className="text-[10px] font-bold text-indigo-600 hover:text-indigo-700 transition-colors"
                                            >
                                                Profile
                                            </button>
                                            <span className="text-[10px] text-slate-300">|</span>
                                            <button 
                                                onClick={handleSignOut}
                                                className="text-[10px] font-bold text-slate-500 hover:text-red-500 transition-colors"
                                            >
                                                Sign Out
                                            </button>
                                        </div>
                                    </div>
                                    <div 
                                        onClick={() => setScreen('profile')}
                                        className="cursor-pointer group relative"
                                    >
                                        {user.photoURL ? (
                                            <img src={user.photoURL} alt="Profile" className="w-10 h-10 rounded-xl border border-white shadow-sm group-hover:shadow-md transition-all" referrerPolicy="no-referrer" />
                                        ) : (
                                            <div className="w-10 h-10 bg-indigo-100 rounded-xl flex items-center justify-center text-indigo-600 font-bold group-hover:bg-indigo-200 transition-all">
                                                {user.displayName?.charAt(0)}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            ) : (
                                <button 
                                    onClick={handleSignIn}
                                    className="px-6 py-2 bg-white text-indigo-600 rounded-full text-sm font-bold shadow-sm hover:shadow-md transition-all"
                                >
                                    Sign In
                                </button>
                            )}
                            <span className="material-symbols-outlined text-slate-500 cursor-pointer hover:text-slate-800 transition-colors">help</span>
                        </div>
                    </header>
                )}

                {/* Content Area */}
                <div className="flex-1 flex flex-col overflow-y-auto custom-scrollbar">
                    {error && (
                        <div className="mx-8 mt-4 bg-red-500/10 border border-red-500/20 text-red-700 px-6 py-3 rounded-2xl flex items-center gap-3 animate-pulse">
                            <span className="material-symbols-outlined">error</span>
                            <span className="font-medium">{error}</span>
                        </div>
                    )}

                    {screen === 'profile' && (
                        <ProfileScreen user={user} onBack={() => setScreen('home')} />
                    )}

                    {screen === 'dashboard' && user && (
                        <DashboardScreen 
                            user={user} 
                            sessions={dashboardSessions} 
                            onBack={() => setScreen('home')} 
                            onViewSession={(s) => {
                                setFeedback(s.feedback);
                                setSettings(s.settings);
                                setSessionType(s.sessionType);
                                setTranscript(s.transcript || []);
                                setScreen('feedback');
                            }}
                        />
                    )}

                    {screen === 'home' && (
                        <div className="flex-1 flex flex-col items-center justify-center px-8 py-12 text-center">
                            <h2 className="text-5xl md:text-7xl font-black text-slate-900 mb-6 leading-[1.1]">
                                Master Your <br />
                                <span className="text-indigo-600">Next Conversation</span>
                            </h2>
                            <p className="text-slate-600 text-lg md:text-xl max-w-2xl mb-12 font-medium leading-relaxed">
                                AI-powered simulation for interviews, presentations, and academic defenses. 
                                Real-time feedback, zero judgement.
                            </p>

                            {/* Feature Cards */}
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 w-full max-w-5xl mb-16">
                                {[
                                    { id: 'interview', title: 'Job Interview', desc: 'Behavioral & technical prep', icon: 'work', color: 'blue' },
                                    { id: 'presentation', title: 'Presentation', desc: 'Slide & delivery coaching', icon: 'present_to_all', color: 'purple' },
                                    { id: 'seminar', title: 'Seminar Defense', desc: 'Academic rigor check', icon: 'school', color: 'orange' }
                                ].map(card => (
                                    <div 
                                        key={card.id}
                                        onClick={() => { setSessionType(card.id as SessionType); setScreen('setup'); }}
                                        className="bg-white/60 hover:bg-white/80 p-8 rounded-[2rem] border border-white/50 shadow-sm hover:shadow-xl transition-all cursor-pointer group text-left"
                                    >
                                        <div className={`w-12 h-12 rounded-2xl flex items-center justify-center mb-6 transition-transform group-hover:scale-110 ${
                                            card.color === 'blue' ? 'bg-blue-50 text-blue-600' : 
                                            card.color === 'purple' ? 'bg-purple-50 text-purple-600' : 'bg-orange-50 text-orange-600'
                                        }`}>
                                            <span className="material-symbols-outlined text-2xl">{card.icon}</span>
                                        </div>
                                        <h3 className="text-xl font-bold text-slate-800 mb-2">{card.title}</h3>
                                        <p className="text-slate-500 text-sm font-medium">{card.desc}</p>
                                    </div>
                                ))}
                            </div>

                            {/* Testimonial Carousel */}
                            <div className="w-full max-w-3xl bg-white/50 p-8 rounded-[2.5rem] border border-white/40 relative overflow-hidden">
                                <AnimatePresence mode="wait">
                                    <motion.div 
                                        key={currentTestimonialIndex}
                                        initial={{ opacity: 0, x: 20 }}
                                        animate={{ opacity: 1, x: 0 }}
                                        exit={{ opacity: 0, x: -20 }}
                                        className="flex flex-col items-center"
                                    >
                                        <div className={`w-12 h-12 ${testimonials[currentTestimonialIndex].color} rounded-full flex items-center justify-center text-white font-bold text-xl mb-6 shadow-lg`}>
                                            {testimonials[currentTestimonialIndex].initial}
                                        </div>
                                        <p className="text-slate-700 italic text-lg mb-6 leading-relaxed font-medium min-h-[80px]">
                                            "{testimonials[currentTestimonialIndex].text}"
                                        </p>
                                        <div className="text-center">
                                            <p className="font-bold text-slate-800">{testimonials[currentTestimonialIndex].name}</p>
                                            <p className="text-slate-500 text-sm font-semibold">{testimonials[currentTestimonialIndex].role}</p>
                                        </div>
                                    </motion.div>
                                </AnimatePresence>

                                <button 
                                    type="button"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        setCurrentTestimonialIndex(prev => (prev - 1 + testimonials.length) % testimonials.length);
                                    }}
                                    className="absolute top-1/2 -translate-y-1/2 left-4 w-10 h-10 bg-white rounded-full flex items-center justify-center shadow-md cursor-pointer hover:bg-slate-50 transition-all z-50 active:scale-90"
                                >
                                    <span className="material-symbols-outlined text-slate-400">chevron_left</span>
                                </button>
                                <button 
                                    type="button"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        setCurrentTestimonialIndex(prev => (prev + 1) % testimonials.length);
                                    }}
                                    className="absolute top-1/2 -translate-y-1/2 right-4 w-10 h-10 bg-white rounded-full flex items-center justify-center shadow-md cursor-pointer hover:bg-slate-50 transition-all z-50 active:scale-90"
                                >
                                    <span className="material-symbols-outlined text-slate-400">chevron_right</span>
                                </button>

                                <div className="flex justify-center gap-2 mt-8 relative z-50">
                                    {testimonials.map((_, i) => (
                                        <button 
                                            key={i} 
                                            type="button"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                setCurrentTestimonialIndex(i);
                                            }}
                                            className={`h-2 rounded-full transition-all ${i === currentTestimonialIndex ? 'bg-indigo-600 w-6' : 'bg-slate-300 w-2 hover:bg-slate-400'}`}
                                        ></button>
                                    ))}
                                </div>
                            </div>
                        </div>
                    )}

                    {screen === 'setup' && (
                        <div className="flex-1 flex flex-col items-center justify-center px-8 py-12">
                            <motion.div 
                                initial={{ opacity: 0, scale: 0.95 }}
                                animate={{ opacity: 1, scale: 1 }}
                                className="w-full max-w-lg bg-white/40 backdrop-blur-2xl rounded-[2.5rem] p-10 border border-white/50 shadow-2xl"
                            >
                                <button 
                                    onClick={() => setScreen('home')}
                                    className="flex items-center gap-2 text-slate-500 hover:text-slate-800 font-bold mb-6 transition-colors"
                                >
                                    <span className="material-symbols-outlined text-sm">arrow_back</span>
                                    Back
                                </button>

                                <div className="text-center mb-10">
                                    <h2 className="text-4xl font-black text-slate-900 mb-2 capitalize">{sessionType} Setup</h2>
                                    <p className="text-slate-500 font-semibold">Configure your AI coach preferences</p>
                                </div>

                                <div className="space-y-6">
                                    <div>
                                        <label className="block text-[11px] font-black text-slate-400 uppercase tracking-widest mb-2 ml-1">
                                            {sessionType === 'interview' ? 'Target Role' : sessionType === 'seminar' ? 'Seminar Topic' : 'Presentation Title'}
                                        </label>
                                        <input 
                                            type="text" 
                                            className="w-full bg-white/60 border-none rounded-2xl px-6 py-4 text-slate-800 font-bold placeholder:text-slate-400 focus:ring-4 focus:ring-indigo-500/20 transition-all shadow-sm"
                                            value={settings.role}
                                            onChange={(e) => setSettings({...settings, role: e.target.value})}
                                            placeholder={
                                                sessionType === 'interview' ? "e.g. Senior Software Engineer" : 
                                                sessionType === 'seminar' ? "e.g. The Future of Sustainable Energy" : 
                                                "e.g. Annual Sales Performance Review"
                                            }
                                        />
                                    </div>

                                    {sessionType === 'interview' && (
                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                            <div>
                                                <label className="block text-[11px] font-black text-slate-400 uppercase tracking-widest mb-2 ml-1">
                                                    Target Company (Optional)
                                                </label>
                                                <input 
                                                    type="text" 
                                                    className="w-full bg-white/60 border-none rounded-2xl px-6 py-4 text-slate-800 font-bold placeholder:text-slate-400 focus:ring-4 focus:ring-indigo-500/20 transition-all shadow-sm"
                                                    value={settings.company}
                                                    onChange={(e) => setSettings({...settings, company: e.target.value})}
                                                    placeholder="e.g. Google, Meta, Netflix"
                                                />
                                            </div>
                                            <div>
                                                <label className="block text-[11px] font-black text-slate-400 uppercase tracking-widest mb-2 ml-1">
                                                    Job Description / Link (Optional)
                                                </label>
                                                <input 
                                                    type="text" 
                                                    className="w-full bg-white/60 border-none rounded-2xl px-6 py-4 text-slate-800 font-bold placeholder:text-slate-400 focus:ring-4 focus:ring-indigo-500/20 transition-all shadow-sm"
                                                    value={settings.jobDescription}
                                                    onChange={(e) => setSettings({...settings, jobDescription: e.target.value})}
                                                    placeholder="Paste JD or URL here"
                                                />
                                            </div>
                                        </div>
                                    )}

                                    {sessionType === 'interview' && (
                                        <div>
                                            <label className="block text-[11px] font-black text-slate-400 uppercase tracking-widest mb-2 ml-1">
                                                Interview Category
                                            </label>
                                            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                                                {['Technical', 'Behavioral', 'Situational', 'Mixed'].map(cat => (
                                                    <button 
                                                        key={cat}
                                                        onClick={() => setSettings({...settings, topicCategory: cat as any})}
                                                        className={`py-2 px-3 rounded-xl text-xs font-bold transition-all border ${
                                                            settings.topicCategory === cat 
                                                            ? 'bg-indigo-600 text-white border-indigo-600 shadow-md' 
                                                            : 'bg-white/60 text-slate-600 border-white/50 hover:bg-white/80'
                                                        }`}
                                                    >
                                                        {cat}
                                                    </button>
                                                ))}
                                            </div>
                                        </div>
                                    )}

                                    <div>
                                        <label className="block text-[11px] font-black text-slate-400 uppercase tracking-widest mb-2 ml-1">
                                            {sessionType === 'interview' ? 'Focus Topics' : sessionType === 'seminar' ? 'Audience & Objectives' : 'Target Audience'}
                                        </label>
                                        <textarea 
                                            className="w-full bg-white/60 border-none rounded-2xl px-6 py-4 text-slate-800 font-bold placeholder:text-slate-400 focus:ring-4 focus:ring-indigo-500/20 transition-all shadow-sm min-h-[100px] resize-none"
                                            value={settings.topics}
                                            onChange={(e) => setSettings({...settings, topics: e.target.value})}
                                            placeholder={
                                                sessionType === 'interview' ? "e.g. React, System Design, Leadership" : 
                                                sessionType === 'seminar' ? "e.g. Environmental Science Students, Analyzing Solar Grid Efficiency" : 
                                                "e.g. Regional Managers, Highlighting Growth in Emerging Markets"
                                            }
                                        />
                                    </div>

                                    <div className="grid grid-cols-2 gap-4">
                                        <div>
                                            <label className="block text-[11px] font-black text-slate-400 uppercase tracking-widest mb-2 ml-1">AI Voice</label>
                                            <select 
                                                className="w-full bg-white/60 border-none rounded-2xl px-6 py-4 text-slate-800 font-bold focus:ring-4 focus:ring-indigo-500/20 transition-all shadow-sm appearance-none cursor-pointer"
                                                value={settings.voice}
                                                onChange={(e) => setSettings({...settings, voice: e.target.value})}
                                            >
                                                {['Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir'].map(v => <option key={v} value={v}>{v}</option>)}
                                            </select>
                                        </div>
                                        <div>
                                            <label className="block text-[11px] font-black text-slate-400 uppercase tracking-widest mb-2 ml-1">Language</label>
                                            <select 
                                                className="w-full bg-white/60 border-none rounded-2xl px-6 py-4 text-slate-800 font-bold focus:ring-4 focus:ring-indigo-500/20 transition-all shadow-sm appearance-none cursor-pointer"
                                                value={settings.language}
                                                onChange={(e) => setSettings({...settings, language: e.target.value})}
                                            >
                                                {['English', 'Spanish', 'French', 'German', 'Hindi'].map(l => <option key={l} value={l}>{l}</option>)}
                                            </select>
                                        </div>
                                    </div>

                                    <div className="grid grid-cols-3 gap-4">
                                        <div>
                                            <label className="block text-[11px] font-black text-slate-400 uppercase tracking-widest mb-2 ml-1">Difficulty</label>
                                            <select 
                                                className="w-full bg-white/60 border-none rounded-2xl px-4 py-4 text-slate-800 font-bold focus:ring-4 focus:ring-indigo-500/20 transition-all shadow-sm appearance-none cursor-pointer text-sm"
                                                value={settings.difficulty}
                                                onChange={(e) => setSettings({...settings, difficulty: e.target.value as any})}
                                            >
                                                {['Easy', 'Medium', 'Hard'].map(d => <option key={d} value={d}>{d}</option>)}
                                            </select>
                                        </div>
                                        <div>
                                            <label className="block text-[11px] font-black text-slate-400 uppercase tracking-widest mb-2 ml-1">Session Mode</label>
                                            <select 
                                                className="w-full bg-white/60 border-none rounded-2xl px-4 py-4 text-slate-800 font-bold focus:ring-4 focus:ring-indigo-500/20 transition-all shadow-sm appearance-none cursor-pointer text-sm"
                                                value={settings.mode}
                                                onChange={(e) => setSettings({...settings, mode: e.target.value})}
                                            >
                                                {['Standard', 'Speed', 'Deep Dive'].map(m => <option key={m} value={m}>{m}</option>)}
                                            </select>
                                        </div>
                                        <div>
                                            <label className="block text-[11px] font-black text-slate-400 uppercase tracking-widest mb-2 ml-1">Q Limit</label>
                                            <select 
                                                className="w-full bg-white/60 border-none rounded-2xl px-4 py-4 text-slate-800 font-bold focus:ring-4 focus:ring-indigo-500/20 transition-all shadow-sm appearance-none cursor-pointer text-sm"
                                                value={settings.qLimit}
                                                onChange={(e) => setSettings({...settings, qLimit: e.target.value})}
                                            >
                                                {['Unlimited', '5 Questions', '10 Questions'].map(q => <option key={q} value={q}>{q}</option>)}
                                            </select>
                                        </div>
                                    </div>

                                    <div className="pt-4">
                                        <button 
                                            onClick={() => document.getElementById('file-upload')?.click()}
                                            className="w-full py-4 bg-white/20 border-2 border-dashed border-white/40 text-slate-700 rounded-2xl font-bold hover:bg-white/30 transition-all flex items-center justify-center gap-3"
                                        >
                                            <span className="material-symbols-outlined">upload_file</span>
                                            {resumeFile ? resumeFile.name : `Upload ${sessionType === 'interview' ? 'Resume' : sessionType === 'seminar' ? 'Seminar Paper/Slides' : 'Slides'} (PDF)`}
                                        </button>
                                        <input 
                                            id="file-upload"
                                            type="file" 
                                            accept="application/pdf"
                                            onChange={(e) => setResumeFile(e.target.files ? e.target.files[0] : null)}
                                            className="hidden"
                                        />
                                    </div>

                                    <button 
                                        onClick={handleGenerateBriefing}
                                        disabled={!!loadingAction}
                                        className="w-full py-5 bg-blue-600 hover:bg-blue-700 text-white rounded-[1.5rem] font-black text-lg shadow-xl hover:shadow-blue-500/40 transition-all flex justify-center items-center gap-3 mt-6 disabled:opacity-50"
                                    >
                                        {loadingAction ? (
                                            <>
                                                <span className="material-symbols-outlined animate-spin">progress_activity</span>
                                                {loadingAction === 'analyzing_file' ? 'Analyzing Resume...' : 
                                                 loadingAction === 'grounding_company' ? 'Grounding Company Data...' :
                                                 loadingAction === 'generating_briefing' ? 'Preparing Coach...' : 'Processing...'}
                                            </>
                                        ) : (
                                            <>Start Session</>
                                        )}
                                    </button>
                                </div>
                            </motion.div>
                        </div>
                    )}

                    {screen === 'briefing' && (
                        <div className="flex-1 flex flex-col items-center justify-center px-8 py-12">
                            <div className="w-full max-w-2xl bg-white/60 p-10 rounded-[2.5rem] border border-white/50 shadow-xl">
                                <div className="flex items-center gap-4 mb-8">
                                    <div className="w-14 h-14 bg-indigo-100 rounded-2xl flex items-center justify-center">
                                        <span className="material-symbols-outlined text-indigo-600 text-3xl">assignment</span>
                                    </div>
                                    <div>
                                        <h2 className="text-3xl font-black text-slate-900">Session Briefing</h2>
                                        <p className="text-slate-500 font-bold">Review your preparation guide</p>
                                    </div>
                                </div>
                                
                                <div className="prose prose-slate max-w-none text-slate-700 leading-relaxed whitespace-pre-wrap font-medium text-lg bg-white/40 p-6 rounded-2xl mb-10 border border-white/30">
                                    {briefingText}
                                </div>
                                
                                <div className="flex gap-4">
                                    <button 
                                        onClick={() => setScreen('setup')}
                                        className="flex-1 py-4 px-6 bg-white border-2 border-slate-100 text-slate-600 rounded-2xl font-black hover:bg-slate-50 transition-all"
                                    >
                                        Back
                                    </button>
                                    <button 
                                        onClick={handleStartLiveSession}
                                        className="flex-1 py-4 px-6 bg-indigo-600 text-white rounded-2xl font-black shadow-lg hover:bg-indigo-700 transition-all flex items-center justify-center gap-3"
                                    >
                                        <span className="material-symbols-outlined">mic</span>
                                        Start Live Session
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}

                    {screen === 'interview' && (
                        <div className="flex-1 grid grid-cols-1 lg:grid-cols-3 gap-8 p-8 h-full">
                            {/* Left Column: Video & Status */}
                            <div className="lg:col-span-2 flex flex-col gap-6">
                                <div className="relative bg-slate-900 rounded-[2.5rem] overflow-hidden shadow-2xl aspect-video flex items-center justify-center group border-4 border-white/20">
                                    <video 
                                        ref={videoRef} 
                                        autoPlay 
                                        playsInline 
                                        muted 
                                        className={`w-full h-full object-cover transform scale-x-[-1] transition-opacity ${isMuted ? 'opacity-90' : 'opacity-100'}`}
                                    />
                                    
                                    <div className="absolute top-6 left-6 flex gap-3">
                                        <div className={`px-4 py-2 rounded-full text-xs font-black uppercase tracking-widest flex items-center gap-2 backdrop-blur-xl border border-white/20 ${isAiSpeaking ? 'bg-emerald-500/90 text-white' : 'bg-slate-800/60 text-slate-300'}`}>
                                            <span className={`w-2 h-2 rounded-full ${isAiSpeaking ? 'bg-white animate-pulse' : 'bg-slate-400'}`}></span>
                                            {isAiSpeaking ? 'AI Speaking' : 'Listening...'}
                                        </div>
                                        <div className="px-4 py-2 rounded-full text-xs font-black uppercase tracking-widest bg-indigo-600/90 text-white backdrop-blur-xl border border-white/20">
                                            {settings.difficulty} Mode
                                        </div>
                                    </div>

                                    <div className="absolute bottom-6 left-6 right-6 flex justify-between items-center">
                                        <div className="flex gap-3">
                                            <button 
                                                onClick={() => setIsMuted(!isMuted)}
                                                className={`w-14 h-14 rounded-2xl flex items-center justify-center backdrop-blur-xl transition-all border border-white/20 ${isMuted ? 'bg-rose-500/90 text-white' : 'bg-white/20 text-white hover:bg-white/30'}`}
                                            >
                                                <span className="material-symbols-outlined text-2xl">{isMuted ? 'mic_off' : 'mic'}</span>
                                            </button>
                                            <button className="w-14 h-14 rounded-2xl flex items-center justify-center bg-white/20 text-white backdrop-blur-xl border border-white/20 hover:bg-white/30 transition-all">
                                                <span className="material-symbols-outlined text-2xl">videocam</span>
                                            </button>
                                        </div>
                                        
                                        <button 
                                            onClick={handleEndSession}
                                            className="px-8 py-4 bg-rose-500 text-white rounded-2xl font-black text-sm shadow-lg hover:bg-rose-600 transition-all flex items-center gap-2"
                                        >
                                            <span className="material-symbols-outlined text-sm">close</span>
                                            End Session
                                        </button>
                                    </div>
                                </div>
                                
                                {loadingAction === 'connecting' && (
                                    <div className="flex items-center justify-center p-12 bg-white/60 rounded-[2rem] border border-white/50 backdrop-blur-xl">
                                        <div className="text-center">
                                            <span className="material-symbols-outlined text-5xl text-indigo-600 animate-spin mb-6">progress_activity</span>
                                            <p className="text-slate-800 font-black text-xl">Connecting to AI Coach...</p>
                                            <p className="text-slate-500 font-bold mt-2">Setting up your personalized session</p>
                                        </div>
                                    </div>
                                )}
                            </div>

                            {/* Right Column: Transcript */}
                            <div className="bg-white/60 rounded-[2.5rem] shadow-xl border border-white/50 backdrop-blur-xl flex flex-col h-full overflow-hidden">
                                <div className="p-6 border-b border-white/50 bg-white/40 flex items-center justify-between">
                                    <h3 className="font-black text-slate-800 flex items-center gap-3 uppercase tracking-widest text-xs">
                                        <span className="material-symbols-outlined text-indigo-600">forum</span>
                                        Live Transcript
                                    </h3>
                                    <div className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse"></div>
                                </div>
                                <div className="flex-1 overflow-y-auto p-6 space-y-6 custom-scrollbar">
                                    {transcript.length === 0 && (
                                        <div className="flex flex-col items-center justify-center h-full text-center opacity-40">
                                            <span className="material-symbols-outlined text-5xl mb-4">chat_bubble</span>
                                            <p className="text-slate-500 font-bold italic">Conversation will appear here...</p>
                                        </div>
                                    )}
                                    {transcript.map((msg, i) => (
                                        <div key={i} className={`flex flex-col ${msg.speaker === 'user' ? 'items-end' : 'items-start'}`}>
                                            <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1 ml-1">
                                                {msg.speaker === 'user' ? 'You' : 'AI Coach'}
                                            </span>
                                            <div className={`max-w-[90%] rounded-2xl px-5 py-3.5 text-sm leading-relaxed font-semibold shadow-sm ${
                                                msg.speaker === 'user' 
                                                ? 'bg-indigo-600 text-white rounded-tr-none' 
                                                : 'bg-white text-slate-800 rounded-tl-none border border-slate-100'
                                            }`}>
                                                {msg.text}
                                            </div>
                                        </div>
                                    ))}
                                    <div ref={transcriptEndRef} />
                                </div>
                            </div>
                        </div>
                    )}

                    {screen === 'feedback' && feedback && (
                        <div className="flex-1 flex flex-col items-center justify-start px-8 py-12 overflow-y-auto custom-scrollbar">
                            <motion.div 
                                initial={{ opacity: 0, y: 20 }}
                                animate={{ opacity: 1, y: 0 }}
                                className="w-full max-w-4xl bg-white/60 p-10 rounded-[2.5rem] border border-white/50 shadow-xl backdrop-blur-xl"
                            >
                                <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-12 gap-6">
                                    <div>
                                        <h1 className="text-4xl md:text-5xl font-black text-slate-900 tracking-tighter mb-2">
                                            Session <span className="text-indigo-600">Complete.</span>
                                        </h1>
                                        <p className="text-slate-600 font-bold uppercase tracking-widest text-xs">
                                            Performance Analysis & Feedback
                                        </p>
                                    </div>
                                    <div className="bg-white/80 p-6 rounded-3xl shadow-xl border border-white flex flex-col items-center justify-center min-w-[140px]">
                                        <span className="text-4xl font-black text-indigo-600 leading-none">{feedback.overallScore}</span>
                                        <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest mt-1">Overall Score</span>
                                    </div>
                                </div>

                                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-12">
                                    {feedback.metrics.map((metric) => (
                                        <motion.button
                                            key={metric.name}
                                            whileHover={{ scale: 1.02 }}
                                            whileTap={{ scale: 0.98 }}
                                            onClick={() => setActiveModal(metric.name)}
                                            className="bg-white/60 hover:bg-white/80 transition-all p-5 rounded-3xl border border-white/50 text-left group"
                                        >
                                            <div className="flex justify-between items-start mb-2">
                                                <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{metric.name}</span>
                                                <span className="material-symbols-outlined text-slate-300 group-hover:text-indigo-400 transition-colors text-sm">info</span>
                                            </div>
                                            <div className="text-2xl font-black text-slate-800">{metric.score}%</div>
                                            <div className="w-full bg-slate-200 h-1.5 rounded-full mt-3 overflow-hidden">
                                                <motion.div 
                                                    initial={{ width: 0 }}
                                                    animate={{ width: `${metric.score}%` }}
                                                    className="bg-indigo-500 h-full rounded-full"
                                                />
                                            </div>
                                        </motion.button>
                                    ))}
                                </div>

                                <div className="space-y-8">
                                    <section>
                                        <h3 className="text-sm font-black text-slate-900 uppercase tracking-widest mb-4 flex items-center gap-2">
                                            <div className="w-1.5 h-1.5 bg-indigo-500 rounded-full" />
                                            Executive Summary
                                        </h3>
                                        <p className="text-slate-700 leading-relaxed font-medium bg-white/30 p-6 rounded-3xl border border-white/20">
                                            {feedback.summary}
                                        </p>
                                    </section>

                                    {feedback.vocalAnalysis && (
                                        <section className="bg-gradient-to-br from-indigo-50 to-violet-50 p-8 rounded-[2.5rem] border border-indigo-100/50 shadow-sm relative overflow-hidden">
                                            <div className="absolute top-0 right-0 p-4 opacity-10">
                                                <span className="material-symbols-outlined text-8xl text-indigo-600">graphic_eq</span>
                                            </div>
                                            <h3 className="text-sm font-black text-indigo-600 uppercase tracking-widest mb-6 flex items-center gap-2 relative z-10">
                                                <div className="w-1.5 h-1.5 bg-indigo-500 rounded-full" />
                                                Vocal & Emotional Analysis
                                            </h3>
                                            
                                            <div className="grid grid-cols-2 md:grid-cols-3 gap-6 mb-8 relative z-10">
                                                <div className="bg-white/60 p-4 rounded-2xl border border-white shadow-sm">
                                                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Primary Emotion</p>
                                                    <p className="text-lg font-black text-slate-800 capitalize">{feedback.vocalAnalysis.primaryEmotion}</p>
                                                </div>
                                                <div className="bg-white/60 p-4 rounded-2xl border border-white shadow-sm">
                                                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Confidence</p>
                                                    <p className="text-lg font-black text-slate-800">{feedback.vocalAnalysis.confidenceLevel}</p>
                                                </div>
                                                <div className="bg-white/60 p-4 rounded-2xl border border-white shadow-sm">
                                                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Pacing</p>
                                                    <p className="text-lg font-black text-slate-800">{feedback.vocalAnalysis.pacing}</p>
                                                </div>
                                            </div>

                                            <div className="space-y-4 relative z-10">
                                                <div className="bg-white/40 p-5 rounded-2xl border border-white/50">
                                                    <p className="text-[10px] font-black text-indigo-500 uppercase tracking-widest mb-2">Tone Observations</p>
                                                    <p className="text-sm text-slate-700 font-medium leading-relaxed italic">
                                                        "{feedback.vocalAnalysis.toneObservations}"
                                                    </p>
                                                </div>
                                                <div className="bg-indigo-600/5 p-5 rounded-2xl border border-indigo-600/10 flex items-start gap-4">
                                                    <div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center shrink-0 shadow-lg shadow-indigo-600/20">
                                                        <span className="material-symbols-outlined text-white text-xl">record_voice_over</span>
                                                    </div>
                                                    <div>
                                                        <p className="text-[10px] font-black text-indigo-600 uppercase tracking-widest mb-1">Vocal Coaching Tip</p>
                                                        <p className="text-sm text-slate-800 font-bold leading-relaxed">
                                                            {feedback.vocalAnalysis.coachingTip}
                                                        </p>
                                                    </div>
                                                </div>
                                            </div>
                                        </section>
                                    )}

                                    <div className="grid md:grid-cols-2 gap-8">
                                        <section>
                                            <h3 className="text-sm font-black text-emerald-600 uppercase tracking-widest mb-4 flex items-center gap-2">
                                                <div className="w-1.5 h-1.5 bg-emerald-500 rounded-full" />
                                                Key Strengths
                                            </h3>
                                            <ul className="space-y-3">
                                                {feedback.strengths.map((s, i) => (
                                                    <li key={i} className="flex items-start gap-3 text-slate-700 font-medium text-sm">
                                                        <div className="mt-1.5 w-1.5 h-1.5 bg-emerald-400 rounded-full flex-shrink-0" />
                                                        {s}
                                                    </li>
                                                ))}
                                            </ul>
                                        </section>
                                        <section>
                                            <h3 className="text-sm font-black text-amber-600 uppercase tracking-widest mb-4 flex items-center gap-2">
                                                <div className="w-1.5 h-1.5 bg-amber-500 rounded-full" />
                                                Areas for Growth
                                            </h3>
                                            <ul className="space-y-3">
                                                {feedback.improvements.map((imp, i) => (
                                                    <li key={i} className="flex items-start gap-3 text-slate-700 font-medium text-sm">
                                                        <div className="mt-1.5 w-1.5 h-1.5 bg-amber-400 rounded-full flex-shrink-0" />
                                                        {imp}
                                                    </li>
                                                ))}
                                            </ul>
                                        </section>
                                    </div>

                                    {feedback.modelAnswers && feedback.modelAnswers.length > 0 && (
                                        <section className="mt-12">
                                            <h3 className="text-sm font-black text-indigo-600 uppercase tracking-widest mb-6 flex items-center gap-2">
                                                <div className="w-1.5 h-1.5 bg-indigo-500 rounded-full" />
                                                "Perfect Answer" Re-writes
                                            </h3>
                                            <div className="space-y-6">
                                                {feedback.modelAnswers.map((ma, i) => (
                                                    <div key={i} className="bg-white/40 border border-white/50 rounded-3xl p-6 shadow-sm">
                                                        <p className="text-xs font-black text-slate-400 uppercase tracking-widest mb-2">Question</p>
                                                        <p className="text-slate-800 font-bold mb-4">{ma.question}</p>
                                                        
                                                        <div className="grid md:grid-cols-2 gap-6">
                                                            <div className="bg-rose-50/50 p-4 rounded-2xl border border-rose-100/50">
                                                                <p className="text-[10px] font-black text-rose-500 uppercase tracking-widest mb-2">Your Answer</p>
                                                                <p className="text-slate-600 text-sm italic">"{ma.userAnswer}"</p>
                                                            </div>
                                                            <div className="bg-emerald-50/50 p-4 rounded-2xl border border-emerald-100/50">
                                                                <p className="text-[10px] font-black text-emerald-600 uppercase tracking-widest mb-2">Model Answer</p>
                                                                <p className="text-slate-800 text-sm font-semibold">{ma.modelAnswer}</p>
                                                            </div>
                                                        </div>
                                                        
                                                        <div className="mt-4 pt-4 border-t border-white/30">
                                                            <p className="text-[10px] font-black text-indigo-400 uppercase tracking-widest mb-1">Why this is better</p>
                                                            <p className="text-slate-500 text-xs font-medium italic">{ma.whyBetter}</p>
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                        </section>
                                    )}

                                    {feedback.studyPlan && feedback.studyPlan.length > 0 && (
                                        <section className="mt-12">
                                            <h3 className="text-sm font-black text-violet-600 uppercase tracking-widest mb-6 flex items-center gap-2">
                                                <div className="w-1.5 h-1.5 bg-violet-500 rounded-full" />
                                                3-Day Actionable Roadmap
                                            </h3>
                                            <div className="grid md:grid-cols-3 gap-6">
                                                {feedback.studyPlan.map((day, i) => (
                                                    <div key={i} className="bg-white/40 border border-white/50 rounded-3xl p-6 shadow-sm flex flex-col">
                                                        <div className="flex items-center justify-between mb-4">
                                                            <span className="bg-violet-100 text-violet-600 px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest">Day {day.day}</span>
                                                        </div>
                                                        <p className="text-slate-800 font-black text-sm mb-4">{day.focus}</p>
                                                        <ul className="space-y-2 mb-6 flex-1">
                                                            {day.tasks.map((task, ti) => (
                                                                <li key={ti} className="flex items-start gap-2 text-slate-600 text-xs font-bold">
                                                                    <span className="material-symbols-outlined text-violet-400 text-sm">check_circle</span>
                                                                    {task}
                                                                </li>
                                                            ))}
                                                        </ul>
                                                        {day.resources && day.resources.length > 0 && (
                                                            <div className="pt-4 border-t border-white/30">
                                                                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Resources</p>
                                                                <div className="space-y-2">
                                                                    {day.resources.map((res, ri) => (
                                                                        <a 
                                                                            key={ri} 
                                                                            href={res.url} 
                                                                            target="_blank" 
                                                                            rel="noopener noreferrer"
                                                                            className="flex items-center gap-2 text-indigo-600 text-[11px] font-black hover:underline group"
                                                                        >
                                                                            <span className="material-symbols-outlined text-xs group-hover:translate-x-0.5 transition-transform">link</span>
                                                                            {res.title}
                                                                        </a>
                                                                    ))}
                                                                </div>
                                                            </div>
                                                        )}
                                                    </div>
                                                ))}
                                            </div>
                                        </section>
                                    )}
                                </div>

                                <div className="mt-12 pt-8 border-t border-white/30 flex justify-center">
                                    <button 
                                        onClick={() => setScreen('home')}
                                        className="bg-slate-900 text-white px-10 py-4 rounded-2xl font-black text-sm uppercase tracking-widest hover:bg-slate-800 transition-all shadow-xl hover:shadow-2xl active:scale-95"
                                    >
                                        Back to Home
                                    </button>
                                </div>
                            </motion.div>
                        </div>
                    )}

                    {/* Metric Detail Modal */}
                    <AnimatePresence>
                        {activeModal && (
                            <div className="fixed inset-0 z-[100] flex items-center justify-center p-6">
                                <motion.div 
                                    initial={{ opacity: 0 }}
                                    animate={{ opacity: 1 }}
                                    exit={{ opacity: 0 }}
                                    onClick={() => setActiveModal(null)}
                                    className="absolute inset-0 bg-slate-900/60 backdrop-blur-md"
                                />
                                <motion.div 
                                    initial={{ opacity: 0, scale: 0.9, y: 20 }}
                                    animate={{ opacity: 1, scale: 1, y: 0 }}
                                    exit={{ opacity: 0, scale: 0.9, y: 20 }}
                                    className="bg-white rounded-[2rem] p-8 md:p-10 max-w-lg w-full relative z-10 shadow-2xl border border-white"
                                >
                                    <div className="flex justify-between items-center mb-6">
                                        <h2 className="text-2xl font-black text-slate-900 tracking-tight">
                                            {activeModal} <span className="text-indigo-600">Analysis</span>
                                        </h2>
                                        <button 
                                            onClick={() => setActiveModal(null)}
                                            className="p-2 hover:bg-slate-100 rounded-full transition-colors"
                                        >
                                            <span className="material-symbols-outlined text-slate-400">close</span>
                                        </button>
                                    </div>
                                    
                                    <div className="flex items-center gap-4 mb-8">
                                        <div className="text-5xl font-black text-indigo-600">
                                            {feedback.metrics.find(m => m.name === activeModal)?.score}%
                                        </div>
                                        <div className="flex-1 h-3 bg-slate-100 rounded-full overflow-hidden">
                                            <motion.div 
                                                initial={{ width: 0 }}
                                                animate={{ width: `${feedback.metrics.find(m => m.name === activeModal)?.score}%` }}
                                                className="h-full bg-indigo-500 rounded-full"
                                            />
                                        </div>
                                    </div>

                                    <div className="bg-indigo-50 p-6 rounded-2xl border border-indigo-100">
                                        <p className="text-slate-700 font-medium leading-relaxed">
                                            {feedback.metrics.find(m => m.name === activeModal)?.explanation}
                                        </p>
                                    </div>

                                    <button 
                                        onClick={() => setActiveModal(null)}
                                        className="w-full mt-8 bg-indigo-600 text-white py-4 rounded-xl font-black text-sm uppercase tracking-widest hover:bg-indigo-700 transition-all"
                                    >
                                        Got it
                                    </button>
                                </motion.div>
                            </div>
                        )}
                    </AnimatePresence>
                </div>
            </div>

            {/* Global Styles for Custom Scrollbar */}
            <style>{`
                .custom-scrollbar::-webkit-scrollbar {
                    width: 6px;
                }
                .custom-scrollbar::-webkit-scrollbar-track {
                    background: transparent;
                }
                .custom-scrollbar::-webkit-scrollbar-thumb {
                    background: rgba(0, 0, 0, 0.1);
                    border-radius: 10px;
                }
                .custom-scrollbar::-webkit-scrollbar-thumb:hover {
                    background: rgba(0, 0, 0, 0.2);
                }
            `}</style>
        </div>
    );
}

const root = createRoot(document.getElementById('root')!);
root.render(<App />);