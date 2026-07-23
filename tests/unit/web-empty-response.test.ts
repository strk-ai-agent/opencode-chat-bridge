import { describe, expect, test } from "bun:test"
import { EventEmitter } from "events"
import { WebConnector } from "../../connectors/web"

interface AttemptScenario {
  response?: string
  chunks?: string[]
  error?: Error
  toolResult?: string
}

class FakeACPClient extends EventEmitter {
  cancelled = false

  constructor(private scenario: AttemptScenario) {
    super()
  }

  async prompt(): Promise<string> {
    if (this.scenario.toolResult) {
      this.emit("update", {
        type: "tool_result",
        toolName: "database",
        toolResult: this.scenario.toolResult,
      })
    }
    for (const chunk of this.scenario.chunks || []) this.emit("chunk", chunk)
    if (this.scenario.error) throw this.scenario.error
    return this.scenario.response || ""
  }

  cancel(): void {
    this.cancelled = true
  }
}

function webSession(client: FakeACPClient) {
  return {
    client,
    createdAt: new Date(),
    lastActivity: new Date(),
    messageCount: 0,
    inputChars: 0,
    outputChars: 0,
  }
}

function fakeConnector(firstScenario: AttemptScenario, retryScenario: AttemptScenario) {
  const first = webSession(new FakeACPClient(firstScenario))
  const retry = webSession(new FakeACPClient(retryScenario))
  let current = first
  let retries = 0
  const messages: any[] = []
  const logs: string[] = []

  return {
    connector: {
      isQueryActive: () => false,
      markQueryActive: () => ({ sessionId: "browser-1", id: 1, aborted: false, abort: () => {} }),
      markQueryDone: () => {},
      getOrCreateSession: async () => first,
      recreateACPSession: async () => {
        retries++
        current = retry
        return retry
      },
      createBaseSession: () => first,
      sessionManager: { get: () => current },
      wsSend: (_clientId: string, data: any) => messages.push(data),
      sendFileAsImage: () => {},
      sendFileAsDoc: () => {},
      log: (message: string) => logs.push(message),
      logError: (message: string) => logs.push(message),
    },
    messages,
    logs,
    retryCount: () => retries,
  }
}

async function processQuery(fake: ReturnType<typeof fakeConnector>): Promise<void> {
  await (WebConnector.prototype as any).processQuery.call(fake.connector, "browser-1", "query")
}

describe("Web empty ACP responses", () => {
  test("retries an empty response with a fresh session and streams the recovered answer", async () => {
    const fake = fakeConnector(
      { response: "", chunks: [] },
      { response: "recovered", chunks: ["recovered"] },
    )

    await processQuery(fake)

    expect(fake.retryCount()).toBe(1)
    expect(fake.messages).toEqual([
      { type: "chunk", text: "recovered" },
      { type: "done" },
    ])
    expect(fake.logs.some((line) => line.includes("[DONE]") && line.includes("9 chars"))).toBe(true)
    expect(fake.logs.some((line) => line.includes("[FAIL]"))).toBe(false)
  })

  test("retries an ACP error once and succeeds", async () => {
    const fake = fakeConnector(
      { error: new Error("ACP failed") },
      { response: "answer", chunks: ["answer"] },
    )

    await processQuery(fake)

    expect(fake.retryCount()).toBe(1)
    expect(fake.messages).toEqual([
      { type: "chunk", text: "answer" },
      { type: "done" },
    ])
    expect(fake.logs.some((line) => line.includes("error=ACP failed"))).toBe(true)
  })

  test("shows a visible failure when both ACP attempts fail", async () => {
    const fake = fakeConnector(
      { error: new Error("first failure") },
      { error: new Error("second failure") },
    )

    await processQuery(fake)

    expect(fake.retryCount()).toBe(1)
    expect(fake.messages).toEqual([
      {
        type: "error",
        message: "The AI service completed without returning a usable response. Please try again.",
      },
      { type: "done" },
    ])
    expect(fake.logs.some((line) => line.includes("[FAIL]") && line.includes("reason=acp-error"))).toBe(true)
  })

  test("shows a visible failure instead of a blank completion after two empty attempts", async () => {
    const fake = fakeConnector({ response: "" }, { response: "" })

    await processQuery(fake)

    expect(fake.retryCount()).toBe(1)
    expect(fake.messages).toEqual([
      {
        type: "error",
        message: "The AI service completed without returning a usable response. Please try again.",
      },
      { type: "done" },
    ])
    expect(fake.logs.some((line) => line.includes("[FAIL]") && line.includes("reason=acp-no-text"))).toBe(true)
    expect(fake.logs.some((line) => line.includes("[DONE]"))).toBe(false)
  })

  test("does not retry an empty response after tool activity", async () => {
    const fake = fakeConnector(
      { response: "", toolResult: "database result" },
      { response: "unused", chunks: ["unused"] },
    )

    await processQuery(fake)

    expect(fake.retryCount()).toBe(0)
    expect(fake.messages.at(-2)).toEqual({
      type: "error",
      message: "The AI service completed without returning a usable response. Please try again.",
    })
    expect(fake.messages.at(-1)).toEqual({ type: "done" })
  })

  test("recovers direct ACP text missed by the Web chunk listener", async () => {
    const fake = fakeConnector(
      { response: "captured answer", chunks: [] },
      { response: "unused" },
    )

    await processQuery(fake)

    expect(fake.retryCount()).toBe(0)
    expect(fake.messages).toEqual([
      { type: "chunk", text: "captured answer" },
      { type: "done" },
    ])
    expect(fake.logs.some((line) => line.includes("Captured response recovery"))).toBe(true)
  })
})
