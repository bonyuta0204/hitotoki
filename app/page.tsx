"use client";

import Image from "next/image";
import {
  ArrowRight,
  Baby,
  Camera,
  CircleStop,
  Clock3,
  Heart,
  LoaderCircle,
  Mic,
  Milk,
  Plus,
  Search,
  Sparkles,
  Video,
  VideoOff,
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { blobToDataUrl, encodeMonoWav } from "@/lib/browser-audio";
import type { Moment, SearchResult } from "@/lib/types";

const CAPTURE_INTERVAL_MS = 8_000;
const searchSuggestions = ["手を振っていたとき", "最後にミルクを飲んだのは？", "笑っていた瞬間"];

type CaptureState = "idle" | "capturing" | "analyzing";
type VoiceState = "idle" | "recording" | "transcribing";

type VoiceRecording = {
  stream: MediaStream;
  context: AudioContext;
  source: MediaStreamAudioSourceNode;
  processor: ScriptProcessorNode;
  sink: GainNode;
  chunks: Float32Array[];
  sampleRate: number;
};

async function parseResponse<T>(response: Response): Promise<T> {
  const payload = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || "通信に失敗しました。");
  return payload;
}

function formatTime(timestamp: string) {
  return new Intl.DateTimeFormat("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function formatDate(timestamp: string) {
  const date = new Date(timestamp);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return "今日";

  return new Intl.DateTimeFormat("ja-JP", {
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(date);
}

function isVoiceMoment(moment: Moment) {
  return moment.metadata?.capture === "voice";
}

function MomentIcon({ moment }: { moment: Moment }) {
  if (isVoiceMoment(moment)) {
    return <Mic size={16} strokeWidth={1.8} />;
  }
  const lower = moment.description.toLowerCase();
  if (lower.includes("ミルク") || lower.includes("milk") || lower.includes("飲")) {
    return <Milk size={16} strokeWidth={1.8} />;
  }
  if (lower.includes("笑") || lower.includes("smile")) {
    return <Heart size={16} strokeWidth={1.8} />;
  }
  return moment.source === "camera" ? (
    <Camera size={16} strokeWidth={1.8} />
  ) : (
    <Baby size={16} strokeWidth={1.8} />
  );
}

function MomentCard({ moment, compact = false }: { moment: SearchResult; compact?: boolean }) {
  const sourceLabel =
    moment.source === "camera" ? "カメラ" : isVoiceMoment(moment) ? "家族の声" : "あなたのメモ";
  const sourceClass = isVoiceMoment(moment) ? "voice" : moment.source;

  return (
    <article className={`moment-card ${compact ? "moment-card--compact" : ""}`}>
      {moment.imageUrl && (
        <div className="moment-card__image">
          <Image src={moment.imageUrl} alt={moment.description} fill sizes="(max-width: 720px) 100vw, 260px" />
        </div>
      )}
      <div className="moment-card__body">
        <div className="moment-card__meta">
          <span className={`source-icon source-icon--${sourceClass}`}>
            <MomentIcon moment={moment} />
          </span>
          <span>{formatTime(moment.timestamp)}</span>
          <span className="meta-dot">·</span>
          <span>{sourceLabel}</span>
        </div>
        <p>{moment.description}</p>
        {moment.score !== undefined && (
          <span className="match-label">この記憶が近そうです</span>
        )}
      </div>
    </article>
  );
}

export default function Home() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const captureBusyRef = useRef(false);
  const voiceRecordingRef = useRef<VoiceRecording | null>(null);
  const voiceStopTimerRef = useRef<number | null>(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [remembering, setRemembering] = useState(false);
  const [captureState, setCaptureState] = useState<CaptureState>("idle");
  const [nextCaptureAt, setNextCaptureAt] = useState<number | null>(null);
  const [secondsToCapture, setSecondsToCapture] = useState(0);
  const [moments, setMoments] = useState<Moment[]>([]);
  const [note, setNote] = useState("");
  const [savingNote, setSavingNote] = useState(false);
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [voiceSeconds, setVoiceSeconds] = useState(0);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [loadingMoments, setLoadingMoments] = useState(true);

  const addMomentToTimeline = useCallback((moment: Moment) => {
    setMoments((current) => [moment, ...current.filter((item) => item.id !== moment.id)]);
  }, []);

  useEffect(() => {
    let active = true;
    fetch("/api/moments")
      .then((response) => parseResponse<{ moments: Moment[] }>(response))
      .then(({ moments: loadedMoments }) => {
        if (active) setMoments(loadedMoments);
      })
      .catch((error: Error) => {
        if (active) setNotice(error.message);
      })
      .finally(() => {
        if (active) setLoadingMoments(false);
      });

    return () => {
      active = false;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      const recording = voiceRecordingRef.current;
      recording?.stream.getTracks().forEach((track) => track.stop());
      recording?.processor.disconnect();
      recording?.source.disconnect();
      recording?.sink.disconnect();
      void recording?.context.close();
      if (voiceStopTimerRef.current) window.clearTimeout(voiceStopTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (voiceState !== "recording") return;
    const timer = window.setInterval(() => setVoiceSeconds((seconds) => seconds + 1), 1_000);
    return () => window.clearInterval(timer);
  }, [voiceState]);

  useEffect(() => {
    if (!nextCaptureAt || !remembering) {
      return;
    }

    const updateCountdown = () => {
      setSecondsToCapture(Math.max(0, Math.ceil((nextCaptureAt - Date.now()) / 1000)));
    };
    updateCountdown();
    const timer = window.setInterval(updateCountdown, 250);
    return () => window.clearInterval(timer);
  }, [nextCaptureAt, remembering]);

  const startCamera = async () => {
    try {
      setNotice(null);
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setCameraReady(true);
    } catch {
      setNotice("カメラを使えませんでした。ブラウザのカメラ許可を確認してください。");
    }
  };

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setRemembering(false);
    setNextCaptureAt(null);
    setCameraReady(false);
  };

  const toggleRemembering = () => {
    if (remembering) setNextCaptureAt(null);
    setRemembering(!remembering);
  };

  const captureFrame = useCallback(async () => {
    if (!videoRef.current || !canvasRef.current || !streamRef.current || captureBusyRef.current) return;
    if (videoRef.current.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;

    captureBusyRef.current = true;
    setCaptureState("capturing");
    setNotice(null);

    try {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      const width = Math.min(video.videoWidth, 960);
      const height = Math.round((width / video.videoWidth) * video.videoHeight);
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("画像を取り込めませんでした。");

      context.translate(width, 0);
      context.scale(-1, 1);
      context.drawImage(video, 0, 0, width, height);
      const imageDataUrl = canvas.toDataURL("image/jpeg", 0.82);

      setCaptureState("analyzing");
      const response = await fetch("/api/moments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "camera", imageDataUrl }),
      });
      const { moment } = await parseResponse<{ moment: Moment }>(response);
      addMomentToTimeline(moment);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "この瞬間を記憶できませんでした。");
    } finally {
      setCaptureState("idle");
      setNextCaptureAt(Date.now() + CAPTURE_INTERVAL_MS);
      captureBusyRef.current = false;
    }
  }, [addMomentToTimeline]);

  useEffect(() => {
    if (!remembering || !cameraReady) {
      return;
    }

    let cancelled = false;
    let timer: number;
    const remember = async () => {
      await captureFrame();
      if (!cancelled) timer = window.setTimeout(remember, CAPTURE_INTERVAL_MS);
    };
    timer = window.setTimeout(remember, 900);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [cameraReady, captureFrame, remembering]);

  const handleAddNote = async (event: FormEvent) => {
    event.preventDefault();
    const description = note.trim();
    if (!description || savingNote) return;

    setSavingNote(true);
    setNotice(null);
    try {
      const response = await fetch("/api/moments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "note", description }),
      });
      const { moment } = await parseResponse<{ moment: Moment }>(response);
      addMomentToTimeline(moment);
      setNote("");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "メモを記憶できませんでした。");
    } finally {
      setSavingNote(false);
    }
  };

  const finishVoiceRecording = useCallback(async () => {
    const recording = voiceRecordingRef.current;
    if (!recording) return;
    voiceRecordingRef.current = null;

    if (voiceStopTimerRef.current) {
      window.clearTimeout(voiceStopTimerRef.current);
      voiceStopTimerRef.current = null;
    }

    recording.processor.onaudioprocess = null;
    recording.processor.disconnect();
    recording.source.disconnect();
    recording.sink.disconnect();
    recording.stream.getTracks().forEach((track) => track.stop());
    await recording.context.close();

    setVoiceState("transcribing");
    setNotice(null);
    try {
      const sampleCount = recording.chunks.reduce((total, chunk) => total + chunk.length, 0);
      if (sampleCount < recording.sampleRate / 2) {
        throw new Error("もう少し長く話してから止めてください。");
      }

      const wav = encodeMonoWav(recording.chunks, recording.sampleRate);
      const audioDataUrl = await blobToDataUrl(wav);
      const response = await fetch("/api/voice-moments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audioDataUrl }),
      });
      const { moment } = await parseResponse<{ moment: Moment }>(response);
      addMomentToTimeline(moment);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "声を記憶できませんでした。");
    } finally {
      setVoiceState("idle");
      setVoiceSeconds(0);
    }
  }, [addMomentToTimeline]);

  const startVoiceRecording = async () => {
    if (voiceState !== "idle" || voiceRecordingRef.current) return;

    setNotice(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
        video: false,
      });
      const context = new AudioContext();
      await context.resume();
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(4_096, 1, 1);
      const sink = context.createGain();
      const chunks: Float32Array[] = [];
      sink.gain.value = 0;
      processor.onaudioprocess = (event) => {
        chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
      };
      source.connect(processor);
      processor.connect(sink);
      sink.connect(context.destination);

      voiceRecordingRef.current = {
        stream,
        context,
        source,
        processor,
        sink,
        chunks,
        sampleRate: context.sampleRate,
      };
      setVoiceSeconds(0);
      setVoiceState("recording");
      voiceStopTimerRef.current = window.setTimeout(() => void finishVoiceRecording(), 30_000);
    } catch {
      setVoiceState("idle");
      setNotice("マイクを使えませんでした。ブラウザのマイク許可を確認してください。");
    }
  };

  const runSearch = async (searchQuery: string) => {
    const normalizedQuery = searchQuery.trim();
    if (!normalizedQuery || searching) return;

    setQuery(normalizedQuery);
    setSearching(true);
    setHasSearched(true);
    setNotice(null);
    try {
      const response = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: normalizedQuery }),
      });
      const { moments: foundMoments } = await parseResponse<{ moments: SearchResult[] }>(response);
      setResults(foundMoments);
    } catch (error) {
      setResults([]);
      setNotice(error instanceof Error ? error.message : "記憶を探せませんでした。");
    } finally {
      setSearching(false);
    }
  };

  const groupedMoments = moments.reduce<Record<string, Moment[]>>((groups, moment) => {
    const label = formatDate(moment.timestamp);
    groups[label] = [...(groups[label] || []), moment];
    return groups;
  }, {});

  const captureLabel =
    captureState === "capturing"
      ? "瞬間を撮影中"
      : captureState === "analyzing"
        ? "この瞬間を言葉にしています"
        : `次の記憶まで ${secondsToCapture}秒`;

  return (
    <main>
      <header className="site-header">
        <a className="brand" href="#top" aria-label="Hitotoki ホーム">
          <span className="brand-mark"><span /></span>
          <span className="brand-name">Hitotoki</span>
          <span className="brand-jp">ひととき</span>
        </a>
        <p>今日の小さな瞬間を、見つけられる記憶に。</p>
      </header>

      <div id="top" className="page-shell">
        {notice && (
          <div className="notice" role="status">
            <span>{notice}</span>
            <button onClick={() => setNotice(null)} aria-label="閉じる">×</button>
          </div>
        )}

        <section className="hero-grid" aria-label="記憶を残す">
          <div className="camera-panel panel">
            <div className="panel-heading camera-heading">
              <div>
                <span className="eyebrow">WATCH</span>
                <h1>今を、そっと覚えておく。</h1>
              </div>
              {cameraReady && (
                <button className="icon-button" onClick={stopCamera} aria-label="カメラを止める" title="カメラを止める">
                  <VideoOff size={18} />
                </button>
              )}
            </div>

            <div className={`camera-frame ${cameraReady ? "camera-frame--ready" : ""}`}>
              <video ref={videoRef} muted playsInline aria-label="ライブカメラ" />
              {!cameraReady && (
                <div className="camera-empty">
                  <span className="camera-orbit"><Video size={25} strokeWidth={1.6} /></span>
                  <h2>カメラをつないで、はじめましょう</h2>
                  <p>映像は保存せず、8秒ごとに一枚の瞬間だけを記憶します。</p>
                  <button className="button button--light" onClick={startCamera}>
                    <Camera size={17} /> カメラをはじめる
                  </button>
                </div>
              )}
              {cameraReady && (
                <>
                  <div className="live-badge"><span /> LIVE</div>
                  {captureState !== "idle" && (
                    <div className="analyzing-badge">
                      <LoaderCircle size={15} className="spin" />
                      {captureState === "capturing" ? "撮影中" : "記憶中"}
                    </div>
                  )}
                </>
              )}
            </div>
            <canvas ref={canvasRef} hidden />

            <div className="camera-controls">
              <button
                className={`remember-toggle ${remembering ? "remember-toggle--active" : ""}`}
                onClick={toggleRemembering}
                disabled={!cameraReady}
              >
                <span className="remember-toggle__icon">
                  {remembering ? <CircleStop size={17} fill="currentColor" /> : <Sparkles size={17} />}
                </span>
                <span>
                  <strong>{remembering ? "記憶しています" : "記憶をはじめる"}</strong>
                  <small>{remembering ? captureLabel : "一定間隔で瞬間を残します"}</small>
                </span>
              </button>
              <button className="capture-now" onClick={captureFrame} disabled={!cameraReady || captureState !== "idle"}>
                <Camera size={17} /> 今を記憶
              </button>
            </div>
          </div>

          <div className="side-stack">
            <section className="note-panel panel">
              <div className="panel-heading">
                <div>
                  <span className="eyebrow">ADD A MOMENT</span>
                  <h2>ひとことだけ、残す。</h2>
                </div>
                <span className="section-icon"><Plus size={18} /></span>
              </div>
              <p className="supporting-copy">量や時間を選ばなくても大丈夫。いつもの言葉で書いてください。</p>
              <form className="note-form" onSubmit={handleAddNote}>
                <textarea
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder="例：ミルクを120ml飲んだ"
                  rows={3}
                  maxLength={500}
                />
                <button className="button button--primary" disabled={!note.trim() || savingNote}>
                  {savingNote ? <LoaderCircle size={17} className="spin" /> : <Sparkles size={17} />}
                  覚えておく
                </button>
              </form>
              <div className="note-divider"><span>または、声で</span></div>
              <button
                type="button"
                className={`voice-button ${voiceState === "recording" ? "voice-button--recording" : ""}`}
                onClick={() => {
                  if (voiceState === "recording") void finishVoiceRecording();
                  else void startVoiceRecording();
                }}
                disabled={voiceState === "transcribing"}
              >
                <span className="voice-button__icon">
                  {voiceState === "transcribing" ? (
                    <LoaderCircle size={18} className="spin" />
                  ) : voiceState === "recording" ? (
                    <CircleStop size={18} fill="currentColor" />
                  ) : (
                    <Mic size={18} />
                  )}
                </span>
                <span className="voice-button__copy">
                  <strong>
                    {voiceState === "recording"
                      ? "話し終えたらタップ"
                      : voiceState === "transcribing"
                        ? "Shisaが言葉にしています"
                        : "話してMomentを残す"}
                  </strong>
                  <small>{voiceState === "recording" ? "最大30秒で自動停止" : "親のひとことをそのまま記憶"}</small>
                </span>
                {voiceState === "recording" && (
                  <span className="voice-live" aria-label={`${voiceSeconds}秒録音中`}>
                    <span className="voice-wave" aria-hidden="true"><i /><i /><i /><i /></span>
                    {voiceSeconds}s
                  </span>
                )}
              </button>
            </section>

            <section className="recall-panel panel">
              <div className="panel-heading">
                <div>
                  <span className="eyebrow">RECALL</span>
                  <h2>記憶に、たずねる。</h2>
                </div>
                <span className="section-icon section-icon--blue"><Search size={18} /></span>
              </div>
              <form
                className="search-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void runSearch(query);
                }}
              >
                <Search size={19} />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="手を振っていたのはいつ？"
                />
                <button aria-label="記憶を検索" disabled={!query.trim() || searching}>
                  {searching ? <LoaderCircle size={18} className="spin" /> : <ArrowRight size={18} />}
                </button>
              </form>
              <div className="suggestions" aria-label="検索例">
                {searchSuggestions.map((suggestion) => (
                  <button key={suggestion} onClick={() => void runSearch(suggestion)}>{suggestion}</button>
                ))}
              </div>
            </section>
          </div>
        </section>

        {hasSearched && (
          <section className="results-section" aria-live="polite">
            <div className="section-title-row">
              <div>
                <span className="eyebrow">FOUND IN YOUR MEMORIES</span>
                <h2>「{query}」の記憶</h2>
              </div>
              <button className="text-button" onClick={() => { setHasSearched(false); setResults([]); }}>
                検索を閉じる
              </button>
            </div>
            {searching ? (
              <div className="search-loading"><LoaderCircle size={22} className="spin" /> 記憶をたどっています…</div>
            ) : results.length > 0 ? (
              <div className="result-grid">
                {results.map((moment) => <MomentCard key={moment.id} moment={moment} compact />)}
              </div>
            ) : (
              <div className="empty-state">
                <Search size={22} />
                <p>近い記憶はまだ見つかりませんでした。</p>
                <span>別の言葉でもう一度たずねてみてください。</span>
              </div>
            )}
          </section>
        )}

        <section className="timeline-section">
          <div className="section-title-row">
            <div>
              <span className="eyebrow">YOUR MOMENTS</span>
              <h2>小さなひととき</h2>
            </div>
            <span className="moment-count"><Clock3 size={15} /> {moments.length} memories</span>
          </div>

          {loadingMoments ? (
            <div className="timeline-loading"><LoaderCircle size={21} className="spin" /> 記憶を開いています…</div>
          ) : moments.length === 0 ? (
            <div className="timeline-empty">
              <span><Heart size={24} strokeWidth={1.5} /></span>
              <h3>最初のひとときを残してみましょう</h3>
              <p>カメラからでも、ひとことのメモからでも。ここに一緒に並びます。</p>
            </div>
          ) : (
            <div className="timeline-groups">
              {Object.entries(groupedMoments).map(([date, dateMoments]) => (
                <div className="timeline-group" key={date}>
                  <div className="date-divider"><span>{date}</span><i /></div>
                  <div className="moment-grid">
                    {dateMoments.map((moment) => <MomentCard key={moment.id} moment={moment} />)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      <footer>
        <span className="brand-mark brand-mark--small"><span /></span>
        <p>思い出を残すことより、思い出をつくることに時間を。</p>
      </footer>
    </main>
  );
}
