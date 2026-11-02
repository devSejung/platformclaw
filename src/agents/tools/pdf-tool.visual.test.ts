// PDF visual inspection tests cover selected-page images and strict evidence requirements.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import * as pdfExtractModule from "../../media/pdf-extract.js";
import * as pdfNativeProviders from "./pdf-native-providers.js";
import {
  createPdfToolInfraStub,
  resetPdfToolAuthEnv,
  withTempPdfAgentDir,
} from "./pdf-tool.test-support.js";

const completeMock = vi.hoisted(() => vi.fn());
const registerProviderStreamForModelMock = vi.hoisted(() => vi.fn());

vi.mock("../../llm/stream.js", async () => {
  const actual = await vi.importActual<typeof import("../../llm/stream.js")>("../../llm/stream.js");
  return { ...actual, complete: completeMock };
});

vi.mock("../provider-stream.js", () => ({
  registerProviderStreamForModel: registerProviderStreamForModelMock,
}));

const { stubPdfToolInfra } = createPdfToolInfraStub(completeMock);
type PdfToolModule = typeof import("./pdf-tool.js");
let createPdfTool: PdfToolModule["createPdfTool"];

async function loadCreatePdfTool() {
  if (!createPdfTool) {
    ({ createPdfTool } = await import("./pdf-tool.js"));
  }
  return createPdfTool;
}

function requirePdfTool(tool: ReturnType<PdfToolModule["createPdfTool"]>) {
  if (!tool) {
    throw new Error("expected pdf tool");
  }
  return tool;
}

function withPdfModel(primary: string): OpenClawConfig {
  return { agents: { defaults: { pdfModel: { primary } } } };
}

const ANTHROPIC_PDF_MODEL = "anthropic/claude-opus-4-6";
const GOOGLE_PDF_MODEL = "google/gemini-2.5-pro";
const OPENAI_PDF_MODEL = "openai/gpt-5.4-mini";
const VISUAL_PAGE_IMAGES: pdfExtractModule.PdfExtractedContent["images"] = [
  { type: "image", data: "cGFnZTk3", mimeType: "image/png", pageNumber: 97 },
  { type: "image", data: "cGFnZTk4", mimeType: "image/png", pageNumber: 98 },
];

