# KRO CRM Assistant

KRO is an AI-powered CRM assistant designed to help sales teams manage client relationships, track deals, and boost efficiency. It integrates voice, AI, and CRM workflows into a single lightweight app.

<img width="697" height="798" alt="Screenshot 2025-10-02 at 6 16 13 PM" src="https://github.com/user-attachments/assets/eb30eb32-a8e4-479d-bdbd-1247eaa24602" />

---

## 🚀 Quick Start Guide

### Prerequisites

- Node.js installed on your computer
- Git installed on your computer
- An API key for your preferred LLM provider (e.g., Gemini, OpenAI, or other supported APIs)

---

### Installation Steps

#### 1. Clone the repository

```bash
git clone [repository-url]
cd kro-crm
```

#### 2. Install dependencies

```bash
npm install
```

#### 3. Set up environment variables

- Create a file named `.env` in the root folder
- Add your API key (example with Gemini):

```ini
GEMINI_API_KEY=your_api_key_here
```

- Save the file

---

## Running the App

### Method 1: Development Mode (Recommended for first run)

1. **Start the frontend:**

```bash
npm run dev -- --port 5180
```

2. **In another terminal, start the desktop app:**

```bash
NODE_ENV=development npm run electron:dev
```

### Method 2: Production Build

```bash
npm run build
```

The built app will be located in the `release` folder.

---

## ⚠️ Important Notes

### Closing the App

- Use **Cmd + Q** (Mac) or **Ctrl + Q** (Windows/Linux) to quit
- Or close the process via Activity Monitor/Task Manager
- **Note:** The X button currently does not fully quit the app (known issue)

### If the app doesn't start

Ensure no other app is using port 5180. Kill any conflicting processes:

```bash
lsof -i :5180
kill [PID]
```

---

## Keyboard Shortcuts (customizable)

- **Cmd/Ctrl + B:** Toggle app visibility
- **Cmd/Ctrl + H:** Capture meeting notes/screenshot
- **Cmd/Enter:** Trigger AI assistant
- **Cmd/Ctrl + Arrow Keys:** Move window

---

## Troubleshooting

If you run into errors:

1. Delete the `node_modules` folder
2. Delete `package-lock.json`
3. Reinstall dependencies:

```bash
npm install
```

4. Run again in development mode
