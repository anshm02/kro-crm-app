import { GoogleGenerativeAI, GenerativeModel } from "@google/generative-ai"
import fs from "fs"
import path from "path"
import { exec } from "child_process"
import { promisify } from "util"

const execAsync = promisify(exec)

export class LLMHelper {
  private model: GenerativeModel
  private readonly systemPrompt = `You are Wingman AI, a helpful, proactive assistant for any kind of problem or situation (not just coding). For any user input, analyze the situation, provide a clear problem statement, relevant context, and suggest several possible responses or actions the user could take next. Always explain your reasoning. Present your suggestions as a list of options or next steps.`

  constructor(apiKey: string) {
    const genAI = new GoogleGenerativeAI(apiKey)
    this.model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" })
  }

  private async fileToGenerativePart(imagePath: string) {
    const imageData = await fs.promises.readFile(imagePath)
    return {
      inlineData: {
        data: imageData.toString("base64"),
        mimeType: "image/png"
      }
    }
  }

  private cleanJsonResponse(text: string): string {
    // Remove markdown code block syntax if present
    text = text.replace(/^```(?:json)?\n/, '').replace(/\n```$/, '');
    // Remove any leading/trailing whitespace
    text = text.trim();
    return text;
  }

  public async extractProblemFromImages(imagePaths: string[]) {
    try {
      const imageParts = await Promise.all(imagePaths.map(path => this.fileToGenerativePart(path)))
      
      const prompt = `${this.systemPrompt}\n\nYou are a wingman. Please analyze these images and extract the following information in JSON format:\n{
  "problem_statement": "A clear statement of the problem or situation depicted in the images.",
  "context": "Relevant background or context from the images.",
  "suggested_responses": ["First possible answer or action", "Second possible answer or action", "..."],
  "reasoning": "Explanation of why these suggestions are appropriate."
}\nImportant: Return ONLY the JSON object, without any markdown formatting or code blocks.`

      const result = await this.model.generateContent([prompt, ...imageParts])
      const response = await result.response
      const text = this.cleanJsonResponse(response.text())
      return JSON.parse(text)
    } catch (error) {
      console.error("Error extracting problem from images:", error)
      throw error
    }
  }

  public async generateSolution(problemInfo: any) {
    const prompt = `${this.systemPrompt}\n\nGiven this problem or situation:\n${JSON.stringify(problemInfo, null, 2)}\n\nPlease provide your response in the following JSON format:\n{
  "solution": {
    "code": "The code or main answer here.",
    "problem_statement": "Restate the problem or situation.",
    "context": "Relevant background/context.",
    "suggested_responses": ["First possible answer or action", "Second possible answer or action", "..."],
    "reasoning": "Explanation of why these suggestions are appropriate."
  }
}\nImportant: Return ONLY the JSON object, without any markdown formatting or code blocks.`

    console.log("[LLMHelper] Calling Gemini LLM for solution...");
    try {
      const result = await this.model.generateContent(prompt)
      console.log("[LLMHelper] Gemini LLM returned result.");
      const response = await result.response
      const text = this.cleanJsonResponse(response.text())
      const parsed = JSON.parse(text)
      console.log("[LLMHelper] Parsed LLM response:", parsed)
      return parsed
    } catch (error) {
      console.error("[LLMHelper] Error in generateSolution:", error);
      throw error;
    }
  }

  public async debugSolutionWithImages(problemInfo: any, currentCode: string, debugImagePaths: string[]) {
    try {
      const imageParts = await Promise.all(debugImagePaths.map(path => this.fileToGenerativePart(path)))
      
      const prompt = `${this.systemPrompt}\n\nYou are a wingman. Given:\n1. The original problem or situation: ${JSON.stringify(problemInfo, null, 2)}\n2. The current response or approach: ${currentCode}\n3. The debug information in the provided images\n\nPlease analyze the debug information and provide feedback in this JSON format:\n{
  "solution": {
    "code": "The code or main answer here.",
    "problem_statement": "Restate the problem or situation.",
    "context": "Relevant background/context.",
    "suggested_responses": ["First possible answer or action", "Second possible answer or action", "..."],
    "reasoning": "Explanation of why these suggestions are appropriate."
  }
}\nImportant: Return ONLY the JSON object, without any markdown formatting or code blocks.`

      const result = await this.model.generateContent([prompt, ...imageParts])
      const response = await result.response
      const text = this.cleanJsonResponse(response.text())
      const parsed = JSON.parse(text)
      console.log("[LLMHelper] Parsed debug LLM response:", parsed)
      return parsed
    } catch (error) {
      console.error("Error debugging solution with images:", error)
      throw error
    }
  }

