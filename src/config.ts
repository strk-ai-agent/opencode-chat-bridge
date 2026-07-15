/**
 * Configuration loader for chat-bridge
 * 
 * Loads settings from chat-bridge.json or chat-bridge.jsonc with environment
 * variable substitution.
 */

import * as fs from "fs"
import * as path from "path"

export interface MatrixConfig {
  enabled: boolean
  homeserver: string
  userId: string
  accessToken: string
  password: string  // For password-based login (auto-generates tokens)
  deviceId: string
  encryption: {
    enabled: boolean
    storePath: string
  }
  autoJoin: boolean
  triggerPatterns: string[]
  ignoreRooms: string[]
  ignoreUsers: string[]
  allowedUsers: string[]
  formatHtml: boolean
  threadIsolation: boolean  // true: per-thread sessions + thread replies, false: per-room
}

export interface MattermostConfig {
  enabled: boolean
  url: string            // Mattermost server URL (e.g., https://mattermost.example.com)
  token: string          // Bot access token
  teamName: string       // Team to connect to (URL slug, e.g., "myteam")
  respondToMentions: boolean // Respond when @mentioned (in addition to trigger)
  ignoreChannels: string[] // Channel IDs to ignore
  ignoreUsers: string[]    // User IDs to ignore
  allowedUsers: string[]
  threadIsolation: boolean // true: per-thread sessions + thread replies, false: per-channel
}

export interface WhatsAppConfig {
  enabled: boolean
  authFolder: string
  allowedUsers: string[]
  respondToOthers: boolean
}

export interface SlackConfig {
  enabled: boolean
  allowedUsers: string[]
  threadIsolation: boolean  // true: per-thread sessions + thread replies, false: per-channel
}

export interface DiscordConfig {
  enabled: boolean
  allowedUsers: string[]
}

export interface TelegramConfig {
  enabled: boolean
  /** Bot token from @BotFather -- env: TELEGRAM_BOT_TOKEN */
  token: string
  /** Respond when @-mentioned in groups (in addition to trigger) */
  respondToMentions: boolean
  /** Per-topic sessions in forum supergroups (chatId:messageThreadId).
   *  When false, all messages in a chat share one session. */
  threadIsolation: boolean
  /** Comma-separated Telegram numeric chat IDs and/or user IDs to ignore */
  ignoreChats: string[]
  /** Comma-separated Telegram numeric user IDs to ignore */
  ignoreUsers: string[]
  allowedUsers: string[]
}


export interface WebConfig {
  enabled: boolean
  port: number
  host: string
  allowedOrigins: string[]  // CORS origins, ["*"] = any
  publicUrl: string         // Override for logs/snippets (e.g. behind reverse proxy)
}

export interface ACPConfig {
  command: string
  args: string[]
  backendId: string
  profileDir: string
}

export interface SessionPickerConfig {
  enabled: boolean
  connectors: string[]
  mirrorIntervalSeconds: number
}

export interface ChatBridgeConfig {
  botName: string
  trigger: string
  rateLimitSeconds: number
  sessionStorePath: string
  defaultAgent: string | null
  modes: Record<string, string>
  streamTools: string[]  // Tools to stream output for (e.g., ["bash"]), empty = none
  sessionPicker: SessionPickerConfig
  acp: ACPConfig
  matrix: MatrixConfig
  mattermost: MattermostConfig
  whatsapp: WhatsAppConfig
  slack: SlackConfig
  discord: DiscordConfig
  telegram: TelegramConfig
  web: WebConfig
}

// Default configuration
const defaultConfig: ChatBridgeConfig = {
  botName: "oc",
  trigger: "!oc",
  rateLimitSeconds: 5,
  sessionStorePath: "./.opencode/chat-sessions.json",
  defaultAgent: null,
  modes: {},
  streamTools: ["bash"],  // Only stream bash output by default
  sessionPicker: {
    enabled: false,
    connectors: [],
    mirrorIntervalSeconds: 60,
  },
  acp: {
    command: "opencode",
    args: ["acp"],
    backendId: "",
    profileDir: "",
  },
  matrix: {
    enabled: false,
    homeserver: "https://matrix.org",
    userId: "",
    accessToken: "",
    password: "",  // For password-based login
    deviceId: "OPENCODE_BRIDGE",
    encryption: {
      enabled: false,
      storePath: "./matrix-store/"
    },
    autoJoin: true,
    triggerPatterns: ["!oc "],
    ignoreRooms: [],
    ignoreUsers: [],
    allowedUsers: [],
    formatHtml: false,
    threadIsolation: true,  // Per-thread sessions by default
  },
  mattermost: {
    enabled: false,
    url: "",
    token: "",
    teamName: "",
    respondToMentions: true,
    ignoreChannels: [],
    ignoreUsers: [],
    allowedUsers: [],
    threadIsolation: true,  // Per-thread sessions by default
  },
  whatsapp: {
    enabled: false,
    authFolder: "./.whatsapp-auth",
    allowedUsers: [],
    respondToOthers: true
  },
  slack: {
    enabled: false,
    allowedUsers: [],
    threadIsolation: true,  // Per-thread sessions by default
  },
  discord: {
    enabled: false,
    allowedUsers: [],
  },
  telegram: {
    enabled: false,
    token: "",
    respondToMentions: true,
    threadIsolation: true,
    ignoreChats: [],
    ignoreUsers: [],
    allowedUsers: [],
  },
  web: {
    enabled: false,
    port: 3420,
    host: "0.0.0.0",
    allowedOrigins: ["*"],
    publicUrl: "",
  }
}

