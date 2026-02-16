export interface TranscriptEntry {
    speaker: string;
    text: string;
}

export interface StrengthPoint {
    strength: string;
    example: string; // Quote
}

export interface ImprovementPoint {
    area: string;
    example: string; // Quote
    suggestion: string; // Actionable fix
}

export interface FeedbackData {
    summary: string;
    strengths: StrengthPoint[];
    improvements: ImprovementPoint[];
    tips: string[];
    overall: number;
    relevance: number;
    clarity: number;
    conciseness: number;
    technicalAccuracy: number;
}

export interface TourStep {
    targetId: string;
    title: string;
    content: string;
}