  public async analyzeAudioFile(audioPath: string) {
    try {
      const audioData = await fs.promises.readFile(audioPath);
      const audioPart = {
        inlineData: {
          data: audioData.toString("base64"),
          mimeType: "audio/mp3"
        }
      };
      const prompt = `${this.systemPrompt}\n\nDescribe this audio clip in a short, concise answer. In addition to your main answer, suggest several possible actions or responses the user could take next based on the audio. Do not return a structured JSON object, just answer naturally as you would to a user.`;
      const result = await this.model.generateContent([prompt, audioPart]);
      const response = await result.response;
      const text = response.text();
      return { text, timestamp: Date.now() };
    } catch (error) {
      console.error("Error analyzing audio file:", error);
      throw error;
    }
  }

  // LOCAL SLM FOR AUDIO ONLY - Using whisper.cpp + Ollama
  public async analyzeAudioFromBase64(data: string, mimeType: string) {
    try {
      const startTime = Date.now();
      console.log("[LLMHelper] Starting local audio processing...");
      
      // Create temp directory if it doesn't exist
      const tempDir = path.join(process.cwd(), 'temp');
      await fs.promises.mkdir(tempDir, { recursive: true });
      
      // Determine file extension from mimeType
      const ext = mimeType.includes('webm') ? 'webm' : 'wav';  // Default to wav
      
      const audioPath = path.join(tempDir, `audio_${Date.now()}.${ext}`);
      
      // Save audio to temp file
      await fs.promises.writeFile(audioPath, Buffer.from(data, 'base64'));
      console.log(`[LLMHelper] Audio saved to: ${audioPath}`);
      
      // Verify file exists and has content
      const stats = await fs.promises.stat(audioPath);
      console.log(`[LLMHelper] Audio file size: ${stats.size} bytes`);
      
      if (stats.size < 1000) {
        console.warn("[LLMHelper] Audio file is very small, might be silent");
      }
      
      // Convert to WAV for whisper with VOLUME BOOST
      let processPath = audioPath;  // Start with original path
      
      // ALWAYS convert to WAV with volume boost for better results
      const boostedWavPath = audioPath.replace(`.${ext}`, '_boosted.wav');
      
      try {
        if (ext !== 'wav') {
          // Convert and boost volume in one step
          const convertCmd = `ffmpeg -i "${audioPath}" -af "volume=3.0,highpass=f=200,lowpass=f=3000" -ar 16000 -ac 1 -c:a pcm_s16le "${boostedWavPath}" -y`;
          console.log(`[LLMHelper] Converting to WAV with volume boost...`);
          console.log(`[LLMHelper] Command: ${convertCmd}`);
          
          await execAsync(convertCmd);
          
          if (fs.existsSync(boostedWavPath)) {
            const wavStats = await fs.promises.stat(boostedWavPath);
            console.log(`[LLMHelper] WAV created: ${boostedWavPath} (${wavStats.size} bytes)`);
            processPath = boostedWavPath;  // UPDATE processPath to the new WAV file
          } else {
            console.error("[LLMHelper] WAV conversion failed");
            throw new Error("WAV conversion failed");
          }
        } else {
          // Even for WAV files, boost the volume
          const boostCmd = `ffmpeg -i "${audioPath}" -af "volume=3.0" "${boostedWavPath}" -y`;
          console.log(`[LLMHelper] Boosting volume for WAV file...`);
          await execAsync(boostCmd);
          
          if (fs.existsSync(boostedWavPath)) {
            processPath = boostedWavPath;  // UPDATE processPath to boosted WAV
            console.log("[LLMHelper] Volume boosted WAV created");
          } else {
            processPath = audioPath;
          }
        }
      } catch (e: any) {
        console.error("[LLMHelper] FFmpeg error:", e.message);
        // Try simpler conversion without filters
        try {
          const simpleWavPath = audioPath.replace(`.${ext}`, '.wav');
          const simpleCmd = `ffmpeg -i "${audioPath}" -ar 16000 -ac 1 "${simpleWavPath}" -y`;
          console.log("[LLMHelper] Trying simple conversion without filters...");
          await execAsync(simpleCmd);
          
          if (fs.existsSync(simpleWavPath)) {
            processPath = simpleWavPath;  // UPDATE processPath
            console.log("[LLMHelper] Simple WAV conversion succeeded");
          }
        } catch (e2) {
          console.error("[LLMHelper] All conversions failed, using original");
          processPath = audioPath;
        }
      }
      
      // Verify the file we're about to process exists
      if (!fs.existsSync(processPath)) {
        throw new Error(`Audio file not found after conversion: ${processPath}`);
      }
      
      console.log(`[LLMHelper] FINAL: Will use this file for whisper: ${processPath}`);
      
      // Transcribe with whisper.cpp (fastest)
      console.log("[LLMHelper] Transcribing with whisper.cpp...");
      
      // Use the CORRECT whisper-cli binary that EXISTS in your build/bin folder
      const whisperCommand = `./whisper.cpp/build/bin/whisper-cli -m ./whisper.cpp/models/ggml-tiny.en.bin -f "${processPath}" -t 8 --no-timestamps -l en`;
      
      console.log(`[LLMHelper] Running command: ${whisperCommand}`);
      
      const { stdout, stderr } = await execAsync(whisperCommand);
      
      // Extract transcription from output
      let transcription = '';
      
      // whisper.cpp outputs directly to stdout when using -otxt
      if (stdout) {
        // Parse the output to get just the transcription text
        const lines = stdout.split('\n');
        for (const line of lines) {
          // Skip metadata lines, get actual transcription
          if (line && !line.startsWith('[') && !line.includes('whisper_') && !line.includes('main:')) {
            transcription += line + ' ';
          }
        }
        transcription = transcription.trim();
      }
      
      // Also check for output file
      const transcriptionFile = audioPath.replace(`.${ext}`, '.txt');
      try {
        const fileContent = await fs.promises.readFile(transcriptionFile, 'utf-8');
        if (fileContent) {
          transcription = fileContent.trim();
        }
        fs.promises.unlink(transcriptionFile).catch(() => {});
      } catch (e) {
        // File might not exist, use stdout transcription
      }
      
      console.log(`\n[LIVE TRANSCRIPTION]: ${transcription}\n`);
      console.log(`[LLMHelper] Transcription complete in ${Date.now() - startTime}ms`);
      
      // Process with Ollama local LLM
      console.log("[LLMHelper] Processing with Ollama...");

      // CHANGE: Properly escape the transcription for JSON
      const escapedTranscription = transcription
        .replace(/\\/g, '\\\\')  // Escape backslashes first
        .replace(/"/g, '\\"')     // Escape quotes
        .replace(/\n/g, '\\n')    // Escape newlines
        .replace(/\r/g, '\\r')    // Escape carriage returns
        .replace(/\t/g, '\\t');   // Escape tabs

      const ollamaPrompt = `${this.systemPrompt}\n\nAudio transcription: "${escapedTranscription}"\n\n Provide a suggestion to the users question.`;

      // CHANGE: Build the JSON payload as an object first, then stringify it
      const ollamaPayload = {
        model: "qwen2.5:0.5b",
        prompt: ollamaPrompt,
        stream: false,
        options: {
          temperature: 0.3,
          num_predict: 100,
          num_ctx: 512,
          num_thread: 8,
          seed: 42
        }
      };

      // CHANGE: Write to temp file to avoid shell escaping issues
      const payloadPath = path.join(tempDir, `ollama_payload_${Date.now()}.json`);
      await fs.promises.writeFile(payloadPath, JSON.stringify(ollamaPayload));

      // CHANGE: Use curl with file input instead of inline JSON
      const ollamaCommand = `curl -s http://localhost:11434/api/generate -d @"${payloadPath}"`;

      const { stdout: ollamaOutput } = await execAsync(ollamaCommand);
      const ollamaResponse = JSON.parse(ollamaOutput);

      // CHANGE: Clean up the payload file
      fs.promises.unlink(payloadPath).catch(() => {});

      console.log(`[LLMHelper] Total processing time: ${Date.now() - startTime}ms`);
      
      // Clean up temp file
      fs.promises.unlink(audioPath).catch(() => {});
      
      return { 
        text: ollamaResponse.response, 
        timestamp: Date.now()
      };
      
    } catch (error) {
      console.error("Error analyzing audio from base64:", error);
      throw error;
    }
  }

  public async analyzeImageFile(imagePath: string) {
    try {
      const imageData = await fs.promises.readFile(imagePath);
      const imagePart = {
        inlineData: {
          data: imageData.toString("base64"),
          mimeType: "image/png"
        }
      };
      const prompt = `${this.systemPrompt}\n\nDescribe the content of this image in a short, concise answer. In addition to your main answer, suggest several possible actions or responses the user could take next based on the image. Do not return a structured JSON object, just answer naturally as you would to a user. Be concise and brief.`;
      const result = await this.model.generateContent([prompt, imagePart]);
      const response = await result.response;
      const text = response.text();
      return { text, timestamp: Date.now() };
    } catch (error) {
      console.error("Error analyzing image file:", error);
      throw error;
    }
  }

  public async chatWithGemini(message: string): Promise<string> {
    try {
      const result = await this.model.generateContent(message);
      const response = await result.response;
      return response.text();
    } catch (error) {
      console.error("[LLMHelper] Error in chatWithGemini:", error);
      throw error;
    }
  }
}