/**
 * Remove JSONC comments while preserving strings and line structure so that
 * JSON.parse can still report useful line/column information for malformed
 * configuration files.
 */
function stripJsoncComments(content: string): string {
  let result = ""
  let inString = false
  let escaped = false
  let lineComment = false
  let blockComment = false

  for (let i = 0; i < content.length; i++) {
    const char = content[i]
    const next = content[i + 1]

    if (lineComment) {
      if (char === "\n" || char === "\r") {
        lineComment = false
        result += char
      } else {
        result += " "
      }
      continue
    }

    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false
        result += "  "
        i++
      } else if (char === "\n" || char === "\r") {
        result += char
      } else {
        result += " "
      }
      continue
    }

    if (inString) {
      result += char
      if (escaped) {
        escaped = false
      } else if (char === "\\") {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
      result += char
    } else if (char === "/" && next === "/") {
      lineComment = true
      result += "  "
      i++
    } else if (char === "/" && next === "*") {
      blockComment = true
      result += "  "
      i++
    } else {
      result += char
    }
  }

  return result
}

/**
 * JSONC commonly permits trailing commas as well as comments. Remove commas
 * immediately before a closing array/object delimiter without touching
 * commas inside strings.
 */
function stripJsoncTrailingCommas(content: string): string {
  let result = ""
  let inString = false
  let escaped = false

  for (let i = 0; i < content.length; i++) {
    const char = content[i]

    if (inString) {
      result += char
      if (escaped) {
        escaped = false
      } else if (char === "\\") {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
      result += char
      continue
    }

    if (char === ",") {
      let next = i + 1
      while (next < content.length && /\s/.test(content[next])) {
        next++
      }
      if (content[next] === "}" || content[next] === "]") {
        continue
      }
    }

    result += char
  }

  return result
}

function parseJsonc(content: string): unknown {
  const withoutBom = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content
  const withoutComments = stripJsoncComments(withoutBom)
  return JSON.parse(stripJsoncTrailingCommas(withoutComments))
}

/**
 * Replace {env:VAR_NAME} patterns with environment variables
 */
function substituteEnvVars(obj: any): any {
  if (typeof obj === "string") {
    return obj.replace(/\{env:([^}]+)\}/g, (_, varName) => {
      return process.env[varName] || ""
    })
  }
  if (Array.isArray(obj)) {
    return obj.map(substituteEnvVars)
  }
  if (obj && typeof obj === "object") {
    const result: any = {}
    for (const [key, value] of Object.entries(obj)) {
      result[key] = substituteEnvVars(value)
    }
    return result
  }
  return obj
}

/**
 * Deep merge two objects
 */
function deepMerge<T>(target: T, source: Partial<T>): T {
  const result = { ...target }
  for (const key in source) {
    const sourceValue = source[key]
    const targetValue = (target as any)[key]
    
    if (sourceValue && typeof sourceValue === "object" && !Array.isArray(sourceValue) &&
        targetValue && typeof targetValue === "object" && !Array.isArray(targetValue)) {
      (result as any)[key] = deepMerge(targetValue, sourceValue)
    } else if (sourceValue !== undefined) {
      (result as any)[key] = sourceValue
    }
  }
  return result
}

let cachedConfig: ChatBridgeConfig | null = null

/**
 * Load configuration from chat-bridge.json or chat-bridge.jsonc
 */
export function loadConfig(configPath?: string): ChatBridgeConfig {
  if (cachedConfig) return cachedConfig
  
  const searchPaths = configPath 
    ? [configPath]
    : [
        path.join(process.cwd(), "chat-bridge.json"),
        path.join(process.cwd(), "chat-bridge.jsonc"),
      ]
  
  for (const filePath of searchPaths) {
    if (fs.existsSync(filePath)) {
      try {
        const content = fs.readFileSync(filePath, "utf-8")
        const parsed = parseJsonc(content)
        const substituted = substituteEnvVars(parsed)
        cachedConfig = deepMerge(defaultConfig, substituted)
        console.log(`[CONFIG] Loaded from ${filePath}`)
        return cachedConfig
      } catch (err) {
        console.error(`[CONFIG] Error loading ${filePath}:`, err)
      }
    }
  }
  
  console.log("[CONFIG] No config file found, using defaults")
  cachedConfig = defaultConfig
  return cachedConfig
}

/**
 * Get the current configuration (loads if not already loaded)
 */
export function getConfig(): ChatBridgeConfig {
  return cachedConfig || loadConfig()
}

/**
 * Clear cached config (useful for testing)
 */
export function clearConfigCache(): void {
  cachedConfig = null
}
