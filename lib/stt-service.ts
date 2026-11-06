// lib/stt-service.ts — 语音识别服务（浏览器 Web Speech API）

type SpeechRecognitionAlternativeLike = { transcript: string };
type SpeechRecognitionResultLike = {
    isFinal: boolean;
    0: SpeechRecognitionAlternativeLike;
};
type SpeechRecognitionResultsLike = ArrayLike<SpeechRecognitionResultLike>;
type SpeechRecognitionEventLike = { results: SpeechRecognitionResultsLike };
type SpeechRecognitionErrorEventLike = { error: string };

interface SpeechRecognitionLike {
    lang: string;
    continuous: boolean;
    interimResults: boolean;
    maxAlternatives: number;
    onresult: ((event: SpeechRecognitionEventLike) => void) | null;
    onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
    onend: (() => void) | null;
    start(): void;
    stop(): void;
    abort(): void;
}
type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;
type SpeechRecognitionWindow = Window & {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
};

export type STTCallbacks = {
    onInterim: (text: string) => void;
    onFinal: (text: string) => void;
    onError: (error: string) => void;
    onEnd: () => void;         // 没有识别到任何内容就结束了
    onNoSpeech: () => void;    // 没检测到语音（用于自动重试）
};

export type STTSession = {
    start: () => void;
    stop: () => void;
    abort: () => void;
    isSupported: boolean;
};

/**
 * Create an STT session using browser Web Speech API.
 */
export function createSTTSession(
    callbacks: STTCallbacks,
    lang = "zh-CN",
): STTSession {
    const SpeechRecognition =
        (window as SpeechRecognitionWindow).SpeechRecognition || (window as SpeechRecognitionWindow).webkitSpeechRecognition;

    if (!SpeechRecognition) {
        return {
            start: () => callbacks.onError("浏览器不支持语音识别"),
            stop: () => {},
            abort: () => {},
            isSupported: false,
        };
    }

    const recognition = new SpeechRecognition();
    recognition.lang = lang;
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    let aborted = false;
    let finalText = "";
    let hadNoSpeech = false;

    recognition.onresult = (event: SpeechRecognitionEventLike) => {
        if (aborted) return;

        let interim = "";
        finalText = "";
        for (let i = 0; i < event.results.length; i++) {
            const transcript = event.results[i][0].transcript;
            if (event.results[i].isFinal) {
                finalText += transcript;
            } else {
                interim += transcript;
            }
        }

        callbacks.onInterim(finalText + interim);
    };

    recognition.onerror = (event: SpeechRecognitionErrorEventLike) => {
        if (aborted) return;
        if (event.error === "aborted") return;

        if (event.error === "no-speech") {
            hadNoSpeech = true;
            return;
        }

        const errorMap: Record<string, string> = {
            "audio-capture": "无法访问麦克风",
            "not-allowed": "麦克风权限被拒绝",
            "network": "网络错误",
        };
        callbacks.onError(errorMap[event.error] || `语音识别错误: ${event.error}`);
    };

    recognition.onend = () => {
        if (aborted) return;

        if (finalText.trim()) {
            callbacks.onFinal(finalText.trim());
        } else if (hadNoSpeech) {
            hadNoSpeech = false;
            callbacks.onNoSpeech();
        } else {
            callbacks.onEnd();
        }
    };

    return {
        start: () => {
            aborted = false;
            finalText = "";
            hadNoSpeech = false;
            try {
                recognition.start();
            } catch {
                // Already started — ignore
            }
        },
        stop: () => {
            try {
                recognition.stop();
            } catch {
                // Already stopped — ignore
            }
        },
        abort: () => {
            aborted = true;
            try {
                recognition.abort();
            } catch {
                // Already aborted — ignore
            }
        },
        isSupported: true,
    };
}
