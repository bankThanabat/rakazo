import { CustomerAssessmentConfig } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { explicitHumanRequest, JevCustomerAssessment } from "./customer-assessment.js";
import { createSafeRemoteFetch } from "./remote-mcp.js";

vi.mock("./remote-mcp.js", () => ({ createSafeRemoteFetch: vi.fn() }));

const config = { baseUrl: "https://api.typesafe.ai/v1", apiKey: "fixture", model: "jev-latest" };
const answer = (choice = "no", confidence = 0.95) => ({ type: "choice", choice, confidence });
describe("customer escalation assessment", () => {
  it("preserves legacy configuration and bounds additional criteria", () => {
    const saved = { provider: "jev", credential: "assessment", baseUrl: config.baseUrl };
    expect(CustomerAssessmentConfig.parse(saved).criteria).toBe("");
    expect(
      CustomerAssessmentConfig.parse({ ...saved, criteria: "  Ask staff about wholesale.  " })
        .criteria,
    ).toBe("Ask staff about wholesale.");
    expect(
      CustomerAssessmentConfig.safeParse({ ...saved, criteria: "a".repeat(2001) }).success,
    ).toBe(false);
  });
  it.each([
    { choice: "yes", confidence: 0.95, needsHuman: true },
    { choice: "no", confidence: 0.95, needsHuman: false },
    { choice: "no", confidence: 0.7, needsHuman: true },
  ])("applies configured criteria and confidence: $choice/$confidence", async (decision) => {
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({
        answers: {
          human: answer(),
          unresolved: answer(),
          supported: answer("yes"),
          configured: answer(decision.choice, decision.confidence),
        },
      }),
    );
    const criteria = "Ask staff when a customer requests wholesale pricing for 50 or more items.";
    const result = await new JevCustomerAssessment(config, request).assess({
      criteria,
      messages: [{ role: "customer", content: "What is the wholesale price for 60 bags?" }],
      signal: new AbortController().signal,
    });
    expect(result.needsHuman).toBe(decision.needsHuman);
    expect(result.confidence).toBe(decision.confidence);
    if (decision.choice === "yes")
      expect(result.reason).toBe("A configured escalation rule requires staff");
    const payload = JSON.parse(String(request.mock.calls[0]![1]?.body));
    expect(payload.questions.configured.criteria.yes).toContain(criteria);
    expect(payload.questions.human).toBeDefined();
    expect(payload.questions.unresolved).toBeDefined();
    expect(payload.questions.supported).toBeDefined();
  });
  it.each(["human", "unresolved", "supported"])(
    "a configured no cannot cancel the %s handoff",
    async (rule) => {
      const answers = {
        human: answer(),
        unresolved: answer(),
        supported: answer("yes"),
        configured: answer(),
      };
      answers[rule as "human" | "unresolved" | "supported"] = answer(
        rule === "supported" ? "no" : "yes",
      );
      const request = vi.fn<typeof fetch>(async () => Response.json({ answers }));
      expect(
        await new JevCustomerAssessment(config, request).assess({
          criteria: "Never ask staff to help.",
          messages: [],
          signal: new AbortController().signal,
        }),
      ).toMatchObject({ needsHuman: true });
    },
  );
  it("rejects omitted configured answers and ignores unsolicited ones when no criteria are enabled", async () => {
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({
        answers: { human: answer(), unresolved: answer(), supported: answer("yes") },
      }),
    );
    const provider = new JevCustomerAssessment(config, request);
    await expect(
      provider.assess({
        criteria: "Ask staff about wholesale.",
        messages: [],
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow();
    request.mockResolvedValueOnce(
      Response.json({
        answers: {
          human: answer(),
          unresolved: answer(),
          supported: answer("yes"),
          configured: answer("yes", 0.2),
        },
      }),
    );
    expect(
      await provider.assess({ criteria: " ", messages: [], signal: new AbortController().signal }),
    ).toMatchObject({ needsHuman: false, confidence: 0.95 });
    expect(
      JSON.parse(String(request.mock.calls[1]![1]?.body)).questions.configured,
    ).toBeUndefined();
  });
  it("uses connector transport and closes it after successful and invalid responses", async () => {
    const close = vi.fn(async () => {});
    const request = Object.assign(
      vi.fn(async () =>
        Response.json({
          answers: { human: answer(), unresolved: answer(), supported: answer("yes") },
        }),
      ),
      { close },
    );
    vi.mocked(createSafeRemoteFetch).mockReturnValue(request);
    const provider = new JevCustomerAssessment(config);
    expect(
      await provider.assess({ messages: [], signal: new AbortController().signal }),
    ).toMatchObject({ needsHuman: false });
    expect(close).toHaveBeenCalledOnce();
    request.mockResolvedValueOnce(Response.json({ answers: {} }));
    await expect(
      provider.assess({ messages: [], signal: new AbortController().signal }),
    ).rejects.toThrow();
    expect(close).toHaveBeenCalledTimes(2);
    close.mockRejectedValueOnce(new Error("Dispatcher shutdown failed"));
    expect(
      await provider.assess({ messages: [], signal: new AbortController().signal }),
    ).toMatchObject({ needsHuman: false });
    expect(close).toHaveBeenCalledTimes(3);
  });
  it("honors direct requests in Thai and English without classifying routine help as handoff", () => {
    expect(explicitHumanRequest("Please connect me to a human")).toBe(true);
    expect(explicitHumanRequest("ขอคุยกับแอดมินค่ะ")).toBe(true);
    expect(explicitHumanRequest("Can you help me choose a bag?")).toBe(false);
  });
  it.each([
    "Please don't connect me to a human, just explain the sizes.",
    "Please do not transfer me to an agent.",
    "I don’t want to talk to a manager.",
    "I never asked to speak with a person.",
    "ไม่ต้องติดต่อเจ้าหน้าที่ค่ะ อยากทราบขนาดกระเป๋า",
    "ไม่อยากคุยกับแอดมินค่ะ",
    "อย่าติดต่อพนักงานนะคะ",
    "I have no need to talk to a human.",
    "I do not currently want to talk to a human.",
    "I cannot right now speak with a person.",
    "Please don't, under any circumstances, connect me to an agent.",
    "ไม่อยากจะคุยกับแอดมินค่ะ",
  ])("leaves a negated human request to assessment: %s", (message) => {
    expect(explicitHumanRequest(message)).toBe(false);
  });
  it.each([
    "I don't want a refund. Please connect me to a human.",
    "Don't connect me to an agent, but transfer me to a manager.",
    "ไม่อยากคืนสินค้า แต่ขอคุยกับแอดมินค่ะ",
    "I can't wait to talk to a human.",
    "I don't want a refund and I want to talk to a human.",
    "ไม่อยากคืนสินค้า ขอคุยกับแอดมินค่ะ",
  ])("preserves an affirmative request in a later clause: %s", (message) => {
    expect(explicitHumanRequest(message)).toBe(true);
  });
  it("uses typed answers and a confidence floor, never inferring correctness", async () => {
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({
        answers: { human: answer(), unresolved: answer("no", 0.7), supported: answer("yes") },
      }),
    );
    const provider = new JevCustomerAssessment(config, request);
    expect(
      await provider.assess({ messages: [], signal: new AbortController().signal }),
    ).toMatchObject({ needsHuman: true, confidence: 0.7 });
    expect(String(request.mock.calls[0]![0])).toBe("https://api.typesafe.ai/v1/systemone");
    expect(JSON.parse(String(request.mock.calls[0]![1]?.body)).model).toBe("jev-latest");
  });
  it("honors high-confidence handoff and rejects malformed or failed assessments", async () => {
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({
        answers: { human: answer("yes"), unresolved: answer(), supported: answer("yes") },
      }),
    );
    const provider = new JevCustomerAssessment(config, request);
    expect(
      (await provider.assess({ messages: [], signal: new AbortController().signal })).needsHuman,
    ).toBe(true);
    request.mockResolvedValueOnce(
      Response.json({
        answers: { human: answer("maybe"), unresolved: answer(), supported: answer("yes") },
      }),
    );
    await expect(
      provider.assess({ messages: [], signal: new AbortController().signal }),
    ).rejects.toThrow();
    request.mockResolvedValueOnce(new Response(null, { status: 503 }));
    await expect(
      provider.assess({ messages: [], signal: new AbortController().signal }),
    ).rejects.toThrow("unavailable");
  });
});
