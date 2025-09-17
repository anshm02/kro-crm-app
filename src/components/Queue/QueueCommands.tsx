import React, { useState, useEffect, useRef } from "react"
import { IoLogOutOutline } from "react-icons/io5"

interface QueueCommandsProps {
  onTooltipVisibilityChange: (visible: boolean, height: number) => void
  screenshots: Array<{ path: string; preview: string }>
  onChatToggle: () => void
}

interface TranscriptEntry {
  type: 'question' | 'answer' | 'live'
  text: string
  timestamp: string
}

const QueueCommands: React.FC<QueueCommandsProps> = ({
  onTooltipVisibilityChange,
  screenshots,
  onChatToggle
}) => {
  const [isTooltipVisible, setIsTooltipVisible] = useState(false)
  const tooltipRef = useRef<HTMLDivElement>(null)

  const [isRecording, setIsRecording] = useState(false)
  const [mediaRecorder, _setMediaRecorder] = useState<MediaRecorder | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const setMediaRecorder = (mr: MediaRecorder | null) => {
    mediaRecorderRef.current = mr
    _setMediaRecorder(mr)
  }

  const [audioResults, setAudioResults] = useState<string[]>([])
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([])
  const [liveTranscription, setLiveTranscription] = useState<string>("")
  const [currentVolume, setCurrentVolume] = useState(0)
  const chunks = useRef<Blob[]>([])
  const transcriptEndRef = useRef<HTMLDivElement>(null)

  // Audio/VAD refs
  const audioContextRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const streamRef = useRef<MediaStream | null>(null)

  const meterRafRef = useRef<number | null>(null)
  const silenceStartRef = useRef<number | null>(null)
  const isSpeakingRef = useRef(false)
  const noiseFloorRef = useRef<number | null>(null)
  const stopInFlightRef = useRef(false)

  // NEW: session lifetime flag
  const sessionActiveRef = useRef(false)

  // Tunables
  const SILENCE_DURATION_MS = 1500
  const CALIBRATION_MS = 800
  const MIN_THRESHOLD_RMS = 0.002
  const NOISE_MULTIPLIER = 2.0

  // Auto-scroll to bottom when new entries are added
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [transcript, liveTranscription])

  useEffect(() => {
    let tooltipHeight = 0
    if (tooltipRef.current && isTooltipVisible) {
      tooltipHeight = tooltipRef.current.offsetHeight + 10
    }
    onTooltipVisibilityChange(isTooltipVisible, tooltipHeight)
  }, [isTooltipVisible])

  const handleMouseEnter = () => setIsTooltipVisible(true)
  const handleMouseLeave = () => setIsTooltipVisible(false)

  function rmsFromFloatBuffer(buf: Float32Array) {
    let sum = 0
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
    return Math.sqrt(sum / buf.length)
  }

  function barsFromRms(rms: number) {
    const db = 20 * Math.log10(rms + 1e-8)
    const minDb = -90, maxDb = -20
    const t = Math.min(1, Math.max(0, (db - minDb) / (maxDb - minDb)))
    return Math.max(0, Math.min(10, Math.round(t * 10)))
  }

  // Simulate live transcription (you'd replace this with actual real-time transcription)
  const simulateLiveTranscription = (text: string) => {
    const words = text.split(' ')
    let currentIndex = 0
    
    const interval = setInterval(() => {
      if (currentIndex < words.length) {
        setLiveTranscription(prev => prev + (prev ? ' ' : '') + words[currentIndex])
        currentIndex++
      } else {
        clearInterval(interval)
        // Convert live transcription to final entry
        const timestamp = new Date().toLocaleTimeString('en-US', { 
          hour: 'numeric', 
          minute: '2-digit',
          hour12: true 
        })
        setTranscript(prev => [...prev, {
          type: 'answer',
          text: liveTranscription + ' ' + words.join(' ').substring(liveTranscription.length).trim(),
          timestamp
        }])
        setLiveTranscription("")
      }
    }, 100) // Simulate word-by-word appearance
  }

  const sendAudioForAnalysis = async () => {
    if (chunks.current.length === 0) return
    const audioBlob = new Blob(chunks.current, { type: "audio/webm" })
    console.log("[VAD] Sending audio, size:", audioBlob.size)

    const reader = new FileReader()
    reader.onloadend = async () => {
      const base64Data = (reader.result as string).split(",")[1]
      try {
        const result = await window.electronAPI.analyzeAudioFromBase64(
          base64Data,
          audioBlob.type
        )
        if (result?.text && result.text.trim()) {
          setAudioResults(prev => [...prev, result.text])
          
          // Add to transcript as an answer and simulate live transcription
          simulateLiveTranscription(result.text)
        }
      } catch (err) {
        console.error("[VAD] Analysis failed:", err)
      }
    }
    reader.readAsDataURL(audioBlob)
    chunks.current = []
  }

  function startMeterLoop(startTs: number) {
    const analyser = analyserRef.current
    if (!analyser) return

    analyser.fftSize = 512
    analyser.smoothingTimeConstant = 0.2
    const buf = new Float32Array(analyser.fftSize)

    const tick = () => {
      analyser.getFloatTimeDomainData(buf)
      const rms = rmsFromFloatBuffer(buf)

      const now = performance.now()
      if (now - startTs < CALIBRATION_MS) {
        noiseFloorRef.current =
          noiseFloorRef.current == null
            ? rms
            : noiseFloorRef.current * 0.9 + rms * 0.1
      }

      const noise = noiseFloorRef.current ?? 0.001
      const threshold = Math.max(MIN_THRESHOLD_RMS, noise * NOISE_MULTIPLIER)

      setCurrentVolume(barsFromRms(rms))

      if (rms > threshold) {
        isSpeakingRef.current = true
        silenceStartRef.current = null
        
        // Show live indicator when speaking
        if (!liveTranscription) {
          setLiveTranscription("🎤 Listening...")
        }
      } else {
        if (isSpeakingRef.current) {
          if (silenceStartRef.current == null) {
            silenceStartRef.current = now
          } else if (now - silenceStartRef.current >= SILENCE_DURATION_MS) {
            if (!stopInFlightRef.current) {
              const rec = mediaRecorderRef.current
              if (rec && rec.state === "recording") {
                console.log("[VAD] Silence detected → stopping recorder")
                stopInFlightRef.current = true
                rec.stop()
              }
            }
            silenceStartRef.current = null
            isSpeakingRef.current = false
          }
        }
      }
      meterRafRef.current = requestAnimationFrame(tick)
    }

    meterRafRef.current = requestAnimationFrame(tick)
  }

  const createMediaRecorder = (stream: MediaStream) => {
    const recorder = new MediaRecorder(stream, { mimeType: "audio/webm" })

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.current.push(e.data)
    }

    recorder.onstart = () => {
      stopInFlightRef.current = false
      isSpeakingRef.current = false
      silenceStartRef.current = null
      console.log("[VAD] Recorder started (onstart)")
    }

    recorder.onstop = async () => {
      try {
        console.log("[VAD] Recorder stopped, chunks:", chunks.current.length)
        if (chunks.current.length > 0) {
          await sendAudioForAnalysis()
        }
      } finally {
        if (sessionActiveRef.current && streamRef.current) {
          chunks.current = []
          try {
            const newRecorder = createMediaRecorder(streamRef.current)
            newRecorder.start(100)
            setMediaRecorder(newRecorder)
            console.log("[VAD] New recorder started after stop")
          } catch (err) {
            console.error("[VAD] Failed to restart recorder:", err)
          }
        } else {
          console.log("[VAD] Session inactive, not restarting recorder")
          setMediaRecorder(null)
        }
      }
    }

    return recorder
  }

  const startRecording = async () => {
    try {
      console.log("[VAD] Requesting microphone access...")
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      })
      streamRef.current = stream

      audioContextRef.current = new (window.AudioContext ||
        (window as any).webkitAudioContext)()
      if (audioContextRef.current.state === "suspended") {
        await audioContextRef.current.resume()
      }

      const ac = audioContextRef.current
      const analyser = ac.createAnalyser()
      const source = ac.createMediaStreamSource(stream)
      source.connect(analyser)

      analyserRef.current = analyser
      sourceRef.current = source

      stopInFlightRef.current = false
      chunks.current = []

      const recorder = createMediaRecorder(stream)
      recorder.start(100)
      setMediaRecorder(recorder)

      noiseFloorRef.current = null
      startMeterLoop(performance.now())

      sessionActiveRef.current = true
      console.log("[VAD] Recording started")
    } catch (err: any) {
      console.error("[VAD] Could not start recording:", err)
      setAudioResults(prev => [...prev, `Microphone error: ${err.message}`])
    }
  }

  const stopRecording = () => {
    sessionActiveRef.current = false

    if (meterRafRef.current != null) {
      cancelAnimationFrame(meterRafRef.current)
      meterRafRef.current = null
    }
    const rec = mediaRecorderRef.current
    if (rec && rec.state !== "inactive") {
      try { rec.stop() } catch {}
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop())
      streamRef.current = null
    }

    try { sourceRef.current?.disconnect() } catch {}
    try { analyserRef.current?.disconnect() } catch {}
    sourceRef.current = null
    analyserRef.current = null

    if (audioContextRef.current) {
      audioContextRef.current.close()
      audioContextRef.current = null
    }

    setCurrentVolume(0)
    setMediaRecorder(null)
    stopInFlightRef.current = false
    isSpeakingRef.current = false
    silenceStartRef.current = null
    setLiveTranscription("")
  }

  const handleRecordClick = async () => {
    if (!isRecording) {
      setIsRecording(true)
      setAudioResults([])
      setTranscript([])
      setLiveTranscription("")
      await startRecording()
    } else {
      setIsRecording(false)
      stopRecording()
    }
  }

  const handleManualFlush = () => {
    const rec = mediaRecorderRef.current
    if (!rec || rec.state !== "recording") return
    if (stopInFlightRef.current) return
    console.log("[VAD] Manual flush → stopping recorder")
    stopInFlightRef.current = true
    try {
      rec.stop()
    } catch (e) {
      stopInFlightRef.current = false
      console.error("[VAD] Manual flush stop() failed:", e)
    }
  }

  useEffect(() => {
    return () => {
      if (isRecording) stopRecording()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const VolumeMeter = () => (
    <div className="flex items-center gap-1 mx-3">
      <span className="text-[10px] text-white/50">Vol:</span>
      <div className="flex gap-0.5">
        {[...Array(10)].map((_, i) => (
          <div
            key={i}
            className={`w-1 h-3 rounded-sm transition-colors ${
              i < currentVolume
                ? i < 3
                  ? "bg-green-400"
                  : i < 7
                  ? "bg-yellow-400"
                  : "bg-red-400"
                : "bg-white/20"
            }`}
          />
        ))}
      </div>
    </div>
  )

  return (
    <div className="w-fit">
      <div className="text-xs text-white/90 liquid-glass-bar py-1 px-4 flex items-center justify-center gap-4 draggable-area">
        {screenshots.length > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-[11px] leading-none">Solve</span>
            <div className="flex gap-1">
              <button className="bg-white/10 hover:bg-white/20 rounded-md px-1.5 py-1 text-[11px] text-white/70">
                ⌘
              </button>
              <button className="bg-white/10 hover:bg-white/20 rounded-md px-1.5 py-1 text-[11px] text-white/70">
                ↵
              </button>
            </div>
          </div>
        )}
        {isRecording && <VolumeMeter />}
        <div className="flex items-center gap-2">
          <button
            className={`bg-white/10 hover:bg-white/20 rounded-md px-2 py-1 text-[11px] text-white/70 flex items-center gap-1 ${
              isRecording ? "bg-red-500/70 hover:bg-red-500/90" : ""
            }`}
            onClick={handleRecordClick}
            type="button"
          >
            {isRecording ? (
              <span className="animate-pulse">Stop Recording</span>
            ) : (
              <span> Start Recording </span>
            )}
          </button>
          {isRecording && (
            <button
              className="bg-blue-500/70 hover:bg-blue-500/90 rounded-md px-2 py-1 text-[11px] text-white/70"
              onClick={handleManualFlush}
              type="button"
            >
              Get Response
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            className="bg-white/10 hover:bg-white/20 rounded-md px-2 py-1 text-[11px] text-white/70 flex items-center gap-1"
            onClick={onChatToggle}
            type="button"
          >
            💬 Chat
          </button>
        </div>
        <div
          className="relative inline-block"
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
        >
          <div className="w-6 h-6 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center cursor-help">
            <span className="text-xs text-white/70">?</span>
          </div>
          {isTooltipVisible && (
            <div ref={tooltipRef} className="absolute top-full right-0 mt-2 w-80">
              <div className="p-3 text-xs bg-black/80 rounded-lg text-white/90">
                <h3 className="font-medium truncate">Keyboard Shortcuts</h3>
                <p className="text-[10px] text-white/70">
                  VAD auto-sends after 1.5s silence. "Flush Segment" manually sends the current audio and immediately restarts recording.
                </p>
              </div>
            </div>
          )}
        </div>
        <div className="mx-2 h-4 w-px bg-white/20" />
        <button
          className="text-red-500/70 hover:text-red-500/90"
          title="Sign Out"
          onClick={() => window.electronAPI.quitApp()}
        >
          <IoLogOutOutline className="w-4 h-4" />
        </button>
      </div>
      
      {/* Q&A Style Transcript Display */}
      {(transcript.length > 0 || liveTranscription || audioResults.length > 0) && (
        <div className="mt-3 mx-auto" style={{ maxWidth: '600px' }}>
          <div className="bg-gradient-to-b from-gray-900/95 to-gray-800/95 backdrop-blur-xl rounded-2xl shadow-2xl border border-white/10 overflow-hidden">
            <div className="px-6 py-4 border-b border-white/10">
              <h3 className="text-sm font-semibold text-white/90 flex items-center gap-2">
                {isRecording && (
                  <span className="inline-flex w-2 h-2 bg-red-500 rounded-full animate-pulse"></span>
                )}
                Live Interview Transcript
              </h3>
            </div>
            
            <div className="px-6 py-4 max-h-96 overflow-y-auto space-y-4">
              {transcript.map((entry, index) => (
                <div key={index} className="space-y-2">
                  {entry.type === 'question' ? (
                    <div className="flex gap-3">
                      <div className="flex-shrink-0 w-8 h-8 rounded-full bg-blue-500/20 flex items-center justify-center">
                        <span className="text-xs">Q</span>
                      </div>
                      <div className="flex-1">
                        <p className="text-sm text-white/80">{entry.text}</p>
                        <span className="text-[10px] text-white/40 mt-1">{entry.timestamp}</span>
                      </div>
                    </div>
                  ) : (
                    <div className="flex gap-3">
                      <div className="flex-shrink-0 w-8 h-8 rounded-full bg-orange-500/20 flex items-center justify-center">
                        <span className="text-xs">A</span>
                      </div>
                      <div className="flex-1">
                        <div className="bg-gradient-to-r from-orange-500/20 to-orange-400/10 rounded-lg p-3 border border-orange-400/20">
                          <p className="text-sm text-orange-200">{entry.text}</p>
                        </div>
                        <span className="text-[10px] text-white/40 mt-1 inline-block">{entry.timestamp}</span>
                      </div>
                    </div>
                  )}
                </div>
              ))}
              
              {/* Live Transcription Display */}
              {liveTranscription && (
                <div className="flex gap-3">
                  <div className="flex-shrink-0 w-8 h-8 rounded-full bg-orange-500/20 flex items-center justify-center animate-pulse">
                    <span className="text-xs">A</span>
                  </div>
                  <div className="flex-1">
                    <div className="bg-gradient-to-r from-orange-500/20 to-orange-400/10 rounded-lg p-3 border border-orange-400/20">
                      <p className="text-sm text-orange-200 animate-pulse">{liveTranscription}</p>
                    </div>
                  </div>
                </div>
              )}
              
              {/* Legacy audio results (hidden but preserved for compatibility) */}
              {audioResults.map((result, index) => (
                <div key={`audio-${index}`} className="hidden">
                  {result}
                </div>
              ))}
              
              <div ref={transcriptEndRef} />
            </div>
            
            {isRecording && (
              <div className="px-6 py-3 border-t border-white/10 bg-black/20">
                <p className="text-[11px] text-white/50 text-center">
                  Speak clearly and pause naturally between responses...
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default QueueCommands