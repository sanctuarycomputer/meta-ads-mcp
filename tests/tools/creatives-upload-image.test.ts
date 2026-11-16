import { describe, it, expect } from "vitest";

import { adImageFileName, registerCreativeTools } from "../../src/tools/creatives.js";
import { createMockMcpServer } from "../setup.js";

describe("adImageFileName", () => {
  it("falls back to image<ext> when there is no name", () => {
    expect(adImageFileName(undefined, ".png")).toBe("image.png");
    expect(adImageFileName("", ".png")).toBe("image.png");
  });

  it("appends the real extension to a bare name", () => {
    expect(adImageFileName("banner verano", ".png")).toBe("banner verano.png");
  });

  it("keeps a name that already ends with the real extension, case-insensitively", () => {
    expect(adImageFileName("Banner.PNG", ".png")).toBe("Banner.PNG");
  });

  it("treats .jpg and .jpeg as the same extension", () => {
    expect(adImageFileName("foto.jpeg", ".jpg")).toBe("foto.jpeg");
    expect(adImageFileName("foto.JPG", ".jpg")).toBe("foto.JPG");
  });

  it("replaces another known image extension with the real one", () => {
    expect(adImageFileName("foto.png", ".jpg")).toBe("foto.jpg");
    expect(adImageFileName("foto.WEBP", ".png")).toBe("foto.png");
    expect(adImageFileName("scan.tiff", ".jpg")).toBe("scan.jpg");
  });

  it("appends the real extension after an unknown one", () => {
    expect(adImageFileName("report.v2", ".png")).toBe("report.v2.png");
  });

  it("keeps only the last path segment", () => {
    expect(adImageFileName("../../etc/passwd", ".png")).toBe("passwd.png");
    expect(adImageFileName("a/b\\c.png", ".png")).toBe("c.png");
  });

  it("removes quotes, control characters and reserved characters, and collapses whitespace", () => {
    expect(adImageFileName('ban"ner\nve\trano <1>: a|b?c*d', ".png")).toBe("banner ve rano 1 abcd.png");
  });

  it("removes C1 control characters too", () => {
    expect(adImageFileName("a\u0085b\u009fc\u0080", ".png")).toBe("abc.png");
  });

  it("a name cut at the limit never splits a character", () => {
    const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
    const result = adImageFileName("x".repeat(95) + "😀", ".png");
    expect(result).not.toMatch(lone);
    expect(result).not.toContain("�");
    expect(result.endsWith(".png")).toBe(true);
    expect(Array.from(result).length).toBeLessThanOrEqual(100);

    const longer = adImageFileName("x".repeat(94) + "😀😀😀", ".png");
    expect(longer).not.toMatch(lone);
    expect(longer.endsWith(".png")).toBe(true);
    expect(Array.from(longer).length).toBeLessThanOrEqual(100);
  });

  it("falls back to image<ext> when nothing is left after cleaning", () => {
    expect(adImageFileName("... ..", ".png")).toBe("image.png");
    expect(adImageFileName("   ", ".jpg")).toBe("image.jpg");
    expect(adImageFileName('"<>:|?*', ".png")).toBe("image.png");
  });

  it("drops leading dots", () => {
    expect(adImageFileName("..hidden", ".png")).toBe("hidden.png");
  });

  it("caps the result at 100 characters and keeps the extension", () => {
    const result = adImageFileName("x".repeat(300), ".png");
    expect(result).toHaveLength(100);
    expect(result.endsWith(".png")).toBe(true);
    expect(result).toBe("x".repeat(96) + ".png");
  });

  it("caps a long name that already carries the real extension", () => {
    const result = adImageFileName(`${"y".repeat(300)}.PNG`, ".png");
    expect(result).toHaveLength(100);
    expect(result.endsWith(".PNG")).toBe(true);
  });
});

// M9 (253): the tool reads a local file (tests/must-fix/m9-uploads.test.ts names the file part); it takes no URL.
describe("ads_upload_ad_image schema", () => {
  it("has no image_url", () => {
    const server = createMockMcpServer();
    registerCreativeTools(server as never);
    const tool = server._registeredTools.find((t) => t.name === "ads_upload_ad_image")!;
    expect(Object.keys(tool.schema as Record<string, unknown>)).not.toContain("image_url");
    expect(Object.keys(tool.schema as Record<string, unknown>)).toContain("path");
  });
});