describe("createPdfTool visual inspection", () => {
  beforeEach(() => {
    resetPdfToolAuthEnv();
    completeMock.mockReset();
    registerProviderStreamForModelMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it.each([
    ["anthropic", ANTHROPIC_PDF_MODEL, "anthropic-messages"],
    ["google", GOOGLE_PDF_MODEL, "google-generative-ai"],
    ["openai", OPENAI_PDF_MODEL, "openai-responses"],
  ])(
    "inspects selected page images through %s even with sufficient text",
    async (provider, model, api) => {
      await withTempPdfAgentDir(async (agentDir) => {
        await stubPdfToolInfra(agentDir, { provider, api, input: ["text", "image"] });
        const anthropicSpy = vi
          .spyOn(pdfNativeProviders, "anthropicAnalyzePdf")
          .mockResolvedValue("unexpected native path");
        const googleSpy = vi
          .spyOn(pdfNativeProviders, "geminiAnalyzePdf")
          .mockResolvedValue("unexpected native path");
        const text = "Searchable prose accompanying a diagram. ".repeat(10);
        const extractSpy = vi.spyOn(pdfExtractModule, "extractPdfContent").mockResolvedValue({
          text,
          images: VISUAL_PAGE_IMAGES,
        });
        completeMock.mockResolvedValue({
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "Page 97 connects to page 98." }],
        });
        const cfg: OpenClawConfig = {
          agents: { defaults: { pdfModel: { primary: model }, pdfMaxPages: 2 } },
        };
        const tool = requirePdfTool((await loadCreatePdfTool())({ config: cfg, agentDir }));

        const result = await tool.execute("visual", {
          pdf: "/tmp/doc.pdf",
          visual: true,
          pages: "98,97-98,97",
          prompt: "Explain the diagram connection.",
        });

        expect(extractSpy).toHaveBeenCalledOnce();
        expect(extractSpy).toHaveBeenCalledWith(
          expect.objectContaining({ renderImages: true, pageNumbers: [97, 98] }),
        );
        expect(anthropicSpy).not.toHaveBeenCalled();
        expect(googleSpy).not.toHaveBeenCalled();
        expect(completeMock).toHaveBeenCalledOnce();
        expect(completeMock.mock.calls[0]?.[1]).toMatchObject({
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: expect.stringContaining(text) },
                { type: "text", text: expect.stringContaining("[PDF 1 page 97]") },
                { type: "image", data: "cGFnZTk3", mimeType: "image/png" },
                { type: "text", text: expect.stringContaining("[PDF 1 page 98]") },
                { type: "image", data: "cGFnZTk4", mimeType: "image/png" },
                { type: "text", text: "Explain the diagram connection." },
              ],
            },
          ],
        });
        expect(result.content).toEqual([{ type: "text", text: "Page 97 connects to page 98." }]);
        expect(result.details).toMatchObject({ native: false, model });
      });
    },
  );

  it.each([
    { pages: undefined, pdfMaxPages: 20 },
    { pages: " ", pdfMaxPages: 20 },
    { pages: "1-5", pdfMaxPages: 20 },
    { pages: "97-99", pdfMaxPages: 2 },
    { pages: `1-${Number.MAX_SAFE_INTEGER}`, pdfMaxPages: 20 },
  ])(
    "rejects visual selection $pages with page limit $pdfMaxPages before loading",
    async ({ pages, pdfMaxPages }) => {
      await withTempPdfAgentDir(async (agentDir) => {
        const { loadSpy } = await stubPdfToolInfra(agentDir, {
          provider: "openai",
          api: "openai-responses",
          input: ["text", "image"],
        });
        const extractSpy = vi.spyOn(pdfExtractModule, "extractPdfContent");
        const cfg: OpenClawConfig = {
          agents: { defaults: { pdfModel: { primary: OPENAI_PDF_MODEL }, pdfMaxPages } },
        };
        const tool = requirePdfTool((await loadCreatePdfTool())({ config: cfg, agentDir }));

        await expect(
          tool.execute("visual", { pdf: "/tmp/doc.pdf", visual: true, pages }),
        ).rejects.toThrow(/pages/i);
        expect(loadSpy).not.toHaveBeenCalled();
        expect(extractSpy).not.toHaveBeenCalled();
        expect(completeMock).not.toHaveBeenCalled();
      });
    },
  );

  it("rejects text-only visual models before extraction", async () => {
    await withTempPdfAgentDir(async (agentDir) => {
      await stubPdfToolInfra(agentDir, {
        provider: "openai",
        api: "openai-responses",
        input: ["text"],
      });
      const extractSpy = vi.spyOn(pdfExtractModule, "extractPdfContent");
      const tool = requirePdfTool(
        (await loadCreatePdfTool())({ config: withPdfModel(OPENAI_PDF_MODEL), agentDir }),
      );

      await expect(
        tool.execute("visual", { pdf: "/tmp/doc.pdf", visual: true, pages: "97-98" }),
      ).rejects.toThrow(/image/i);
      expect(extractSpy).not.toHaveBeenCalled();
      expect(completeMock).not.toHaveBeenCalled();
    });
  });

  it.each([
    { label: "no images", images: [] },
    { label: "one requested page missing", images: VISUAL_PAGE_IMAGES.slice(0, 1) },
    {
      label: "wrong source page",
      images: VISUAL_PAGE_IMAGES.map((image) =>
        image.pageNumber === 98 ? { ...image, pageNumber: 99 } : image,
      ),
    },
    {
      label: "missing source page provenance",
      images: VISUAL_PAGE_IMAGES.map((image) => ({
        type: image.type,
        data: image.data,
        mimeType: image.mimeType,
      })),
    },
    {
      label: "empty image payload",
      images: VISUAL_PAGE_IMAGES.map((image) => ({ ...image, data: "" })),
    },
  ])("rejects visual extraction with $label instead of answering from text", async ({ images }) => {
    await withTempPdfAgentDir(async (agentDir) => {
      await stubPdfToolInfra(agentDir, {
        provider: "openai",
        api: "openai-responses",
        input: ["text", "image"],
      });
      vi.spyOn(pdfExtractModule, "extractPdfContent").mockResolvedValue({
        text: "Readable text must not satisfy the visual request.",
        images,
      });
      const tool = requirePdfTool(
        (await loadCreatePdfTool())({ config: withPdfModel(OPENAI_PDF_MODEL), agentDir }),
      );

      await expect(
        tool.execute("visual", { pdf: "/tmp/doc.pdf", visual: true, pages: "97-98" }),
      ).rejects.toThrow(/image|page/i);
      expect(completeMock).not.toHaveBeenCalled();
    });
  });

  it("requires requested page images from every PDF", async () => {
    await withTempPdfAgentDir(async (agentDir) => {
      await stubPdfToolInfra(agentDir, {
        provider: "openai",
        api: "openai-responses",
        input: ["text", "image"],
      });
      const extractSpy = vi
        .spyOn(pdfExtractModule, "extractPdfContent")
        .mockResolvedValueOnce({ text: "First PDF", images: VISUAL_PAGE_IMAGES })
        .mockResolvedValueOnce({ text: "Second PDF", images: VISUAL_PAGE_IMAGES.slice(0, 1) });
      const tool = requirePdfTool(
        (await loadCreatePdfTool())({ config: withPdfModel(OPENAI_PDF_MODEL), agentDir }),
      );

      await expect(
        tool.execute("visual", {
          pdfs: ["/tmp/first.pdf", "/tmp/second.pdf"],
          visual: true,
          pages: "97-98",
        }),
      ).rejects.toThrow(/image|page/i);
      expect(extractSpy).toHaveBeenCalledTimes(2);
      expect(completeMock).not.toHaveBeenCalled();
    });
  });

  it("does not call the visual model after renderer failure", async () => {
    await withTempPdfAgentDir(async (agentDir) => {
      await stubPdfToolInfra(agentDir, {
        provider: "openai",
        api: "openai-responses",
        input: ["text", "image"],
      });
      vi.spyOn(pdfExtractModule, "extractPdfContent").mockRejectedValue(
        new Error("renderer failed"),
      );
      const tool = requirePdfTool(
        (await loadCreatePdfTool())({ config: withPdfModel(OPENAI_PDF_MODEL), agentDir }),
      );

      await expect(
        tool.execute("visual", { pdf: "/tmp/doc.pdf", visual: true, pages: "97-98" }),
      ).rejects.toThrow("renderer failed");
      expect(completeMock).not.toHaveBeenCalled();
    });
  });
});
