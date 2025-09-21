import React, { useState, useEffect, useRef } from "react"
import { IoLogOutOutline } from "react-icons/io5"
import { FiHeadphones, FiPower, FiMic, FiSend, FiMessageSquare, FiSettings } from "react-icons/fi"
import { BsRecordCircle, BsStopCircle, BsPauseFill, BsPlayFill } from "react-icons/bs"
import { AiOutlineClose } from "react-icons/ai"

interface QueueCommandsProps {
  onTooltipVisibilityChange: (visible: boolean, height: number) => void
  screenshots: Array<{ path: string; preview: string }>
  onChatToggle: () => void
}

interface TranscriptEntry {
  type: 'question' | 'answer' | 'live' | 'interviewer' | 'system'
  text: string
  timestamp: string
}

interface LiveTranscriptionState {
  fullText: string
  displayedText: string
  currentIndex: number
  messageId: string
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
  const [liveTranscription, setLiveTranscription] = useState<LiveTranscriptionState | null>(null)
  const [currentVolume, setCurrentVolume] = useState(0)
  const [messageInput, setMessageInput] = useState("")
  const [showChat, setShowChat] = useState(false)
  const chunks = useRef<Blob[]>([])
  const transcriptEndRef = useRef<HTMLDivElement>(null)
  const animationFrameRef = useRef<number | null>(null)
  const transcriptionTimeoutRef = useRef<NodeJS.Timeout | null>(null)

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

