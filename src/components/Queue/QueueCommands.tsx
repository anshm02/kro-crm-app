import React, { useState, useEffect, useRef } from "react"
import { IoLogOutOutline } from "react-icons/io5"

interface QueueCommandsProps {
  onTooltipVisibilityChange: (visible: boolean, height: number) => void
  screenshots: Array<{ path: string; preview: string }>
  onChatToggle: () => void
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
  const [currentVolume, setCurrentVolume] = useState(0)
  const chunks = useRef<Blob[]>([])

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
  }

  const handleRecordClick = async () => {
    if (!isRecording) {
      setIsRecording(true)
      setAudioResults([])
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
              <span className="animate-pulse">● Stop VAD</span>
            ) : (
              <span>🎤 Start VAD</span>
            )}
          </button>
          {isRecording && (
            <button
              className="bg-blue-500/70 hover:bg-blue-500/90 rounded-md px-2 py-1 text-[11px] text-white/70"
              onClick={handleManualFlush}
              type="button"
            >
              ⏸ Flush Segment
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
                  VAD auto-sends after 1.5s silence. “Flush Segment” manually sends the current audio and immediately restarts recording.
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
      {audioResults.length > 0 && (
        <div className="mt-2 p-2 bg-white/10 rounded text-white text-xs max-w-md max-h-40 overflow-y-auto">
          <span className="font-semibold block mb-1">Audio Results:</span>
          {audioResults.map((result, index) => (
            <div key={index} className="mb-1 pb-1 border-b border-white/20 last:border-0">
              <span className="text-white/60">Segment {index + 1}:</span> {result}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default QueueCommands