  // Session lifetime flag
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
  }, [isTooltipVisible, onTooltipVisibilityChange])

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

  // Improved smooth live transcription animation
  const simulateLiveTranscription = (text: string) => {
    // Clear any existing animation
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current)
    }
    if (transcriptionTimeoutRef.current) {
      clearTimeout(transcriptionTimeoutRef.current)
    }

    // Generate unique ID for this message
    const messageId = Date.now().toString()
    
    // Initialize live transcription state
    const liveState: LiveTranscriptionState = {
      fullText: text,
      displayedText: '',
      currentIndex: 0,
      messageId
    }
    
    setLiveTranscription(liveState)

    // Character-by-character animation with variable speed
    const animateText = () => {
      setLiveTranscription(prev => {
        if (!prev || prev.messageId !== messageId) return prev
        
        if (prev.currentIndex >= prev.fullText.length) {
          // Animation complete - convert to final transcript entry
          const timestamp = new Date().toLocaleTimeString('en-US', { 
            hour: 'numeric', 
            minute: '2-digit',
            hour12: true 
          })
          
          // Add to transcript
          setTranscript(current => [...current, {
            type: 'answer',
            text: prev.fullText,
            timestamp
          }])
          
          // Clear live transcription immediately
          return null
        }
        
        // Calculate how many characters to add (variable speed for more natural feel)
        const remainingChars = prev.fullText.length - prev.currentIndex
        let charsToAdd = 1
        
        // Speed up for longer remaining text
        if (remainingChars > 100) charsToAdd = 3
        else if (remainingChars > 50) charsToAdd = 2
        
        // Don't break words - if we're in the middle of a word, complete it
        const nextIndex = Math.min(prev.currentIndex + charsToAdd, prev.fullText.length)
        const nextChar = prev.fullText[nextIndex]
        const currentChar = prev.fullText[prev.currentIndex + charsToAdd - 1]
        
        // If we're about to break a word, find the end of the word
        let adjustedIndex = nextIndex
        if (nextChar && nextChar !== ' ' && currentChar !== ' ') {
          const spaceIndex = prev.fullText.indexOf(' ', nextIndex)
          if (spaceIndex !== -1 && spaceIndex - nextIndex < 10) {
            adjustedIndex = spaceIndex
          }
        }
        
        return {
          ...prev,
          displayedText: prev.fullText.substring(0, adjustedIndex),
          currentIndex: adjustedIndex
        }
      })
      
      // Variable delay for more natural typing effect
      const delay = Math.random() * 20 + 15 // 15-35ms
      animationFrameRef.current = requestAnimationFrame(() => {
        transcriptionTimeoutRef.current = setTimeout(animateText, delay)
      })
    }
    
    // Start animation
    animateText()
  }

  const sendAudioForAnalysis = async () => {
    if (chunks.current.length === 0) return
    
    // Clear any existing live transcription
    setLiveTranscription(null)
    
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
          
          // Add smooth animation for the response
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
        // Don't show "Listening..." text - only show actual transcriptions
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
    setLiveTranscription(null)
  }

  const handleRecordClick = async () => {
    if (!isRecording) {
      setIsRecording(true)
      setAudioResults([])
      setTranscript([])
      setLiveTranscription(null)
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

  const handleSendMessage = () => {
    if (messageInput.trim()) {
      const timestamp = new Date().toLocaleTimeString('en-US', { 
        hour: 'numeric', 
        minute: '2-digit',
        hour12: true 
      })
      setTranscript(prev => [...prev, {
        type: 'question',
        text: messageInput,
        timestamp
      }])
      setMessageInput("")
      // Simulate a response
      setTimeout(() => {
        simulateLiveTranscription("I understand your message. Let me help you with that.")
      }, 1000)
    }
  }

  useEffect(() => {
    return () => {
      if (isRecording) stopRecording()
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current)
      }
      if (transcriptionTimeoutRef.current) {
        clearTimeout(transcriptionTimeoutRef.current)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const VolumeMeter = () => (
    <div className="flex items-center gap-1">
      <div className="flex gap-0.5">
        {[...Array(10)].map((_, i) => (
          <div
            key={i}
            className={`w-0.5 h-3 rounded-full transition-all duration-75 ${
              i < currentVolume
                ? i < 3
                  ? "bg-green-400"
                  : i < 7
                  ? "bg-yellow-400"
                  : "bg-red-400"
                : "bg-gray-600"
            }`}
          />
        ))}
      </div>
    </div>
  )

  return (
    <div className="w-full h-screen bg-gradient-to-br from-gray-900/30 via-black/30 to-gray-900/30 flex flex-col">
      {/* Top Bar - Draggable Area */}
      <div className="bg-black/20 backdrop-blur-2xl border-b border-gray-800/30 px-4 py-2 draggable-area">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {/* Mac-style window controls */}
            <div className="flex gap-2 no-drag">
              <div className="w-3 h-3 rounded-full bg-red-500/80 hover:bg-red-600 cursor-pointer" onClick={() => window.electronAPI.quitApp()} />
              <div className="w-3 h-3 rounded-full bg-yellow-500/80 hover:bg-yellow-600 cursor-pointer" />
              <div className="w-3 h-3 rounded-full bg-green-500/80 hover:bg-green-600 cursor-pointer" />
            </div>
            <div className="text-gray-400/90 text-sm font-medium">AI Interview Assistant</div>
          </div>

          <div className="flex items-center gap-4">
            {/* Control buttons - make them non-draggable */}
            <button className="text-gray-400/80 hover:text-white transition-colors p-2 no-drag">
              <FiHeadphones className="w-4 h-4" />
            </button>
            <button 
              className="text-gray-400/80 hover:text-white transition-colors p-2 no-drag"
              onClick={() => setShowChat(!showChat)}
            >
              <FiMessageSquare className="w-4 h-4" />
            </button>
            <button className="text-gray-400/80 hover:text-white transition-colors p-2 no-drag">
              <FiSettings className="w-4 h-4" />
            </button>
            <div className="w-px h-6 bg-gray-700/50" />
            <button
              className="text-red-400/80 hover:text-red-500 transition-colors p-2 no-drag"
              title="Sign Out"
              onClick={() => window.electronAPI.quitApp()}
            >
              <FiPower className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 flex overflow-hidden">
        {/* Chat/Transcript Area */}
        <div className="flex-1 flex flex-col bg-black/10 backdrop-blur-sm">
          <div className="flex-1 overflow-y-auto p-6">
            <div className="max-w-4xl mx-auto space-y-4">
              {/* Sample initial messages */}
              {transcript.length === 0 && !isRecording && (
                <div className="text-center py-12">
                  <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-gradient-to-br from-purple-500 to-pink-500 mb-4">
                    <FiMic className="w-8 h-8 text-white" />
                  </div>
                  <h2 className="text-2xl font-semibold text-white mb-2">Ready to Start</h2>
                  <p className="text-gray-400">Click the record button to begin your interview session</p>
                </div>
              )}

              {/* Transcript Messages */}
              {transcript.map((entry, index) => (
                <div key={index} className={`flex ${entry.type === 'question' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-2xl ${entry.type === 'question' ? 'order-2' : ''}`}>
                    <div className={`rounded-2xl px-4 py-3 shadow-xl ${
                      entry.type === 'question' 
                        ? 'bg-gradient-to-r from-blue-600/70 to-blue-500/70 backdrop-blur-md text-white' 
                        : entry.type === 'interviewer'
                        ? 'bg-gradient-to-r from-purple-600/60 to-pink-600/60 backdrop-blur-md text-white'
                        : 'bg-gray-800/30 backdrop-blur-md text-gray-200 border border-gray-700/50'
                    }`}>
                      <p className="text-sm leading-relaxed">{entry.text}</p>
                    </div>
                    <div className="flex items-center gap-2 mt-1 px-2">
                      <span className="text-[10px] text-gray-500">{entry.timestamp}</span>
                    </div>
                  </div>
                </div>
              ))}

              {/* Live Transcription */}
              {liveTranscription && (
                <div className="flex justify-start">
                  <div className="max-w-2xl">
                    <div className="rounded-2xl px-4 py-3 bg-gradient-to-r from-orange-500/15 to-yellow-500/15 backdrop-blur-md text-orange-200 border border-orange-500/20 shadow-xl">
                      <div className="flex items-start gap-2">
                        <div className="w-2 h-2 bg-orange-400 rounded-full animate-pulse mt-1.5 flex-shrink-0" />
                        <p className="text-sm leading-relaxed">
                          {liveTranscription.displayedText}
                          {liveTranscription.currentIndex < liveTranscription.fullText.length && (
                            <span className="inline-block w-0.5 h-4 bg-orange-400 animate-pulse ml-0.5" />
                          )}
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              <div ref={transcriptEndRef} />
            </div>
          </div>

          {/* Input Area */}
          <div className="border-t border-gray-800/30 bg-black/20 backdrop-blur-xl p-4">
            <div className="max-w-4xl mx-auto">
              <div className="flex items-center gap-3">
                {/* Recording Controls */}
                <button
                  onClick={handleRecordClick}
                  className={`p-3 rounded-full transition-all shadow-lg ${
                    isRecording 
                      ? 'bg-red-500/70 hover:bg-red-600/80 text-white animate-pulse backdrop-blur-md' 
                      : 'bg-gray-800/40 hover:bg-gray-700/50 text-gray-300 backdrop-blur-md'
                  }`}
                >
                  {isRecording ? <BsStopCircle className="w-5 h-5" /> : <BsRecordCircle className="w-5 h-5" />}
                </button>

                {isRecording && (
                  <>
                    <VolumeMeter />
                    <button
                      onClick={handleManualFlush}
                      className="px-4 py-2 rounded-full bg-blue-600/70 hover:bg-blue-700/80 backdrop-blur-md text-white text-sm font-medium transition-all shadow-lg"
                    >
                      Send
                    </button>
                  </>
                )}

                {/* Text Input */}
                <div className="flex-1 relative">
                  <input
                    type="text"
                    value={messageInput}
                    onChange={(e) => setMessageInput(e.target.value)}
                    onKeyPress={(e) => e.key === 'Enter' && handleSendMessage()}
                    placeholder="Type your message..."
                    className="w-full px-4 py-3 bg-gray-800/30 backdrop-blur-md border border-gray-700/50 rounded-full text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500/70 transition-colors shadow-inner"
                  />
                  <button
                    onClick={handleSendMessage}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-2 text-gray-400 hover:text-blue-400 transition-colors"
                  >
                    <FiSend className="w-4 h-4" />
                  </button>
                </div>

                {/* Additional Controls */}
                <div className="flex items-center gap-2">
                  <button className="p-2 text-gray-400 hover:text-white transition-colors">
                    <FiHeadphones className="w-5 h-5" />
                  </button>
                  <button 
                    onClick={onChatToggle}
                    className="p-2 text-gray-400 hover:text-white transition-colors"
                  >
                    <FiMessageSquare className="w-5 h-5" />
                  </button>
                </div>
              </div>

              {/* Recording Status */}
              {isRecording && (
                <div className="mt-3 flex items-center justify-center gap-2">
                  <div className="w-2 h-2 bg-red-500 rounded-full animate-pulse" />
                  <span className="text-xs text-gray-400">Recording... VAD will auto-send after 1.5s of silence</span>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Side Panel (when chat is shown) */}
        {showChat && (
          <div className="w-80 border-l border-gray-800/30 bg-black/20 backdrop-blur-2xl p-4">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-white font-semibold">Quick Actions</h3>
              <button 
                onClick={() => setShowChat(false)}
                className="text-gray-400 hover:text-white"
              >
                <AiOutlineClose className="w-4 h-4" />
              </button>
            </div>
            
            <div className="space-y-3">
              {screenshots.length > 0 && (
                <div className="p-3 bg-gray-800/30 backdrop-blur-md rounded-lg border border-gray-700/30">
                  <p className="text-sm text-gray-400 mb-2">Screenshots: {screenshots.length}</p>
                  <div className="flex gap-2">
                    <button className="flex-1 px-3 py-1.5 bg-blue-600/60 hover:bg-blue-700/70 backdrop-blur-md rounded text-white text-xs">
                      Analyze All
                    </button>
                    <button className="px-3 py-1.5 bg-gray-700/50 hover:bg-gray-600/60 backdrop-blur-md rounded text-white text-xs">
                      Clear
                    </button>
                  </div>
                </div>
              )}

              <div className="p-3 bg-gray-800/30 backdrop-blur-md rounded-lg border border-gray-700/30">
                <p className="text-sm text-gray-400 mb-2">Session Stats</p>
                <div className="space-y-1 text-xs">
                  <div className="flex justify-between">
                    <span className="text-gray-500">Messages:</span>
                    <span className="text-gray-300">{transcript.length}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Duration:</span>
                    <span className="text-gray-300">--:--</span>
                  </div>
                </div>
              </div>

              <div className="p-3 bg-gray-800/30 backdrop-blur-md rounded-lg border border-gray-700/30">
                <p className="text-sm text-gray-400 mb-2">Keyboard Shortcuts</p>
                <div className="space-y-1 text-xs">
                  <div className="flex justify-between">
                    <span className="text-gray-500">Start/Stop:</span>
                    <span className="text-gray-300">Space</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Send:</span>
                    <span className="text-gray-300">Enter</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Clear:</span>
                    <span className="text-gray-300">Esc</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default QueueCommands